/**
 * @scaleapp/db — acesso a dados de baixo nível: pool Postgres e migrations.
 * Não contém regras de negócio; repositórios/queries de domínio vivem nas apps.
 */

export { createPool } from "./pool.js";
export type { Pool } from "./pool.js";
