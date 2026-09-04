-- Fase 04 — orquestração de pipeline.
--
-- Duas tabelas novas, sem tocar no que a Fase 03 validou:
--  - pipeline_executions: a corrida orquestrada de um pipeline contra uma conta.
--    Autoridade do estado do PIPELINE (job_executions continua sendo o agregado
--    de jobs, atualizado pelo worker). Carrega um lease de avanço que serializa
--    o advance entre instâncias do Orchestrator (regra: concorrência via banco).
--  - pipeline_step_executions: o estado por etapa (ordem, dependência, vínculo
--    com job, status, resultado, erro), guardando a operação para materializar
--    o job de forma autocontida.

CREATE TABLE pipeline_executions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id              uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  -- Agregado de jobs (a Execution do domínio) que ancora os jobs das etapas.
  job_execution_id         uuid NOT NULL REFERENCES job_executions(id) ON DELETE RESTRICT,
  trigger                  text NOT NULL DEFAULT 'manual'
                             CHECK (trigger IN ('manual','scheduled','event')),
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','running','completed',
                                               'partially_failed','failed','cancelled')),
  current_step_index       integer NOT NULL DEFAULT 0,
  error                    jsonb,
  -- Lease de avanço: só uma instância avança a mesma execução por vez.
  advance_lease_owner      text,
  advance_lease_expires_at timestamptz,
  started_at               timestamptz,
  finished_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pipeline_executions_status_idx ON pipeline_executions (status);
CREATE INDEX pipeline_executions_pipeline_idx ON pipeline_executions (pipeline_id);

CREATE TRIGGER pipeline_executions_set_updated_at
  BEFORE UPDATE ON pipeline_executions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pipeline_step_executions (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_execution_id        uuid NOT NULL
                                 REFERENCES pipeline_executions(id) ON DELETE CASCADE,
  step_id                      text NOT NULL,
  step_index                   integer NOT NULL,
  operation_type               text NOT NULL
                                 CHECK (operation_type IN ('publish_post','publish_campaign',
                                        'repost_loop','publish_story','repost_story_template',
                                        'warmup','acquire_content','fetch_insights')),
  -- Operação completa serializada — materializa o job sem recarregar o pipeline.
  operation                    jsonb NOT NULL,
  condition                    text NOT NULL
                                 CHECK (condition IN ('always','on_previous_success',
                                                      'on_previous_failure')),
  status                       text NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','running','succeeded',
                                                   'failed','dead_letter','skipped')),
  -- Dependência explícita entre etapas (ordenação confiável).
  depends_on_step_execution_id uuid REFERENCES pipeline_step_executions(id) ON DELETE SET NULL,
  -- Vínculo com o job do sistema de execução (Fase 03).
  job_id                       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  -- Idempotência determinística da etapa (mesma etapa nunca vira dois jobs).
  idempotency_key              text NOT NULL,
  result                       jsonb,
  error                        jsonb,
  started_at                   timestamptz,
  finished_at                  timestamptz,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_step_executions_order_unique UNIQUE (pipeline_execution_id, step_index)
);

CREATE INDEX pipeline_step_executions_exec_idx
  ON pipeline_step_executions (pipeline_execution_id, step_index);

CREATE TRIGGER pipeline_step_executions_set_updated_at
  BEFORE UPDATE ON pipeline_step_executions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
