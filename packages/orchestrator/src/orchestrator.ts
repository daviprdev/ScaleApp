/**
 * PipelineOrchestrator: executa um `Pipeline` como sequência de etapas
 * dependentes, reagindo ao resultado FINAL de cada job (o retry/backoff/
 * dead-letter é do worker — Fase 03; o Orchestrator não os duplica).
 *
 * Como conversa com @scaleapp/execution:
 *  - cria o job de cada etapa via `JobRepository.create` (na MESMA transação do
 *    avanço, atômico) e o publica via `JobProducer.enqueue` (após o commit);
 *  - lê o estado terminal do job direto da tabela `jobs` (fonte da verdade da
 *    Fase 03) para decidir a próxima etapa.
 *
 * Sequenciamento, concorrência e recuperação:
 *  - `advance` roda numa transação que faz `SELECT ... FOR UPDATE` na linha da
 *    execução → duas instâncias nunca avançam a mesma etapa ao mesmo tempo;
 *  - a `idempotencyKey` de cada etapa é determinística → reexecutar `advance`
 *    (inclusive após reinício) nunca gera dois jobs/ações reais para a etapa;
 *  - todo estado é persistido → ao reiniciar, o Orchestrator descobre onde
 *    parou lendo o banco e continua sem repetir etapas concluídas.
 */

import type { Pool, PoolClient } from "pg";
import {
  BackoffStrategy,
  ExecutionTrigger,
  type OperationError,
  type PipelineExecution,
  type PipelineOperation,
  type PipelineStepExecution,
  type RetryPolicy,
  StepConditionType,
} from "@scaleapp/domain";
import { JobRepository, type JobProducer, type Logger } from "@scaleapp/execution";
import { OrchestratorRepository } from "./orchestratorRepository.js";
import { PipelineRepository } from "./pipelineRepository.js";
import { mapOperation } from "./operationMapping.js";

const TERMINAL_STEP = new Set(["succeeded", "failed", "dead_letter", "skipped"]);
const TERMINAL_EXEC = new Set(["completed", "failed", "partially_failed", "cancelled"]);

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoff: BackoffStrategy.Exponential,
  baseDelayMs: 200,
};

export interface PipelineOrchestratorDeps {
  readonly pool: Pool;
  readonly producer: JobProducer;
  readonly logger: Logger;
  readonly orchestratorId: string;
  readonly retryPolicy?: RetryPolicy;
}

export interface AdvanceOutcome {
  readonly status: string;
  /** Terminou (completed/failed/...). */
  readonly done: boolean;
  /** Está aguardando um job em andamento. */
  readonly waiting: boolean;
}

interface PeRow {
  id: string;
  pipeline_id: string;
  account_id: string;
  job_execution_id: string;
  status: string;
  current_step_index: number;
}

interface StepRow {
  id: string;
  step_id: string;
  step_index: number;
  status: string;
  condition: string;
  operation: PipelineOperation;
  job_id: string | null;
  idempotency_key: string;
}

interface EnqueueSpec {
  id: string;
  idempotencyKey: string;
  driverClass: ReturnType<typeof mapOperation>["driverClass"];
  operationKind: ReturnType<typeof mapOperation>["operationKind"];
}

export class PipelineOrchestrator {
  private readonly pool: Pool;
  private readonly producer: JobProducer;
  private readonly logger: Logger;
  private readonly orchestratorId: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly repo: OrchestratorRepository;
  private readonly pipelineRepo: PipelineRepository;
  private readonly jobRepo: JobRepository;

  constructor(deps: PipelineOrchestratorDeps) {
    this.pool = deps.pool;
    this.producer = deps.producer;
    this.logger = deps.logger;
    this.orchestratorId = deps.orchestratorId;
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.repo = new OrchestratorRepository(this.pool);
    this.pipelineRepo = new PipelineRepository(this.pool);
    this.jobRepo = new JobRepository(this.pool);
  }

  /** Inicia a execução de um pipeline contra uma conta e libera a 1ª etapa. */
  async start(
    pipelineId: string,
    accountId: string,
    trigger: ExecutionTrigger = ExecutionTrigger.Manual,
  ): Promise<string> {
    const steps = await this.pipelineRepo.getSteps(pipelineId);
    if (!steps || steps.length === 0) {
      throw new Error(`pipeline ${pipelineId} não encontrado ou sem etapas`);
    }
    const peId = await this.repo.start({ pipelineId, accountId, trigger, steps });
    this.logger.info(
      { orchestratorId: this.orchestratorId, peId, pipelineId, accountId, steps: steps.length },
      "pipeline execution iniciada",
    );
    await this.advance(peId);
    return peId;
  }

