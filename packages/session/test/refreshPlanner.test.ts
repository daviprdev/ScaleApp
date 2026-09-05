/**
 * Testes da varredura de refresh preventivo contra um Postgres fake. O que
 * importa verificar aqui são as três garantias do planejador: teto do lote
 * (regra 8), um job por sessão mesmo com varreduras repetidas (regra 9) e
 * despacho escalonado dentro do ciclo (regra 5).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { DriverOperationKind } from "@scaleapp/domain";
import type { EnqueueInput, JobProducer } from "@scaleapp/execution";
import { planPreventiveRefresh, refreshIdempotencyKey } from "../src/refreshPlanner.js";

interface AccountFixture {
  id: string;
  handle: string;
  expiresAt: string;
  attemptedAt: string | null;
}

/** Postgres fake: só as queries que o planejador emite. */
class FakePool {
  readonly accounts: AccountFixture[];
  readonly jobsByKey = new Map<string, { id: string; execution_id: string }>();
  readonly executions = new Set<string>();
  readonly attemptedMarks: string[] = [];
  private seq = 0;

  constructor(accounts: AccountFixture[]) {
    this.accounts = accounts;
  }

  async query<R>(text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT id, handle, access_token_ref")) {
      const limit = params[3] as number;
      const rows = this.accounts.slice(0, limit).map((a) => ({
        id: a.id,
        handle: a.handle,
        access_token_ref: `vault://${a.id}`,
        session_expires_at: new Date(a.expiresAt),
        session_refresh_failures: 0,
      }));
      return { rows: rows as unknown as R[] };
    }

    if (sql.startsWith("INSERT INTO job_executions")) {
      const id = `exec-${this.seq++}`;
      this.executions.add(id);
      return { rows: [{ id }] as unknown as R[] };
    }

    if (sql.startsWith("INSERT INTO jobs")) {
      const [key, executionId, , , accountId] = params as [string, string, string, string, string];
      if (this.jobsByKey.has(key)) return { rows: [] as R[] };
      const row = jobRow(`job-${this.seq++}`, key, executionId, accountId);
      this.jobsByKey.set(key, { id: row.id, execution_id: executionId });
      return { rows: [row] as unknown as R[] };
    }

    if (sql.includes("FROM jobs WHERE idempotency_key")) {
      const key = params[0] as string;
      const existing = this.jobsByKey.get(key)!;
      return { rows: [jobRow(existing.id, key, existing.execution_id, "acc")] as unknown as R[] };
    }

    if (sql.startsWith("UPDATE accounts SET session_refresh_attempted_at")) {
      this.attemptedMarks.push(params[0] as string);
      return { rows: [] as R[] };
    }

    if (sql.startsWith("DELETE FROM job_executions")) {
      const id = params[0] as string;
      const temJob = [...this.jobsByKey.values()].some((j) => j.execution_id === id);
      if (!temJob) this.executions.delete(id);
      return { rows: [] as R[] };
    }

    throw new Error(`SQL não previsto no fake: ${sql}`);
  }

  /** `ExecutionRepository.recompute` roda numa transação. */
  async connect(): Promise<{ query: FakePool["query"]; release: () => void }> {
    const self = this;
    return {
      async query<R>(text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
        const sql = text.replace(/\s+/g, " ").trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] as R[] };
        if (sql.startsWith("SELECT id FROM job_executions")) return { rows: [] as R[] };
        if (sql.startsWith("SELECT status, count")) return { rows: [] as R[] };
        if (sql.startsWith("UPDATE job_executions")) return { rows: [] as R[] };
        return self.query<R>(text, params);
      },
      release: () => {},
    };
  }
}

function jobRow(id: string, key: string, executionId: string, accountId: string) {
  return {
    id,
    idempotency_key: key,
    execution_id: executionId,
    pipeline_id: "pipe",
    step_id: "refresh",
    account_id: accountId,
    driver_class: "graph_api",
    operation_kind: "refresh_session",
    payload: {},
    status: "pending",
    attempts: 0,
    max_attempts: 3,
    priority: 500,
    result: null,
    last_error: null,
  };
}

