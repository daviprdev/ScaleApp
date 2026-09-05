/**
 * Testes do cofre contra um Postgres fake (as queries são interceptadas por
 * substring do SQL). Interessa aqui: o que vai para o banco está cifrado, a
 * referência é estável através do `replace` (que o refresh usa), e a rotação de
 * chave é limitada e converge.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { Keyring } from "../src/crypto.js";
import { PostgresSecretVault, isVaultRef, parseVaultRef } from "../src/vault.js";

interface Row {
  id: string;
  kind: string;
  key_id: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  created_at: number;
}

/** Postgres fake com a tabela `secrets` em memória. */
class FakePool {
  readonly rows = new Map<string, Row>();
  private seq = 0;

  async query<R>(text: string, params: readonly unknown[] = []): Promise<{ rows: R[] }> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO secrets")) {
      const [id, kind, keyId, , iv, authTag, ciphertext] = params as [
        string, string, string, string, Buffer, Buffer, Buffer,
      ];
      this.rows.set(id, {
        id, kind, key_id: keyId, iv, auth_tag: authTag, ciphertext, created_at: this.seq++,
      });
      return { rows: [] as R[] };
    }

    if (sql.startsWith("SELECT id, kind, key_id")) {
      if (sql.includes("WHERE key_id <> $1")) {
        const [activeKeyId, limit] = params as [string, number];
        const stale = [...this.rows.values()]
          .filter((r) => r.key_id !== activeKeyId)
          .sort((a, b) => a.created_at - b.created_at)
          .slice(0, limit);
        return { rows: stale as unknown as R[] };
      }
      const row = this.rows.get(params[0] as string);
      return { rows: (row ? [row] : []) as unknown as R[] };
    }

    if (sql.startsWith("UPDATE secrets")) {
      const [id, keyId, ...rest] = params as [string, string, ...unknown[]];
      const row = this.rows.get(id);
      if (!row) return { rows: [] as R[] };
      // A query de replace tem `algorithm` no $3; a de rotação não.
      const [iv, authTag, ciphertext] = (
        sql.includes("algorithm = $3") ? rest.slice(1) : rest
      ) as [Buffer, Buffer, Buffer];
      this.rows.set(id, { ...row, key_id: keyId, iv, auth_tag: authTag, ciphertext });
      return { rows: [{ id }] as unknown as R[] };
    }

    if (sql.startsWith("DELETE FROM secrets")) {
      const id = params[0] as string;
      const existed = this.rows.delete(id);
      return { rows: (existed ? [{ id }] : []) as unknown as R[] };
    }

    throw new Error(`SQL não previsto no fake: ${sql}`);
  }
}

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function makeVault(spec = `k1:${KEY_A}`, active?: string): { vault: PostgresSecretVault; pool: FakePool } {
  const pool = new FakePool();
  const vault = new PostgresSecretVault(pool as unknown as Pool, Keyring.parse(spec, active));
  return { vault, pool };
}

test("put grava cifrado e get devolve o texto claro", async () => {
  const { vault, pool } = makeVault();
  const ref = await vault.put("account_access_token", "IGQVJ-token");

  assert.ok(isVaultRef(ref), `esperava uma referência vault://, veio ${ref}`);
  const stored = [...pool.rows.values()][0]!;
  // O que está no banco não pode conter o segredo.
  assert.ok(!stored.ciphertext.toString("utf8").includes("IGQVJ"));
  assert.equal(await vault.get(ref), "IGQVJ-token");
});

test("replace mantém a MESMA referência (o refresh depende disso)", async () => {
  const { vault, pool } = makeVault();
  const ref = await vault.put("account_access_token", "token-1");
  const idAntes = parseVaultRef(ref);

  assert.equal(await vault.replace(ref, "token-2"), true);
  assert.equal(await vault.get(ref), "token-2");
  assert.equal(parseVaultRef(ref), idAntes);
  assert.equal(pool.rows.size, 1, "replace não pode criar linha nova");
});

test("referência inexistente ou malformada devolve null/false, não lança", async () => {
  const { vault } = makeVault();
  assert.equal(await vault.get("vault://11111111-1111-1111-1111-111111111111"), null);
  assert.equal(await vault.get("token-em-texto-puro"), null);
  assert.equal(await vault.replace("vault://nao-e-uuid", "x"), false);
  assert.equal(await vault.delete("vault://11111111-1111-1111-1111-111111111111"), false);
});

test("delete remove e o segredo some", async () => {
  const { vault } = makeVault();
  const ref = await vault.put("meta_app_secret", "app-secret");
  assert.equal(await vault.delete(ref), true);
  assert.equal(await vault.get(ref), null);
});

test("rotação de chave é limitada por lote e converge", async () => {
  const { vault, pool } = makeVault();
  const refs = [];
  for (let i = 0; i < 5; i++) refs.push(await vault.put("account_access_token", `token-${i}`));

  // Novo keyring: k1 ainda conhecida (para decifrar), k2 ativa.
  const rotativo = new PostgresSecretVault(
    pool as unknown as Pool,
    Keyring.parse(`k1:${KEY_A},k2:${KEY_B}`, "k2"),
  );

  assert.equal(await rotativo.rotateToActiveKey(2), 2);
  assert.equal(await rotativo.rotateToActiveKey(2), 2);
  assert.equal(await rotativo.rotateToActiveKey(2), 1);
  assert.equal(await rotativo.rotateToActiveKey(2), 0);

  assert.ok([...pool.rows.values()].every((r) => r.key_id === "k2"));
  for (const [i, ref] of refs.entries()) {
    assert.equal(await rotativo.get(ref), `token-${i}`);
  }
});
