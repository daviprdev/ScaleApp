/**
 * Retry (recuperação após falha simulada), dead-letter ao esgotar tentativas e
 * idempotência por idempotencyKey.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackoffStrategy, DriverClass, DriverOperationKind, FailureClass } from "@scaleapp/domain";
import { withMockDirective } from "@scaleapp/driver-mock";
import { JobRepository, createAndEnqueueJob } from "../src/index.js";
import { makeHarness, seedGraph, uniqueKey, waitFor } from "./setup.js";

test("falha retryável gera retry e conclui na tentativa seguinte", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();
    h.makeWorker("w-retry");

    const { jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      // falha 1 vez (retryável), depois sucede.
      payload: withMockDirective(
        { mediaIds: ["m1"] },
        { failuresBeforeSuccess: 1, retryable: true, failureClass: FailureClass.Network },
      ),
      retryPolicy: { maxAttempts: 3, backoff: BackoffStrategy.Exponential, baseDelayMs: 40 },
    });

    const record = await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "succeeded" ? j : null;
    });

    assert.equal(record.status, "succeeded");
    // Executou duas vezes (1 falha + 1 sucesso); recuperou.
    assert.equal(h.mock.executionCount(key), 2);
    assert.equal(h.mock.successCount(key), 1);
    assert.ok(record.attempts >= 2);
  } finally {
    await h.closeAll();
  }
});

test("falha além do maxAttempts termina em dead_letter", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();
    h.makeWorker("w-dl");

    const { jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      // sempre falha (retryável) — nunca sucede dentro do orçamento.
      payload: withMockDirective(
        { mediaIds: ["m1"] },
        { failuresBeforeSuccess: 9, retryable: true, failureClass: FailureClass.RateLimited },
      ),
      retryPolicy: { maxAttempts: 2, backoff: BackoffStrategy.Fixed, baseDelayMs: 30 },
    });

    const record = await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "dead_letter" ? j : null;
    });

    assert.equal(record.status, "dead_letter");
    assert.equal(h.mock.executionCount(key), 2); // exatamente maxAttempts tentativas
    assert.equal(h.mock.successCount(key), 0);
    assert.ok(record.lastError, "erro deve estar persistido");
    assert.equal(record.lastError?.failureClass, FailureClass.RateLimited);
  } finally {
    await h.closeAll();
  }
});

test("falha não-retryável termina em failed sem retentar", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();
    h.makeWorker("w-fail");

    const { jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: withMockDirective(
        { mediaIds: ["m1"] },
        { failuresBeforeSuccess: 9, retryable: false, failureClass: FailureClass.TokenDead },
      ),
      retryPolicy: { maxAttempts: 5, backoff: BackoffStrategy.Fixed, baseDelayMs: 30 },
    });

    const record = await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "failed" ? j : null;
    });

    assert.equal(record.status, "failed");
    assert.equal(h.mock.executionCount(key), 1); // não retentou, apesar de maxAttempts=5
  } finally {
    await h.closeAll();
  }
});

test("mesma idempotencyKey não cria nem executa a ação duas vezes", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();
    h.makeWorker("w-idem");

    const base = {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: { mediaIds: ["m1"] },
      retryPolicy: { maxAttempts: 3, backoff: BackoffStrategy.Fixed, baseDelayMs: 30 },
    };

    const first = await createAndEnqueueJob(h.pool, h.producer, base);
    const second = await createAndEnqueueJob(h.pool, h.producer, base);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.jobId, second.jobId);

    await waitFor(async () => {
      const j = await jobRepo.getById(first.jobId);
      return j?.status === "succeeded" ? j : null;
    });

    // Uma única linha de job e uma única execução da ação.
    const count = await h.pool.query<{ n: string }>(
      "SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = $1",
      [key],
    );
    assert.equal(Number(count.rows[0]!.n), 1);
    assert.equal(h.mock.executionCount(key), 1);
  } finally {
    await h.closeAll();
  }
});
