/**
 * Execution: uma corrida de pipeline. O Orchestrator cria uma Execution ao
 * disparar um pipeline sobre um conjunto de contas; ela agrega o estado e o
 * histórico (contagens de job, failovers) para observabilidade.
 */

import type {
  AccountId,
  ExecutionId,
  FailureClass,
  IsoTimestamp,
  PipelineId,
} from "./common.js";

export enum ExecutionTrigger {
  Manual = "manual",
  /** Disparo recorrente do Scheduler (módulo 7). */
  Scheduled = "scheduled",
  /** Disparo por evento. */
  Event = "event",
}

export enum ExecutionStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  /** Terminou com parte dos jobs falhando. */
  PartiallyFailed = "partially_failed",
  Failed = "failed",
  Cancelled = "cancelled",
}

export interface ExecutionCounts {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLetter: number;
}

/**
 * Registro de failover para o histórico. A `reason` é a classificação da falha
 * — cascata só deve disparar por outage/erro real, com limiar percentual e
 * contagem mínima absoluta (regra 2); esta é a evidência auditável disso.
 */
export interface FailoverEvent {
  readonly fromAccountId: AccountId;
  readonly toAccountId?: AccountId;
  readonly reason: FailureClass;
  readonly occurredAt: IsoTimestamp;
}

export interface Execution {
  readonly id: ExecutionId;
  readonly pipelineId: PipelineId;
  readonly trigger: ExecutionTrigger;
  readonly status: ExecutionStatus;
  readonly targetAccountIds: readonly AccountId[];
  readonly counts: ExecutionCounts;
  readonly failovers: readonly FailoverEvent[];
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}
