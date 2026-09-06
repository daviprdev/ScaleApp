/**
 * Guarda de fiação: o pipeline NÃO pode voltar a resolver mídia pelo stub de
 * desenvolvimento. É um teste sobre o composition root porque é lá que a
 * escolha acontece — e uma regressão aqui não quebraria nenhum outro teste,
 * só faria o driver aceitar qualquer string como URL de mídia de novo.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const composition = await readFile(join(HERE, "..", "src", "index.ts"), "utf8");

test("o worker resolve mídia pela biblioteca real", () => {
  assert.match(composition, /from "@scaleapp\/media"/);
  assert.match(composition, /new LibraryMediaResolver\(/);
});

test("o worker não usa mais o UrlMediaResolver de desenvolvimento", () => {
  assert.doesNotMatch(
    composition,
    /UrlMediaResolver/,
    "o stub de mídia voltou ao composition root do worker",
  );
});

test("o worker também não usa mais o resolver de proxy de desenvolvimento", () => {
  assert.doesNotMatch(composition, /DbAccountProxyResolver/);
  assert.match(composition, /new PoolProxyResolver\(/);
});
