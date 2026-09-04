/**
 * Fluxo completo: criação → fila → worker → driver mock → persistência →
 * conclusão. E resiliência a reinício do worker.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackoffStrategy, DriverClass, DriverOperationKind } from "@scaleapp/domain";
import { JobRepository, createAndEnqueueJob } from "../src/index.js";
import { makeHarness, seedGraph, uniqueKey, waitFor } from "./setup.js";

const retryPolicy = { maxAttempts: 3, backoff: BackoffStrategy.Exponential, baseDelayMs: 50 };

test("job flui pending → succeeded, executa o driver e persiste resultado", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();
    h.makeWorker("w1");

    const { created, jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: { mediaIds: ["m1"] },
      retryPolicy,
    });
    assert.equal(created, true);

    const record = await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "succeeded" ? j : null;
    });

    // Resultado persistido e ação executada exatamente uma vez.
    assert.ok(record.result, "resultado deve estar persistido");
    assert.equal(h.mock.executionCount(key), 1);
    assert.equal(h.mock.successCount(key), 1);

    // Execução agregada refletindo a conclusão.
    const ex = await h.pool.query<{ status: string; count_succeeded: number; count_total: number }>(
      "SELECT status, count_succeeded, count_total FROM job_executions WHERE id = $1",
      [refs.executionId],
    );
    assert.equal(ex.rows[0]!.status, "completed");
    assert.equal(ex.rows[0]!.count_succeeded, 1);
    assert.equal(ex.rows[0]!.count_total, 1);
  } finally {
    await h.closeAll();
  }
});

test("job enfileirado com worker fora é processado ao (re)iniciar o worker", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();

    // Enfileira SEM worker rodando.
    const { jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: { mediaIds: ["m1"] },
      retryPolicy,
    });

    // Ainda pending — nada processou.
    const before = await jobRepo.getById(jobId);
    assert.equal(before?.status, "pending");
    assert.equal(h.mock.executionCount(key), 0);

    // Sobe o worker "reiniciado" e o job pendente é consumido.
    h.makeWorker("w-restart");
    const record = await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "succeeded" ? j : null;
    });
    assert.equal(record.status, "succeeded");
    assert.equal(h.mock.executionCount(key), 1);
  } finally {
    await h.closeAll();
  }
});
