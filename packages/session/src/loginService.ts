/**
 * Login de conta (onboarding OAuth). Orquestra o fluxo sem conhecer a
 * plataforma: a troca de código por token vive atrás da porta
 * `OAuthTokenExchange`, implementada pelo pacote do driver.
 *
 * O fluxo inteiro sai pelo proxy dedicado da conta (regras 7 e 10). Fazer o
 * login pelo IP da VPS e só depois passar a operar por proxy é justamente o
 * padrão que a Meta correlaciona — a conta nasceria marcada.
 *
 * Segredos: o secret do Meta App é lido do cofre na hora do uso e o token
 * obtido é gravado no cofre; nenhum dos dois é devolvido ao chamador nem
 * escrito em log. O que sai daqui é a referência.
 */

import type { Pool } from "pg";
import type { Keyring } from "./crypto.js";
import { signOAuthState, verifyOAuthState } from "./oauthState.js";
import type { OAuthTokenExchange, ProxyResolverPort } from "./ports.js";
import { SessionRepository } from "./sessionRepository.js";
import type { SecretVault } from "./vault.js";

/**
 * Escopos do Instagram Login API para o fluxo core (publicar + ler insights).
 * `manage_insights` depende de Advanced Access da Meta: pedir o escopo é
 * gratuito, ter a permissão aprovada não é — e o resto do sistema não pode
 * ficar bloqueado nisso.
 */
export const DEFAULT_SCOPES: readonly string[] = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
];

export class LoginError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LoginError";
  }
}

export interface AccountLoginServiceDeps {
  readonly pool: Pool;
  readonly vault: SecretVault;
  readonly keyring: Keyring;
  readonly exchange: OAuthTokenExchange;
  readonly proxies: ProxyResolverPort;
  /** URI de callback registrada no Meta App. */
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  /** Validade do `state` assinado. */
  readonly stateTtlMs?: number;
}

export interface AuthorizationStart {
  readonly url: string;
  readonly state: string;
  readonly expiresInMs: number;
}

export interface LoginCompletion {
  readonly accountId: string;
  readonly igUserId: string;
  readonly username: string;
  readonly expiresAt: string;
  /** Referência do cofre — nunca o token. */
  readonly accessTokenRef: string;
}

export class AccountLoginService {
  private readonly sessions: SessionRepository;
  private readonly scopes: readonly string[];
  private readonly stateTtlMs: number;

  constructor(private readonly deps: AccountLoginServiceDeps) {
    this.sessions = new SessionRepository(deps.pool);
    this.scopes = deps.scopes ?? DEFAULT_SCOPES;
    this.stateTtlMs = deps.stateTtlMs ?? 10 * 60_000;
  }

  /** Passo 1: URL de autorização para a conta, com `state` assinado. */
  async startAuthorization(accountId: string): Promise<AuthorizationStart> {
    const ctx = await this.sessions.loadAuthContext(accountId);
    if (!ctx) throw new LoginError(`conta ${accountId} não existe`, "ACCOUNT_NOT_FOUND");

    const state = signOAuthState(this.deps.keyring, accountId, { ttlMs: this.stateTtlMs });
    const url = this.deps.exchange.authorizationUrl({
      clientId: ctx.clientId,
      redirectUri: this.deps.redirectUri,
      scopes: this.scopes,
      state,
    });
    return { url, state, expiresInMs: this.stateTtlMs };
  }

  /**
   * Passo 2: callback. Troca o código por token de longa duração, guarda no
   * cofre e liga a sessão à conta.
   *
   * A ordem importa: o token vai para o cofre ANTES de a conta passar a
   * apontar para ele. Se falhasse no meio da ordem inversa, a conta ficaria
   * apontando para uma referência inexistente e toda operação dela viraria
   * `TokenDead` sem que o token estivesse morto.
   */
  async completeAuthorization(input: {
    readonly code: string;
    readonly state: string;
  }): Promise<LoginCompletion> {
    const claims = verifyOAuthState(this.deps.keyring, input.state);
    const ctx = await this.sessions.loadAuthContext(claims.accountId);
    if (!ctx) throw new LoginError(`conta ${claims.accountId} não existe`, "ACCOUNT_NOT_FOUND");

    const proxy = await this.deps.proxies.resolveProxy(ctx.proxyId);
    if (!proxy) {
      // Regra 7/10: sem proxy dedicado o login não sai. Nada de "só desta vez
      // pelo IP da infra" — é assim que a correlação de contas começa.
      throw new LoginError(
        `proxy dedicado da conta ${ctx.handle} indisponível — login abortado`,
        "PROXY_UNAVAILABLE",
      );
    }

    const clientSecret = await this.deps.vault.get(ctx.metaAppSecretRef);
    if (!clientSecret) {
      throw new LoginError(
        `secret do Meta App ${ctx.metaAppId} não está no cofre (${ctx.metaAppSecretRef})`,
        "APP_SECRET_MISSING",
      );
    }

    const short = await this.deps.exchange.exchangeCode({
      clientId: ctx.clientId,
      clientSecret,
      redirectUri: this.deps.redirectUri,
      code: input.code,
      proxyUrl: proxy.url,
    });

    const long = await this.deps.exchange.exchangeForLongLived({
      clientSecret,
      shortLivedToken: short.accessToken,
      proxyUrl: proxy.url,
    });

    const identity = await this.deps.exchange.fetchIdentity({
      accessToken: long.accessToken,
      proxyUrl: proxy.url,
    });

    const expiresAt = new Date(Date.now() + long.expiresInSeconds * 1000).toISOString();

    // Reusa a referência existente quando há uma (re-login da mesma conta):
    // reescrever a linha do cofre evita acumular segredo órfão a cada relogin.
    let accessTokenRef: string;
    if (ctx.accessTokenRef && (await this.deps.vault.replace(ctx.accessTokenRef, long.accessToken))) {
      accessTokenRef = ctx.accessTokenRef;
    } else {
      accessTokenRef = await this.deps.vault.put("account_access_token", long.accessToken);
    }

    const igUserId = identity.userId || short.userId;
    await this.sessions.attachSession({
      accountId: ctx.accountId,
      accessTokenRef,
      expiresAt,
      ...(igUserId ? { igUserId } : {}),
    });

    return {
      accountId: ctx.accountId,
      igUserId: identity.userId,
      username: identity.username,
      expiresAt,
      accessTokenRef,
    };
  }
}
