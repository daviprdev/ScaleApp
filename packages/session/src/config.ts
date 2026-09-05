/**
 * Configuração do Session Manager. Os defaults valem para o token de longa
 * duração do Instagram Login (60 dias): refrescar com 7 dias de antecedência
 * dá margem de várias varreduras antes da expiração, mesmo se algumas falharem.
 */

export interface SessionConfig {
  /** Antecedência do refresh preventivo (regra 6). */
  readonly refreshWithinMs: number;
  /** Janela em que a sessão é considerada `expiring`. */
  readonly expiringWindowMs: number;
  /** Intervalo entre varreduras — também o teto do stagger (regra 5). */
  readonly sweepIntervalMs: number;
  /** Teto de contas por varredura (regra 8). */
  readonly sweepLimit: number;
  /** Intervalo mínimo entre tentativas na mesma conta. */
  readonly minRetryIntervalMs: number;
  /** Falhas consecutivas antes de parar de tentar sozinho. */
  readonly maxFailures: number;
  /** TTL do cache de token decifrado no worker. */
  readonly tokenCacheTtlMs: number;
  /** Liga a varredura periódica neste processo. */
  readonly sweepEnabled: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  refreshWithinMs: 7 * DAY,
  expiringWindowMs: 7 * DAY,
  sweepIntervalMs: 15 * 60_000,
  sweepLimit: 200,
  minRetryIntervalMs: 60 * 60_000,
  maxFailures: 5,
  tokenCacheTtlMs: 30_000,
  sweepEnabled: false,
};

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadSessionConfig(env: NodeJS.ProcessEnv = process.env): SessionConfig {
  const d = DEFAULT_SESSION_CONFIG;
  return {
    refreshWithinMs: num(env.SESSION_REFRESH_WITHIN_MS, d.refreshWithinMs),
    expiringWindowMs: num(env.SESSION_EXPIRING_WINDOW_MS, d.expiringWindowMs),
    sweepIntervalMs: num(env.SESSION_SWEEP_INTERVAL_MS, d.sweepIntervalMs),
    sweepLimit: num(env.SESSION_SWEEP_LIMIT, d.sweepLimit),
    minRetryIntervalMs: num(env.SESSION_MIN_RETRY_INTERVAL_MS, d.minRetryIntervalMs),
    maxFailures: num(env.SESSION_MAX_REFRESH_FAILURES, d.maxFailures),
    tokenCacheTtlMs: num(env.SESSION_TOKEN_CACHE_TTL_MS, d.tokenCacheTtlMs),
    sweepEnabled: env.SESSION_SWEEP_ENABLED === "1",
  };
}
