/**
 * Acesso a dados de `job_executions` (o agregado Execution). Cria execuções e
 * recomputa contagens/estado a partir dos jobs, refletindo o progresso real.
 */

import type { Pool } from "pg";
import { ExecutionStatus, type ExecutionTrigger } from "@scaleapp/domain";

export interface CreateExecutionInput {
  readonly pipelineId: string;
  readonly trigger: ExecutionTrigger;
  readonly targetAccountIds?: readonly string[];
}

export class ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateExecutionInput): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO job_executions (pipeline_id, trigger, target_account_ids)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.pipelineId, input.trigger, input.targetAccountIds ?? []],
    );
    return res.rows[0]!.id;
  }

  /**
   * Recomputa as contagens e o status da execução a partir dos jobs. Serializa
   * com `FOR UPDATE` na linha da execução para evitar corrida entre workers que
   * finalizam jobs ao mesmo tempo.
   */
  async recompute(executionId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM job_executions WHERE id = $1 FOR UPDATE", [executionId]);

      const grouped = await client.query<{ status: string; n: string }>(
        `SELECT status, count(*)::int AS n FROM jobs WHERE execution_id = $1 GROUP BY status`,
        [executionId],
      );

      const counts = new Map<string, number>();
      for (const row of grouped.rows) counts.set(row.status, Number(row.n));
      const c = (s: string): number => counts.get(s) ?? 0;

      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const inflight =
        c("pending") + c("scheduled") + c("queued") + c("claimed") + c("running") + c("retrying");
      const terminalBad = c("failed") + c("dead_letter");
      const succeeded = c("succeeded");

      let status: ExecutionStatus;
      if (total === 0) status = ExecutionStatus.Pending;
      else if (inflight > 0) status = ExecutionStatus.Running;
      else if (terminalBad > 0 && succeeded > 0) status = ExecutionStatus.PartiallyFailed;
      else if (terminalBad > 0) status = ExecutionStatus.Failed;
      else status = ExecutionStatus.Completed;

      const finished = total > 0 && inflight === 0;

      await client.query(
        `UPDATE job_executions
         SET count_total = $2,
             count_pending = $3,
             count_running = $4,
             count_succeeded = $5,
             count_failed = $6,
             count_dead_letter = $7,
             status = $8,
             started_at = COALESCE(started_at,
               CASE WHEN $4 > 0 OR $5 > 0 OR $6 > 0 OR $7 > 0 THEN now() END),
             finished_at = CASE WHEN $9 THEN now() ELSE NULL END
         WHERE id = $1`,
        [
          executionId,
          total,
          c("pending") + c("scheduled") + c("queued"),
          c("running") + c("claimed"),
          succeeded,
          c("failed"),
          c("dead_letter"),
          status,
          finished,
        ],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
