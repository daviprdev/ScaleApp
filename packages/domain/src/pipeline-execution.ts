/**
 * Contratos de runtime da orquestração de pipeline (Fase 04).
 *
 * `Pipeline`/`PipelineStep` (pipeline.ts) descrevem *o quê* deve acontecer.
 * `PipelineExecution`/`PipelineStepExecution` são a contraparte executada: o
 * estado persistido e rastreável de uma corrida do pipeline contra uma conta.
 *
 * Reusam ao máximo os tipos já existentes: `ExecutionStatus`/`ExecutionTrigger`
 * (execution.ts) para o estado da execução, `PipelineOperationType`/
 * `StepConditionType` (pipeline.ts) para a etapa, e `OperationError`
 * (common.ts) para a falha. Só o estado por etapa é novo (`PipelineStepStatus`).
 */

import type {
  AccountId,
  ExecutionId,
  IdempotencyKey,
  IsoTimestamp,
  JobId,
  OperationError,
  PipelineExecutionId,
  PipelineId,
  PipelineStepExecutionId,
  PipelineStepId,
} from "./common.js";
import type { ExecutionStatus, ExecutionTrigger } from "./execution.js";
import type { PipelineOperationType, StepConditionType } from "./pipeline.js";

/** Estado de uma etapa dentro de uma execução de pipeline. */
export enum PipelineStepStatus {
  /** Ainda não liberada. */
  Pending = "pending",
  /** Job criado/enfileirado, aguardando resultado final. */
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
  /** Job foi para dead-letter — falha rastreável. */
  DeadLetter = "dead_letter",
  /** Condição não satisfeita — etapa não executa. */
  Skipped = "skipped",
}

/**
 * Uma corrida de um pipeline contra uma conta. Reusa `ExecutionStatus`. O
 * `jobExecutionId` é o agregado de jobs (job_executions) que ancora os jobs das
 * etapas (a Execution do domínio, Fase 03).
 */
export interface PipelineExecution {
  readonly id: PipelineExecutionId;
  readonly pipelineId: PipelineId;
  readonly accountId: AccountId;
  readonly jobExecutionId: ExecutionId;
  readonly trigger: ExecutionTrigger;
  readonly status: ExecutionStatus;
  /** Índice da etapa corrente (ordem de sequenciamento). */
  readonly currentStepIndex: number;
  readonly error?: OperationError;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Estado persistido de uma etapa executada. */
export interface PipelineStepExecution {
  readonly id: PipelineStepExecutionId;
  readonly pipelineExecutionId: PipelineExecutionId;
  readonly stepId: PipelineStepId;
  /** Ordem da etapa no pipeline. */
  readonly stepIndex: number;
  readonly operationType: PipelineOperationType;
  readonly condition: StepConditionType;
  readonly status: PipelineStepStatus;
  /** Dependência explícita: qual etapa precede esta (ordenação confiável). */
  readonly dependsOnStepExecutionId?: PipelineStepExecutionId;
  /** Job do sistema de execução (Fase 03) que materializa esta etapa. */
  readonly jobId?: JobId;
  /** Idempotência determinística da etapa — mesma etapa nunca vira dois jobs. */
  readonly idempotencyKey: IdempotencyKey;
  readonly result?: unknown;
  readonly error?: OperationError;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
