/**
 * Troca OAuth do Instagram Login API. Fica no pacote do driver, e não no
 * Session Manager, porque é conhecimento da plataforma externa: endpoints,
 * nomes de parâmetro e o fato de o token curto precisar de uma segunda troca
 * para virar longo. O Control Plane só enxerga a porta `OAuthTokenExchange`.
 *
 * Como toda I/O em nome de uma conta, sai pelo proxy dedicado (regras 7 e 10):
 * `proxyUrl` é obrigatório em cada método.
 */

import { HttpTransportError, type HttpClient } from "./httpClient.js";

export interface InstagramOAuthConfig {
  /** Host do diálogo de autorização (onde o usuário aprova). */
  readonly authorizeUrl: string;
  /** Endpoint da troca código → token curto. */
  readonly tokenUrl: string;
  /** Base da Graph API (troca por token longo e leitura de identidade). */
  readonly graphBaseUrl: string;
  readonly apiVersion: string;
  readonly requestTimeoutMs: number;
}

export const DEFAULT_OAUTH_CONFIG: InstagramOAuthConfig = {
  authorizeUrl: "https://www.instagram.com/oauth/authorize",
  tokenUrl: "https://api.instagram.com/oauth/access_token",
  graphBaseUrl: "https://graph.instagram.com",
  apiVersion: "v21.0",
  requestTimeoutMs: 30_000,
};

/** Falha da troca OAuth. Nunca carrega token nem secret na mensagem. */
export class OAuthExchangeError extends Error {
  constructor(
    message: string,
    readonly step: "exchange_code" | "long_lived" | "identity",
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

export class InstagramOAuthClient {
  private readonly cfg: InstagramOAuthConfig;

  constructor(
    private readonly http: HttpClient,
    config: Partial<InstagramOAuthConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_OAUTH_CONFIG, ...config };
  }

  authorizationUrl(input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly state: string;
  }): string {
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: input.scopes.join(","),
      state: input.state,
    });
    return `${this.cfg.authorizeUrl}?${params.toString()}`;
  }

  /** Código de autorização → token curto (~1h) + id da conta. */
  async exchangeCode(input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly proxyUrl: string;
  }): Promise<{ accessToken: string; userId?: string }> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
      code: input.code,
    }).toString();

    const json = await this.send("exchange_code", {
      method: "POST",
      url: this.cfg.tokenUrl,
      proxyUrl: input.proxyUrl,
      timeoutMs: this.cfg.requestTimeoutMs,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const accessToken = String(json.access_token ?? "");
    if (!accessToken) {
      throw new OAuthExchangeError("resposta sem access_token", "exchange_code");
    }
    const userId = json.user_id !== undefined ? String(json.user_id) : undefined;
    return { accessToken, ...(userId ? { userId } : {}) };
  }

  /** Token curto → token de longa duração (60 dias), o que de fato operamos. */
  async exchangeForLongLived(input: {
    readonly clientSecret: string;
    readonly shortLivedToken: string;
    readonly proxyUrl: string;
  }): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const params = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: input.clientSecret,
      access_token: input.shortLivedToken,
    });

    const json = await this.send("long_lived", {
      method: "GET",
      url: `${this.cfg.graphBaseUrl}/access_token?${params.toString()}`,
      proxyUrl: input.proxyUrl,
      timeoutMs: this.cfg.requestTimeoutMs,
    });

    const accessToken = String(json.access_token ?? "");
    const expiresInSeconds = Number(json.expires_in ?? 0);
    if (!accessToken || expiresInSeconds <= 0) {
      throw new OAuthExchangeError("resposta sem access_token/expires_in", "long_lived");
    }
    return { accessToken, expiresInSeconds };
  }

  /** Quem é a conta por trás do token: id da Graph API + handle. */
  async fetchIdentity(input: {
    readonly accessToken: string;
    readonly proxyUrl: string;
  }): Promise<{ userId: string; username: string }> {
    const params = new URLSearchParams({
      fields: "user_id,username",
      access_token: input.accessToken,
    });

    const json = await this.send("identity", {
      method: "GET",
      url: `${this.cfg.graphBaseUrl}/${this.cfg.apiVersion}/me?${params.toString()}`,
      proxyUrl: input.proxyUrl,
      timeoutMs: this.cfg.requestTimeoutMs,
    });

    // `user_id` é o id da conta IG Business; `id` é o id do app-scoped user.
    // Preferimos o primeiro: é ele que endereça /{ig-user-id}/media.
    const userId = String(json.user_id ?? json.id ?? "");
    const username = String(json.username ?? "");
    if (!userId) throw new OAuthExchangeError("resposta sem user_id", "identity");
    return { userId, username };
  }

  private async send(
    step: OAuthExchangeError["step"],
    req: Parameters<HttpClient["request"]>[0],
  ): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await this.http.request(req);
    } catch (err) {
      if (err instanceof HttpTransportError) {
        throw new OAuthExchangeError(
          `falha de transporte na troca OAuth (${err.code}${err.viaProxy ? ", via proxy" : ""})`,
          step,
        );
      }
      throw err;
    }

    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      // corpo não-JSON: a mensagem de erro abaixo cobre.
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = errorMessage(json) ?? `HTTP ${res.status}`;
      throw new OAuthExchangeError(`troca OAuth rejeitada: ${detail}`, step, res.status);
    }
    return json;
  }
}

/** Extrai a mensagem tanto do formato Graph (`error.message`) quanto do legado. */
function errorMessage(json: Record<string, unknown>): string | undefined {
  const error = json.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  const message = json.error_message;
  return typeof message === "string" ? message : undefined;
}
