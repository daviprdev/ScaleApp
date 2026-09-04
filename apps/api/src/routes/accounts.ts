/**
 * Rotas do Account Registry (CRUD mínimo, sem auth ainda — auth entra em fase
 * posterior). Validação via JSON schema do Fastify, com os enums vindos direto
 * de @scaleapp/domain para não divergir do contrato nem do schema SQL.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  AccountHealthStatus,
  AccountLifecycleState,
  InstagramAccountType,
} from "@scaleapp/domain";
import {
  AccountRepository,
  type CreateAccountInput,
  type UpdateStatusInput,
} from "../repositories/accountRepository.js";

const accountTypes = Object.values(InstagramAccountType);
const lifecycleStates = Object.values(AccountLifecycleState);
const healthStatuses = Object.values(AccountHealthStatus);

interface PgLikeError {
  code?: string;
  constraint?: string;
}

/** Mapeia erros conhecidos do Postgres para respostas HTTP; senão devolve null. */
function pgErrorResponse(err: unknown): { status: number; error: string } | null {
  const e = err as PgLikeError;
  switch (e.code) {
    case "23505":
      return { status: 409, error: `conflito de unicidade${e.constraint ? ` (${e.constraint})` : ""}` };
    case "23503":
      return { status: 400, error: "referência inválida: meta_app_id ou proxy_id não existe" };
    case "23514":
      return { status: 400, error: "valor viola constraint de checagem" };
    case "22P02":
      return { status: 400, error: "identificador inválido (uuid malformado)" };
    default:
      return null;
  }
}

interface CreateBody {
  handle: string;
  accountType: InstagramAccountType;
  metaAppId: string;
  proxyId: string;
  username: string;
  secretRef?: string;
  tags?: string[];
  groups?: string[];
  failoverPriority?: number;
}

interface StatusBody {
  lifecycleState?: AccountLifecycleState;
  health?: AccountHealthStatus;
}

export function registerAccountRoutes(app: FastifyInstance, pool: Pool): void {
  const repo = new AccountRepository(pool);

  // Criar conta
  app.post<{ Body: CreateBody }>(
    "/accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["handle", "accountType", "metaAppId", "proxyId", "username"],
          additionalProperties: false,
          properties: {
            handle: { type: "string", minLength: 1 },
            accountType: { type: "string", enum: accountTypes },
            metaAppId: { type: "string", minLength: 1 },
            proxyId: { type: "string", minLength: 1 },
            username: { type: "string", minLength: 1 },
            secretRef: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            groups: { type: "array", items: { type: "string" } },
            failoverPriority: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const b = req.body;
        const input: CreateAccountInput = {
          handle: b.handle,
          accountType: b.accountType,
          metaAppId: b.metaAppId,
          proxyId: b.proxyId,
          username: b.username,
          ...(b.secretRef !== undefined ? { secretRef: b.secretRef } : {}),
          ...(b.tags !== undefined ? { tags: b.tags } : {}),
          ...(b.groups !== undefined ? { groups: b.groups } : {}),
          ...(b.failoverPriority !== undefined ? { failoverPriority: b.failoverPriority } : {}),
        };
        const account = await repo.create(input);
        return reply.code(201).send(account);
      } catch (err) {
        const mapped = pgErrorResponse(err);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
        throw err;
      }
    },
  );

  // Listar contas (sempre limitado — regra 8)
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    "/accounts",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 50;
      const offset = req.query.offset ?? 0;
      const items = await repo.list({ limit, offset });
      return { items, limit, offset };
    },
  );

  // Detalhe de uma conta
  app.get<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
    try {
      const account = await repo.getById(req.params.id);
      if (!account) return reply.code(404).send({ error: "conta não encontrada" });
      return account;
    } catch (err) {
      const mapped = pgErrorResponse(err);
      if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
      throw err;
    }
  });

  // Atualizar status/health
  app.patch<{ Params: { id: string }; Body: StatusBody }>(
    "/accounts/:id/status",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            lifecycleState: { type: "string", enum: lifecycleStates },
            health: { type: "string", enum: healthStatuses },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const input: UpdateStatusInput = {
        ...(b.lifecycleState !== undefined ? { lifecycleState: b.lifecycleState } : {}),
        ...(b.health !== undefined ? { health: b.health } : {}),
      };
      const account = await repo.updateStatus(req.params.id, input);
      if (!account) return reply.code(404).send({ error: "conta não encontrada" });
      return account;
    },
  );

  // Associar proxy
  app.patch<{ Params: { id: string }; Body: { proxyId: string } }>(
    "/accounts/:id/proxy",
    {
      schema: {
        body: {
          type: "object",
          required: ["proxyId"],
          additionalProperties: false,
          properties: { proxyId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const account = await repo.setProxy(req.params.id, req.body.proxyId);
        if (!account) return reply.code(404).send({ error: "conta não encontrada" });
        return account;
      } catch (err) {
        const mapped = pgErrorResponse(err);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
        throw err;
      }
    },
  );

  // Associar Meta App
  app.patch<{ Params: { id: string }; Body: { metaAppId: string } }>(
    "/accounts/:id/meta-app",
    {
      schema: {
        body: {
          type: "object",
          required: ["metaAppId"],
          additionalProperties: false,
          properties: { metaAppId: { type: "string", minLength: 1 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const account = await repo.setMetaApp(req.params.id, req.body.metaAppId);
        if (!account) return reply.code(404).send({ error: "conta não encontrada" });
        return account;
      } catch (err) {
        const mapped = pgErrorResponse(err);
        if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
        throw err;
      }
    },
  );
}
