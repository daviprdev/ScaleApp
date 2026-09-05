/**
 * Implementações reais das portas que o driver Graph consumia por stub:
 *  - `VaultCredentialResolver` decifra `vault://…` no token de acesso;
 *  - `VaultTokenSink` persiste o token rotacionado pelo refresh.
 *
 * As duas são estruturalmente compatíveis com as portas de
 * `@scaleapp/driver-graph` sem que este pacote importe o driver: o Control
 * Plane não conhece o Execution Plane, é o composition root que liga.
 */

import type { Pool } from "pg";
import type { SecretVault } from "./vault.js";
import { isVaultRef } from "./vault.js";
import type { SessionRepository } from "./sessionRepository.js";

export interface CredentialResolverPort {
  resolveToken(accessTokenRef: string): Promise<string | null>;
}

export interface TokenSinkPort {
  rotateToken(accessTokenRef: string, accessToken: string, expiresAt: string): Promise<void>;
}

export interface VaultCredentialResolverOptions {
  /**
   * Janela de cache do token decifrado, em ms. Existe porque a 500 contas/dia
   * cada job faria uma ida ao banco + decifra só para montar o header. É curta
   * de propósito: um refresh feito por outro processo precisa ser visto rápido,
   * senão o worker segue mandando um token velho até a entrada vencer.
   * 0 desliga o cache.
   */
  readonly cacheTtlMs?: number;
  /** Teto de entradas em memória (regra 8 também vale para cache). */
  readonly cacheMaxEntries?: number;
}

interface CacheEntry {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** Resolve a referência do cofre no token real, com cache curto em memória. */
export class VaultCredentialResolver implements CredentialResolverPort {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly vault: SecretVault,
    options: VaultCredentialResolverOptions = {},
  ) {
    this.ttlMs = options.cacheTtlMs ?? 30_000;
    this.maxEntries = options.cacheMaxEntries ?? 1_000;
  }

  async resolveToken(accessTokenRef: string): Promise<string | null> {
    if (!accessTokenRef || !isVaultRef(accessTokenRef)) return null;

    const cached = this.cache.get(accessTokenRef);
    if (cached && cached.expiresAtMs > Date.now()) return cached.token;

    const token = await this.vault.get(accessTokenRef);
    if (token === null) {
      this.cache.delete(accessTokenRef);
      return null;
    }
    this.remember(accessTokenRef, token);
    return token;
  }

  /** Invalida uma referência (chamado quando o token é rotacionado aqui). */
  invalidate(accessTokenRef: string): void {
    this.cache.delete(accessTokenRef);
  }

  private remember(ref: string, token: string): void {
    if (this.ttlMs <= 0) return;
    if (this.cache.size >= this.maxEntries) {
      // Descarta a entrada mais antiga (Map preserva ordem de inserção).
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(ref, { token, expiresAtMs: Date.now() + this.ttlMs });
  }
}

/**
 * Persiste o token que o refresh devolveu. Reescreve a linha do cofre (a
 * referência não muda) e atualiza a expiração da conta na MESMA transação: se
 * o token novo fosse gravado sem a expiração nova, a conta seguiria sendo
 * escolhida para refresh a cada varredura; se a expiração fosse gravada sem o
 * token, a conta usaria um token prestes a morrer achando que está válida.
 *
 * O token em claro só existe dentro deste método — nunca vai para o resultado
 * do job (que é persistido em JSONB) nem para log.
 */
export class VaultTokenSink implements TokenSinkPort {
  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
    private readonly sessions: SessionRepository,
    private readonly credentials?: VaultCredentialResolver,
  ) {}

  async rotateToken(accessTokenRef: string, accessToken: string, expiresAt: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const replaced = await this.vault.replace(accessTokenRef, accessToken, client);
      if (!replaced) {
        throw new Error(`referência de token ${accessTokenRef} não existe no cofre`);
      }
      const accountId = await this.sessions.findIdByAccessTokenRef(accessTokenRef, client);
      if (!accountId) {
        throw new Error(`nenhuma conta aponta para ${accessTokenRef}`);
      }
      await this.sessions.applyRefreshSuccess(accountId, expiresAt, client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    // Só depois do COMMIT: até aqui o token antigo ainda é o vigente.
    this.credentials?.invalidate(accessTokenRef);
  }
}
