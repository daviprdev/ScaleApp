/**
 * Worker: consome jobs do BullMQ e roda o ciclo completo de execução.
 *
 * Ciclo por entrega do BullMQ:
 *  1. claim atômico por id no Postgres (regra 4). Se não reivindicar, é skip
 *     idempotente — outra entrega/worker já tratou (não reprocessa).
 *  2. marca `running`, resolve o contexto (conta → App/proxy/token) e chama o
 *     driver via a porta `AutomationDriver` (Control Plane não conhece o driver
 *     concreto).
 *  3. sucesso → persiste resultado (`succeeded`) e recomputa a execução.
 *  4. falha retryável com tentativas restantes → `retrying` e relança (BullMQ
 *     reagenda com backoff derivado do `RetryPolicy`).
 *  5. falha retryável sem tentativas → `dead_letter`.
 *  6. falha não-retryável → `failed` + `UnrecoverableError` (BullMQ não retenta).
 */

import { UnrecoverableError, Worker } from "bullmq";
import type { Job as BullJob } from "bullmq";
import type {
  AccountId,
  DriverCapabilityRegistry,
  DriverClass,
  DriverExecutionContext,
  DriverOperationKind,
  DriverOperationPayloadMap,
  DriverOperationRequest,
  IdempotencyKey,
  JobId,
  MetaAppId,
  ProxyId,
} from "@scaleapp/domain";
import { recordJobProcessed, startJobTimer } from "@scaleapp/observability";
import type { Pool } from "pg";
import { computeBackoff } from "./backoff.js";
import type { Redis } from "./connection.js";
import { ExecutionRepository } from "./executionRepository.js";
import { JobRepository } from "./jobRepository.js";
import type { Logger } from "./logger.js";
import { queueName, type JobQueueData } from "./queue.js";

export interface CreateJobWorkerOptions {
  readonly pool: Pool;
  readonly connection: Redis;
  readonly registry: DriverCapabilityRegistry;
  readonly driverClass: DriverClass;
  readonly logger: Logger;
  readonly workerId: string;
  readonly concurrency?: number;
  readonly leaseSeconds?: number;
  /** Prefixo das chaves Redis (isolamento de ambiente/teste). */
  readonly prefix?: string;
}

export function createJobWorker(opts: CreateJobWorkerOptions): Worker<JobQueueData> {
  const {
    pool,
    connection,
    registry,
    driverClass,
    logger,
    workerId,
    concurrency = 5,
    leaseSeconds = 60,
    prefix,
  } = opts;

  const jobRepo = new JobRepository(pool);
  const executionRepo = new ExecutionRepository(pool);

  const processor = async (bullJob: BullJob<JobQueueData>): Promise<unknown> => {
    const dbJobId = bullJob.data.dbJobId;
    const log = logger.child({
      workerId,
      driverClass,
      dbJobId,
      bullJobId: bullJob.id,
      attemptsMade: bullJob.attemptsMade,
    });

    // Cronômetro da entrega; o desfecho e a operação são conhecidos adiante.
    const endTimer = startJobTimer(driverClass);

    // 1. Claim atômico.
    const claimed = await jobRepo.claimById(dbJobId, workerId, leaseSeconds);
    if (!claimed) {
      const current = await jobRepo.getById(dbJobId);
      endTimer({ operation_kind: current?.operationKind ?? "unknown", outcome: "skipped" });
      recordJobProcessed(driverClass, "skipped");
      if (current?.status === "succeeded") {
        log.info("job já concluído anteriormente — skip idempotente");
        return current.result;
      }
      log.warn({ currentStatus: current?.status }, "job não reivindicável — skip");
      return undefined;
    }
    log.info({ attempts: claimed.attempts }, "job reivindicado (claimed)");

    // 2. Marca running, resolve contexto e driver.
    await jobRepo.markRunning(dbJobId);

    const contextRow = await jobRepo.loadDriverContext(dbJobId);
    if (!contextRow) {
      throw new UnrecoverableError(`conta do job ${dbJobId} não encontrada`);
    }

    const driver = registry.get(driverClass);
    if (!driver) {
      throw new Error(`nenhum driver registrado para a classe ${driverClass}`);
    }

    const context: DriverExecutionContext = {
      accountId: contextRow.accountId as AccountId,
      metaAppId: contextRow.metaAppId as MetaAppId,
      proxyId: contextRow.proxyId as ProxyId,
      accessTokenRef: contextRow.accessTokenRef ?? "mock-token",
    };

    const request: DriverOperationRequest<DriverOperationKind> = {
      jobId: claimed.id as JobId,
      idempotencyKey: claimed.idempotencyKey as IdempotencyKey,
      kind: claimed.operationKind,
      context,
      payload: claimed.payload as unknown as DriverOperationPayloadMap[DriverOperationKind],
    };

    log.info({ kind: request.kind }, "executando driver");
    const result = await driver.execute(request);

    const operationKind = claimed.operationKind;

    // 3. Sucesso.
    if (result.ok) {
      await jobRepo.markSucceeded(dbJobId, result.value);
      await executionRepo.recompute(claimed.executionId);
      endTimer({ operation_kind: operationKind, outcome: "succeeded" });
      recordJobProcessed(driverClass, "succeeded");
      log.info("job concluído com sucesso (succeeded)");
      return result.value;
    }

    // 4-6. Falha: classifica e decide retry / dead-letter / terminal.
    const error = result.error;
    const maxAttempts = bullJob.opts.attempts ?? 1;
    const isLastAttempt = bullJob.attemptsMade + 1 >= maxAttempts;

    if (!error.retryable) {
      await jobRepo.markFailed(dbJobId, error);
      await executionRepo.recompute(claimed.executionId);
      endTimer({ operation_kind: operationKind, outcome: "failed" });
      recordJobProcessed(driverClass, "failed");
      log.error({ failureClass: error.failureClass, code: error.code }, "falha não-retryável (failed)");
      throw new UnrecoverableError(error.message);
    }

    if (isLastAttempt) {
      await jobRepo.markDeadLetter(dbJobId, error);
      await executionRepo.recompute(claimed.executionId);
      endTimer({ operation_kind: operationKind, outcome: "dead_letter" });
      recordJobProcessed(driverClass, "dead_letter");
      log.error({ failureClass: error.failureClass, code: error.code }, "retries esgotados (dead_letter)");
      throw new Error(error.message);
    }

    await jobRepo.markRetrying(dbJobId, error);
    await executionRepo.recompute(claimed.executionId);
    endTimer({ operation_kind: operationKind, outcome: "retrying" });
    recordJobProcessed(driverClass, "retrying");
    log.warn(
      { failureClass: error.failureClass, code: error.code, nextAttempt: bullJob.attemptsMade + 2 },
      "falha retryável — reagendando (retrying)",
    );
    throw new Error(error.message);
  };

  const worker = new Worker<JobQueueData>(queueName(driverClass), processor, {
    connection,
    concurrency,
    ...(prefix !== undefined ? { prefix } : {}),
    settings: {
      backoffStrategy: (attemptsMade, _type, _err, job) => {
        const retryPolicy = (job?.data as JobQueueData | undefined)?.retryPolicy;
        return retryPolicy ? computeBackoff(retryPolicy, attemptsMade) : 0;
      },
    },
  });

  worker.on("failed", (bullJob, err) => {
    logger.warn({ workerId, bullJobId: bullJob?.id, err: err.message }, "entrega falhou");
  });
  worker.on("error", (err) => {
    logger.error({ workerId, err: err.message }, "erro no worker");
  });

  return worker;
}
