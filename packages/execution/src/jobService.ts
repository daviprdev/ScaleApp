/**
 * Serviço de criação de job: insere a linha no Postgres (fonte da verdade) e só
 * então enfileira no BullMQ. Não é fire-and-forget — a persistência precede a
 * publicação, e a publicação é aguardada. Se a `idempotencyKey` já existir, não
 * cria nem enfileira de novo (a ação não roda duas vezes — regra 9).
 */

import type { Pool } from "pg";
import { JobRepository, type CreateJobInput } from "./jobRepository.js";
import type { JobProducer } from "./producer.js";

export interface CreateAndEnqueueResult {
  readonly jobId: string;
  readonly created: boolean;
}

export async function createAndEnqueueJob(
  pool: Pool,
  producer: JobProducer,
  input: CreateJobInput & { readonly delayMs?: number },
): Promise<CreateAndEnqueueResult> {
  const repo = new JobRepository(pool);
  const { record, created } = await repo.create(input);

  if (created) {
    await producer.enqueue({
      id: record.id,
      idempotencyKey: record.idempotencyKey,
      driverClass: record.driverClass,
      operationKind: record.operationKind,
      retryPolicy: input.retryPolicy,
      ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
    });
  }

  return { jobId: record.id, created };
}
