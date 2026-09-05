/**
 * Acesso a dados da sessão de conta. Concentra as transições de estado de
 * sessão/saúde para que a regra 3 (checkpoint ≠ token morto) exista num lugar
 * só: são caminhos diferentes, com remediações diferentes, e nunca devem
 * colapsar num "erro de conta" genérico.
 *
 * Toda listagem aqui é limitada explicitamente (regra 8).
 */

import type { Pool, PoolClient } from "pg";
import type { AccountHealthStatus, SessionStatus } from "@scaleapp/domain";

export type Executor = Pool | PoolClient;

/** Conta elegível a refresh preventivo, com o que o job precisa saber. */
export interface RefreshCandidate {
  readonly accountId: string;
  readonly handle: string;
  readonly accessTokenRef: string;
  /** Expiração conhecida; base da chave de idempotência do job. */
  readonly expiresAt: string;
  readonly failures: number;
}

export interface FindDueForRefreshOptions {
  /** Teto explícito de contas por varredura. */
  readonly limit: number;
  /** Antecedência: refrescar quando faltar menos que isto para expirar. */
  readonly withinMs: number;
  /** Intervalo mínimo entre tentativas para a mesma conta. */
  readonly minRetryIntervalMs: number;
  /** Acima disto, para de tentar sozinho (exige intervenção). */
  readonly maxFailures: number;
}

export interface AccountAuthContext {
  readonly accountId: string;
  readonly handle: string;
  readonly proxyId: string;
  readonly metaAppId: string;
  readonly clientId: string;
  readonly metaAppSecretRef: string;
  readonly accessTokenRef: string | null;
}

export interface SessionSnapshot {
  readonly accountId: string;
  readonly status: SessionStatus | null;
  readonly expiresAt: string | null;
  readonly refreshedAt: string | null;
  readonly refreshAttemptedAt: string | null;
  readonly refreshFailures: number;
  readonly health: AccountHealthStatus;
  readonly hasToken: boolean;
}

