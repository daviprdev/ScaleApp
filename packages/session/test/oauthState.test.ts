/**
 * Testes do `state` do OAuth: ele é o que amarra o callback à conta certa, então
 * forjar, adulterar ou reaproveitar um antigo tem que falhar.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Keyring } from "../src/crypto.js";
import { OAuthStateError, signOAuthState, verifyOAuthState } from "../src/oauthState.js";

const kr = Keyring.parse(`k1:${randomBytes(32).toString("base64")}`);
const outroKr = Keyring.parse(`k1:${randomBytes(32).toString("base64")}`);
const ACCOUNT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

test("assina e verifica, devolvendo a conta", () => {
  const state = signOAuthState(kr, ACCOUNT);
  assert.equal(verifyOAuthState(kr, state).accountId, ACCOUNT);
});

test("dois fluxos para a mesma conta geram states diferentes (nonce)", () => {
  assert.notEqual(signOAuthState(kr, ACCOUNT), signOAuthState(kr, ACCOUNT));
});

test("state assinado com outra chave é rejeitado", () => {
  const state = signOAuthState(outroKr, ACCOUNT);
  assert.throws(() => verifyOAuthState(kr, state), OAuthStateError);
});

test("trocar a conta dentro do state invalida a assinatura", () => {
  const state = signOAuthState(kr, ACCOUNT);
  const [body, sig] = state.split(".") as [string, string];
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  claims.accountId = "00000000-0000-0000-0000-000000000000";
  const forjado = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  assert.throws(() => verifyOAuthState(kr, forjado), OAuthStateError);
});

test("state expirado é rejeitado", () => {
  const now = Date.now();
  const state = signOAuthState(kr, ACCOUNT, { ttlMs: 1_000, now });
  assert.equal(verifyOAuthState(kr, state, now + 500).accountId, ACCOUNT);
  assert.throws(() => verifyOAuthState(kr, state, now + 1_500), OAuthStateError);
});

test("state malformado não derruba o handler", () => {
  assert.throws(() => verifyOAuthState(kr, "lixo"), OAuthStateError);
  assert.throws(() => verifyOAuthState(kr, ""), OAuthStateError);
  assert.throws(() => verifyOAuthState(kr, `naoEhJson.${"a".repeat(43)}`), OAuthStateError);
});
