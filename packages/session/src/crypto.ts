/**
 * Criptografia do cofre: AES-256-GCM com keyring versionado.
 *
 * Decisões:
 *  - GCM (autenticado) e não CBC: um ciphertext adulterado falha na
 *    verificação em vez de decifrar em lixo silencioso.
 *  - AAD = `${id}:${kind}`: amarra o ciphertext à linha e ao tipo de segredo.
 *    Copiar o blob de uma linha para outra (ou trocar um token de conta por um
 *    secret de Meta App) deixa de decifrar.
 *  - Keyring com id por chave: rotacionar a chave ativa não exige reescrever
 *    todas as linhas de uma vez — as antigas seguem decifráveis pela chave que
 *    as cifrou, e a rotação varre em lotes limitados (regra 8).
 *  - A chave vive só no ambiente (SECRETS_KEYS), nunca no banco.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const SECRET_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Segredo cifrado, no formato em que é persistido. */
export interface EncryptedPayload {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

/** Monta o AAD que amarra o ciphertext à linha e ao tipo de segredo. */
export function secretAad(id: string, kind: string): string {
  return `${id}:${kind}`;
}

export class Keyring {
  private constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  /**
   * Constrói a partir de `SECRETS_KEYS` (`id:base64,id2:base64`, chave de 32
   * bytes) e `SECRETS_ACTIVE_KEY` (default: a última declarada). Retorna null
   * quando não há chave configurada — o chamador decide se isso é fatal (o
   * cofre é obrigatório em produção) ou se cai no modo de dev sem cofre.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Keyring | null {
    const raw = env.SECRETS_KEYS?.trim();
    if (!raw) return null;
    return Keyring.parse(raw, env.SECRETS_ACTIVE_KEY?.trim());
  }

  static parse(raw: string, activeKeyId?: string): Keyring {
    const keys = new Map<string, Buffer>();
    let last = "";
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf(":");
      if (sep <= 0) {
        throw new KeyringError(`entrada inválida em SECRETS_KEYS (esperado "id:base64")`);
      }
      const id = trimmed.slice(0, sep);
      const key = Buffer.from(trimmed.slice(sep + 1), "base64");
      if (key.length !== KEY_BYTES) {
        throw new KeyringError(`chave "${id}" tem ${key.length} bytes; esperado ${KEY_BYTES}`);
      }
      keys.set(id, key);
      last = id;
    }
    if (keys.size === 0) throw new KeyringError("SECRETS_KEYS não declarou nenhuma chave");
    const active = activeKeyId && activeKeyId.length > 0 ? activeKeyId : last;
    if (!keys.has(active)) {
      throw new KeyringError(`SECRETS_ACTIVE_KEY="${active}" não existe em SECRETS_KEYS`);
    }
    return new Keyring(keys, active);
  }

  /** Ids de todas as chaves conhecidas (a ativa inclusa). */
  keyIds(): readonly string[] {
    return [...this.keys.keys()];
  }

  private keyFor(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new KeyringError(`chave "${keyId}" não está no keyring — não é decifrável`);
    return key;
  }

  /** Cifra com a chave ativa. */
  encrypt(plaintext: string, aad: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(SECRET_ALGORITHM, this.keyFor(this.activeKeyId), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { keyId: this.activeKeyId, iv, authTag: cipher.getAuthTag(), ciphertext };
  }

  /** Decifra; lança se a chave sumiu do keyring ou se o blob foi adulterado. */
  decrypt(payload: EncryptedPayload, aad: string): string {
    const decipher = createDecipheriv(SECRET_ALGORITHM, this.keyFor(payload.keyId), payload.iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString("utf8");
  }

  /**
   * HMAC de propósito específico derivado da chave ativa (usado para assinar o
   * `state` do OAuth). A derivação por rótulo evita reusar a chave de cifra
   * crua para outra finalidade.
   */
  hmac(purpose: string, data: string): Buffer {
    const derived = createHmac("sha256", this.keyFor(this.activeKeyId))
      .update(`scaleapp:${purpose}`)
      .digest();
    return createHmac("sha256", derived).update(data).digest();
  }
}
