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
  EnvCredentialResolver,
  GraphApiDriver,
  UndiciHttpClient,
  type CredentialResolver,
  type MediaResolver,
  type TokenSink,
} from "@scaleapp/driver-graph";
import {
  LibraryMediaResolver,
  MediaRepository,
  loadMediaConfig,
} from "@scaleapp/media";
import {
  PoolProxyResolver,
  ProxyAssignmentService,
  ProxyRepository,
  createProxyFailureHandler,
  loadProxyConfig,
  startProxyHealthSweep,
  type SecretReader,
} from "@scaleapp/proxy";
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
  const proxyConfig = loadProxyConfig();
  const mediaConfig = loadMediaConfig();
  const logger = createLogger("worker");
  const pool = createPool(config.databaseUrl);
  const sessions = new SessionRepository(pool);

  // Cofre (módulo 8). Sem SECRETS_KEYS não há criptografia em repouso: seguimos
  // com os stubs de dev, mas dizendo isso alto — não é configuração de produção.
  const keyring = Keyring.fromEnv();
  let credentials: CredentialResolver;
  let tokenSink: TokenSink | undefined;
  let secrets: SecretReader;
  if (keyring) {
    const vault = new PostgresSecretVault(pool, keyring);
    const vaultCredentials = new VaultCredentialResolver(vault, {
      cacheTtlMs: sessionConfig.tokenCacheTtlMs,
    });
    credentials = vaultCredentials;
    tokenSink = new VaultTokenSink(pool, vault, sessions, vaultCredentials);
    secrets = vault;
    logger.info({ activeKeyId: keyring.activeKeyId }, "cofre de segredos ativo");
  } else {
    credentials = new EnvCredentialResolver();
    // Dev sem cofre: trata `credentials_ref` literal (`user:pass`) como a
    // própria credencial, como faziam os stubs. Nunca em produção.
    secrets = { async get(ref: string) { return ref.startsWith("vault://") ? null : ref; } };
    logger.warn("SECRETS_KEYS ausente — usando resolvers de dev, sem cofre nem refresh");
  }

  // Biblioteca de mídia: o driver recebe uma URL assinada e temporária servida
  // pela nossa API — a Graph API baixa o arquivo por conta própria. Sem cofre
  // não há como assinar, e aí a mídia não resolve (job falha explicitamente)
  // em vez de cair num stub que aceitaria qualquer string como URL.
  let media: MediaResolver;
  if (keyring) {
    media = new LibraryMediaResolver(
      new MediaRepository(pool),
      { sign: (data) => keyring.hmac("media-url", data).toString("base64url") },
      { publicBaseUrl: mediaConfig.publicBaseUrl, urlTtlMs: mediaConfig.urlTtlMs },
    );
  } else {
    media = {
      async resolveMedia() {
        logger.error("sem SECRETS_KEYS não há URL assinada — mídia não resolve");
        return null;
      },
    };
  }

  // Pool de proxies (módulo 9): resolver real no lugar do stub de dev.
  const proxyRepo = new ProxyRepository(pool);
  const proxyResolver = new PoolProxyResolver(pool, secrets, {
    cacheTtlMs: proxyConfig.resolverCacheTtlMs,
  });
  const proxyAssignments = new ProxyAssignmentService(pool);

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
          proxies: proxyResolver,
          media,
          ...(tokenSink ? { tokenSink } : {}),
        }),
      );
      logger.info({ driverClass, vault: keyring !== null }, "driver Graph API real registrado");
    } else {
      registry.register(new MockDriver(driverClass));
    }
  }

  // Regra 3: checkpoint e token morto viram estados distintos da conta assim que
  // o driver classifica a falha, mesmo que o job ainda vá retentar. O pool de
  // proxies escuta a mesma falha para contabilizar `ProxyError` no proxy certo.
  const onSessionFailure = createSessionFailureHandler({
    sessions,
    onRemediation: (r) => logger.warn(r, "remediação de sessão aplicada"),
  });
  const onProxyFailure = createProxyFailureHandler({
    repo: proxyRepo,
    pool,
    swapAfterFailures: proxyConfig.swapAfterFailures,
    assignments: proxyAssignments,
    onProxyFailure: (r) => logger.warn(r, "falha de proxy registrada"),
  });
  const onOperationFailure = async (info: Parameters<typeof onSessionFailure>[0]): Promise<void> => {
    await onSessionFailure(info);
    await onProxyFailure(info);
  };

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

  // Health check do pool de proxies. Mesma disciplina da varredura de sessão:
  // opt-in, e ligada em um worker só (sondar o mesmo proxy de N processos não
  // melhora o diagnóstico e multiplica tráfego pelo IP dele).
  let proxySweep: { stop: () => void } | undefined;
  if (proxyConfig.sweepEnabled) {
    proxySweep = startProxyHealthSweep({
      pool,
      resolver: proxyResolver,
      probe: new UndiciHttpClient(),
      config: proxyConfig,
      onSweep: (r) => {
        if (r.suspectedOutage) {
          logger.error(r, "varredura de proxy suspeita de OUTAGE — nenhum proxy condenado");
        } else if (r.lowPool) {
          logger.warn(r, "pool de proxies perto de acabar");
        } else {
          logger.info(r, "varredura de saúde do pool de proxies");
        }
      },
      onError: (err) =>
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "varredura de proxy falhou",
        ),
    });
    logger.info(
      { intervalMs: proxyConfig.sweepIntervalMs, limit: proxyConfig.sweepLimit },
      "varredura de saúde de proxy ativa",
    );
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
    proxySweep?.stop();
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
