/**
 * Configuração do Proxy/Network Manager. Defaults conservadores: a varredura
 * fica desligada até alguém ligar, e a troca automática de proxy também — em
 * v1 é preferível alertar e decidir do que a conta trocar de IP sozinha.
 */

import { DEFAULT_HEALTH_CONFIG, type HealthCheckConfig } from "./healthChecker.js";

export interface ProxyConfig {
  readonly health: HealthCheckConfig;
  /** Intervalo entre varreduras — teto do espaçamento das sondas (regra 5). */
  readonly sweepIntervalMs: number;
  /** Teto de proxies por varredura (regra 8). */
  readonly sweepLimit: number;
  /** Idade a partir da qual a checagem de um proxy é considerada velha. */
  readonly staleAfterMs: number;
  readonly sweepEnabled: boolean;
  /** TTL do cache de URL resolvida no worker. */
  readonly resolverCacheTtlMs: number;
  /** Falhas seguidas para troca automática de proxy. 0 = desligado. */
  readonly swapAfterFailures: number;
  /** Abaixo disto, o pool está perto de acabar e alguém precisa saber. */
  readonly lowPoolThreshold: number;
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  health: DEFAULT_HEALTH_CONFIG,
  sweepIntervalMs: 10 * 60_000,
  sweepLimit: 100,
  staleAfterMs: 30 * 60_000,
  sweepEnabled: false,
  resolverCacheTtlMs: 60_000,
  swapAfterFailures: 0,
  lowPoolThreshold: 5,
};

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const d = DEFAULT_PROXY_CONFIG;
  return {
    health: {
      probeUrl: env.PROXY_PROBE_URL ?? d.health.probeUrl,
      timeoutMs: num(env.PROXY_PROBE_TIMEOUT_MS, d.health.timeoutMs),
      downAfterFailures: num(env.PROXY_DOWN_AFTER_FAILURES, d.health.downAfterFailures),
      outageRatio: num(env.PROXY_OUTAGE_RATIO, d.health.outageRatio),
      outageMinCount: num(env.PROXY_OUTAGE_MIN_COUNT, d.health.outageMinCount),
    },
    sweepIntervalMs: num(env.PROXY_SWEEP_INTERVAL_MS, d.sweepIntervalMs),
    sweepLimit: num(env.PROXY_SWEEP_LIMIT, d.sweepLimit),
    staleAfterMs: num(env.PROXY_STALE_AFTER_MS, d.staleAfterMs),
    sweepEnabled: env.PROXY_SWEEP_ENABLED === "1",
    resolverCacheTtlMs: num(env.PROXY_RESOLVER_CACHE_TTL_MS, d.resolverCacheTtlMs),
    swapAfterFailures: num(env.PROXY_SWAP_AFTER_FAILURES, d.swapAfterFailures),
    lowPoolThreshold: num(env.PROXY_LOW_POOL_THRESHOLD, d.lowPoolThreshold),
  };
}
