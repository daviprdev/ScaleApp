/**
 * @scaleapp/observability — instrumentação Prometheus compartilhada entre a API
 * e o worker. Registry central, métricas de job/fila e o servidor `/metrics`.
 * Não conhece regra de negócio; só recebe labels de baixa cardinalidade.
 */

export {
  register,
  initDefaultMetrics,
  metricsText,
  registryContentType,
  jobsEnqueuedTotal,
  jobsProcessedTotal,
  jobDurationSeconds,
  recordJobEnqueued,
  recordJobProcessed,
  startJobTimer,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  recordHttpRequest,
} from "./metrics.js";
export type { JobOutcome } from "./metrics.js";
export { registerQueueMetrics } from "./queueMetrics.js";
export type { QueueMetricsOptions } from "./queueMetrics.js";
export { startMetricsServer } from "./server.js";
export type { MetricsServerOptions } from "./server.js";
