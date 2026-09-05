/**
 * Refresh preventivo de token (regra 6): uma varredura periódica seleciona as
 * contas cuja sessão vai expirar dentro da janela e enfileira um job
 * `refresh_session` para cada uma. O refresh acontece ANTES do erro — nunca em
 * reação a um 190 na hora de postar.
 *
 * Três garantias que o CLAUDE.md exige e que estão aqui, não na intenção:
 *  - regra 8: o lote tem teto explícito (`limit`), sempre.
 *  - regra 9: a chave de idempotência inclui a expiração vigente, então duas
 *    varreduras sobre a mesma conta com a mesma expiração criam UM job. Uma
 *    nova expiração (isto é, um refresh que de fato aconteceu) gera uma chave
 *    nova — é isso que permite refrescar de novo no ciclo seguinte.
 *  - regra 5: os jobs saem escalonados dentro da janela do ciclo, nunca todos
 *    de uma vez (thundering herd → rate-limit em cascata), e nunca com atraso
 *    maior que o próprio ciclo (pulo de ciclo).
 *
 * O job nasce do pipeline de sistema `system:session-refresh` (migration 0005):
 * `jobs` exige pipeline/execução, e manutenção passar pela mesma trilha dá a
 * ela a mesma observabilidade dos jobs normais.
 */

import type { Pool } from "pg";
import {
  BackoffStrategy,
  DriverClass,
  DriverOperationKind,
  ExecutionTrigger,
  type RetryPolicy,
} from "@scaleapp/domain";
import { ExecutionRepository, createAndEnqueueJob, type JobProducer } from "@scaleapp/execution";
import { SessionRepository, type RefreshCandidate } from "./sessionRepository.js";
import { staggerDelayMs } from "./status.js";

/** Pipeline de sistema criado pela migration 0005. */
export const SESSION_REFRESH_PIPELINE_ID = "00000000-0000-0000-0000-000000000008";
export const SESSION_REFRESH_STEP_ID = "refresh";

/**
 * Refresh é barato e não duplica ação real (é idempotente do lado da Meta),
 * mas não deve competir com publicação: prioridade numérica alta = menos
 * prioritário na ordenação do claim.
 */
const REFRESH_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: BackoffStrategy.Exponential,
  baseDelayMs: 30_000,
  maxDelayMs: 10 * 60_000,
};
const REFRESH_PRIORITY = 500;

export interface PlanRefreshOptions {
  readonly pool: Pool;
  readonly producer: JobProducer;
  /** Teto de contas por varredura (regra 8). */
  readonly limit: number;
  /** Antecedência do refresh: quanto antes da expiração agir. */
  readonly withinMs: number;
  /** Intervalo entre varreduras — teto do stagger (regra 5). */
  readonly cycleIntervalMs: number;
  /** Intervalo mínimo entre tentativas para a mesma conta. */
  readonly minRetryIntervalMs?: number;
  /** Falhas consecutivas antes de parar de tentar sozinho. */
  readonly maxFailures?: number;
  readonly random?: () => number;
}

export interface PlanRefreshResult {
  readonly candidates: number;
  readonly enqueued: number;
  /** Já existiam (mesma chave de idempotência) — varredura anterior criou. */
  readonly skipped: number;
  readonly executionId?: string;
}

/**
 * Chave de idempotência do refresh. A expiração vigente entra na chave: mesma
 * sessão ⇒ mesma chave ⇒ no máximo um job em voo por conta (regra 9).
 */
export function refreshIdempotencyKey(candidate: RefreshCandidate): string {
  const bucket = Date.parse(candidate.expiresAt);
  return `session-refresh:${candidate.accountId}:${Number.isNaN(bucket) ? "unknown" : bucket}`;
}

/** Roda uma varredura de refresh preventivo. Seguro de chamar concorrentemente. */
export async function planPreventiveRefresh(opts: PlanRefreshOptions): Promise<PlanRefreshResult> {
  const sessions = new SessionRepository(opts.pool);
  const candidates = await sessions.findDueForRefresh({
    limit: opts.limit,
    withinMs: opts.withinMs,
    minRetryIntervalMs: opts.minRetryIntervalMs ?? opts.cycleIntervalMs,
    maxFailures: opts.maxFailures ?? 5,
  });

  if (candidates.length === 0) return { candidates: 0, enqueued: 0, skipped: 0 };

  const executions = new ExecutionRepository(opts.pool);
  const executionId = await executions.create({
    pipelineId: SESSION_REFRESH_PIPELINE_ID,
    trigger: ExecutionTrigger.Scheduled,
    targetAccountIds: candidates.map((c) => c.accountId),
  });

  let enqueued = 0;
  let skipped = 0;
  for (const [index, candidate] of candidates.entries()) {
    const delayMs = staggerDelayMs(
      index,
      candidates.length,
      opts.cycleIntervalMs,
      opts.random ?? Math.random,
    );
    const { created } = await createAndEnqueueJob(opts.pool, opts.producer, {
      idempotencyKey: refreshIdempotencyKey(candidate),
      executionId,
      pipelineId: SESSION_REFRESH_PIPELINE_ID,
      stepId: SESSION_REFRESH_STEP_ID,
      accountId: candidate.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.RefreshSession,
      payload: { force: false },
      retryPolicy: REFRESH_RETRY_POLICY,
      priority: REFRESH_PRIORITY,
      delayMs,
    });

    if (created) {
      enqueued++;
      // Marca a tentativa na criação, não na execução: sem isso, a varredura
      // seguinte (que roda antes do job ser processado) reavalia a mesma conta.
      await sessions.markRefreshAttempted(candidate.accountId);
    } else {
      skipped++;
    }
  }

  if (enqueued === 0) {
    // Todos os candidatos já tinham job em voo (criado por uma varredura
    // anterior, ou por outra rodando em paralelo). A execução ficaria vazia e
    // presa em `pending` no painel — remove, com guarda contra apagar uma que
    // tenha job associado.
    await opts.pool.query(
      `DELETE FROM job_executions e
       WHERE e.id = $1 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.execution_id = e.id)`,
      [executionId],
    );
    return { candidates: candidates.length, enqueued, skipped };
  }

  await executions.recompute(executionId);
  return { candidates: candidates.length, enqueued, skipped, executionId };
}
