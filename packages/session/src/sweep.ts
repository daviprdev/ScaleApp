/**
 * Laço da varredura de refresh preventivo. É um substituto mínimo do Scheduler
 * (módulo 7, ainda não construído): quando ele existir, o disparo passa a vir
 * de lá e este laço some — a lógica de planejamento (`planPreventiveRefresh`)
 * fica igual.
 *
 * Não roda varreduras concorrentes consigo mesma: se uma demora mais que o
 * intervalo, a próxima é pulada em vez de empilhar (é assim que uma varredura
 * lenta vira thundering herd).
 */

import type { Pool } from "pg";
import type { JobProducer } from "@scaleapp/execution";
import type { SessionConfig } from "./config.js";
import { planPreventiveRefresh, type PlanRefreshResult } from "./refreshPlanner.js";
import { SessionRepository } from "./sessionRepository.js";

export interface SessionSweepOptions {
  readonly pool: Pool;
  readonly producer: JobProducer;
  readonly config: SessionConfig;
  readonly onSweep?: (result: PlanRefreshResult & { readonly reconciled: number }) => void;
  readonly onError?: (err: unknown) => void;
}

export interface SessionSweepHandle {
  /** Executa uma varredura imediatamente (usado no boot e nos testes). */
  runNow(): Promise<void>;
  stop(): void;
}

export function startSessionRefreshSweep(opts: SessionSweepOptions): SessionSweepHandle {
  const { pool, producer, config } = opts;
  const sessions = new SessionRepository(pool);
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      // Reconciliar antes de planejar: a seleção de candidatos filtra por
      // `session_status`, então um status defasado esconderia contas elegíveis.
      const reconciled = await sessions.reconcileStatuses(
        config.expiringWindowMs,
        config.sweepLimit,
      );
      const result = await planPreventiveRefresh({
        pool,
        producer,
        limit: config.sweepLimit,
        withinMs: config.refreshWithinMs,
        cycleIntervalMs: config.sweepIntervalMs,
        minRetryIntervalMs: config.minRetryIntervalMs,
        maxFailures: config.maxFailures,
      });
      opts.onSweep?.({ ...result, reconciled });
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.sweepIntervalMs);
  // Não segura o processo vivo só por causa da varredura.
  timer.unref?.();

  return {
    runNow: tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
