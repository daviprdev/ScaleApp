/**
 * Acesso a dados do pool de proxies.
 *
 * Duas garantias moram aqui, no banco e não na aplicação:
 *  - regra 4: pegar um proxy do pool é um claim atômico
 *    (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`). Duas contas
 *    sendo provisionadas ao mesmo tempo nunca recebem o mesmo proxy — e é a
 *    unicidade de `accounts.proxy_id` que fecha a porta de vez.
 *  - regra 8: toda listagem tem `LIMIT` explícito.
 */

import type { Pool, PoolClient } from "pg";
import type {
  ProxyAssignmentState,
  ProxyHealthStatus,
  ProxyProtocol,
} from "@scaleapp/domain";

export type Executor = Pool | PoolClient;

export interface ProxyRecord {
  readonly id: string;
  readonly label: string | null;
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  readonly credentialsRef: string | null;
  readonly assignmentState: ProxyAssignmentState;
  readonly assignedAccountId: string | null;
  readonly health: ProxyHealthStatus;
  readonly consecutiveFailures: number;
  readonly lastCheckedAt: string | null;
  readonly lastLatencyMs: number | null;
  readonly lastError: string | null;
  readonly lastExitIp: string | null;
}

interface ProxyRow {
  id: string;
  label: string | null;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  credentials_ref: string | null;
  assignment_state: ProxyAssignmentState;
  assigned_account_id: string | null;
  health: ProxyHealthStatus;
  consecutive_failures: number;
  last_checked_at: Date | null;
  last_latency_ms: number | null;
  last_error: string | null;
  last_exit_ip: string | null;
}

const COLS = `
  id, label, protocol, host, port, credentials_ref, assignment_state,
  assigned_account_id, health, consecutive_failures, last_checked_at,
  last_latency_ms, last_error, last_exit_ip
`;

function toRecord(r: ProxyRow): ProxyRecord {
  return {
    id: r.id,
    label: r.label,
    protocol: r.protocol,
    host: r.host,
    port: r.port,
    credentialsRef: r.credentials_ref,
    assignmentState: r.assignment_state,
    assignedAccountId: r.assigned_account_id,
    health: r.health,
    consecutiveFailures: r.consecutive_failures,
    lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
    lastLatencyMs: r.last_latency_ms,
    lastError: r.last_error,
    lastExitIp: r.last_exit_ip,
  };
}

export interface CreateProxyInput {
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  /** Referência do cofre para `user:pass` — nunca a credencial em texto. */
  readonly credentialsRef?: string;
  readonly label?: string;
}

export interface ListProxiesOptions {
  /** Teto explícito (regra 8). */
  readonly limit: number;
  readonly offset?: number;
  readonly assignmentState?: ProxyAssignmentState;
  readonly health?: ProxyHealthStatus;
}

export interface CheckOutcome {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly exitIp?: string;
  readonly error?: string;
}

/** Proxies que compartilham IP de saída — sintoma de pool rotativo (regra 10). */
export interface SharedExitIp {
  readonly exitIp: string;
  readonly proxyIds: readonly string[];
}

