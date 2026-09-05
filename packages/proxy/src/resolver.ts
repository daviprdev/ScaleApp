/**
 * `PoolProxyResolver` — implementação real da porta `ProxyResolver` do driver
 * (que até aqui era o stub de dev `DbAccountProxyResolver`). Resolve o id do
 * proxy na URL utilizável, decifrando a credencial do cofre.
 *
 * Recusa deliberadamente dois casos, e a recusa vira `ProxyError` no driver
 * (job retenta, conta não é culpada):
 *  - proxy `retired`: saiu do pool de propósito;
 *  - proxy `down`: só a varredura marca `down`, e ela não marca durante um
 *    outage do provedor (regra 2) — então `down` aqui significa "este proxy
 *    especificamente está morto", e mandar tráfego por ele é pior que falhar.
 *
 * Nunca há fallback para "sair sem proxy": a regra 10 não tem exceção.
 */

import type { Pool } from "pg";
import { ProxyAssignmentState, ProxyHealthStatus } from "@scaleapp/domain";
import type { SecretReader } from "./ports.js";

export interface ProxyConnection {
  readonly url: string;
}

export interface ProxyResolverPort {
  resolveProxy(proxyId: string): Promise<ProxyConnection | null>;
}

export interface PoolProxyResolverOptions {
  /**
   * Cache da URL montada, em ms. O ganho é não decifrar credencial a cada job;
   * curto porque uma troca de proxy (failover) precisa ser vista rápido.
   * 0 desliga.
   */
  readonly cacheTtlMs?: number;
  readonly cacheMaxEntries?: number;
}

interface Entry {
  readonly url: string;
  readonly expiresAtMs: number;
}

interface Row {
  protocol: string;
  host: string;
  port: number;
  credentials_ref: string | null;
  assignment_state: ProxyAssignmentState;
  health: ProxyHealthStatus;
}

/** Monta `protocolo://user:pass@host:porta`, escapando a credencial. */
export function buildProxyUrl(
  protocol: string,
  host: string,
  port: number,
  credentials?: string | null,
): string {
  if (!credentials) return `${protocol}://${host}:${port}`;
  const sep = credentials.indexOf(":");
  // Sem ':' tratamos tudo como usuário — senha vazia é um caso real de provedor
  // que autentica só por token no campo de usuário.
  const user = sep >= 0 ? credentials.slice(0, sep) : credentials;
  const pass = sep >= 0 ? credentials.slice(sep + 1) : "";
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
  return `${protocol}://${auth}@${host}:${port}`;
}

export class PoolProxyResolver implements ProxyResolverPort {
  private readonly cache = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly pool: Pool,
    private readonly secrets: SecretReader,
    options: PoolProxyResolverOptions = {},
  ) {
    this.ttlMs = options.cacheTtlMs ?? 60_000;
    this.maxEntries = options.cacheMaxEntries ?? 1_000;
  }

  async resolveProxy(proxyId: string): Promise<ProxyConnection | null> {
    const cached = this.cache.get(proxyId);
    if (cached && cached.expiresAtMs > Date.now()) return { url: cached.url };

    const res = await this.pool.query<Row>(
      `SELECT protocol, host, port, credentials_ref, assignment_state, health
       FROM proxies WHERE id = $1`,
      [proxyId],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.assignment_state === ProxyAssignmentState.Retired) return null;
    if (row.health === ProxyHealthStatus.Down) return null;

    let credentials: string | null = null;
    if (row.credentials_ref) {
      credentials = await this.secrets.get(row.credentials_ref);
      if (credentials === null) {
        // Referência sem segredo no cofre: sair sem autenticação seria pior —
        // o provedor recusaria (ou pior, aceitaria de um IP compartilhado).
        return null;
      }
    }

    const url = buildProxyUrl(row.protocol, row.host, row.port, credentials);
    this.remember(proxyId, url);
    return { url };
  }

  invalidate(proxyId: string): void {
    this.cache.delete(proxyId);
  }

  private remember(proxyId: string, url: string): void {
    if (this.ttlMs <= 0) return;
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(proxyId, { url, expiresAtMs: Date.now() + this.ttlMs });
  }
}
