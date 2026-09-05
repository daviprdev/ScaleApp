/**
 * Regra 3 em teste: checkpoint e token morto NÃO podem cair no mesmo caminho, e
 * outage de plataforma não pode marcar a conta como errada (regra 2).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DriverClass, DriverOperationKind, FailureClass } from "@scaleapp/domain";
import type { OperationError } from "@scaleapp/domain";
import type { OperationFailureInfo } from "@scaleapp/execution";
import { createSessionFailureHandler } from "../src/failureHandler.js";
import type { SessionRepository } from "../src/sessionRepository.js";

class FakeSessions {
  readonly calls: string[] = [];
  async markCheckpointRequired(id: string): Promise<void> {
    this.calls.push(`checkpoint:${id}`);
  }
  async markTokenDead(id: string): Promise<void> {
    this.calls.push(`token_dead:${id}`);
  }
  async registerRefreshFailure(id: string): Promise<void> {
    this.calls.push(`refresh_failure:${id}`);
  }
}

function failure(
  failureClass: FailureClass,
  kind: DriverOperationKind = DriverOperationKind.PublishMedia,
): OperationFailureInfo {
  const error: OperationError = {
    failureClass,
    code: "TEST",
    message: "teste",
    retryable: false,
    occurredAt: new Date().toISOString() as never,
  };
  return {
    accountId: "acc-1",
    jobId: "job-1",
    driverClass: DriverClass.GraphApi,
    operationKind: kind,
    error,
  };
}

function handler(sessions: FakeSessions) {
  return createSessionFailureHandler({ sessions: sessions as unknown as SessionRepository });
}

test("checkpoint marca checkpoint_required — a conta não é dada como morta", async () => {
  const sessions = new FakeSessions();
  await handler(sessions)(failure(FailureClass.CheckpointRequired));
  assert.deepEqual(sessions.calls, ["checkpoint:acc-1"]);
});

test("token morto marca token_dead — remediação diferente do checkpoint", async () => {
  const sessions = new FakeSessions();
  await handler(sessions)(failure(FailureClass.TokenDead));
  assert.deepEqual(sessions.calls, ["token_dead:acc-1"]);
});

test("outage/rate limit não mexem na conta (regra 2)", async () => {
  const sessions = new FakeSessions();
  const run = handler(sessions);
  await run(failure(FailureClass.PlatformOutage));
  await run(failure(FailureClass.RateLimited));
  await run(failure(FailureClass.Network));
  assert.deepEqual(sessions.calls, []);
});

test("falha de um job de refresh conta strike para espaçar a próxima tentativa", async () => {
  const sessions = new FakeSessions();
  await handler(sessions)(
    failure(FailureClass.PlatformOutage, DriverOperationKind.RefreshSession),
  );
  assert.deepEqual(sessions.calls, ["refresh_failure:acc-1"]);
});