export class ProxyRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateProxyInput, executor: Executor = this.pool): Promise<ProxyRecord> {
    const res = await executor.query<ProxyRow>(
      `INSERT INTO proxies (protocol, host, port, credentials_ref, label)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLS}`,
      [input.protocol, input.host, input.port, input.credentialsRef ?? null, input.label ?? null],
    );
    return toRecord(res.rows[0]!);
  }

  async getById(proxyId: string, executor: Executor = this.pool): Promise<ProxyRecord | null> {
    const res = await executor.query<ProxyRow>(
      `SELECT ${COLS} FROM proxies WHERE id = $1`,
      [proxyId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  async list(opts: ListProxiesOptions): Promise<readonly ProxyRecord[]> {
    const res = await this.pool.query<ProxyRow>(
      `SELECT ${COLS} FROM proxies
       WHERE ($1::text IS NULL OR assignment_state = $1)
         AND ($2::text IS NULL OR health = $2)
       ORDER BY created_at
       LIMIT $3 OFFSET $4`,
      [opts.assignmentState ?? null, opts.health ?? null, opts.limit, opts.offset ?? 0],
    );
    return res.rows.map(toRecord);
  }

  /**
   * Tira um proxy do pool para uma conta (regra 4). Prefere os saudáveis e,
   * entre eles, os mais antigos — evita concentrar uso nos recém-cadastrados.
   * Proxies `down` nunca são atribuídos: entregar um proxy morto a uma conta
   * nova só transfere o problema para o primeiro job dela.
   */
  async claimAvailable(
    accountId: string,
    executor: Executor = this.pool,
  ): Promise<ProxyRecord | null> {
    const res = await executor.query<ProxyRow>(
      `UPDATE proxies
       SET assignment_state = 'assigned',
           assigned_account_id = $1,
           assigned_at = now(),
           released_at = NULL
       WHERE id = (
         SELECT id FROM proxies
         WHERE assignment_state = 'available'
           AND health <> 'down'
         ORDER BY (health = 'healthy') DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
      [accountId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  /** Devolve o proxy ao pool (sem apagar histórico de saúde). */
  async release(proxyId: string, executor: Executor = this.pool): Promise<ProxyRecord | null> {
    const res = await executor.query<ProxyRow>(
      `UPDATE proxies
       SET assignment_state = 'available',
           assigned_account_id = NULL,
           released_at = now()
       WHERE id = $1 AND assignment_state <> 'retired'
       RETURNING ${COLS}`,
      [proxyId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  /** Aposenta o proxy: sai do pool e nunca mais é atribuído. */
  async retire(proxyId: string, executor: Executor = this.pool): Promise<ProxyRecord | null> {
    const res = await executor.query<ProxyRow>(
      `UPDATE proxies
       SET assignment_state = 'retired',
           assigned_account_id = NULL,
           released_at = now()
       WHERE id = $1
       RETURNING ${COLS}`,
      [proxyId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * Proxies a checar: os que nunca foram checados primeiro, depois os mais
   * desatualizados. Lote com teto explícito (regra 8) — com centenas de proxies,
   * checar "todos" é o mesmo que checar nenhum dentro do ciclo.
   */
  async findDueForCheck(limit: number, staleAfterMs: number): Promise<readonly ProxyRecord[]> {
    const res = await this.pool.query<ProxyRow>(
      `SELECT ${COLS} FROM proxies
       WHERE assignment_state IN ('available','assigned','reserved')
         AND (last_checked_at IS NULL
              OR last_checked_at <= now() - make_interval(secs => $1))
       ORDER BY last_checked_at ASC NULLS FIRST
       LIMIT $2`,
      [staleAfterMs / 1000, limit],
    );
    return res.rows.map(toRecord);
  }

  /**
   * Grava o resultado de uma checagem. `health` vem decidido de fora porque a
   * decisão depende do lote inteiro (regra 2: durante um outage do provedor,
   * nenhum proxy individual deve ser condenado).
   */
  async recordCheck(
    proxyId: string,
    outcome: CheckOutcome,
    health: ProxyHealthStatus,
    executor: Executor = this.pool,
  ): Promise<void> {
    await executor.query(
      `UPDATE proxies
       SET health = $2,
           last_checked_at = now(),
           last_latency_ms = $3,
           last_error = $4,
           last_exit_ip = COALESCE($5, last_exit_ip),
           consecutive_failures = CASE WHEN $6 THEN 0 ELSE consecutive_failures + 1 END
       WHERE id = $1`,
      [
        proxyId,
        health,
        outcome.latencyMs ?? null,
        outcome.error ?? null,
        outcome.exitIp ?? null,
        outcome.ok,
      ],
    );
  }

  /**
   * Falha observada em produção (job que quebrou com `ProxyError`), não numa
   * checagem sintética. Conta o strike e degrada; só a varredura decide `down`,
   * porque é ela que enxerga o lote e consegue distinguir outage.
   */
  async registerFailure(
    proxyId: string,
    error: string,
    executor: Executor = this.pool,
  ): Promise<void> {
    await executor.query(
      `UPDATE proxies
       SET consecutive_failures = consecutive_failures + 1,
           last_error = $2,
           health = CASE WHEN health = 'healthy' THEN 'degraded' ELSE health END
       WHERE id = $1`,
      [proxyId, error.slice(0, 500)],
    );
  }

  /**
   * IPs de saída repetidos entre proxies distintos. Um proxy "dedicado" que
   * divide IP com outro é rotativo/compartilhado na prática — exatamente o que
   * a regra 10 proíbe. Limitado (regra 8).
   */
  async findSharedExitIps(limit: number): Promise<readonly SharedExitIp[]> {
    const res = await this.pool.query<{ last_exit_ip: string; ids: string[] }>(
      `SELECT last_exit_ip, array_agg(id::text ORDER BY id) AS ids
       FROM proxies
       WHERE last_exit_ip IS NOT NULL AND assignment_state <> 'retired'
       GROUP BY last_exit_ip
       HAVING count(*) > 1
       ORDER BY count(*) DESC
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ exitIp: r.last_exit_ip, proxyIds: r.ids }));
  }

  /** Números do pool para o painel (uma linha só, sem varrer tabela inteira). */
  async stats(): Promise<Record<string, number>> {
    const res = await this.pool.query<{ assignment_state: string; health: string; n: number }>(
      `SELECT assignment_state, health, count(*)::int AS n
       FROM proxies GROUP BY assignment_state, health`,
    );
    const out: Record<string, number> = { total: 0 };
    for (const row of res.rows) {
      out.total = (out.total ?? 0) + row.n;
      out[`state:${row.assignment_state}`] = (out[`state:${row.assignment_state}`] ?? 0) + row.n;
      out[`health:${row.health}`] = (out[`health:${row.health}`] ?? 0) + row.n;
    }
    return out;
  }

  /** Quantos proxies o pool ainda tem para entregar (alerta de esgotamento). */
  async availableCount(): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM proxies
       WHERE assignment_state = 'available' AND health <> 'down'`,
    );
    return res.rows[0]?.n ?? 0;
  }
}
