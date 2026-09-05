/**
 * Rotas do Proxy/Network Manager (módulo 9): cadastro no pool, atribuição,
 * saúde e o diagnóstico de IP compartilhado.
 *
 * Credencial de proxy entra por aqui em texto (é o único jeito de cadastrar) e
 * sai daqui como referência do cofre — nenhuma resposta devolve `user:pass`.
 * Sem `SECRETS_KEYS`, cadastrar proxy COM credencial é recusado com 503; o
 * resto do pool continua operando.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  ProxyAssignmentState,
  ProxyHealthStatus,
  ProxyProtocol,
} from "@scaleapp/domain";
import { UndiciHttpClient } from "@scaleapp/driver-graph";
import {
  PoolProxyResolver,
  ProxyAssignmentService,
  ProxyPoolExhaustedError,
  ProxyRepository,
  decideHealth,
  loadProxyConfig,
  probeProxy,
} from "@scaleapp/proxy";
import { Keyring, PostgresSecretVault } from "@scaleapp/session";

const protocols = Object.values(ProxyProtocol);
const assignmentStates = Object.values(ProxyAssignmentState);
const healthStatuses = Object.values(ProxyHealthStatus);

interface CreateBody {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  /** `user:pass`. Vai para o cofre; nunca é persistido em texto. */
  credentials?: string;
  label?: string;
}

export function registerProxyRoutes(app: FastifyInstance, pool: Pool): void {
  const repo = new ProxyRepository(pool);
  const assignments = new ProxyAssignmentService(pool);
  const config = loadProxyConfig();

  const keyring = Keyring.fromEnv();
  const vault = keyring ? new PostgresSecretVault(pool, keyring) : null;
  const secrets = vault ?? {
    // Sem cofre: só resolve credencial literal (modo dev), igual ao worker.
    async get(ref: string) {
      return ref.startsWith("vault://") ? null : ref;
    },
  };
  const resolver = new PoolProxyResolver(pool, secrets, { cacheTtlMs: 0 });

  // Cadastrar proxy no pool
  app.post<{ Body: CreateBody }>(
    "/proxies",
    {
      schema: {
        body: {
          type: "object",
          required: ["protocol", "host", "port"],
          additionalProperties: false,
          properties: {
            protocol: { type: "string", enum: protocols },
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            credentials: { type: "string", minLength: 1 },
            label: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (b.credentials && !vault) {
        return reply
          .code(503)
          .send({ error: "cofre indisponível: defina SECRETS_KEYS para cadastrar credencial" });
      }
      const credentialsRef = b.credentials
        ? await vault!.put("proxy_credentials", b.credentials)
        : undefined;

      const proxy = await repo.create({
        protocol: b.protocol,
        host: b.host,
        port: b.port,
        ...(credentialsRef ? { credentialsRef } : {}),
        ...(b.label !== undefined ? { label: b.label } : {}),
      });
      return reply.code(201).send(proxy);
    },
  );

  // Listar (sempre limitado — regra 8)
  app.get<{
    Querystring: {
      limit?: number;
      offset?: number;
      assignmentState?: ProxyAssignmentState;
      health?: ProxyHealthStatus;
    };
  }>(
    "/proxies",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
            assignmentState: { type: "string", enum: assignmentStates },
            health: { type: "string", enum: healthStatuses },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const items = await repo.list({
        limit,
        offset,
        ...(req.query.assignmentState ? { assignmentState: req.query.assignmentState } : {}),
        ...(req.query.health ? { health: req.query.health } : {}),
      });
      return { items, limit, offset };
    },
  );

  app.get("/proxies/stats", async () => {
    const [stats, available] = await Promise.all([repo.stats(), repo.availableCount()]);
    return { ...stats, available, lowPool: available < config.lowPoolThreshold };
  });

  // Diagnóstico da regra 10: proxies "dedicados" dividindo IP de saída.
  app.get("/proxies/diagnostics/shared-exit-ips", async () => {
    const shared = await repo.findSharedExitIps(50);
    return { items: shared, count: shared.length };
  });

  // Reserva um proxy para o cadastro de uma conta nova (accounts.proxy_id é
  // NOT NULL, então o proxy precisa existir antes da conta).
  app.post("/proxies/reserve", async (_req, reply) => {
    try {
      return await assignments.reserveForNewAccount();
    } catch (err) {
      if (err instanceof ProxyPoolExhaustedError) {
        return reply.code(409).send({ error: err.message, code: "POOL_EXHAUSTED" });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/proxies/:id", async (req, reply) => {
    const proxy = await repo.getById(req.params.id);
    if (!proxy) return reply.code(404).send({ error: "proxy não encontrado" });
    return proxy;
  });

  app.post<{ Params: { id: string } }>("/proxies/:id/release", async (req, reply) => {
    const proxy = await repo.release(req.params.id);
    if (!proxy) return reply.code(404).send({ error: "proxy não encontrado ou aposentado" });
    return proxy;
  });

  app.post<{ Params: { id: string } }>("/proxies/:id/retire", async (req, reply) => {
    const proxy = await repo.retire(req.params.id);
    if (!proxy) return reply.code(404).send({ error: "proxy não encontrado" });
    return proxy;
  });

  // Checagem sob demanda. Um proxy só: não há lote para inferir outage, então a
  // decisão é individual — por isso o resultado vale menos que o da varredura
  // e não deve ser usado para condenar em massa.
  app.post<{ Params: { id: string } }>("/proxies/:id/check", async (req, reply) => {
    const proxy = await repo.getById(req.params.id);
    if (!proxy) return reply.code(404).send({ error: "proxy não encontrado" });

    const connection = await resolver.resolveProxy(proxy.id);
    const outcome = connection
      ? await probeProxy(new UndiciHttpClient(), connection.url, config.health)
      : { ok: false, error: "proxy não resolvível (credencial ou estado)" };

    const health = decideHealth(outcome, proxy.consecutiveFailures, config.health, false);
    await repo.recordCheck(proxy.id, outcome, health);
    return { proxyId: proxy.id, health, ...outcome };
  });

  // Troca o proxy da conta por outro do pool (failover de IP).
  app.post<{ Params: { id: string }; Body: { retireOld?: boolean } }>(
    "/accounts/:id/proxy/swap",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { retireOld: { type: "boolean", default: false } },
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await assignments.swapForAccount(
          req.params.id,
          req.body?.retireOld ?? false,
        );
        return result;
      } catch (err) {
        if (err instanceof ProxyPoolExhaustedError) {
          return reply.code(409).send({ error: err.message, code: "POOL_EXHAUSTED" });
        }
        if (err instanceof Error && err.message.includes("não existe")) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
