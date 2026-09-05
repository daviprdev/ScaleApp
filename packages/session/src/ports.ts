/**
 * Portas que o Session Manager consome. Nenhuma delas conhece Instagram: a
 * troca de código por token é específica da plataforma e vive no pacote do
 * driver (Execution Plane); aqui só existe o contrato. O composition root liga
 * as duas pontas.
 *
 * As interfaces de resolução de proxy/HTTP são estruturalmente idênticas às de
 * `@scaleapp/driver-graph` de propósito: o Control Plane não importa o driver,
 * mas aceita a implementação dele por injeção.
 */

/** Conexão de proxy dedicado já resolvida (regra 10). */
export interface ProxyConnection {
  readonly url: string;
}

export interface ProxyResolverPort {
  resolveProxy(proxyId: string): Promise<ProxyConnection | null>;
}

/** Token curto recém-trocado pelo código de autorização. */
export interface ShortLivedToken {
  readonly accessToken: string;
  /** Id numérico da conta IG (endereço na Graph API), quando a troca o devolve. */
  readonly userId?: string;
}

export interface LongLivedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface ProfileIdentity {
  readonly userId: string;
  readonly username: string;
}

/**
 * Troca OAuth da plataforma. Implementada pelo pacote do driver; o Session
 * Manager só sabe que existe um jeito de virar `code` em token de longa
 * duração e de descobrir a identidade por trás dele.
 *
 * Todas as chamadas recebem `proxyUrl`: mesmo o login sai pelo proxy dedicado
 * da conta (regra 7 — nunca pelo IP da infraestrutura em nome de uma conta).
 */
export interface OAuthTokenExchange {
  authorizationUrl(input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly state: string;
  }): string;

  exchangeCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly proxyUrl: string;
  }): Promise<ShortLivedToken>;

  exchangeForLongLived(input: {
    readonly clientSecret: string;
    readonly shortLivedToken: string;
    readonly proxyUrl: string;
  }): Promise<LongLivedToken>;

  fetchIdentity(input: {
    readonly accessToken: string;
    readonly proxyUrl: string;
  }): Promise<ProfileIdentity>;
}
