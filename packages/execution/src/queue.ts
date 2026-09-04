/**
 * Nome de fila por classe de driver (filas segmentadas — módulo 6 do CLAUDE.md)
 * e o formato dos dados que trafegam no BullMQ.
 *
 * O payload real e o estado do job vivem no Postgres (fonte da verdade); pelo
 * BullMQ trafega só a referência (`dbJobId`) e a política de retry, necessária
 * para a estratégia de backoff do worker.
 */

import type { DriverClass, RetryPolicy } from "@scaleapp/domain";

export function queueName(driverClass: DriverClass): string {
  // Sem ":" — o BullMQ reserva ":" como separador de chave Redis e rejeita no
  // nome da fila (o namespacing fica no `prefix`).
  return `jobs.${driverClass}`;
}

export interface JobQueueData {
  readonly dbJobId: string;
  readonly retryPolicy: RetryPolicy;
}