  private conditionMet(active: StepRow, steps: readonly StepRow[]): boolean {
    if (active.condition === StepConditionType.Always) return true;
    if (active.step_index === 0) {
      return active.condition === StepConditionType.OnPreviousSuccess;
    }
    const prev = steps.find((s) => s.step_index === active.step_index - 1);
    const prevOk = prev?.status === "succeeded";
    const prevBad = prev?.status === "failed" || prev?.status === "dead_letter";
    return active.condition === StepConditionType.OnPreviousSuccess ? prevOk : prevBad;
  }

  /**
   * Avança a execução o máximo possível numa única transação, parando quando
   * precisa aguardar um job em andamento ou quando o pipeline termina. Seguro
   * para chamadas concorrentes e repetidas (FOR UPDATE + idempotência).
   */
  async advance(peId: string): Promise<AdvanceOutcome> {
    const client = await this.pool.connect();
    let enqueue: EnqueueSpec | null = null;
    let outcomeStatus = "running";
    let waiting = false;

    try {
      await client.query("BEGIN");

      const peRes = await client.query<PeRow>(
        "SELECT id, pipeline_id, account_id, job_execution_id, status, current_step_index FROM pipeline_executions WHERE id = $1 FOR UPDATE",
        [peId],
      );
      const pe = peRes.rows[0];
      if (!pe) {
        await client.query("ROLLBACK");
        throw new Error(`pipeline execution ${peId} não encontrada`);
      }
      if (TERMINAL_EXEC.has(pe.status)) {
        await client.query("COMMIT");
        return { status: pe.status, done: true, waiting: false };
      }

      for (let guard = 0; ; guard++) {
        if (guard > 10_000) throw new Error("advance: guard de loop excedido");

        const steps = (
          await client.query<StepRow>(
            "SELECT id, step_id, step_index, status, condition, operation, job_id, idempotency_key FROM pipeline_step_executions WHERE pipeline_execution_id = $1 ORDER BY step_index ASC",
            [peId],
          )
        ).rows;

        const active = steps.find((s) => !TERMINAL_STEP.has(s.status));

        // Todas as etapas em estado terminal → finaliza a execução.
        if (!active) {
          const anyBad = steps.some((s) => s.status === "failed" || s.status === "dead_letter");
          outcomeStatus = anyBad ? "failed" : "completed";
          await client.query(
            "UPDATE pipeline_executions SET status = $2, finished_at = now(), current_step_index = $3 WHERE id = $1",
            [peId, outcomeStatus, steps.length],
          );
          this.logger.info(
            { orchestratorId: this.orchestratorId, peId, status: outcomeStatus },
            "pipeline execution finalizada",
          );
          break;
        }

        if (active.status === "running") {
          const jobRes = await client.query<{
            status: string;
            result: unknown;
            last_error: OperationError | null;
          }>("SELECT status, result, last_error FROM jobs WHERE id = $1", [active.job_id]);
          const job = jobRes.rows[0];

          if (!job) {
            // Job sumiu (inesperado) — reabre a etapa para recriação idempotente.
            await client.query(
              "UPDATE pipeline_step_executions SET status = 'pending', job_id = NULL WHERE id = $1",
              [active.id],
            );
            continue;
          }

          if (job.status === "succeeded") {
            await client.query(
              "UPDATE pipeline_step_executions SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
              [active.id, JSON.stringify(job.result ?? null)],
            );
            this.logger.info(
              { orchestratorId: this.orchestratorId, peId, stepIndex: active.step_index },
              "etapa concluída (succeeded) — liberando próxima",
            );
            continue; // libera a próxima etapa na mesma transação
          }

          if (job.status === "failed" || job.status === "dead_letter") {
            const stepStatus = job.status === "dead_letter" ? "dead_letter" : "failed";
            await client.query(
              "UPDATE pipeline_step_executions SET status = $2, error = $3::jsonb, finished_at = now() WHERE id = $1",
              [active.id, stepStatus, JSON.stringify(job.last_error)],
            );
            // Etapas seguintes não executam — marca as pendentes como skipped.
            await client.query(
              "UPDATE pipeline_step_executions SET status = 'skipped', finished_at = now() WHERE pipeline_execution_id = $1 AND status = 'pending'",
              [peId],
            );
            await client.query(
              "UPDATE pipeline_executions SET status = 'failed', error = $2::jsonb, finished_at = now(), current_step_index = $3 WHERE id = $1",
              [peId, JSON.stringify(job.last_error), active.step_index],
            );
            outcomeStatus = "failed";
            this.logger.error(
              {
                orchestratorId: this.orchestratorId,
                peId,
                stepIndex: active.step_index,
                stepStatus,
                failureClass: job.last_error?.failureClass,
              },
              "etapa falhou permanentemente — pipeline falhou",
            );
            break;
          }

          // Job em andamento (pending/scheduled/queued/claimed/running/retrying).
          if (job.status === "pending") {
            const mapping = mapOperation(active.operation);
            enqueue = {
              id: active.job_id!,
              idempotencyKey: active.idempotency_key,
              driverClass: mapping.driverClass,
              operationKind: mapping.operationKind,
            };
          }
          await client.query(
            "UPDATE pipeline_executions SET current_step_index = $2 WHERE id = $1",
            [peId, active.step_index],
          );
          waiting = true;
          outcomeStatus = "running";
          break;
        }

        // active.status === 'pending' → decide executar ou pular.
        if (!this.conditionMet(active, steps)) {
          await client.query(
            "UPDATE pipeline_step_executions SET status = 'skipped', finished_at = now() WHERE id = $1",
            [active.id],
          );
          this.logger.info(
            { orchestratorId: this.orchestratorId, peId, stepIndex: active.step_index },
            "etapa pulada (condição não satisfeita)",
          );
          continue;
        }

        // Cria o job da etapa NA MESMA transação (atômico com a transição).
        const mapping = mapOperation(active.operation);
        const { record, created } = await this.jobRepo.create(
          {
            idempotencyKey: active.idempotency_key,
            executionId: pe.job_execution_id,
            pipelineId: pe.pipeline_id,
            stepId: active.step_id,
            accountId: pe.account_id,
            driverClass: mapping.driverClass,
            operationKind: mapping.operationKind,
            payload: mapping.payload,
            retryPolicy: this.retryPolicy,
          },
          client,
        );
        await client.query(
          "UPDATE pipeline_step_executions SET status = 'running', job_id = $2, started_at = COALESCE(started_at, now()) WHERE id = $1",
          [active.id, record.id],
        );
        await client.query(
          "UPDATE pipeline_executions SET status = 'running', started_at = COALESCE(started_at, now()), current_step_index = $2 WHERE id = $1",
          [peId, active.step_index],
        );
        enqueue = {
          id: record.id,
          idempotencyKey: record.idempotencyKey,
          driverClass: mapping.driverClass,
          operationKind: mapping.operationKind,
        };
        waiting = true;
        outcomeStatus = "running";
        this.logger.info(
          {
            orchestratorId: this.orchestratorId,
            peId,
            stepIndex: active.step_index,
            jobId: record.id,
            created,
          },
          "etapa liberada — job criado",
        );
        break;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Enqueue após o commit (idempotente): garante entrega mesmo se o processo
    // cair entre o commit e a publicação — a próxima advance reenfileira.
    if (enqueue) {
      await this.producer.enqueue({
        id: enqueue.id,
        idempotencyKey: enqueue.idempotencyKey,
        driverClass: enqueue.driverClass,
        operationKind: enqueue.operationKind,
        retryPolicy: this.retryPolicy,
      });
    }

    return {
      status: outcomeStatus,
      done: TERMINAL_EXEC.has(outcomeStatus),
      waiting,
    };
  }

  /** Reconcilia todas as execuções ativas (uma passada). */
  async tick(): Promise<void> {
    const ids = await this.repo.listActiveIds();
    for (const id of ids) {
      try {
        await this.advance(id);
      } catch (err) {
        this.logger.error(
          { orchestratorId: this.orchestratorId, peId: id, err: err instanceof Error ? err.message : err },
          "falha ao avançar execução",
        );
      }
    }
  }

  /** Poller: reconcilia periodicamente, sem sobrepor ticks. */
  runPoller(intervalMs = 200): { stop: () => void } {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.tick().finally(() => {
        running = false;
      });
    }, intervalMs);
    return {
      stop: (): void => {
        clearInterval(timer);
      },
    };
  }

  getExecution(peId: string): Promise<PipelineExecution | null> {
    return this.repo.getExecution(peId);
  }

  getSteps(peId: string): Promise<readonly PipelineStepExecution[]> {
    return this.repo.getSteps(peId);
  }
}
