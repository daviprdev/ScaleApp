/**
 * Métricas de profundidade de fila BullMQ, coletadas sob demanda (no scrape do
 * Prometheus). Um gauge por estado, com label `queue`. As contagens são lidas
 * do Redis via `getJobCounts` no momento do scrape — nada é mantido em memória.
 */

import { Gauge } from "prom-client";
import type { Queue } from "bullmq";
import { register } from "./metrics.js";

/** Estados do BullMQ que expomos como profundidade de fila. */
const STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;

export interface QueueMetricsOptions {
  /** Filas a observar, indexadas por um nome estável (ex.: a classe de driver). */
  readonly queues: ReadonlyMap<string, Queue>;
}

/**
 * Registra um gauge que, a cada scrape, consulta a profundidade de cada fila.
 * Retorna uma função para desregistrar (usada no shutdown/teste).
 */
const QUEUE_GAUGE_NAME = "scaleapp_queue_jobs";

export function registerQueueMetrics(opts: QueueMetricsOptions): () => void {
  new Gauge({
    name: QUEUE_GAUGE_NAME,
    help: "Jobs na fila BullMQ por estado (coletado no scrape).",
    labelNames: ["queue", "state"] as const,
    registers: [register],
    async collect() {
      for (const [name, queue] of opts.queues) {
        try {
          const counts = await queue.getJobCounts(...STATES);
          for (const state of STATES) {
            this.set({ queue: name, state }, counts[state] ?? 0);
          }
        } catch {
          // Fila indisponível no momento do scrape — omite este ciclo.
        }
      }
    },
  });

  return () => {
    register.removeSingleMetric(QUEUE_GAUGE_NAME);
  };
}
