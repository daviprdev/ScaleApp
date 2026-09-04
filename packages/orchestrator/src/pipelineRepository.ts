/**
 * Persistência de `Pipeline` (definição) na tabela `pipelines` da Fase 02. Os
 * passos são guardados como JSONB (`PipelineStep[]`). O Orchestrator carrega os
 * passos ao iniciar uma execução.
 */

import type { Pool } from "pg";
import type { PipelineStep } from "@scaleapp/domain";

export interface CreatePipelineInput {
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly PipelineStep[];
  readonly enabled?: boolean;
}

export class PipelineRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreatePipelineInput): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO pipelines (name, description, steps, enabled)
       VALUES ($1, $2, $3::jsonb, COALESCE($4, true))
       RETURNING id`,
      [input.name, input.description ?? null, JSON.stringify(input.steps), input.enabled ?? null],
    );
    return res.rows[0]!.id;
  }

  async getSteps(pipelineId: string): Promise<readonly PipelineStep[] | null> {
    const res = await this.pool.query<{ steps: PipelineStep[] }>(
      `SELECT steps FROM pipelines WHERE id = $1`,
      [pipelineId],
    );
    return res.rows[0] ? res.rows[0].steps : null;
  }
}
