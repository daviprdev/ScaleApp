/**
 * Testes das regras puras: quando a sessão entra em `expiring` (regra 6) e o
 * teto do stagger (regra 5).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionStatus } from "@scaleapp/domain";
import { computeSessionStatus, staggerDelayMs } from "../src/status.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

function inDays(days: number): string {
  return new Date(NOW + days * DAY).toISOString();
}

test("sessão longe da expiração é valid", () => {
  assert.equal(computeSessionStatus(inDays(30), WINDOW, NOW), SessionStatus.Valid);
});

test("dentro da janela vira expiring — sinal de refrescar ANTES do erro", () => {
  assert.equal(computeSessionStatus(inDays(3), WINDOW, NOW), SessionStatus.Expiring);
  // A borda exata da janela já conta como expiring.
  assert.equal(computeSessionStatus(inDays(7), WINDOW, NOW), SessionStatus.Expiring);
});

test("expirada, sem data ou data ilegível → expired", () => {
  assert.equal(computeSessionStatus(inDays(-1), WINDOW, NOW), SessionStatus.Expired);
  assert.equal(computeSessionStatus(null, WINDOW, NOW), SessionStatus.Expired);
  assert.equal(computeSessionStatus("nem-data", WINDOW, NOW), SessionStatus.Expired);
});

test("stagger nunca ultrapassa o ciclo (regra 5: sem pulo de ciclo)", () => {
  const cycle = 15 * 60_000;
  const batch = 200;
  for (let i = 0; i < batch; i++) {
    const delay = staggerDelayMs(i, batch, cycle, () => 0.999);
    assert.ok(delay <= cycle, `atraso ${delay} passou do ciclo ${cycle}`);
    assert.ok(delay <= cycle * 0.9 + 1, `atraso ${delay} estourou o teto de 90% do ciclo`);
  }
});

test("stagger espalha o lote em vez de despachar tudo junto", () => {
  const cycle = 600_000;
  const delays = Array.from({ length: 50 }, (_, i) => staggerDelayMs(i, 50, cycle, () => 0.5));
  const distintos = new Set(delays).size;
  assert.ok(distintos > 40, `esperava atrasos espalhados, vieram ${distintos} valores distintos`);
  // Crescente: a conta 0 sai primeiro, a última por último.
  assert.ok(delays[0]! < delays[49]!);
});

test("lote de um só, ou ciclo zerado, não atrasa nada", () => {
  assert.equal(staggerDelayMs(0, 1, 600_000), 0);
  assert.equal(staggerDelayMs(3, 10, 0), 0);
});
