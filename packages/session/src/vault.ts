/**
 * Cofre de segredos sobre Postgres. Guarda token de acesso, senha de conta,
 * secret de Meta App e credencial de proxy cifrados em repouso (AES-256-GCM);
 * o resto do sistema só manuseia a referência `vault://<uuid>`.
 *
 * Ponto de design que importa para o refresh (regra 6): `replace` reescreve a
 * MESMA linha. Assim `accounts.access_token_ref` continua válido depois de um
 * refresh — o ponteiro é estável, só o conteúdo cifrado muda. Se cada refresh
 * criasse uma linha nova, toda rotação exigiria atualizar a conta em conjunto,
 * e uma falha no meio deixaria a conta apontando para um token velho.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Keyring, SECRET_ALGORITHM, secretAad, type EncryptedPayload } from "./crypto.js";

/** Pool ou client — permite operar dentro de uma transação externa. */
export type Executor = Pool | PoolClient;

export type SecretKind =
  | "account_access_token"
  | "account_password"
  | "meta_app_secret"
  | "proxy_credentials";

export const VAULT_SCHEME = "vault://";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVaultRef(ref: string): boolean {
  return parseVaultRef(ref) !== null;
}

/** Extrai o uuid de uma referência `vault://<uuid>`; null se não for uma. */
export function parseVaultRef(ref: string): string | null {
  if (!ref.startsWith(VAULT_SCHEME)) return null;
  const id = ref.slice(VAULT_SCHEME.length);
  return UUID_RE.test(id) ? id : null;
}

export function toVaultRef(id: string): string {
  return `${VAULT_SCHEME}${id}`;
}

/** Porta do cofre — quem consome não precisa saber que é Postgres. */
export interface SecretVault {
  put(kind: SecretKind, plaintext: string, executor?: Executor): Promise<string>;
  get(ref: string, executor?: Executor): Promise<string | null>;
  replace(ref: string, plaintext: string, executor?: Executor): Promise<boolean>;
  delete(ref: string, executor?: Executor): Promise<boolean>;
}

interface SecretRow {
  id: string;
  kind: SecretKind;
  key_id: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

export class PostgresSecretVault implements SecretVault {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: Keyring,
  ) {}

  /** Cifra e insere; devolve a referência estável para guardar no registry. */
  async put(kind: SecretKind, plaintext: string, executor: Executor = this.pool): Promise<string> {
    const id = randomUUID();
    const enc = this.keyring.encrypt(plaintext, secretAad(id, kind));
    await executor.query(
      `INSERT INTO secrets (id, kind, key_id, algorithm, iv, auth_tag, ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, kind, enc.keyId, SECRET_ALGORITHM, enc.iv, enc.authTag, enc.ciphertext],
    );
    return toVaultRef(id);
  }

  /** Decifra; null quando a referência não existe (ou não é `vault://`). */
  async get(ref: string, executor: Executor = this.pool): Promise<string | null> {
    const row = await this.load(ref, executor);
    if (!row) return null;
    return this.keyring.decrypt(payloadOf(row), secretAad(row.id, row.kind));
  }

  /**
   * Reescreve o conteúdo mantendo a referência (usado pelo refresh de token).
   * Recifra sempre com a chave ativa, então um refresh também traz a linha para
   * a chave corrente. Retorna false se a referência não existe.
   */
  async replace(ref: string, plaintext: string, executor: Executor = this.pool): Promise<boolean> {
    const id = parseVaultRef(ref);
    if (!id) return false;
    const existing = await this.load(ref, executor);
    if (!existing) return false;
    const enc = this.keyring.encrypt(plaintext, secretAad(id, existing.kind));
    const res = await executor.query<{ id: string }>(
      `UPDATE secrets
       SET key_id = $2, algorithm = $3, iv = $4, auth_tag = $5, ciphertext = $6,
           version = version + 1, rotated_at = now()
       WHERE id = $1
       RETURNING id`,
      [id, enc.keyId, SECRET_ALGORITHM, enc.iv, enc.authTag, enc.ciphertext],
    );
    return res.rows.length > 0;
  }

  async delete(ref: string, executor: Executor = this.pool): Promise<boolean> {
    const id = parseVaultRef(ref);
    if (!id) return false;
    const res = await executor.query<{ id: string }>(
      `DELETE FROM secrets WHERE id = $1 RETURNING id`,
      [id],
    );
    return res.rows.length > 0;
  }

  /**
   * Recifra um lote de segredos que ainda estão numa chave antiga para a chave
   * ativa. Lote explicitamente limitado (regra 8): rotação de chave em 500+
   * contas não pode virar uma varredura sem teto. Chame em loop até devolver 0.
   */
  async rotateToActiveKey(limit: number): Promise<number> {
    const stale = await this.pool.query<SecretRow>(
      `SELECT id, kind, key_id, iv, auth_tag, ciphertext
       FROM secrets
       WHERE key_id <> $1
       ORDER BY created_at
       LIMIT $2`,
      [this.keyring.activeKeyId, limit],
    );
    let rotated = 0;
    for (const row of stale.rows) {
      const plaintext = this.keyring.decrypt(payloadOf(row), secretAad(row.id, row.kind));
      const enc = this.keyring.encrypt(plaintext, secretAad(row.id, row.kind));
      await this.pool.query(
        `UPDATE secrets
         SET key_id = $2, iv = $3, auth_tag = $4, ciphertext = $5, rotated_at = now()
         WHERE id = $1 AND key_id = $6`,
        [row.id, enc.keyId, enc.iv, enc.authTag, enc.ciphertext, row.key_id],
      );
      rotated++;
    }
    return rotated;
  }

  private async load(ref: string, executor: Executor): Promise<SecretRow | null> {
    const id = parseVaultRef(ref);
    if (!id) return null;
    const res = await executor.query<SecretRow>(
      `SELECT id, kind, key_id, iv, auth_tag, ciphertext FROM secrets WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }
}

function payloadOf(row: SecretRow): EncryptedPayload {
  return { keyId: row.key_id, iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext };
}
