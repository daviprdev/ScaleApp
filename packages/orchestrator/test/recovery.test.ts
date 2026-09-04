/**
 * Recuperação (reinício do Orchestrator no meio), concorrência (duas instâncias
 * não avançam a mesma etapa) e idempotência (mesma etapa nunca vira dois jobs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionTrigger, StepConditionType } from "@scaleapp/domain";
import { OrchestratorRepository } from "../src/index.js";
import { makeOrchHarness, publishPost, seedAccount, step, waitFor, warmup } from "./setup.js";

async function jobCount(pool: Awaited<ReturnType<typeof makeOrchHarness>>["pool"], key: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE idempotency_key = $1",
    [key],
  );
  return r.rows[0]!.n;
}

test("reinício do Orchestrator no meio → etapas concluídas não reexecutam", async () => {
  const h = makeOrchHarness();
  try {
    h.startWorker();
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-restart",
      steps: [
        step("s0", publishPost(["m0"], { latencyMs: 100 }), StepConditionType.Always),
        step("s1", publishPost(["m1"], { latencyMs: 100 })),
        step("s2", warmup({ latencyMs: 100 })),
      ],
    });

    // Instância 1 inicia e "cai" logo após liberar a 1ª etapa (sem poller).
    const o1 = h.newOrchestrator("o1");
    const peId = await o1.start(pipelineId, account, ExecutionTrigger.Manual);

    // Instância 2 assume, descobre o estado persistido e continua.
    const o2 = h.newOrchestrator("o2");
    const poller = o2.runPoller(80);
    const pe = await waitFor(async () => {
      const e = await o2.getExecution(peId);
      return e?.status === "completed" ? e : null;
    });
    poller.stop();

    assert.equal(pe.status, "completed");
    const steps = await o2.getSteps(peId);
    assert.deepEqual(
      steps.map((s) => s.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    // Nenhuma etapa executada mais de uma vez apesar da troca de instância.
    for (const s of steps) assert.equal(h.mock.executionCount(s.idempotencyKey), 1);
  } finally {
    await h.closeAll();
  }
});

test("duas instâncias concorrentes → só uma avança a etapa (um único job)", async () => {
  const h = makeOrchHarness();
  try {
    h.startWorker();
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-concurrent",
      steps: [step("s0", publishPost(["m0"]), StepConditionType.Always), step("s1", warmup())],
    });

    // Cria o grafo SEM avançar (para as duas instâncias disputarem a 1ª etapa).
    const repo = new OrchestratorRepository(h.pool);
    const steps0 = await h.pipelineRepo.getSteps(pipelineId);
    const peId = await repo.start({
      pipelineId,
      accountId: account,
      trigger: ExecutionTrigger.Manual,
      steps: steps0!,
    });

    const o1 = h.newOrchestrator("o1");
    const o2 = h.newOrchestrator("o2");

    // Avanço concorrente da mesma etapa por duas instâncias.
    await Promise.all([o1.advance(peId), o2.advance(peId), o1.advance(peId), o2.advance(peId)]);

    const key0 = `${peId}:0:s0`;
    assert.equal(await jobCount(h.pool, key0), 1, "deve existir exatamente um job para a etapa 0");

    const steps = await o1.getSteps(peId);
    assert.ok(steps[0]!.jobId, "etapa 0 deve ter um único job vinculado");
    assert.ok(["running", "succeeded"].includes(steps[0]!.status));
  } finally {
    await h.closeAll();
  }
});

test("idempotência → múltiplos advance não geram dois jobs/ações para a etapa", async () => {
  const h = makeOrchHarness();
  try {
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-idem",
      steps: [step("s0", publishPost(["m0"]), StepConditionType.Always), step("s1", warmup())],
    });

    const repo = new OrchestratorRepository(h.pool);
    const steps0 = await h.pipelineRepo.getSteps(pipelineId);
    const peId = await repo.start({
      pipelineId,
      accountId: account,
      trigger: ExecutionTrigger.Manual,
      steps: steps0!,
    });

    const o1 = h.newOrchestrator("o1");
    // Vários advance da mesma etapa (reexecução do Orchestrator).
    await o1.advance(peId);
    await o1.advance(peId);
    await o1.advance(peId);

    const key0 = `${peId}:0:s0`;
    assert.equal(await jobCount(h.pool, key0), 1, "etapa 0 não pode gerar dois jobs");

    // Agora sobe o worker e conclui: a ação real acontece uma única vez por etapa.
    h.startWorker();
    const poller = o1.runPoller(80);
    await waitFor(async () => {
      const e = await o1.getExecution(peId);
      return e?.status === "completed" ? e : null;
    });
    poller.stop();

    const steps = await o1.getSteps(peId);
    for (const s of steps) assert.equal(h.mock.executionCount(s.idempotencyKey), 1);
  } finally {
    await h.closeAll();
  }
});
