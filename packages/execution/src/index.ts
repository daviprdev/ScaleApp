/**
 * @scaleapp/execution — pipeline de execução de jobs (Control Plane): fila
 * BullMQ, producer, worker e repositórios de job/execução. Depende apenas da
 * porta `AutomationDriver` (domínio); o driver concreto é injetado por quem usa.
 */

export { createRedis } from "./connection.js";
export type { Redis } from "./connection.js";
export { createLogger } from "./logger.js";
export type { Logger } from "./logger.js";
export { queueName } from "./queue.js";
export type { JobQueueData } from "./queue.js";
export { computeBackoff } from "./backoff.js";
export { JobRepository } from "./jobRepository.js";
export type { JobRecord, CreateJobInput, DriverContextRow } from "./jobRepository.js";
export { ExecutionRepository } from "./executionRepository.js";
export type { CreateExecutionInput } from "./executionRepository.js";
export { JobProducer } from "./producer.js";
export type { EnqueueInput, JobProducerOptions } from "./producer.js";
export { createAndEnqueueJob } from "./jobService.js";
export type { CreateAndEnqueueResult } from "./jobService.js";
export { createJobWorker } from "./worker.js";
export type { CreateJobWorkerOptions } from "./worker.js";
