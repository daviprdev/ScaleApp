import pg from "pg";
import type { Pool, PoolConfig } from "pg";

/**
 * Cria um pool de conexões Postgres a partir de uma connection string.
 * O `db` não conhece configuração de app — quem chama passa a URL resolvida.
 */
export function createPool(
  connectionString: string,
  config: Omit<PoolConfig, "connectionString"> = {},
): Pool {
  return new pg.Pool({ connectionString, ...config });
}

export type { Pool } from "pg";
