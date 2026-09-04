/**
 * Sequenciamento: etapas em ordem, falha permanente interrompe, falha
 * retryável recupera e libera a próxima. Conclusão marca a Execution completed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionTrigger, FailureClass, StepConditionType } from "@scaleapp/domain";
import { makeOrchHarness, publishPost, seedAccount, step, waitFor, warmup } from "./setup.js";

test("pipeline de 3 etapas conclui todas em ordem → Execution completed", async () => {
  const h = makeOrchHarness();
  try {
    h.startWorker();
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-3-ok",
      steps: [
        step("s0", publishPost(["m0"]), StepConditionType.Always),
        step("s1", publishPost(["m1"])),
        step("s2", warmup()),
      ],
    });

    const orch = h.newOrchestrator("o1");
    const poller = orch.runPoller(80);
    const peId = await orch.start(pipelineId, account, ExecutionTrigger.Manual);

    const pe = await waitFor(async () => {
      const e = await orch.getExecution(peId);
      return e?.status === "completed" ? e : null;
    });
    poller.stop();

    assert.equal(pe.status, "completed");

    const steps = await orch.getSteps(peId);
    assert.equal(steps.length, 3);
    assert.deepEqual(
      steps.map((s) => s.status),
      ["succeeded", "succeeded", "succeeded"],
    );

    // Cada etapa gerou exatamente um job, distinto, e executou uma única ação.
    const jobIds = steps.map((s) => s.jobId);
    assert.ok(jobIds.every((id) => typeof id === "string"));
    assert.equal(new Set(jobIds).size, 3);
    for (const s of steps) assert.equal(h.mock.executionCount(s.idempotencyKey), 1);

    // Ordem: a etapa i+1 só começa depois de a i terminar.
    for (let i = 1; i < steps.length; i++) {
      assert.ok(
        steps[i]!.startedAt! >= steps[i - 1]!.finishedAt!,
        `etapa ${i} começou antes de a ${i - 1} terminar`,
      );
    }

    // A Execution do domínio (job_executions) também fica completed.
    const je = await h.pool.query<{ status: string }>(
      "SELECT je.status FROM job_executions je JOIN pipeline_executions pe ON pe.job_execution_id = je.id WHERE pe.id = $1",
      [peId],
    );
    assert.equal(je.rows[0]!.status, "completed");
  } finally {
    await h.closeAll();
  }
});

test("etapa 1 falha permanentemente → etapas posteriores não executam", async () => {
  const h = makeOrchHarness();
  try {
    h.startWorker();
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-fail",
      steps: [
        // não-retryável → o worker marca 'failed' de imediato.
        step(
          "s0",
          publishPost(["m0"], { failuresBeforeSuccess: 9, retryable: false, failureClass: FailureClass.TokenDead }),
          StepConditionType.Always,
        ),
        step("s1", publishPost(["m1"])),
        step("s2", warmup()),
      ],
    });

    const orch = h.newOrchestrator("o1");
    const poller = orch.runPoller(80);
    const peId = await orch.start(pipelineId, account);

    const pe = await waitFor(async () => {
      const e = await orch.getExecution(peId);
      return e?.status === "failed" ? e : null;
    });
    poller.stop();

    assert.equal(pe.status, "failed");
    assert.ok(pe.error, "erro do pipeline deve ser rastreável");

    const steps = await orch.getSteps(peId);
    assert.equal(steps[0]!.status, "failed");
    assert.equal(steps[1]!.status, "skipped");
    assert.equal(steps[2]!.status, "skipped");

    // Etapas posteriores nem geraram job nem executaram ação.
    assert.equal(steps[1]!.jobId, undefined);
    assert.equal(steps[2]!.jobId, undefined);
    assert.equal(h.mock.executionCount(steps[1]!.idempotencyKey), 0);
    assert.equal(h.mock.executionCount(steps[2]!.idempotencyKey), 0);
  } finally {
    await h.closeAll();
  }
});

test("etapa 1 falha retryável → retry do worker atua e a próxima é liberada após sucesso", async () => {
  const h = makeOrchHarness();
  try {
    h.startWorker();
    const account = await seedAccount(h.pool);
    const pipelineId = await h.pipelineRepo.create({
      name: "p-retry",
      steps: [
        // falha 1x (retryável) e depois sucede — o retry é do worker, não do orchestrator.
        step(
          "s0",
          publishPost(["m0"], { failuresBeforeSuccess: 1, retryable: true, failureClass: FailureClass.Network }),
          StepConditionType.Always,
        ),
        step("s1", warmup()),
      ],
    });

    const orch = h.newOrchestrator("o1");
    const poller = orch.runPoller(80);
    const peId = await orch.start(pipelineId, account);

    const pe = await waitFor(async () => {
      const e = await orch.getExecution(peId);
      return e?.status === "completed" ? e : null;
    });
    poller.stop();

    assert.equal(pe.status, "completed");
    const steps = await orch.getSteps(peId);
    assert.equal(steps[0]!.status, "succeeded");
    assert.equal(steps[1]!.status, "succeeded");
    // Etapa 0 foi executada 2x (1 falha + 1 sucesso): o retry existente funcionou.
    assert.equal(h.mock.executionCount(steps[0]!.idempotencyKey), 2);
    // Etapa 1 só liberada após o sucesso da 0, executada 1x.
    assert.equal(h.mock.executionCount(steps[1]!.idempotencyKey), 1);
    assert.ok(steps[1]!.startedAt! >= steps[0]!.finishedAt!);
  } finally {
    await h.closeAll();
  }
});
