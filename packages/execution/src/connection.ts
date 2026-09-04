/** Conexão Redis (ioredis) para BullMQ. */

import { Redis } from "ioredis";

export type { Redis } from "ioredis";

/**
 * Cria uma conexão ioredis apta para BullMQ. `maxRetriesPerRequest: null` é
 * exigido pelo BullMQ em conexões usadas por Worker (comandos bloqueantes).
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
