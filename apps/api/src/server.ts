import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  initDefaultMetrics,
  metricsText,
  recordHttpRequest,
  registryContentType,
} from "@scaleapp/observability";
import type { Pool } from "pg";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerProxyRoutes } from "./routes/proxies.js";
import { registerSessionRoutes, type SessionRoutesConfig } from "./routes/session.js";

/** Monta a instância Fastify com as rotas, dado um pool já criado. */
export function buildServer(pool: Pool, sessionConfig: SessionRoutesConfig): FastifyInstance {
  const app = Fastify({ logger: true });

  // Métricas de processo (heap, event loop, CPU) neste processo da API.
  initDefaultMetrics();

  // Instrumenta toda requisição: conta e cronometra por rota lógica (routerPath
  // evita explosão de cardinalidade com ids na URL).
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? req.url;
    const durationSeconds = reply.elapsedTime / 1000;
    recordHttpRequest(req.method, route, reply.statusCode, durationSeconds);
  });

  app.get("/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", db: "up" };
    } catch {
      return reply.code(503).send({ status: "degraded", db: "down" });
    }
  });

  // Endpoint de scrape do Prometheus.
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registryContentType);
    return metricsText();
  });

  registerAccountRoutes(app, pool);
  registerSessionRoutes(app, pool, sessionConfig);
  registerProxyRoutes(app, pool);

  return app;
}
