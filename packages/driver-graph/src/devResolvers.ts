/**
 * Stubs de DESENVOLVIMENTO das portas de resolução. Não têm cofre nem
 * criptografia — servem para exercitar o driver antes dos módulos reais
 * (Sessão/Proxy/Biblioteca de mídia) existirem. NÃO usar em produção com
 * segredos reais: aqui tokens/credenciais trafegam em texto.
 *
 * Quando os módulos 8/9 chegarem, eles implementam as mesmas interfaces de
 * `ports.ts` e substituem estes stubs sem tocar no driver.
 */

import type {
  CredentialResolver,
  MediaResolver,
  ProxyConnection,
  ProxyResolver,
  ResolvedMedia,
} from "./ports.js";

/** Query mínima (subconjunto de pg.Pool) — evita depender de `pg` no package. */
export interface Queryable {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Dev: resolve o token a partir de um mapa em memória, ou trata a própria
 * referência como o token quando não é um ponteiro de cofre (`vault://...`),
 * ou cai para a env `GRAPH_DEV_TOKEN`.
 */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(private readonly tokensByRef: ReadonlyMap<string, string> = new Map()) {}

  async resolveToken(accessTokenRef: string): Promise<string | null> {
    const mapped = this.tokensByRef.get(accessTokenRef);
    if (mapped) return mapped;
    if (accessTokenRef && !accessTokenRef.startsWith("vault://")) return accessTokenRef;
    return process.env.GRAPH_DEV_TOKEN ?? null;
  }
}

interface ProxyRow {
  protocol: string;
  host: string;
  port: number;
  credentials_ref: string | null;
}

/**
 * Dev: lê o proxy dedicado da tabela `proxies` e monta a URL. Credenciais:
 * em produção viriam do cofre via `credentials_ref`; aqui, se o `credentials_ref`
 * for um literal `user:pass`, embutimos; senão usamos a env `GRAPH_DEV_PROXY_AUTH`.
 */
export class DbAccountProxyResolver implements ProxyResolver {
  constructor(private readonly db: Queryable) {}

  async resolveProxy(proxyId: string): Promise<ProxyConnection | null> {
    const res = await this.db.query<ProxyRow>(
      `SELECT protocol, host, port, credentials_ref FROM proxies WHERE id = $1`,
      [proxyId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const rawAuth = row.credentials_ref ?? process.env.GRAPH_DEV_PROXY_AUTH ?? "";
    const auth = rawAuth && !rawAuth.startsWith("vault://") ? `${rawAuth}@` : "";
    return { url: `${row.protocol}://${auth}${row.host}:${row.port}` };
  }
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)(\?|$)/i;

/**
 * Dev: resolve a mídia a partir de um mapa em memória; como fallback, se o id
 * já for uma URL http(s), infere o tipo pela extensão. A biblioteca de mídia
 * real substitui isto resolvendo o id interno para uma URL pública assinada.
 */
export class UrlMediaResolver implements MediaResolver {
  constructor(private readonly byId: ReadonlyMap<string, ResolvedMedia> = new Map()) {}

  async resolveMedia(mediaId: string): Promise<ResolvedMedia | null> {
    const mapped = this.byId.get(mediaId);
    if (mapped) return mapped;
    if (/^https?:\/\//i.test(mediaId)) {
      return { url: mediaId, kind: VIDEO_EXT.test(mediaId) ? "video" : "image" };
    }
    return null;
  }
}
