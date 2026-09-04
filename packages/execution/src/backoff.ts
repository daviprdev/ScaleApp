/**
 * Traduz o `RetryPolicy` do domínio para um atraso de backoff, respeitando
 * estratégia (fixa/exponencial), atraso base e teto (`maxDelayMs`). Usado como
 * estratégia customizada de backoff do worker BullMQ.
 */

import { BackoffStrategy, type RetryPolicy } from "@scaleapp/domain";

/**
 * @param retryPolicy política do job
 * @param attemptsMade tentativas já feitas (BullMQ passa o valor já incrementado)
 * @returns atraso em ms antes da próxima tentativa
 */
export function computeBackoff(retryPolicy: RetryPolicy, attemptsMade: number): number {
  const base = retryPolicy.baseDelayMs;
  const exponent = Math.max(0, attemptsMade - 1);
  let delay =
    retryPolicy.backoff === BackoffStrategy.Exponential
      ? base * 2 ** exponent
      : base;
  if (retryPolicy.maxDelayMs !== undefined) {
    delay = Math.min(delay, retryPolicy.maxDelayMs);
  }
  return delay;
}
