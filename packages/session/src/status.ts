/**
 * Derivação pura do estado de sessão. Fica separada do repositório porque é a
 * regra que decide QUANDO o refresh preventivo acontece (regra 6) — e regra que
 * decide isso merece ser testável sem banco.
 */

import { SessionStatus } from "@scaleapp/domain";

/**
 * `Expiring` não é falha: é o sinal de "refresque agora, antes do erro". A
 * janela precisa ser maior que o intervalo da varredura, senão a conta pula de
 * `valid` direto para `expired` entre duas varreduras e o refresh vira reativo.
 */
export function computeSessionStatus(
  expiresAt: string | null | undefined,
  expiringWindowMs: number,
  now: number = Date.now(),
): SessionStatus {
  if (!expiresAt) return SessionStatus.Expired;
  const remainingMs = Date.parse(expiresAt) - now;
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return SessionStatus.Expired;
  return remainingMs <= expiringWindowMs ? SessionStatus.Expiring : SessionStatus.Valid;
}

/**
 * Atraso inicial de cada conta do lote (regra 5). O teto é o próprio intervalo
 * do ciclo, nunca mais: um stagger que ultrapassa a janela do ciclo faz a conta
 * "pular" o ciclo e dobra o intervalo efetivo — foi exatamente esse o bug do
 * projeto anterior. Distribui de forma determinística por índice e some um
 * jitter pequeno para não despachar tudo no mesmo milissegundo (thundering
 * herd → rate-limit em cascata).
 */
export function staggerDelayMs(
  index: number,
  batchSize: number,
  cycleIntervalMs: number,
  random: () => number = Math.random,
): number {
  if (batchSize <= 1 || cycleIntervalMs <= 0) return 0;
  // Teto = 90% do ciclo: deixa folga para o job ser processado dentro da janela.
  const ceiling = cycleIntervalMs * 0.9;
  const slot = ceiling / batchSize;
  const jitter = random() * slot;
  return Math.min(Math.round(index * slot + jitter), Math.round(ceiling));
}
