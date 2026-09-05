/**
 * Reação à classificação de falha, do lado da sessão. É aqui que a regra 3
 * deixa de ser só um enum e vira mudança de estado: checkpoint e token morto
 * levam a remediações diferentes, então marcam a conta de formas diferentes.
 *
 * O que este handler deliberadamente NÃO faz: mexer na conta por causa de
 * `PlatformOutage` ou `RateLimited`. Marcar conta como errada durante um outage
 * da plataforma é o falso positivo da regra 2 — a decisão de cascata pertence a
 * outro módulo, com limiar percentual E contagem mínima.
 */

import { FailureClass } from "@scaleapp/domain";
import type { OperationFailureInfo } from "@scaleapp/execution";
import type { SessionRepository } from "./sessionRepository.js";

export interface SessionFailureHandlerOptions {
  readonly sessions: SessionRepository;
  /** Log opcional da remediação escolhida. */
  readonly onRemediation?: (info: {
    readonly accountId: string;
    readonly failureClass: FailureClass;
    readonly action: "checkpoint_required" | "token_dead" | "refresh_failure";
  }) => void;
}

/**
 * Devolve o observador a passar para `createJobWorker`. Só age nas classes que
 * são de fato sobre a sessão da conta.
 */
export function createSessionFailureHandler(
  opts: SessionFailureHandlerOptions,
): (info: OperationFailureInfo) => Promise<void> {
  const { sessions, onRemediation } = opts;

  return async (info: OperationFailureInfo): Promise<void> => {
    switch (info.error.failureClass) {
      case FailureClass.CheckpointRequired:
        // Login/verificação manual. O token pode estar perfeitamente vivo.
        await sessions.markCheckpointRequired(info.accountId);
        onRemediation?.({
          accountId: info.accountId,
          failureClass: info.error.failureClass,
          action: "checkpoint_required",
        });
        return;

      case FailureClass.TokenDead:
        // Só um novo fluxo de OAuth resolve; refrescar não adianta.
        await sessions.markTokenDead(info.accountId);
        onRemediation?.({
          accountId: info.accountId,
          failureClass: info.error.failureClass,
          action: "token_dead",
        });
        return;

      default:
        // Falha de um job de refresh que não é sobre a sessão em si (rede,
        // proxy, outage): conta o strike para a varredura espaçar as tentativas
        // em vez de reenfileirar a mesma conta a cada ciclo.
        if (info.operationKind === "refresh_session") {
          await sessions.registerRefreshFailure(info.accountId);
          onRemediation?.({
            accountId: info.accountId,
            failureClass: info.error.failureClass,
            action: "refresh_failure",
          });
        }
    }
  };
}
