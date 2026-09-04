/**
 * Helpers de teste de integração: conexão, seed do grafo de FKs
 * (meta_app → proxy → account → pipeline → execution) e utilidades de espera.
 *
 * Requer DATABASE_URL e REDIS_URL apontando para instâncias reais.
 */

import { randomUUID } from "node:crypto";
import type { Worker } from "bullmq";
import { createPool, type Pool } from "@scaleapp/db";
import { DriverClass, ExecutionTrigger } from "@scaleapp/domain";
import { InMemoryDriverRegistry, MockDriver } from "@scaleapp/driver-mock";
import { createRedis, type Redis } from "../src/connection.js";
import { createLogger } from "../src/logger.js";
import { ExecutionRepository } from "../src/executionRepository.js";
import { JobProducer } from "../src/producer.js";
import { createJobWorker } from "../src/worker.js";

export function dbUrl(): string {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("DATABASE_URL não definida");
  return u;
}

export function redisUrl(): string {
  const u = process.env.REDIS_URL;
  if (!u) throw new Error("REDIS_URL não definida");
  return u;
}

export function newPool(): Pool {
  return createPool(dbUrl());
}

export function uniqueKey(prefix = "idem"): string {
  return `${prefix}-${randomUUID()}`;
}

export function testPrefix(): string {
  return `scaleapp:test:${randomUUID().slice(0, 8)}`;
}

export interface SeedRefs {
  readonly metaAppId: string;
  readonly proxyId: string;
  readonly accountId: string;
  readonly pipelineId: string;
  readonly executionId: string;
}

/** Cria todo o grafo de FKs necessário para inserir e processar um job. */
export async function seedGraph(pool: Pool): Promise<SeedRefs> {
  const s = randomUUID().slice(0, 8);

  const meta = await pool.query<{ id: string }>(
    `INSERT INTO meta_apps (label, client_id, secret_ref) VALUES ($1, $2, $3) RETURNING id`,
    [`meta-${s}`, `client-${s}`, "vault://meta"],
  );
  const metaAppId = meta.rows[0]!.id;

  const proxy = await pool.query<{ id: string }>(
    `INSERT INTO proxies (protocol, host, port, credentials_ref)
     VALUES ('http', $1, 8080, 'vault://proxy') RETURNING id`,
    [`proxy-${s}.example`],
  );
  const proxyId = proxy.rows[0]!.id;

  const account = await pool.query<{ id: string }>(
    `INSERT INTO accounts
       (handle, account_type, meta_app_id, proxy_id, username, access_token_ref, session_status)
     VALUES ($1, 'business', $2, $3, $1, 'vault://token', 'valid') RETURNING id`,
    [`acc-${s}`, metaAppId, proxyId],
  );
  const accountId = account.rows[0]!.id;

  const pipeline = await pool.query<{ id: string }>(
    `INSERT INTO pipelines (name) VALUES ($1) RETURNING id`,
    [`pipeline-${s}`],
  );
  const pipelineId = pipeline.rows[0]!.id;

  const executionId = await new ExecutionRepository(pool).create({
    pipelineId,
    trigger: ExecutionTrigger.Manual,
    targetAccountIds: [accountId],
  });

  return { metaAppId, proxyId, accountId, pipelineId, executionId };
}

export interface Harness {
  readonly pool: Pool;
  readonly mock: MockDriver;
  readonly registry: InMemoryDriverRegistry;
  readonly producer: JobProducer;
  readonly prefix: string;
  /** Cria um worker (nova conexão Redis) e registra para cleanup. */
  makeWorker: (workerId: string, leaseSeconds?: number) => Worker;
  closeAll: () => Promise<void>;
}

/**
 * Monta um ambiente isolado (prefixo Redis único, um mock, um producer) e
 * permite criar N workers. `closeAll` encerra tudo com ordem segura.
 */
export function makeHarness(driverClass: DriverClass = DriverClass.GraphApi): Harness {
  const pool = newPool();
  const mock = new MockDriver(driverClass);
  const registry = new InMemoryDriverRegistry();
  registry.register(mock);
  const prefix = testPrefix();

  const producerConn = createRedis(redisUrl());
  const producer = new JobProducer(producerConn, { prefix });

  const logger = createLogger("test", process.env.TEST_LOG_LEVEL ?? "warn");
  const workers: Worker[] = [];
  const workerConns: Redis[] = [];

  const makeWorker = (workerId: string, leaseSeconds = 60): Worker => {
    const connection = createRedis(redisUrl());
    workerConns.push(connection);
    const worker = createJobWorker({
      pool,
      connection,
      registry,
      driverClass,
      logger,
      workerId,
      concurrency: 5,
      leaseSeconds,
      prefix,
    });
    workers.push(worker);
    return worker;
  };

  const closeAll = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.close()));
    await producer.close();
    await Promise.all([producerConn, ...workerConns].map((c) => c.quit()));
    await pool.end();
  };

  return { pool, mock, registry, producer, prefix, makeWorker, closeAll };
}

/** Faz polling até `fn` retornar valor não-nulo, ou lança em timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: timeout após ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
