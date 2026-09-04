/**
 * Job: unidade concreta que o Orchestrator produz a partir de um step de
 * pipeline e enfileira. Alvo sempre uma conta e uma operação atômica de driver.
 *
 * A fila é segmentada por classe de driver (módulo 6), então o job carrega a
 * `driverClass` que decide em qual fila ele entra.
 */

import type {
  AccountId,
  ExecutionId,
  IdempotencyKey,
  IsoTimestamp,
  JobId,
  OperationError,
  PipelineId,
  PipelineStepId,
} from "./common.js";
import type {
  DriverClass,
  DriverOperationKind,
  DriverOperationPayloadMap,
} from "./driver.js";

export enum JobStatus {
  Pending = "pending",
  /** Aguardando janela de postagem / stagger (regra 5). */
  Scheduled = "scheduled",
  Queued = "queued",
  /** Claim atômico feito por um worker (regra 4). */
  Claimed = "claimed",
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
  Retrying = "retrying",
  /** Esgotou os retries — vai para dead-letter, não some. */
  DeadLetter = "dead_letter",
  Cancelled = "cancelled",
}

export enum BackoffStrategy {
  Fixed = "fixed",
  Exponential = "exponential",
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: BackoffStrategy;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
}

/** Claim atômico (regra 4): quem pegou o job e até quando o lease vale. */
export interface JobClaim {
  readonly workerId: string;
  readonly claimedAt: IsoTimestamp;
  readonly leaseExpiresAt: IsoTimestamp;
}

/**
 * Parametrizado por `DriverOperationKind` para que `operationKind` e `payload`
 * fiquem correlacionados (o payload é sempre o da operação certa).
 */
export interface Job<
  K extends DriverOperationKind = DriverOperationKind,
> {
  readonly id: JobId;
  /** Regra 9: chave de idempotência em todo job. */
  readonly idempotencyKey: IdempotencyKey;

  /** Proveniência: de qual execução/pipeline/step este job nasceu. */
  readonly executionId: ExecutionId;
  readonly pipelineId: PipelineId;
  readonly stepId: PipelineStepId;

  readonly accountId: AccountId;

  /** Define a fila (filas segmentadas por classe de driver). */
  readonly driverClass: DriverClass;
  readonly operationKind: K;
  readonly payload: DriverOperationPayloadMap[K];

  readonly status: JobStatus;
  readonly priority: number;

  readonly attempts: number;
  readonly retryPolicy: RetryPolicy;

  /** Momento agendado; o atraso do stagger nunca ultrapassa o ciclo (regra 5). */
  readonly scheduledFor?: IsoTimestamp;

  readonly claim?: JobClaim;
  readonly lastError?: OperationError;

  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
