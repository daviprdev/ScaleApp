/**
 * Composition root do worker: liga o driver mock (Execution Plane) à porta e
 * sobe um worker BullMQ por classe de driver configurada. É aqui — e só aqui —
 * que o concreto encontra o Control Plane.
 *
 * Também expõe /metrics (Prometheus): métricas de processo, de job (via
 * @scaleapp/execution instrumentado) e de profundidade de fila.
 */

import { createPool } from "@scaleapp/db";
import { InMemoryDriverRegistry, MockDriver } from "@scaleapp/driver-mock";
import {
  createJobWorker,
  createLogger,
  createRedis,
  queueName,
  type Redis,
} from "@scaleapp/execution";
import {
  initDefaultMetrics,
  registerQueueMetrics,
  startMetricsServer,
} from "@scaleapp/observability";
import { Queue } from "bullmq";
import { loadWorkerConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const logger = createLogger("worker");
  const pool = createPool(config.databaseUrl);

  // Registry com um driver mock por classe configurada.
  const registry = new InMemoryDriverRegistry();
  for (const driverClass of config.driverClasses) {
    registry.register(new MockDriver(driverClass));
  }

  const connections: Redis[] = [];
  const workers = config.driverClasses.map((driverClass) => {
    const connection = createRedis(config.redisUrl);
    connections.push(connection);
    return createJobWorker({
      pool,
      connection,
      registry,
      driverClass,
      logger,
      workerId: `${config.workerId}:${driverClass}`,
      concurrency: config.concurrency,
    });
  });

  // Observabilidade: métricas de processo + profundidade de fila por classe.
  initDefaultMetrics();
  const metricsConnection = createRedis(config.redisUrl);
  connections.push(metricsConnection);
  const queues = new Map(
    config.driverClasses.map((driverClass) => [
      driverClass,
      new Queue(queueName(driverClass), { connection: metricsConnection }),
    ]),
  );
  registerQueueMetrics({ queues });
  const metricsServer = await startMetricsServer({ port: config.metricsPort });

  logger.info(
    {
      workerId: config.workerId,
      driverClasses: config.driverClasses,
      concurrency: config.concurrency,
      metricsPort: config.metricsPort,
    },
    "workers iniciados",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "encerrando workers...");
    metricsServer.close();
    await Promise.all([...queues.values()].map((q) => q.close()));
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(connections.map((c) => c.quit()));
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error("falha ao iniciar worker:", err);
  process.exit(1);
});
