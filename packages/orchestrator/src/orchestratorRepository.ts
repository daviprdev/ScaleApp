/**
 * Persistência da orquestração: cria o grafo de execução (pipeline_executions +
 * pipeline_step_executions, com dependência linear e job_executions ancorando os
 * jobs) e expõe consultas mapeadas para os contratos de @scaleapp/domain.
 *
 * A transição de estado (advance) é transacional e vive em orchestrator.ts; aqui
 * ficam a criação e as leituras.
 */

import type { Pool } from "pg";
import {
  type ExecutionTrigger,
  type IdempotencyKey,
  type IsoTimestamp,
  type JobId,
  type OperationError,
  type PipelineExecution,
  type PipelineExecutionId,
  type PipelineOperation,
  type PipelineStep,
  type PipelineStepExecution,
  type PipelineStepId,
  type PipelineStepExecutionId,
} from "@scaleapp/domain";

const iso = (d: Date): IsoTimestamp => d.toISOString() as IsoTimestamp;

interface ExecutionRow {
  id: string;
  pipeline_id: string;
  account_id: string;
  job_execution_id: string;
  trigger: ExecutionTrigger;
  status: PipelineExecution["status"];
  current_step_index: number;
  error: OperationError | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  id: string;
  pipeline_execution_id: string;
  step_id: string;
  step_index: number;
  operation_type: PipelineStepExecution["operationType"];
  condition: PipelineStepExecution["condition"];
  status: PipelineStepExecution["status"];
  depends_on_step_execution_id: string | null;
  job_id: string | null;
  idempotency_key: string;
  result: unknown | null;
  error: OperationError | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toExecution(r: ExecutionRow): PipelineExecution {
  return {
    id: r.id as PipelineExecutionId,
    pipelineId: r.pipeline_id as PipelineExecution["pipelineId"],
    accountId: r.account_id as PipelineExecution["accountId"],
    jobExecutionId: r.job_execution_id as PipelineExecution["jobExecutionId"],
    trigger: r.trigger,
    status: r.status,
    currentStepIndex: r.current_step_index,
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.started_at !== null ? { startedAt: iso(r.started_at) } : {}),
    ...(r.finished_at !== null ? { finishedAt: iso(r.finished_at) } : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toStep(r: StepRow): PipelineStepExecution {
  return {
    id: r.id as PipelineStepExecutionId,
    pipelineExecutionId: r.pipeline_execution_id as PipelineExecutionId,
    stepId: r.step_id as PipelineStepId,
    stepIndex: r.step_index,
    operationType: r.operation_type,
    condition: r.condition,
    status: r.status,
    ...(r.depends_on_step_execution_id !== null
      ? { dependsOnStepExecutionId: r.depends_on_step_execution_id as PipelineStepExecutionId }
      : {}),
    ...(r.job_id !== null ? { jobId: r.job_id as JobId } : {}),
    idempotencyKey: r.idempotency_key as IdempotencyKey,
    ...(r.result !== null ? { result: r.result } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.started_at !== null ? { startedAt: iso(r.started_at) } : {}),
    ...(r.finished_at !== null ? { finishedAt: iso(r.finished_at) } : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface StartInput {
  readonly pipelineId: string;
  readonly accountId: string;
  readonly trigger: ExecutionTrigger;
  readonly steps: readonly PipelineStep[];
}

export class OrchestratorRepository {
  constructor(private readonly pool: Pool) {}

  /** Cria job_executions + pipeline_executions + as etapas, atomicamente. */
  async start(input: StartInput): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const je = await client.query<{ id: string }>(
        `INSERT INTO job_executions (pipeline_id, trigger, target_account_ids)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.pipelineId, input.trigger, [input.accountId]],
      );
      const jobExecutionId = je.rows[0]!.id;

      const pe = await client.query<{ id: string }>(
        `INSERT INTO pipeline_executions (pipeline_id, account_id, job_execution_id, trigger)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.pipelineId, input.accountId, jobExecutionId, input.trigger],
      );
      const peId = pe.rows[0]!.id;

      let previousStepExecId: string | null = null;
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i]!;
        const operation: PipelineOperation = step.operation;
        const idempotencyKey = `${peId}:${i}:${step.id}`;
        const insertedId: string = (
          await client.query<{ id: string }>(
            `INSERT INTO pipeline_step_executions
               (pipeline_execution_id, step_id, step_index, operation_type, operation,
                condition, idempotency_key, depends_on_step_execution_id)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
             RETURNING id`,
            [
              peId,
              step.id,
              i,
              operation.type,
              JSON.stringify(operation),
              step.condition,
              idempotencyKey,
              previousStepExecId,
            ],
          )
        ).rows[0]!.id;
        previousStepExecId = insertedId;
      }

      await client.query("COMMIT");
      return peId;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getExecution(pipelineExecutionId: string): Promise<PipelineExecution | null> {
    const res = await this.pool.query<ExecutionRow>(
      `SELECT * FROM pipeline_executions WHERE id = $1`,
      [pipelineExecutionId],
    );
    return res.rows[0] ? toExecution(res.rows[0]) : null;
  }

  async getSteps(pipelineExecutionId: string): Promise<readonly PipelineStepExecution[]> {
    const res = await this.pool.query<StepRow>(
      `SELECT * FROM pipeline_step_executions
       WHERE pipeline_execution_id = $1 ORDER BY step_index ASC`,
      [pipelineExecutionId],
    );
    return res.rows.map(toStep);
  }

  /** Execuções ainda ativas (para o poller reconciliar). Sempre limitado (regra 8). */
  async listActiveIds(limit = 100): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM pipeline_executions
       WHERE status IN ('pending', 'running')
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => r.id);
  }
}
