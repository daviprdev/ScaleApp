import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registerAccountRoutes } from "./routes/accounts.js";

/** Monta a instância Fastify com as rotas, dado um pool já criado. */
export function buildServer(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", db: "up" };
    } catch {
      return reply.code(503).send({ status: "degraded", db: "down" });
    }
  });

  registerAccountRoutes(app, pool);

  return app;
}
