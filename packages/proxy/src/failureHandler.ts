/**
 * Reação do pool à falha de um job. `ProxyError` observado em produção vale
 * mais que qualquer sonda sintética: é a prova de que o proxy não serve para o
 * tráfego real.
 *
 * O que o handler NÃO faz: marcar `down` e trocar o proxy da conta na primeira
 * falha. Um `ProxyError` isolado pode ser soluço de rede; e uma troca de proxy
 * não é barata para a conta (IP novo é justamente o que a plataforma nota).
 * Aqui só acumula o strike; `down` continua sendo decisão da varredura, que
 * enxerga o lote e distingue outage (regra 2).
 *
 * A troca automática existe, mas atrás de um limite alto e explícito.
 */

import type { Pool } from "pg";
import { FailureClass } from "@scaleapp/domain";
import type { ProxyAssignmentService } from "./assignmentService.js";
import type { ProxyRepository } from "./proxyRepository.js";

/** Recorte da falha que este handler consome (mesma forma do worker). */
export interface ProxyFailureInfo {
  readonly accountId: string;
  readonly jobId: string;
  readonly error: {
    readonly failureClass: FailureClass;
    readonly code: string;
    readonly message: string;
  };
}

export interface ProxyFailureHandlerOptions {
  readonly repo: ProxyRepository;
  readonly pool: Pool;
  /**
   * Troca automática de proxy depois de N falhas seguidas. 0 desliga — que é o
   * default: em v1 é preferível alertar e decidir do que a plataforma ver a
   * conta pulando de IP sozinha.
   */
  readonly swapAfterFailures?: number;
  readonly assignments?: ProxyAssignmentService;
  readonly onProxyFailure?: (info: {
    readonly accountId: string;
    readonly proxyId: string;
    readonly swapped: boolean;
  }) => void;
}

export function createProxyFailureHandler(
  opts: ProxyFailureHandlerOptions,
): (info: ProxyFailureInfo) => Promise<void> {
  const swapAfter = opts.swapAfterFailures ?? 0;

  return async (info: ProxyFailureInfo): Promise<void> => {
    if (info.error.failureClass !== FailureClass.ProxyError) return;

    // O job conhece a conta; o proxy vem do vínculo dedicado dela.
    const res = await opts.pool.query<{ proxy_id: string }>(
      `SELECT proxy_id FROM accounts WHERE id = $1`,
      [info.accountId],
    );
    const proxyId = res.rows[0]?.proxy_id;
    if (!proxyId) return;

    await opts.repo.registerFailure(proxyId, `${info.error.code}: ${info.error.message}`);

    let swapped = false;
    if (swapAfter > 0 && opts.assignments) {
      const proxy = await opts.repo.getById(proxyId);
      if (proxy && proxy.consecutiveFailures >= swapAfter) {
        await opts.assignments.swapForAccount(info.accountId, true);
        swapped = true;
      }
    }

    opts.onProxyFailure?.({ accountId: info.accountId, proxyId, swapped });
  };
}
