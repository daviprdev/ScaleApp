/**
 * `state` do OAuth: carrega qual conta está sendo autorizada e prova que o
 * callback veio de um fluxo que nós iniciamos.
 *
 * É assinado (HMAC derivado da chave ativa do cofre) e tem validade curta, em
 * vez de guardado numa tabela: sem estado no banco não há linha órfã de fluxo
 * abandonado, e um `state` forjado não passa na verificação. A comparação da
 * assinatura é em tempo constante.
 *
 * Consequência de usar a chave ativa: rotacionar a chave invalida os `state`
 * em voo. São segundos de vida — aceitável, e o usuário só refaz o clique.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "./crypto.js";

const PURPOSE = "oauth-state";
const DEFAULT_TTL_MS = 10 * 60_000;

export interface OAuthStateClaims {
  readonly accountId: string;
  /** Nonce: dois fluxos para a mesma conta não geram o mesmo `state`. */
  readonly nonce: string;
  readonly expiresAtMs: number;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

export function signOAuthState(
  keyring: Keyring,
  accountId: string,
  options: { readonly ttlMs?: number; readonly nonce?: string; readonly now?: number } = {},
): string {
  const claims: OAuthStateClaims = {
    accountId,
    nonce: options.nonce ?? b64url(randomBytes(9)),
    expiresAtMs: (options.now ?? Date.now()) + (options.ttlMs ?? DEFAULT_TTL_MS),
  };
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(keyring.hmac(PURPOSE, body));
  return `${body}.${sig}`;
}

/** Verifica assinatura e validade; lança `OAuthStateError` se algo não bate. */
export function verifyOAuthState(
  keyring: Keyring,
  state: string,
  now: number = Date.now(),
): OAuthStateClaims {
  const dot = state.lastIndexOf(".");
  if (dot <= 0) throw new OAuthStateError("state malformado");
  const body = state.slice(0, dot);
  const sig = Buffer.from(state.slice(dot + 1), "base64url");
  const expected = keyring.hmac(PURPOSE, body);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new OAuthStateError("assinatura do state inválida");
  }

  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStateClaims;
  } catch {
    throw new OAuthStateError("conteúdo do state ilegível");
  }
  if (typeof claims.accountId !== "string" || typeof claims.expiresAtMs !== "number") {
    throw new OAuthStateError("state sem os campos esperados");
  }
  if (claims.expiresAtMs <= now) throw new OAuthStateError("state expirado");
  return claims;
}
