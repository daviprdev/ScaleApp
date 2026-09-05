/**
 * Testes do resolver do pool. O ponto central é a regra 10: ou sai pelo proxy
 * dedicado e vivo, ou não sai — nunca há caminho alternativo sem proxy.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { PoolProxyResolver, buildProxyUrl } from "../src/resolver.js";
import type { SecretReader } from "../src/ports.js";

interface Row {
  protocol: string;
  host: string;
  port: number;
  credentials_ref: string | null;
  assignment_state: string;
  health: string;
}

class FakePool {
  queries = 0;
  constructor(private readonly rows: Record<string, Row>) {}
  async query<R>(_text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
    this.queries++;
    const row = this.rows[params[0] as string];
    return { rows: (row ? [row] : []) as unknown as R[] };
  }
}

const cofre = (map: Record<string, string>): SecretReader => ({
  async get(ref) {
    return map[ref] ?? null;
  },
});

function row(over: Partial<Row> = {}): Row {
  return {
    protocol: "http",
    host: "proxy.test",
    port: 8080,
    credentials_ref: "vault://cred",
    assignment_state: "assigned",
    health: "healthy",
    ...over,
  };
}

test("monta a URL com a credencial decifrada do cofre", async () => {
  const r = new PoolProxyResolver(
    new FakePool({ p1: row() }) as unknown as Pool,
    cofre({ "vault://cred": "usuario:senha" }),
  );
  assert.deepEqual(await r.resolveProxy("p1"), { url: "http://usuario:senha@proxy.test:8080" });
});

test("proxy sem credencial resolve sem autenticação", async () => {
  const r = new PoolProxyResolver(
    new FakePool({ p1: row({ credentials_ref: null }) }) as unknown as Pool,
    cofre({}),
  );
  assert.deepEqual(await r.resolveProxy("p1"), { url: "http://proxy.test:8080" });
});

test("credencial com caracteres especiais é escapada", () => {
  assert.equal(
    buildProxyUrl("http", "h", 1, "user@corp:p@ss/word"),
    "http://user%40corp:p%40ss%2Fword@h:1",
  );
  assert.equal(buildProxyUrl("socks5", "h", 1, "token-sem-senha"), "socks5://token-sem-senha:@h:1");
});

test("proxy down não resolve — melhor falhar que mandar tráfego por IP morto", async () => {
  const r = new PoolProxyResolver(
    new FakePool({ p1: row({ health: "down" }) }) as unknown as Pool,
    cofre({ "vault://cred": "u:p" }),
  );
  assert.equal(await r.resolveProxy("p1"), null);
});

test("proxy aposentado não resolve", async () => {
  const r = new PoolProxyResolver(
    new FakePool({ p1: row({ assignment_state: "retired" }) }) as unknown as Pool,
    cofre({ "vault://cred": "u:p" }),
  );
  assert.equal(await r.resolveProxy("p1"), null);
});

test("referência de credencial órfã no cofre não vira saída sem auth", async () => {
  const r = new PoolProxyResolver(
    new FakePool({ p1: row() }) as unknown as Pool,
    cofre({}), // o vault:// não existe
  );
  assert.equal(await r.resolveProxy("p1"), null);
});

test("proxy inexistente devolve null", async () => {
  const r = new PoolProxyResolver(new FakePool({}) as unknown as Pool, cofre({}));
  assert.equal(await r.resolveProxy("fantasma"), null);
});

test("cache evita reconsultar o banco, e invalidate derruba o cache", async () => {
  const pool = new FakePool({ p1: row() });
  const r = new PoolProxyResolver(pool as unknown as Pool, cofre({ "vault://cred": "u:p" }), {
    cacheTtlMs: 60_000,
  });

  await r.resolveProxy("p1");
  await r.resolveProxy("p1");
  assert.equal(pool.queries, 1, "segunda resolução deveria vir do cache");

  r.invalidate("p1");
  await r.resolveProxy("p1");
  assert.equal(pool.queries, 2);
});

test("com TTL 0 o cache fica desligado", async () => {
  const pool = new FakePool({ p1: row() });
  const r = new PoolProxyResolver(pool as unknown as Pool, cofre({ "vault://cred": "u:p" }), {
    cacheTtlMs: 0,
  });
  await r.resolveProxy("p1");
  await r.resolveProxy("p1");
  assert.equal(pool.queries, 2);
});
