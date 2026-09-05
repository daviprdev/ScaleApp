/**
 * Composition root do worker: liga os concretos do Execution Plane à porta e
 * sobe um worker BullMQ por classe de driver configurada. É aqui — e só aqui —
 * que o concreto encontra o Control Plane.
 *
 * Com `SECRETS_KEYS` no ambiente, o driver Graph passa a resolver tokens pelo
 * cofre real (módulo 8) e a persistir o token renovado nele; sem a chave, cai
 * nos stubs de dev, e o refresh é recusado em vez de fingir sucesso.
 *
 * Também expõe /metrics (Prometheus): métricas de processo, de job (via
 * @scaleapp/execution instrumentado) e de profundidade de fila.
 */

import { createPool } from "@scaleapp/db";
import { DriverClass } from "@scaleapp/domain";
import { InMemoryDriverRegistry, MockDriver } from "@scaleapp/driver-mock";
import {
  DbAccountProxyResolver,
  EnvCredentialResolver,
  GraphApiDriver,
  UndiciHttpClient,
  UrlMediaResolver,
  type CredentialResolver,
  type TokenSink,
} from "@scaleapp/driver-graph";
import {
  JobProducer,
  createJobWorker,
  createLogger,
  createRedis,
  queueName,
  type Redis,
} from "@scaleapp/execution";
import {
  Keyring,
  PostgresSecretVault,
  SessionRepository,
  VaultCredentialResolver,
  VaultTokenSink,
  createSessionFailureHandler,
  loadSessionConfig,
  startSessionRefreshSweep,
} from "@scaleapp/session";
import {
  initDefaultMetrics,
  registerQueueMetrics,
  startMetricsServer,
} from "@scaleapp/observability";
import { Queue } from "bullmq";
import { loadWorkerConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const sessionConfig = loadSessionConfig();
  const logger = createLogger("worker");
  const pool = createPool(config.databaseUrl);
  const sessions = new SessionRepository(pool);

  // Cofre (módulo 8). Sem SECRETS_KEYS não há criptografia em repouso: seguimos
  // com os stubs de dev, mas dizendo isso alto — não é configuração de produção.
  const keyring = Keyring.fromEnv();
  let credentials: CredentialResolver;
  let tokenSink: TokenSink | undefined;
  if (keyring) {
    const vault = new PostgresSecretVault(pool, keyring);
    const vaultCredentials = new VaultCredentialResolver(vault, {
      cacheTtlMs: sessionConfig.tokenCacheTtlMs,
    });
    credentials = vaultCredentials;
    tokenSink = new VaultTokenSink(pool, vault, sessions, vaultCredentials);
    logger.info({ activeKeyId: keyring.activeKeyId }, "cofre de segredos ativo");
  } else {
    credentials = new EnvCredentialResolver();
    logger.warn("SECRETS_KEYS ausente — usando resolvers de dev, sem cofre nem refresh");
  }

  // Registry: um driver por classe. Para graph_api, usa o driver Graph API real
  // quando WORKER_GRAPH_DRIVER=1; senão, o mock. As demais classes seguem no
  // mock (Playwright/Content Acquisition virão depois).
  const registry = new InMemoryDriverRegistry();
  for (const driverClass of config.driverClasses) {
    if (driverClass === DriverClass.GraphApi && config.useGraphDriver) {
      registry.register(
        new GraphApiDriver({
          http: new UndiciHttpClient(),
          credentials,
          proxies: new DbAccountProxyResolver(pool),
          media: new UrlMediaResolver(),
          ...(tokenSink ? { tokenSink } : {}),
        }),
      );
      logger.info({ driverClass, vault: keyring !== null }, "driver Graph API real registrado");
    } else {
      registry.register(new MockDriver(driverClass));
    }
  }

  // Regra 3: checkpoint e token morto viram estados distintos da conta assim que
  // o driver classifica a falha, mesmo que o job ainda vá retentar.
  const onOperationFailure = createSessionFailureHandler({
    sessions,
    onRemediation: (r) => logger.warn(r, "remediação de sessão aplicada"),
  });

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
      onOperationFailure,
    });
  });

  // Refresh preventivo (regra 6). Substituto mínimo do Scheduler (módulo 7):
  // só um processo precisa varrer, então fica opt-in por env — com mais de um
  // worker, ligue em apenas um deles (a chave de idempotência já protege
  // contra duplicata, mas varrer em N processos é trabalho jogado fora).
  let sweep: { stop: () => void } | undefined;
  let sweepProducer: JobProducer | undefined;
  if (sessionConfig.sweepEnabled) {
    if (!keyring) {
      logger.warn("SESSION_SWEEP_ENABLED=1 sem SECRETS_KEYS — varredura não iniciada");
    } else {
      const sweepConnection = createRedis(config.redisUrl);
      connections.push(sweepConnection);
      sweepProducer = new JobProducer(sweepConnection);
      sweep = startSessionRefreshSweep({
        pool,
        producer: sweepProducer,
        config: sessionConfig,
        onSweep: (r) => logger.info(r, "varredura de refresh preventivo"),
        onError: (err) =>
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "varredura de refresh falhou",
          ),
      });
      logger.info(
        {
          intervalMs: sessionConfig.sweepIntervalMs,
          limit: sessionConfig.sweepLimit,
          withinMs: sessionConfig.refreshWithinMs,
        },
        "varredura de refresh preventivo ativa",
      );
    }
  }

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
    sweep?.stop();
    metricsServer.close();
    await sweepProducer?.close();
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
