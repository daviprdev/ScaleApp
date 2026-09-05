/**
 * Laço da varredura de saúde do pool. Mesmo desenho da varredura de sessão:
 * substituto mínimo do Scheduler (módulo 7), sem rodar concorrente consigo
 * mesma — se uma varredura demora mais que o intervalo, a próxima é pulada em
 * vez de empilhar sondas.
 */

import type { Pool } from "pg";
import type { ProxyConfig } from "./config.js";
import { runHealthSweep, type HealthSweepResult } from "./healthChecker.js";
import type { HttpProbe } from "./ports.js";
import { ProxyRepository } from "./proxyRepository.js";
import type { ProxyResolverPort } from "./resolver.js";

export interface ProxySweepOptions {
  readonly pool: Pool;
  readonly resolver: ProxyResolverPort;
  readonly probe: HttpProbe;
  readonly config: ProxyConfig;
  readonly onSweep?: (
    result: HealthSweepResult & { readonly available: number; readonly lowPool: boolean },
  ) => void;
  readonly onError?: (err: unknown) => void;
}

export interface ProxySweepHandle {
  runNow(): Promise<void>;
  stop(): void;
}

export function startProxyHealthSweep(opts: ProxySweepOptions): ProxySweepHandle {
  const repo = new ProxyRepository(opts.pool);
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runHealthSweep({
        repo,
        resolver: opts.resolver,
        probe: opts.probe,
        config: opts.config.health,
        limit: opts.config.sweepLimit,
        staleAfterMs: opts.config.staleAfterMs,
        cycleIntervalMs: opts.config.sweepIntervalMs,
      });
      // Pool vazio não dá erro em lugar nenhum até uma conta nova precisar de
      // proxy e o cadastro falhar. Reportar antes é o ponto.
      const available = await repo.availableCount();
      opts.onSweep?.({
        ...result,
        available,
        lowPool: available < opts.config.lowPoolThreshold,
      });
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.config.sweepIntervalMs);
  timer.unref?.();

  return {
    runNow: tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
