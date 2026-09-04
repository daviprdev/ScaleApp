/**
 * Acesso a dados de `jobs`. Concentra as garantias que o CLAUDE.md exige no
 * banco, não na aplicação:
 *  - criação idempotente por `idempotency_key` (regra 9): ON CONFLICT DO NOTHING;
 *  - claim atômico por id (regra 4): um único UPDATE condicional, com
 *    recuperação de jobs "presos" cujo lease expirou;
 *  - transições de estado explícitas (pending → claimed → running → terminal).
 */

import type { Pool, PoolClient } from "pg";
import {
  type DriverClass,
  type DriverOperationKind,
  type JobStatus,
  type OperationError,
  type RetryPolicy,
} from "@scaleapp/domain";

/** Pool ou client — permite criar o job dentro de uma transação externa. */
export type Queryable = Pool | PoolClient;

const COLS = `
  id, idempotency_key, execution_id, pipeline_id, step_id, account_id,
  driver_class, operation_kind, payload, status, attempts, max_attempts,
  priority, result, last_error
`;

export interface JobRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly pipelineId: string;
  readonly stepId: string;
  readonly accountId: string;
  readonly driverClass: DriverClass;
  readonly operationKind: DriverOperationKind;
  readonly payload: Record<string, unknown>;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly result: unknown | null;
  readonly lastError: OperationError | null;
}

interface JobRow {
  id: string;
  idempotency_key: string;
  execution_id: string;
  pipeline_id: string;
  step_id: string;
  account_id: string;
  driver_class: DriverClass;
  operation_kind: DriverOperationKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  priority: number;
  result: unknown | null;
  last_error: OperationError | null;
}

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    executionId: r.execution_id,
    pipelineId: r.pipeline_id,
    stepId: r.step_id,
    accountId: r.account_id,
    driverClass: r.driver_class,
    operationKind: r.operation_kind,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    priority: r.priority,
    result: r.result,
    lastError: r.last_error,
  };
}

export interface CreateJobInput {
  readonly idempotencyKey: string;
  readonly executionId: string;
  readonly pipelineId: string;
  readonly stepId: string;
  readonly accountId: string;
  readonly driverClass: DriverClass;
  readonly operationKind: DriverOperationKind;
  readonly payload: Record<string, unknown>;
  readonly retryPolicy: RetryPolicy;
  readonly priority?: number;
}

export interface DriverContextRow {
  readonly accountId: string;
  readonly metaAppId: string;
  readonly proxyId: string;
  readonly accessTokenRef: string | null;
  /** Id numérico da conta IG Business (Graph API); null até ser resolvido. */
  readonly igUserId: string | null;
}

export class JobRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Cria o job se a `idempotency_key` for nova. Se já existir, devolve o job
   * existente com `created=false` — sem inserir de novo (regra 9).
   */
  async create(
    input: CreateJobInput,
    executor: Queryable = this.pool,
  ): Promise<{ record: JobRecord; created: boolean }> {
    const inserted = await executor.query<JobRow>(
      `INSERT INTO jobs
         (idempotency_key, execution_id, pipeline_id, step_id, account_id,
          driver_class, operation_kind, payload, priority,
          max_attempts, backoff, base_delay_ms, max_delay_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9, 100),
               $10, $11, $12, $13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLS}`,
      [
        input.idempotencyKey,
        input.executionId,
        input.pipelineId,
        input.stepId,
        input.accountId,
        input.driverClass,
        input.operationKind,
        JSON.stringify(input.payload),
        input.priority ?? null,
        input.retryPolicy.maxAttempts,
        input.retryPolicy.backoff,
        input.retryPolicy.baseDelayMs,
        input.retryPolicy.maxDelayMs ?? null,
      ],
    );

    if (inserted.rows[0]) {
      return { record: toRecord(inserted.rows[0]), created: true };
    }

    const existing = await executor.query<JobRow>(
      `SELECT ${COLS} FROM jobs WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { record: toRecord(existing.rows[0]!), created: false };
  }

  /**
   * Claim atômico por id (regra 4). Só reivindica jobs em estado reivindicável
   * ou jobs presos (claimed/running) cujo lease expirou. Retorna o job já em
   * `claimed` ou `null` se outro worker/estado já o tomou.
   */
  async claimById(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<JobRecord | null> {
    const res = await this.pool.query<JobRow>(
      `UPDATE jobs
       SET status = 'claimed',
           attempts = attempts + 1,
           claim_worker_id = $2,
           claim_claimed_at = now(),
           claim_lease_expires_at = now() + make_interval(secs => $3)
       WHERE id = $1
         AND (
           status IN ('pending', 'scheduled', 'queued', 'retrying')
           OR (status IN ('claimed', 'running')
               AND claim_lease_expires_at IS NOT NULL
               AND claim_lease_expires_at < now())
         )
       RETURNING ${COLS}`,
      [jobId, workerId, leaseSeconds],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async markRunning(jobId: string): Promise<void> {
    await this.pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [jobId]);
  }

  async markSucceeded(jobId: string, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET status = 'succeeded', result = $2::jsonb, last_error = NULL, completed_at = now()
       WHERE id = $1`,
      [jobId, JSON.stringify(result ?? null)],
    );
  }

  async markRetrying(jobId: string, error: OperationError): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'retrying', last_error = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify(error)],
    );
  }

  async markDeadLetter(jobId: string, error: OperationError): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET status = 'dead_letter', last_error = $2::jsonb, completed_at = now()
       WHERE id = $1`,
      [jobId, JSON.stringify(error)],
    );
  }

  async markFailed(jobId: string, error: OperationError): Promise<void> {
    await this.pool.query(
      `UPDATE jobs
       SET status = 'failed', last_error = $2::jsonb, completed_at = now()
       WHERE id = $1`,
      [jobId, JSON.stringify(error)],
    );
  }

  async getById(jobId: string): Promise<JobRecord | null> {
    const res = await this.pool.query<JobRow>(
      `SELECT ${COLS} FROM jobs WHERE id = $1`,
      [jobId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /** Resolve a amarração conta → App/proxy/token para montar o contexto do driver. */
  async loadDriverContext(jobId: string): Promise<DriverContextRow | null> {
    const res = await this.pool.query<{
      account_id: string;
      meta_app_id: string;
      proxy_id: string;
      access_token_ref: string | null;
      ig_user_id: string | null;
    }>(
      `SELECT a.id AS account_id, a.meta_app_id, a.proxy_id, a.access_token_ref, a.ig_user_id
       FROM jobs j JOIN accounts a ON a.id = j.account_id
       WHERE j.id = $1`,
      [jobId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      metaAppId: row.meta_app_id,
      proxyId: row.proxy_id,
      accessTokenRef: row.access_token_ref,
      igUserId: row.ig_user_id,
    };
  }
}
