/**
 * Composition root do worker: liga o driver mock (Execution Plane) à porta e
 * sobe um worker BullMQ por classe de driver configurada. É aqui — e só aqui —
 * que o concreto encontra o Control Plane.
 */

import { createPool } from "@scaleapp/db";
import { InMemoryDriverRegistry, MockDriver } from "@scaleapp/driver-mock";
import { createJobWorker, createLogger, createRedis, type Redis } from "@scaleapp/execution";
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

  logger.info(
    { workerId: config.workerId, driverClasses: config.driverClasses, concurrency: config.concurrency },
    "workers iniciados",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "encerrando workers...");
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
