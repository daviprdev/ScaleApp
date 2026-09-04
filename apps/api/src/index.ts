/**
 * Bootstrap da API: carrega config, cria o pool, sobe o servidor e trata
 * shutdown limpo.
 */

import { createPool } from "@scaleapp/db";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = buildServer(pool);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`recebido ${signal}, encerrando...`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    await pool.end();
    process.exit(1);
  }
}

void main();
