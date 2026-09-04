/**
 * Producer: publica jobs no BullMQ, uma fila por classe de driver. O `jobId` do
 * BullMQ é a `idempotencyKey`, dando dedupe também no nível da fila (além do
 * UNIQUE no banco). A `attempts`/backoff vêm do `RetryPolicy` do domínio.
 */

import { Queue } from "bullmq";
import type { DriverClass, DriverOperationKind, RetryPolicy } from "@scaleapp/domain";
import { recordJobEnqueued } from "@scaleapp/observability";
import type { Redis } from "./connection.js";
import { queueName, type JobQueueData } from "./queue.js";

export interface EnqueueInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly driverClass: DriverClass;
  readonly operationKind: DriverOperationKind;
  readonly retryPolicy: RetryPolicy;
  /** Atraso inicial (stagger/scheduler); ms. */
  readonly delayMs?: number;
}

export interface JobProducerOptions {
  /** Prefixo das chaves Redis do BullMQ (isolamento de ambiente/teste). */
  readonly prefix?: string;
}

export class JobProducer {
  private readonly queues = new Map<DriverClass, Queue<JobQueueData>>();

  constructor(
    private readonly connection: Redis,
    private readonly options: JobProducerOptions = {},
  ) {}

  private queueFor(driverClass: DriverClass): Queue<JobQueueData> {
    let queue = this.queues.get(driverClass);
    if (!queue) {
      queue = new Queue<JobQueueData>(queueName(driverClass), {
        connection: this.connection,
        ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      });
      this.queues.set(driverClass, queue);
    }
    return queue;
  }

  async enqueue(input: EnqueueInput): Promise<void> {
    const queue = this.queueFor(input.driverClass);
    await queue.add(
      input.operationKind,
      { dbJobId: input.id, retryPolicy: input.retryPolicy },
      {
        jobId: input.idempotencyKey,
        attempts: input.retryPolicy.maxAttempts,
        backoff: { type: "custom" },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
        ...(input.delayMs !== undefined ? { delay: input.delayMs } : {}),
      },
    );
    recordJobEnqueued(input.driverClass, input.operationKind);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