export class SessionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Contas cuja sessão expira dentro da janela e que estão aptas a refrescar.
   * Exclui explicitamente `checkpoint_required` e `token_dead`: nenhuma das
   * duas se resolve com refresh (regra 3) — insistir só queima requisição e
   * mascara o motivo real na fila.
   */
  async findDueForRefresh(opts: FindDueForRefreshOptions): Promise<readonly RefreshCandidate[]> {
    const res = await this.pool.query<{
      id: string;
      handle: string;
      access_token_ref: string;
      session_expires_at: Date;
      session_refresh_failures: number;
    }>(
      `SELECT id, handle, access_token_ref, session_expires_at, session_refresh_failures
       FROM accounts
       WHERE access_token_ref IS NOT NULL
         AND session_expires_at IS NOT NULL
         AND session_expires_at <= now() + make_interval(secs => $1)
         AND session_status IN ('valid','expiring')
         AND lifecycle_state NOT IN ('disabled','failed')
         AND health NOT IN ('checkpoint_required','token_dead','suspended')
         AND session_refresh_failures < $2
         AND (session_refresh_attempted_at IS NULL
              OR session_refresh_attempted_at <= now() - make_interval(secs => $3))
       ORDER BY session_expires_at ASC
       LIMIT $4`,
      [opts.withinMs / 1000, opts.maxFailures, opts.minRetryIntervalMs / 1000, opts.limit],
    );
    return res.rows.map((r) => ({
      accountId: r.id,
      handle: r.handle,
      accessTokenRef: r.access_token_ref,
      expiresAt: r.session_expires_at.toISOString(),
      failures: r.session_refresh_failures,
    }));
  }

  /** Marca que a tentativa saiu (evita re-enfileirar a mesma conta em loop). */
  async markRefreshAttempted(accountId: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `UPDATE accounts SET session_refresh_attempted_at = now() WHERE id = $1`,
      [accountId],
    );
  }

  /**
   * Aplica um refresh bem-sucedido: nova expiração, contador de falhas zerado
   * e saúde restaurada só se ela estava degradada de forma genérica — nunca
   * sobrescreve checkpoint/token morto, que exigem ação humana (regra 3).
   */
  async applyRefreshSuccess(
    accountId: string,
    expiresAt: string,
    executor: Executor = this.pool,
  ): Promise<void> {
    await executor.query(
      `UPDATE accounts
       SET session_status = 'valid',
           session_expires_at = $2,
           session_refreshed_at = now(),
           session_refresh_attempted_at = now(),
           session_refresh_failures = 0,
           health = CASE WHEN health IN ('degraded','unknown') THEN 'healthy' ELSE health END
       WHERE id = $1`,
      [accountId, expiresAt],
    );
  }

  /** Falha de refresh não-terminal: conta o strike e adia a próxima tentativa. */
  async registerRefreshFailure(accountId: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `UPDATE accounts
       SET session_refresh_failures = session_refresh_failures + 1,
           session_refresh_attempted_at = now()
       WHERE id = $1`,
      [accountId],
    );
  }

  /**
   * Regra 3, ramo A: checkpoint de segurança. A sessão continua existindo — o
   * que falta é um humano passar pela verificação. NÃO apaga o token e NÃO
   * marca a conta como morta; só a tira do fluxo automático.
   */
  async markCheckpointRequired(accountId: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `UPDATE accounts
       SET health = 'checkpoint_required',
           session_status = COALESCE(session_status, 'valid')
       WHERE id = $1`,
      [accountId],
    );
  }

  /**
   * Regra 3, ramo B: token morto/revogado. Aqui a sessão acabou de fato — só
   * um novo fluxo de OAuth resolve. A referência do cofre é mantida (a linha é
   * reescrita no próximo login) para não deixar segredo órfão.
   */
  async markTokenDead(accountId: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `UPDATE accounts
       SET health = 'token_dead',
           session_status = 'revoked'
       WHERE id = $1`,
      [accountId],
    );
  }

  /** Conta dona de um token, pelo ponteiro do cofre (usado pelo token sink). */
  async findIdByAccessTokenRef(
    accessTokenRef: string,
    executor: Executor = this.pool,
  ): Promise<string | null> {
    const res = await executor.query<{ id: string }>(
      `SELECT id FROM accounts WHERE access_token_ref = $1 LIMIT 1`,
      [accessTokenRef],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Dados do login: App (client id/secret) e proxy dedicado da conta. */
  async loadAuthContext(accountId: string): Promise<AccountAuthContext | null> {
    const res = await this.pool.query<{
      id: string;
      handle: string;
      proxy_id: string;
      meta_app_id: string;
      client_id: string;
      secret_ref: string;
      access_token_ref: string | null;
      enabled: boolean;
    }>(
      `SELECT a.id, a.handle, a.proxy_id, a.meta_app_id, a.access_token_ref,
              m.client_id, m.secret_ref, m.enabled
       FROM accounts a JOIN meta_apps m ON m.id = a.meta_app_id
       WHERE a.id = $1`,
      [accountId],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (!row.enabled) throw new Error(`Meta App ${row.meta_app_id} está desabilitado`);
    return {
      accountId: row.id,
      handle: row.handle,
      proxyId: row.proxy_id,
      metaAppId: row.meta_app_id,
      clientId: row.client_id,
      metaAppSecretRef: row.secret_ref,
      accessTokenRef: row.access_token_ref,
    };
  }

  /**
   * Liga a sessão recém-obtida à conta: ponteiro do token, expiração e o
   * `ig_user_id` (endereço da conta na Graph API). Sai do estado de erro de
   * sessão porque acabou de haver login bem-sucedido.
   */
  async attachSession(
    input: {
      readonly accountId: string;
      readonly accessTokenRef: string;
      readonly expiresAt: string;
      readonly igUserId?: string;
    },
    executor: Executor = this.pool,
  ): Promise<void> {
    await executor.query(
      `UPDATE accounts
       SET access_token_ref = $2,
           session_status = 'valid',
           session_issued_at = now(),
           session_expires_at = $3,
           session_refreshed_at = now(),
           session_refresh_attempted_at = NULL,
           session_refresh_failures = 0,
           ig_user_id = COALESCE($4, ig_user_id),
           health = CASE WHEN health IN ('token_dead','checkpoint_required','unknown','degraded')
                         THEN 'healthy' ELSE health END
       WHERE id = $1`,
      [input.accountId, input.accessTokenRef, input.expiresAt, input.igUserId ?? null],
    );
  }

  async getSnapshot(accountId: string): Promise<SessionSnapshot | null> {
    const res = await this.pool.query<{
      id: string;
      session_status: SessionStatus | null;
      session_expires_at: Date | null;
      session_refreshed_at: Date | null;
      session_refresh_attempted_at: Date | null;
      session_refresh_failures: number;
      health: AccountHealthStatus;
      access_token_ref: string | null;
    }>(
      `SELECT id, session_status, session_expires_at, session_refreshed_at,
              session_refresh_attempted_at, session_refresh_failures, health, access_token_ref
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      accountId: row.id,
      status: row.session_status,
      expiresAt: row.session_expires_at?.toISOString() ?? null,
      refreshedAt: row.session_refreshed_at?.toISOString() ?? null,
      refreshAttemptedAt: row.session_refresh_attempted_at?.toISOString() ?? null,
      refreshFailures: row.session_refresh_failures,
      health: row.health,
      hasToken: row.access_token_ref !== null,
    };
  }

  /**
   * Reavalia `session_status` a partir da expiração num lote limitado
   * (regra 8): mantém valid/expiring/expired coerentes mesmo quando ninguém
   * tocou na conta. Retorna quantas linhas mudaram.
   */
  async reconcileStatuses(expiringWindowMs: number, limit: number): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      `UPDATE accounts SET session_status = derived.next_status
       FROM (
         SELECT id,
                CASE WHEN session_expires_at <= now() THEN 'expired'
                     WHEN session_expires_at <= now() + make_interval(secs => $1) THEN 'expiring'
                     ELSE 'valid' END AS next_status
         FROM accounts
         WHERE session_expires_at IS NOT NULL
           AND session_status IN ('valid','expiring','expired')
         ORDER BY session_expires_at ASC
         LIMIT $2
       ) AS derived
       WHERE accounts.id = derived.id AND accounts.session_status <> derived.next_status
       RETURNING accounts.id`,
      [expiringWindowMs / 1000, limit],
    );
    return res.rows.length;
  }
}
