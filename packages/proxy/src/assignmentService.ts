/**
 * Atribuição de proxy a conta. Proxy dedicado é obrigatório (regra 10), então
 * este serviço tem uma responsabilidade só: garantir que cada conta tenha um
 * proxy exclusivo e vivo, e trocar quando o atual morre.
 *
 * A troca acontece numa transação. Fora dela, uma falha no meio deixaria a
 * conta apontando para um proxy já liberado (que outra conta pode ter pegado)
 * — dois perfis saindo pelo mesmo IP é exatamente o cenário que a regra 10
 * existe para impedir.
 */

import type { Pool } from "pg";
import { ProxyRepository, type ProxyRecord } from "./proxyRepository.js";

export class ProxyPoolExhaustedError extends Error {
  constructor(readonly accountId?: string) {
    super(
      accountId
        ? `pool sem proxy disponível para a conta ${accountId}`
        : "pool sem proxy disponível",
    );
    this.name = "ProxyPoolExhaustedError";
  }
}

export interface ProxySwapResult {
  readonly accountId: string;
  readonly newProxy: ProxyRecord;
  readonly releasedProxyId: string | null;
}

export class ProxyAssignmentService {
  private readonly repo: ProxyRepository;

  constructor(private readonly pool: Pool) {
    this.repo = new ProxyRepository(pool);
  }

  /**
   * Troca o proxy da conta por um novo do pool e devolve o antigo.
   * `retireOld=true` quando o motivo da troca é o proxy estar morto — nesse
   * caso ele não pode voltar ao pool para envenenar a próxima conta.
   */
  async swapForAccount(accountId: string, retireOld = false): Promise<ProxySwapResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const current = await client.query<{ proxy_id: string }>(
        `SELECT proxy_id FROM accounts WHERE id = $1 FOR UPDATE`,
        [accountId],
      );
      const oldProxyId = current.rows[0]?.proxy_id ?? null;
      if (current.rows.length === 0) {
        throw new Error(`conta ${accountId} não existe`);
      }

      const claimed = await this.repo.claimAvailable(accountId, client);
      if (!claimed) throw new ProxyPoolExhaustedError(accountId);

      await client.query(`UPDATE accounts SET proxy_id = $2 WHERE id = $1`, [
        accountId,
        claimed.id,
      ]);

      if (oldProxyId && oldProxyId !== claimed.id) {
        if (retireOld) await this.repo.retire(oldProxyId, client);
        else await this.repo.release(oldProxyId, client);
      }

      await client.query(
        `INSERT INTO audit_log (entity_type, entity_id, event, data)
         VALUES ('account', $1, $2, $3::jsonb)`,
        [
          accountId,
          retireOld ? "proxy_swapped_after_failure" : "proxy_swapped",
          JSON.stringify({ from: oldProxyId, to: claimed.id }),
        ],
      );

      await client.query("COMMIT");
      return { accountId, newProxy: claimed, releasedProxyId: oldProxyId };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reserva um proxy antes de a conta existir. `accounts.proxy_id` é NOT NULL,
   * então o cadastro precisa de um proxy em mãos; reservar (em vez de deixar
   * `available`) impede que outra criação concorrente pegue o mesmo.
   */
  async reserveForNewAccount(): Promise<ProxyRecord> {
    const res = await this.pool.query<{ id: string }>(
      `UPDATE proxies
       SET assignment_state = 'reserved'
       WHERE id = (
         SELECT id FROM proxies
         WHERE assignment_state = 'available' AND health <> 'down'
         ORDER BY (health = 'healthy') DESC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id`,
    );
    const id = res.rows[0]?.id;
    if (!id) throw new ProxyPoolExhaustedError();
    const proxy = await this.repo.getById(id);
    if (!proxy) throw new ProxyPoolExhaustedError();
    return proxy;
  }

  /** Confirma a reserva depois que a conta foi criada apontando para o proxy. */
  async confirmReservation(proxyId: string, accountId: string): Promise<void> {
    await this.pool.query(
      `UPDATE proxies
       SET assignment_state = 'assigned', assigned_account_id = $2, assigned_at = now()
       WHERE id = $1 AND assignment_state = 'reserved'`,
      [proxyId, accountId],
    );
  }

  /** Desfaz uma reserva que não virou conta (cadastro abortado). */
  async cancelReservation(proxyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE proxies
       SET assignment_state = 'available'
       WHERE id = $1 AND assignment_state = 'reserved'`,
      [proxyId],
    );
  }

  /**
   * Reconcilia os dois lados do vínculo. Eles podem divergir se alguém editar
   * `accounts.proxy_id` direto no banco (o cadastro de conta faz isso hoje):
   * o proxy apontado pela conta é a verdade; o resto do pool é corrigido.
   * Lote limitado (regra 8).
   */
  async reconcileAssignments(limit: number): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      `WITH alvo AS (
         SELECT p.id, a.id AS account_id
         FROM proxies p
         JOIN accounts a ON a.proxy_id = p.id
         WHERE p.assignment_state <> 'assigned'
            OR p.assigned_account_id IS DISTINCT FROM a.id
         ORDER BY p.created_at
         LIMIT $1
       )
       UPDATE proxies p
       SET assignment_state = 'assigned',
           assigned_account_id = alvo.account_id,
           assigned_at = COALESCE(p.assigned_at, now())
       FROM alvo
       WHERE p.id = alvo.id AND p.assignment_state <> 'retired'
       RETURNING p.id`,
      [limit],
    );
    return res.rows.length;
  }
}
