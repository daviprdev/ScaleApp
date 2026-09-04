/**
 * Registro Prometheus central e métricas de domínio do ScaleApp.
 *
 * Um processo (API ou worker) tem um único registry (o default do prom-client).
 * `initDefaultMetrics` liga as métricas de processo (CPU, heap, event loop) uma
 * vez; as métricas de domínio abaixo são registradas na importação do módulo.
 *
 * Convenção de nomes: prefixo `scaleapp_`, unidades no sufixo (`_seconds`,
 * `_total`). Labels de baixa cardinalidade — `driver_class`, `operation_kind`,
 * `outcome` são conjuntos fechados; nunca colocar id de conta/job em label.
 */

import {
  Counter,
  Histogram,
  collectDefaultMetrics,
  register as defaultRegistry,
} from "prom-client";

export const register = defaultRegistry;

let defaultMetricsStarted = false;

/** Liga as métricas padrão de processo uma única vez (idempotente). */
export function initDefaultMetrics(): void {
  if (defaultMetricsStarted) return;
  collectDefaultMetrics({ register, prefix: "scaleapp_" });
  defaultMetricsStarted = true;
}

/** Serializa o registry no formato de exposição do Prometheus. */
export async function metricsText(): Promise<string> {
  return register.metrics();
}

export const registryContentType = register.contentType;

// --- Jobs (Execution Plane) --------------------------------------------------

/** Desfecho terminal de uma entrega de job processada pelo worker. */
export type JobOutcome = "succeeded" | "failed" | "dead_letter" | "retrying" | "skipped";

export const jobsEnqueuedTotal = new Counter({
  name: "scaleapp_jobs_enqueued_total",
  help: "Jobs publicados na fila, por classe de driver e operação.",
  labelNames: ["driver_class", "operation_kind"] as const,
  registers: [register],
});

export const jobsProcessedTotal = new Counter({
  name: "scaleapp_jobs_processed_total",
  help: "Entregas de job processadas pelo worker, por classe de driver e desfecho.",
  labelNames: ["driver_class", "outcome"] as const,
  registers: [register],
});

export const jobDurationSeconds = new Histogram({
  name: "scaleapp_job_duration_seconds",
  help: "Duração do processamento de um job (claim → desfecho), em segundos.",
  labelNames: ["driver_class", "operation_kind", "outcome"] as const,
  // Automação de rede: de sub-segundo a dezenas de segundos.
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register],
});

// --- HTTP (API / Control Plane) ---------------------------------------------

export const httpRequestsTotal = new Counter({
  name: "scaleapp_http_requests_total",
  help: "Requisições HTTP atendidas pela API, por método, rota e status.",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "scaleapp_http_request_duration_seconds",
  help: "Duração das requisições HTTP da API, em segundos.",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const labels = { method, route, status_code: String(statusCode) };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationSeconds);
}

export function recordJobEnqueued(driverClass: string, operationKind: string): void {
  jobsEnqueuedTotal.inc({ driver_class: driverClass, operation_kind: operationKind });
}

export function recordJobProcessed(driverClass: string, outcome: JobOutcome): void {
  jobsProcessedTotal.inc({ driver_class: driverClass, outcome });
}

/**
 * Inicia um cronômetro para a duração do job. Chame o retorno no desfecho,
 * passando os labels finais (`operation_kind` pode não ser conhecido no início).
 */
export function startJobTimer(driverClass: string): (labels: {
  operation_kind: string;
  outcome: JobOutcome;
}) => void {
  const end = jobDurationSeconds.startTimer({ driver_class: driverClass });
  return (labels) => end(labels);
}
