/**
 * Health check do pool.
 *
 * A parte que importa não é mandar o GET — é decidir o que a falha significa.
 * Regra 2 aplicada ao pool: quando muitos proxies falham na mesma varredura, a
 * explicação provável é o provedor (ou a nossa saída de rede), não centenas de
 * proxies morrendo juntos. Condenar cada um individualmente nesse cenário tira
 * o pool inteiro do ar e, pior, aposenta proxies bons.
 *
 * Por isso a suspeita de outage exige **limiar percentual E contagem mínima
 * absoluta**: só percentual gera falso positivo em lote pequeno (2 de 3 falhas
 * = 66% não é outage de provedor). Sob suspeita de outage, nenhum proxy é
 * marcado `down` — todos ficam `degraded` e a varredura reporta o fato para
 * quem alerta.
 */

import { ProxyHealthStatus } from "@scaleapp/domain";
import type { HttpProbe } from "./ports.js";
import type { CheckOutcome, ProxyRecord, ProxyRepository } from "./proxyRepository.js";
import type { ProxyResolverPort } from "./resolver.js";

export interface HealthCheckConfig {
  /** URL neutra usada como alvo da checagem (devolve o IP de saída). */
  readonly probeUrl: string;
  readonly timeoutMs: number;
  /** Falhas seguidas para declarar `down`. Uma só é soluço de rede. */
  readonly downAfterFailures: number;
  /** Fração de falhas do lote que levanta suspeita de outage. */
  readonly outageRatio: number;
  /** Contagem mínima absoluta de falhas — sem isso, lote pequeno vira outage. */
  readonly outageMinCount: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthCheckConfig = {
  probeUrl: "https://api.ipify.org?format=json",
  timeoutMs: 10_000,
  downAfterFailures: 3,
  outageRatio: 0.5,
  outageMinCount: 5,
};

/** Extrai o IP da resposta da sonda (JSON `{"ip":…}` ou texto puro). */
export function parseExitIp(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed) as { ip?: unknown };
    if (typeof json.ip === "string" && json.ip.length > 0) return json.ip;
  } catch {
    // corpo não-JSON: cai no formato texto abaixo.
  }
  const match = /^[0-9a-f.:]{7,45}$/i.exec(trimmed);
  return match ? trimmed : undefined;
}

/** Uma checagem: mede latência e captura o IP de saída. Nunca lança. */
export async function probeProxy(
  probe: HttpProbe,
  proxyUrl: string,
  config: HealthCheckConfig,
  now: () => number = Date.now,
): Promise<CheckOutcome> {
  const started = now();
  try {
    const res = await probe.request({
      method: "GET",
      url: config.probeUrl,
      proxyUrl,
      timeoutMs: config.timeoutMs,
    });
    const latencyMs = now() - started;
    if (res.status < 200 || res.status >= 400) {
      return { ok: false, latencyMs, error: `sonda respondeu HTTP ${res.status}` };
    }
    const exitIp = parseExitIp(res.body);
    return { ok: true, latencyMs, ...(exitIp ? { exitIp } : {}) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Suspeita de outage: percentual E contagem mínima, as duas juntas. Ver o
 * comentário do topo — cada metade sozinha erra num sentido diferente.
 */
export function suspectsOutage(
  failed: number,
  total: number,
  config: HealthCheckConfig,
): boolean {
  if (total === 0) return false;
  return failed >= config.outageMinCount && failed / total >= config.outageRatio;
}

/** Traduz o resultado de um proxy em saúde, dado o contexto do lote. */
export function decideHealth(
  outcome: CheckOutcome,
  consecutiveFailures: number,
  config: HealthCheckConfig,
  suspectedOutage: boolean,
): ProxyHealthStatus {
  if (outcome.ok) return ProxyHealthStatus.Healthy;
  // Sob suspeita de outage o proxy não é condenado — no máximo degradado.
  if (suspectedOutage) return ProxyHealthStatus.Degraded;
  return consecutiveFailures + 1 >= config.downAfterFailures
    ? ProxyHealthStatus.Down
    : ProxyHealthStatus.Degraded;
}

/**
 * Espaçamento entre sondas do lote (regra 5): distribui dentro do ciclo, com
 * teto, para não disparar centenas de conexões no mesmo instante.
 */
export function probeSpacingMs(batchSize: number, cycleIntervalMs: number): number {
  if (batchSize <= 1 || cycleIntervalMs <= 0) return 0;
  return Math.floor((cycleIntervalMs * 0.9) / batchSize);
}

export interface HealthSweepOptions {
  readonly repo: ProxyRepository;
  readonly resolver: ProxyResolverPort;
  readonly probe: HttpProbe;
  readonly config: HealthCheckConfig;
  /** Teto de proxies por varredura (regra 8). */
  readonly limit: number;
  /** Idade a partir da qual a checagem é considerada velha. */
  readonly staleAfterMs: number;
  /** Intervalo do ciclo — teto do espaçamento entre sondas (regra 5). */
  readonly cycleIntervalMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HealthSweepResult {
  readonly checked: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly down: number;
  /** Verdadeiro quando o lote parece outage, não proxies individuais. */
  readonly suspectedOutage: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Roda uma varredura: sonda o lote, decide a saúde com o lote inteiro em mãos
 * e só então persiste. A decisão vem depois de todas as sondas de propósito —
 * é o que permite reconhecer o outage antes de condenar alguém.
 */
export async function runHealthSweep(opts: HealthSweepOptions): Promise<HealthSweepResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const due = await opts.repo.findDueForCheck(opts.limit, opts.staleAfterMs);
  if (due.length === 0) {
    return { checked: 0, healthy: 0, degraded: 0, down: 0, suspectedOutage: false };
  }

  const spacing = probeSpacingMs(due.length, opts.cycleIntervalMs);
  const results: Array<{ proxy: ProxyRecord; outcome: CheckOutcome }> = [];

  for (const [index, proxy] of due.entries()) {
    if (index > 0) await sleep(spacing);
    const connection = await opts.resolver.resolveProxy(proxy.id);
    if (!connection) {
      results.push({
        proxy,
        outcome: { ok: false, error: "proxy não resolvível (credencial ou estado)" },
      });
      continue;
    }
    results.push({ proxy, outcome: await probeProxy(opts.probe, connection.url, opts.config) });
  }

  const failed = results.filter((r) => !r.outcome.ok).length;
  const suspectedOutage = suspectsOutage(failed, results.length, opts.config);

  let healthy = 0;
  let degraded = 0;
  let down = 0;
  for (const { proxy, outcome } of results) {
    const health = decideHealth(
      outcome,
      proxy.consecutiveFailures,
      opts.config,
      suspectedOutage,
    );
    if (health === ProxyHealthStatus.Healthy) healthy++;
    else if (health === ProxyHealthStatus.Down) down++;
    else degraded++;
    await opts.repo.recordCheck(proxy.id, outcome, health);
  }

  return { checked: results.length, healthy, degraded, down, suspectedOutage };
}
