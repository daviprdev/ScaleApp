/**
 * Harness dos testes de orquestração: sobe Postgres+Redis reais, um worker da
 * Fase 03 (com driver mock) e permite criar N instâncias do Orchestrator sobre
 * o mesmo banco. Também ajuda a montar pipelines e a esperar por estados.
 *
 * Requer DATABASE_URL e REDIS_URL apontando para instâncias reais.
 */

import { randomUUID } from "node:crypto";
import type { Worker } from "bullmq";
import { createPool, type Pool } from "@scaleapp/db";
import {
  type MediaId,
  type PipelineOperation,
  PipelineOperationType,
  type PipelineStep,
  type PipelineStepId,
  StepConditionType,
  DriverClass,
} from "@scaleapp/domain";
import { InMemoryDriverRegistry, MockDriver, type MockDirective } from "@scaleapp/driver-mock";
import { JobProducer, createJobWorker, createLogger, createRedis, type Redis } from "@scaleapp/execution";
import { PipelineOrchestrator } from "../src/orchestrator.js";
import { PipelineRepository } from "../src/pipelineRepository.js";

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

export async function seedAccount(pool: Pool): Promise<string> {
  const s = randomUUID().slice(0, 8);
  const meta = await pool.query<{ id: string }>(
    `INSERT INTO meta_apps (label, client_id, secret_ref) VALUES ($1, $2, 'v') RETURNING id`,
    [`m-${s}`, `c-${s}`],
  );
  const proxy = await pool.query<{ id: string }>(
    `INSERT INTO proxies (protocol, host, port) VALUES ('http', $1, 8080) RETURNING id`,
    [`p-${s}.example`],
  );
  const acc = await pool.query<{ id: string }>(
    `INSERT INTO accounts (handle, account_type, meta_app_id, proxy_id, username, access_token_ref, session_status)
     VALUES ($1, 'business', $2, $3, $1, 'v', 'valid') RETURNING id`,
    [`a-${s}`, meta.rows[0]!.id, proxy.rows[0]!.id],
  );
  return acc.rows[0]!.id;
}

// --- Builders de pipeline -------------------------------------------------

export function publishPost(mediaIds: string[], mock?: MockDirective): PipelineOperation {
  const op: Record<string, unknown> = {
    type: PipelineOperationType.PublishPost,
    mediaIds: mediaIds as unknown as MediaId[],
  };
  if (mock) op.__mock = mock;
  return op as unknown as PipelineOperation;
}

export function warmup(mock?: MockDirective): PipelineOperation {
  const op: Record<string, unknown> = { type: PipelineOperationType.Warmup, dailyActionBudget: 3 };
  if (mock) op.__mock = mock;
  return op as unknown as PipelineOperation;
}

export function step(
  id: string,
  operation: PipelineOperation,
  condition: StepConditionType = StepConditionType.OnPreviousSuccess,
): PipelineStep {
  return { id: id as PipelineStepId, operation, condition };
}

// --- Harness --------------------------------------------------------------

export interface OrchHarness {
  readonly pool: Pool;
  readonly mock: MockDriver;
  readonly producer: JobProducer;
  readonly prefix: string;
  readonly pipelineRepo: PipelineRepository;
  /** Cria uma instância do Orchestrator (simula um processo/worker distinto). */
  newOrchestrator: (orchestratorId: string) => PipelineOrchestrator;
  /** Sobe o worker BullMQ que processa os jobs das etapas. */
  startWorker: () => Worker;
  closeAll: () => Promise<void>;
}

export function makeOrchHarness(): OrchHarness {
  const pool = createPool(dbUrl());
  const mock = new MockDriver(DriverClass.GraphApi);
  const registry = new InMemoryDriverRegistry();
  registry.register(mock);
  const prefix = `scaleapp:orch:${randomUUID().slice(0, 8)}`;
  const logger = createLogger("orch-test", process.env.TEST_LOG_LEVEL ?? "warn");

  const producerConn = createRedis(redisUrl());
  const producer = new JobProducer(producerConn, { prefix });
  const pipelineRepo = new PipelineRepository(pool);

  const workers: Worker[] = [];
  const workerConns: Redis[] = [];

  const startWorker = (): Worker => {
    const connection = createRedis(redisUrl());
    workerConns.push(connection);
    const worker = createJobWorker({
      pool,
      connection,
      registry,
      driverClass: DriverClass.GraphApi,
      logger,
      workerId: `w-${workers.length}`,
      concurrency: 5,
      prefix,
    });
    workers.push(worker);
    return worker;
  };

  const newOrchestrator = (orchestratorId: string): PipelineOrchestrator =>
    new PipelineOrchestrator({ pool, producer, logger, orchestratorId });

  const closeAll = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.close()));
    await producer.close();
    await Promise.all([producerConn, ...workerConns].map((c) => c.quit()));
    await pool.end();
  };

  return { pool, mock, producer, prefix, pipelineRepo, newOrchestrator, startWorker, closeAll };
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 20_000,
  intervalMs = 80,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`waitFor: timeout após ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
