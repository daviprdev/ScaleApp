/**
 * Repositório do Account Registry: fala SQL parametrizado com o Postgres e
 * traduz linhas para o contrato `Account` de @scaleapp/domain.
 *
 * Toda listagem é limitada explicitamente (regra 8). Associar proxy é
 * transacional e marca o proxy como dedicado à conta (regra 10).
 */

import type { Pool } from "pg";
import type {
  Account,
  AccountHealthStatus,
  AccountId,
  AccountLifecycleState,
  InstagramAccountType,
  IsoTimestamp,
  MetaAppId,
  ProxyId,
  SessionStatus,
} from "@scaleapp/domain";

interface AccountRow {
  id: string;
  handle: string;
  account_type: InstagramAccountType;
  lifecycle_state: AccountLifecycleState;
  health: AccountHealthStatus;
  meta_app_id: string;
  proxy_id: string;
  username: string;
  secret_ref: string | null;
  session_status: SessionStatus | null;
  access_token_ref: string | null;
  session_issued_at: Date | null;
  session_expires_at: Date | null;
  session_refreshed_at: Date | null;
  tags: string[];
  groups: string[];
  failover_priority: number;
  warmup_started_at: Date | null;
  warmup_completes_at: Date | null;
  warmup_completed: boolean | null;
  created_at: Date;
  updated_at: Date;
}

const ACCOUNT_COLUMNS = `
  id, handle, account_type, lifecycle_state, health, meta_app_id, proxy_id,
  username, secret_ref, session_status, access_token_ref, session_issued_at,
  session_expires_at, session_refreshed_at, tags, groups, failover_priority,
  warmup_started_at, warmup_completes_at, warmup_completed, created_at, updated_at
`;

const iso = (d: Date): IsoTimestamp => d.toISOString() as IsoTimestamp;

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id as AccountId,
    handle: r.handle,
    accountType: r.account_type,
    lifecycleState: r.lifecycle_state,
    health: r.health,
    metaAppId: r.meta_app_id as MetaAppId,
    proxyId: r.proxy_id as ProxyId,
    credentials: {
      username: r.username,
      ...(r.secret_ref !== null ? { secretRef: r.secret_ref } : {}),
    },
    ...(r.session_status !== null
      ? {
          session: {
            accessTokenRef: r.access_token_ref ?? "",
            status: r.session_status,
            ...(r.session_issued_at !== null ? { issuedAt: iso(r.session_issued_at) } : {}),
            ...(r.session_expires_at !== null ? { expiresAt: iso(r.session_expires_at) } : {}),
            ...(r.session_refreshed_at !== null ? { refreshedAt: iso(r.session_refreshed_at) } : {}),
          },
        }
      : {}),
    tags: r.tags,
    groups: r.groups,
    failoverPriority: r.failover_priority,
    ...(r.warmup_started_at !== null && r.warmup_completes_at !== null
      ? {
          warmup: {
            startedAt: iso(r.warmup_started_at),
            completesAt: iso(r.warmup_completes_at),
            completed: r.warmup_completed ?? false,
          },
        }
      : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface CreateAccountInput {
  readonly handle: string;
  readonly accountType: InstagramAccountType;
  readonly metaAppId: string;
  readonly proxyId: string;
  readonly username: string;
  readonly secretRef?: string;
  readonly tags?: readonly string[];
  readonly groups?: readonly string[];
  readonly failoverPriority?: number;
}

export interface ListAccountsParams {
  readonly limit: number;
  readonly offset: number;
}

export interface UpdateStatusInput {
  readonly lifecycleState?: AccountLifecycleState;
  readonly health?: AccountHealthStatus;
}

export class AccountRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAccountInput): Promise<Account> {
    const res = await this.pool.query<AccountRow>(
      `INSERT INTO accounts
         (handle, account_type, meta_app_id, proxy_id, username, secret_ref,
          tags, groups, failover_priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 100))
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        input.handle,
        input.accountType,
        input.metaAppId,
        input.proxyId,
        input.username,
        input.secretRef ?? null,
        input.tags ?? [],
        input.groups ?? [],
        input.failoverPriority ?? null,
      ],
    );
    return rowToAccount(res.rows[0]!);
  }

  async list(params: ListAccountsParams): Promise<Account[]> {
    const res = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS}
       FROM accounts
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [params.limit, params.offset],
    );
    return res.rows.map(rowToAccount);
  }

  async getById(id: string): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToAccount(res.rows[0]) : null;
  }

  async updateStatus(id: string, input: UpdateStatusInput): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `UPDATE accounts
       SET lifecycle_state = COALESCE($2, lifecycle_state),
           health          = COALESCE($3, health)
       WHERE id = $1
       RETURNING ${ACCOUNT_COLUMNS}`,
      [id, input.lifecycleState ?? null, input.health ?? null],
    );
    return res.rows[0] ? rowToAccount(res.rows[0]) : null;
  }

  /** Associa um proxy dedicado à conta e marca o proxy como atribuído (regra 10). */
  async setProxy(id: string, proxyId: string): Promise<Account | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<AccountRow>(
        `UPDATE accounts SET proxy_id = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [id, proxyId],
      );
      if (res.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE proxies
         SET assignment_state = 'assigned', assigned_account_id = $1
         WHERE id = $2`,
        [id, proxyId],
      );
      await client.query("COMMIT");
      return rowToAccount(res.rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async setMetaApp(id: string, metaAppId: string): Promise<Account | null> {
    const res = await this.pool.query<AccountRow>(
      `UPDATE accounts SET meta_app_id = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
      [id, metaAppId],
    );
    return res.rows[0] ? rowToAccount(res.rows[0]) : null;
  }
}
