/**
 * Testes da criptografia do cofre: ida e volta, detecção de adulteração, o
 * papel do AAD (um blob não vale para outra linha/tipo) e rotação de chave.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Keyring, KeyringError, secretAad } from "../src/crypto.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function keyring(spec = `k1:${KEY_A}`, active?: string): Keyring {
  return Keyring.parse(spec, active);
}

test("cifra e decifra de volta o mesmo texto", () => {
  const kr = keyring();
  const aad = secretAad("11111111-1111-1111-1111-111111111111", "account_access_token");
  const enc = kr.encrypt("IGQVJ-token-secreto", aad);
  assert.notEqual(enc.ciphertext.toString("utf8"), "IGQVJ-token-secreto");
  assert.equal(kr.decrypt(enc, aad), "IGQVJ-token-secreto");
});

test("ciphertext adulterado não decifra em lixo — falha (GCM)", () => {
  const kr = keyring();
  const aad = secretAad("11111111-1111-1111-1111-111111111111", "account_access_token");
  const enc = kr.encrypt("token", aad);
  const tampered = Buffer.from(enc.ciphertext);
  tampered[0] = tampered[0]! ^ 0xff;
  assert.throws(() => kr.decrypt({ ...enc, ciphertext: tampered }, aad));
});

test("AAD amarra o segredo à linha e ao tipo: blob movido não decifra", () => {
  const kr = keyring();
  const enc = kr.encrypt("token", secretAad("id-a", "account_access_token"));
  // Mesma chave, outra linha.
  assert.throws(() => kr.decrypt(enc, secretAad("id-b", "account_access_token")));
  // Mesma linha, outro tipo de segredo.
  assert.throws(() => kr.decrypt(enc, secretAad("id-a", "meta_app_secret")));
});

test("rotação: chave nova cifra, chave antiga ainda decifra o que era dela", () => {
  const aad = secretAad("id-a", "account_access_token");
  const antes = keyring(`k1:${KEY_A}`);
  const enc = antes.encrypt("token-antigo", aad);

  // Keyring com as duas chaves e a nova como ativa.
  const depois = keyring(`k1:${KEY_A},k2:${KEY_B}`, "k2");
  assert.equal(depois.activeKeyId, "k2");
  assert.equal(depois.decrypt(enc, aad), "token-antigo");
  assert.equal(depois.encrypt("token-novo", aad).keyId, "k2");
});

test("chave ausente do keyring é erro explícito, não decifra errado", () => {
  const enc = keyring(`k1:${KEY_A}`).encrypt("token", secretAad("id-a", "account_access_token"));
  const semK1 = keyring(`k2:${KEY_B}`);
  assert.throws(
    () => semK1.decrypt(enc, secretAad("id-a", "account_access_token")),
    KeyringError,
  );
});

test("chave com tamanho errado é rejeitada no parse", () => {
  assert.throws(() => Keyring.parse(`k1:${randomBytes(16).toString("base64")}`), KeyringError);
  assert.throws(() => Keyring.parse("k1"), KeyringError);
  assert.throws(() => Keyring.parse(`k1:${KEY_A}`, "inexistente"), KeyringError);
});

test("fromEnv devolve null sem SECRETS_KEYS (modo sem cofre é decisão do caller)", () => {
  assert.equal(Keyring.fromEnv({} as NodeJS.ProcessEnv), null);
  const kr = Keyring.fromEnv({ SECRETS_KEYS: `k1:${KEY_A}` } as NodeJS.ProcessEnv);
  assert.ok(kr);
  assert.equal(kr.activeKeyId, "k1");
});

test("hmac separa propósitos: mesmo dado, rótulos diferentes, saídas diferentes", () => {
  const kr = keyring();
  assert.notEqual(
    kr.hmac("oauth-state", "abc").toString("hex"),
    kr.hmac("outra-coisa", "abc").toString("hex"),
  );
});
