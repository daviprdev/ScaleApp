/**
 * Concorrência: o claim atômico impede processamento duplicado, tanto no nível
 * do banco (N claims simultâneos, um vencedor) quanto ponta a ponta (dois
 * workers, um job, uma execução).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BackoffStrategy, DriverClass, DriverOperationKind } from "@scaleapp/domain";
import { JobRepository, createAndEnqueueJob } from "../src/index.js";
import { makeHarness, seedGraph, uniqueKey, waitFor } from "./setup.js";

test("claim atômico: N reivindicações concorrentes, só uma vence", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();

    // Cria um job pending diretamente (sem enfileirar).
    const { record } = await jobRepo.create({
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: { mediaIds: ["m1"] },
      retryPolicy: { maxAttempts: 3, backoff: BackoffStrategy.Fixed, baseDelayMs: 30 },
    });

    const N = 10;
    const attempts = await Promise.all(
      Array.from({ length: N }, (_, i) => jobRepo.claimById(record.id, `w-${i}`, 60)),
    );

    const winners = attempts.filter((r) => r !== null);
    assert.equal(winners.length, 1, "exatamente um worker deve reivindicar o job");
    assert.equal(winners[0]!.status, "claimed");
  } finally {
    await h.closeAll();
  }
});

test("dois workers concorrentes não executam o mesmo job duas vezes", async () => {
  const h = makeHarness();
  const jobRepo = new JobRepository(h.pool);
  try {
    const refs = await seedGraph(h.pool);
    const key = uniqueKey();

    // Dois workers competindo pela mesma fila/prefixo.
    h.makeWorker("w-a");
    h.makeWorker("w-b");

    const { jobId } = await createAndEnqueueJob(h.pool, h.producer, {
      idempotencyKey: key,
      executionId: refs.executionId,
      pipelineId: refs.pipelineId,
      stepId: "step-1",
      accountId: refs.accountId,
      driverClass: DriverClass.GraphApi,
      operationKind: DriverOperationKind.PublishMedia,
      payload: { mediaIds: ["m1"] },
      retryPolicy: { maxAttempts: 3, backoff: BackoffStrategy.Fixed, baseDelayMs: 40 },
    });

    await waitFor(async () => {
      const j = await jobRepo.getById(jobId);
      return j?.status === "succeeded" ? j : null;
    });

    // Ação executada uma única vez apesar de dois workers ativos.
    assert.equal(h.mock.executionCount(key), 1);
    assert.equal(h.mock.successCount(key), 1);
  } finally {
    await h.closeAll();
  }
});
