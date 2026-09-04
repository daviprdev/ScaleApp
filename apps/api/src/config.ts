import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Carrega o .env da raiz do monorepo, se existir, usando o loader nativo do
 * Node (>=20.12 / 22 `process.loadEnvFile`) — sem dependência externa.
 * Se o arquivo não existir, seguimos com o process.env já presente.
 */
const rootEnv = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(rootEnv);
} catch {
  // .env ausente — segue com as variáveis já definidas no ambiente.
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
}

export function loadConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL não definida (copie .env.example para .env).");
  }
  return {
    databaseUrl,
    host: process.env.API_HOST ?? "0.0.0.0",
    port: Number(process.env.API_PORT ?? "3000"),
  };
}
