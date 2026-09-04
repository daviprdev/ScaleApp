import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriverClass } from "@scaleapp/domain";

// Carrega o .env da raiz do monorepo, se existir (sem dependência externa).
const rootEnv = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(rootEnv);
} catch {
  // .env ausente — usa o process.env já presente.
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly workerId: string;
  readonly concurrency: number;
  readonly driverClasses: readonly DriverClass[];
  /** Porta do endpoint /metrics (Prometheus) exposto por este worker. */
  readonly metricsPort: number;
  /**
   * Usa o driver Graph API real para a classe graph_api (senão, driver mock).
   * Default false: o mock continua o padrão até haver credenciais/resolvers
   * reais (Sessão/Proxy/Mídia). Ligar com WORKER_GRAPH_DRIVER=1.
   */
  readonly useGraphDriver: boolean;
}

function parseDriverClasses(raw: string | undefined): DriverClass[] {
  if (!raw) return [DriverClass.GraphApi];
  const valid = new Set<string>(Object.values(DriverClass));
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => valid.has(s)) as DriverClass[];
  return parsed.length > 0 ? parsed : [DriverClass.GraphApi];
}

export function loadWorkerConfig(): WorkerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL não definida (copie .env.example para .env).");
  if (!redisUrl) throw new Error("REDIS_URL não definida (copie .env.example para .env).");
  return {
    databaseUrl,
    redisUrl,
    workerId: process.env.WORKER_ID ?? "worker-1",
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? "5"),
    driverClasses: parseDriverClasses(process.env.WORKER_DRIVER_CLASSES),
    metricsPort: Number(process.env.WORKER_METRICS_PORT ?? "9101"),
    useGraphDriver: process.env.WORKER_GRAPH_DRIVER === "1",
  };
}
