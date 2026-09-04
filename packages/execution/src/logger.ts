/** Logger estruturado (pino) — logs em JSON para acompanhar o ciclo do job. */

import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string, level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({ name, level });
}
