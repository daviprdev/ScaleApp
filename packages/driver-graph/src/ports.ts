/**
 * Portas que o driver Graph API precisa mas cuja implementação "de verdade"
 * pertence a outros módulos ainda não construídos:
 *  - CredentialResolver → Session/Credential Manager (módulo 8, cofre/cripto).
 *  - ProxyResolver      → Proxy/Network Manager (módulo 9, pool + health).
 *  - MediaResolver      → Biblioteca de mídia (URL pública para a Graph API).
 *
 * O driver depende só destas interfaces; stubs de desenvolvimento as satisfazem
 * agora e os módulos reais as substituem sem tocar no driver.
 */

/** Resolve a referência de token do cofre no token de acesso real. */
export interface CredentialResolver {
  /** Retorna o token, ou null se a referência não resolver (→ TokenDead). */
  resolveToken(accessTokenRef: string): Promise<string | null>;
}

export interface ProxyConnection {
  /** URL completa do proxy, com credenciais embutidas quando houver. */
  readonly url: string;
}

/** Resolve o id do proxy dedicado na conexão utilizável (regra 10). */
export interface ProxyResolver {
  /** Retorna a conexão do proxy, ou null se indisponível (→ ProxyError). */
  resolveProxy(proxyId: string): Promise<ProxyConnection | null>;
}

export type ResolvedMediaKind = "image" | "video";

export interface ResolvedMedia {
  /** URL pública acessível pela Graph API (Instagram baixa a mídia daí). */
  readonly url: string;
  readonly kind: ResolvedMediaKind;
}

/** Resolve um id interno de mídia na URL pública que a Graph API consome. */
export interface MediaResolver {
  /** Retorna a mídia resolvida, ou null se não encontrada (→ InvalidInput). */
  resolveMedia(mediaId: string): Promise<ResolvedMedia | null>;
}
