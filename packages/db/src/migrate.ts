/**
 * Runner de migration simples: aplica os .sql de ./migrations em ordem
 * lexicográfica, uma vez cada, dentro de uma transação, registrando o que já
 * rodou em schema_migrations.
 *
 * Uso:
 *   pnpm --filter @scaleapp/db migrate           # aplica pendentes
 *   pnpm --filter @scaleapp/db migrate:status     # só lista o estado
 *
 * Requer DATABASE_URL no ambiente.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

// Carrega o .env da raiz do monorepo, se existir, para que `pnpm migrate`
// funcione sem exportar DATABASE_URL manualmente (Node >=20.12 / 22).
try {
  (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(
    join(HERE, "..", "..", "..", ".env"),
  );
} catch {
  // .env ausente — segue com as variáveis já definidas no ambiente.
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL não definida (copie .env.example para .env).");
    process.exit(1);
  }

  const statusOnly = process.argv.includes("--status");
  const pool = createPool(databaseUrl);

  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const appliedRes = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const applied = new Set(appliedRes.rows.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const pending = files.filter((f) => !applied.has(f));

    if (statusOnly) {
      console.log("Migrations:");
      for (const f of files) {
        console.log(`  ${applied.has(f) ? "[x]" : "[ ]"} ${f}`);
      }
      console.log(`\n${applied.size} aplicadas, ${pending.length} pendentes.`);
      return;
    }

    if (pending.length === 0) {
      console.log("Nada a aplicar — banco já está atualizado.");
      return;
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`aplicada: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`falha em ${file}:`, err instanceof Error ? err.message : err);
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`\n${pending.length} migration(s) aplicada(s).`);
  } finally {
    await pool.end();
  }
}

main().catch(() => process.exit(1));