class FakeProducer {
  readonly enqueued: EnqueueInput[] = [];
  async enqueue(input: EnqueueInput): Promise<void> {
    this.enqueued.push(input);
  }
  async close(): Promise<void> {}
}

const CYCLE = 15 * 60_000;

function accounts(n: number): AccountFixture[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `acc-${i}`,
    handle: `conta${i}`,
    expiresAt: new Date(Date.now() + (2 + i) * 24 * 60 * 60 * 1000).toISOString(),
    attemptedAt: null,
  }));
}

function plan(pool: FakePool, producer: FakeProducer, limit = 100) {
  return planPreventiveRefresh({
    pool: pool as unknown as Pool,
    producer: producer as unknown as JobProducer,
    limit,
    withinMs: 7 * 24 * 60 * 60 * 1000,
    cycleIntervalMs: CYCLE,
  });
}

test("enfileira um refresh por conta elegível e marca a tentativa", async () => {
  const pool = new FakePool(accounts(3));
  const producer = new FakeProducer();

  const res = await plan(pool, producer);

  assert.deepEqual(
    { candidates: res.candidates, enqueued: res.enqueued, skipped: res.skipped },
    { candidates: 3, enqueued: 3, skipped: 0 },
  );
  assert.equal(producer.enqueued.length, 3);
  assert.ok(producer.enqueued.every((e) => e.operationKind === DriverOperationKind.RefreshSession));
  // Sem a marcação, a próxima varredura reavaliaria as mesmas contas.
  assert.deepEqual(pool.attemptedMarks.sort(), ["acc-0", "acc-1", "acc-2"]);
});

test("varredura repetida sobre a mesma sessão não duplica job (regra 9)", async () => {
  const pool = new FakePool(accounts(3));
  const producer = new FakeProducer();

  await plan(pool, producer);
  const segunda = await plan(pool, producer);

  assert.deepEqual(
    { enqueued: segunda.enqueued, skipped: segunda.skipped },
    { enqueued: 0, skipped: 3 },
  );
  assert.equal(producer.enqueued.length, 3, "nada novo deveria ir para a fila");
  // Execução vazia não fica presa em `pending` no painel.
  assert.equal(pool.executions.size, 1);
  assert.equal(segunda.executionId, undefined);
});

test("uma expiração nova gera chave nova — a conta volta a ser refrescável", () => {
  const base = { accountId: "acc-1", handle: "c", accessTokenRef: "vault://x", failures: 0 };
  const antes = refreshIdempotencyKey({ ...base, expiresAt: "2026-03-01T00:00:00.000Z" });
  const depois = refreshIdempotencyKey({ ...base, expiresAt: "2026-05-01T00:00:00.000Z" });
  assert.notEqual(antes, depois);
  // Mesma sessão ⇒ mesma chave, sempre.
  assert.equal(antes, refreshIdempotencyKey({ ...base, expiresAt: "2026-03-01T00:00:00.000Z" }));
});

test("o lote respeita o teto e o despacho é escalonado dentro do ciclo", async () => {
  const pool = new FakePool(accounts(50));
  const producer = new FakeProducer();

  const res = await plan(pool, producer, 10);

  assert.equal(res.candidates, 10, "o teto do lote tem que ser respeitado (regra 8)");
  const delays = producer.enqueued.map((e) => e.delayMs ?? 0);
  assert.ok(delays.every((d) => d <= CYCLE), "nenhum atraso pode passar do ciclo (regra 5)");
  assert.ok(new Set(delays).size > 1, "o lote não pode sair todo no mesmo instante");
});

test("sem contas elegíveis, não cria execução nem toca na fila", async () => {
  const pool = new FakePool([]);
  const producer = new FakeProducer();

  const res = await plan(pool, producer);

  assert.deepEqual(res, { candidates: 0, enqueued: 0, skipped: 0 });
  assert.equal(pool.executions.size, 0);
  assert.equal(producer.enqueued.length, 0);
});
