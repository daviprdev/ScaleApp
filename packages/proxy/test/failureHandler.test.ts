/**
 * Testes da reação a `ProxyError` vindo de job real. O que se verifica aqui é
 * contenção: strike sim, troca de IP automática só sob limite explícito.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FailureClass } from "@scaleapp/domain";
import type { Pool } from "pg";
import { createProxyFailureHandler, type ProxyFailureInfo } from "../src/failureHandler.js";
import type { ProxyAssignmentService } from "../src/assignmentService.js";
import type { ProxyRecord, ProxyRepository } from "../src/proxyRepository.js";

const poolCom = (proxyId: string | null): Pool =>
  ({
    async query<R>(): Promise<{ rows: R[] }> {
      return { rows: (proxyId ? [{ proxy_id: proxyId }] : []) as unknown as R[] };
    },
  }) as unknown as Pool;

class FakeRepo {
  readonly failures: string[] = [];
  constructor(private readonly consecutiveFailures = 0) {}
  async registerFailure(id: string): Promise<void> {
    this.failures.push(id);
  }
  async getById(id: string): Promise<ProxyRecord> {
    return { id, consecutiveFailures: this.consecutiveFailures } as ProxyRecord;
  }
}

class FakeAssignments {
  readonly swaps: Array<{ accountId: string; retireOld: boolean }> = [];
  async swapForAccount(accountId: string, retireOld = false): Promise<never> {
    this.swaps.push({ accountId, retireOld });
    return undefined as never;
  }
}

function falha(failureClass: FailureClass): ProxyFailureInfo {
  return {
    accountId: "acc-1",
    jobId: "job-1",
    error: { failureClass, code: "PROXY_TRANSPORT", message: "ECONNRESET" },
  };
}

test("ProxyError conta strike no proxy dedicado da conta", async () => {
  const repo = new FakeRepo();
  const handler = createProxyFailureHandler({
    repo: repo as unknown as ProxyRepository,
    pool: poolCom("px-1"),
  });
  await handler(falha(FailureClass.ProxyError));
  assert.deepEqual(repo.failures, ["px-1"]);
});

test("outras classes de falha não mexem no pool", async () => {
  const repo = new FakeRepo();
  const handler = createProxyFailureHandler({
    repo: repo as unknown as ProxyRepository,
    pool: poolCom("px-1"),
  });
  await handler(falha(FailureClass.RateLimited));
  await handler(falha(FailureClass.PlatformOutage));
  await handler(falha(FailureClass.CheckpointRequired));
  assert.deepEqual(repo.failures, []);
});

test("sem troca automática configurada, o IP da conta não muda sozinho", async () => {
  const assignments = new FakeAssignments();
  const handler = createProxyFailureHandler({
    repo: new FakeRepo(99) as unknown as ProxyRepository,
    pool: poolCom("px-1"),
    assignments: assignments as unknown as ProxyAssignmentService,
    // swapAfterFailures ausente = 0 = desligado (default do v1)
  });
  await handler(falha(FailureClass.ProxyError));
  assert.deepEqual(assignments.swaps, []);
});

test("com limite configurado e atingido, troca e aposenta o proxy ruim", async () => {
  const assignments = new FakeAssignments();
  const handler = createProxyFailureHandler({
    repo: new FakeRepo(5) as unknown as ProxyRepository,
    pool: poolCom("px-1"),
    assignments: assignments as unknown as ProxyAssignmentService,
    swapAfterFailures: 5,
  });
  await handler(falha(FailureClass.ProxyError));
  assert.deepEqual(assignments.swaps, [{ accountId: "acc-1", retireOld: true }]);
});

test("abaixo do limite não troca", async () => {
  const assignments = new FakeAssignments();
  const handler = createProxyFailureHandler({
    repo: new FakeRepo(2) as unknown as ProxyRepository,
    pool: poolCom("px-1"),
    assignments: assignments as unknown as ProxyAssignmentService,
    swapAfterFailures: 5,
  });
  await handler(falha(FailureClass.ProxyError));
  assert.deepEqual(assignments.swaps, []);
});

test("conta sem proxy resolvido não quebra o handler", async () => {
  const repo = new FakeRepo();
  const handler = createProxyFailureHandler({
    repo: repo as unknown as ProxyRepository,
    pool: poolCom(null),
  });
  await handler(falha(FailureClass.ProxyError));
  assert.deepEqual(repo.failures, []);
});
