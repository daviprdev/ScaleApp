-- ScaleApp — schema inicial (Fase 02).
--
-- Cobre as entidades de @scaleapp/domain. Os CHECKs de texto espelham
-- exatamente os valores dos enums do domínio; se um enum mudar lá, muda aqui
-- numa nova migration. As regras de design do CLAUDE.md estão embutidas no
-- schema (não delegadas à aplicação): idempotency_key único, claim atômico,
-- proxy dedicado por conta.

-- ---------------------------------------------------------------------------
-- Utilitário: updated_at automático
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- meta_apps (BYOC — múltiplos Meta Apps desde o v1)
-- ---------------------------------------------------------------------------

CREATE TABLE meta_apps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label            text NOT NULL,
  client_id        text NOT NULL UNIQUE,           -- App ID público
  secret_ref       text NOT NULL,                  -- referência ao cofre
  enabled          boolean NOT NULL DEFAULT true,
  account_capacity integer CHECK (account_capacity IS NULL OR account_capacity > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER meta_apps_set_updated_at
  BEFORE UPDATE ON meta_apps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- proxies (dedicado por conta, nunca rotativo por padrão — regra 10)
-- ---------------------------------------------------------------------------

CREATE TABLE proxies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol            text NOT NULL CHECK (protocol IN ('http','https','socks5')),
  host                text NOT NULL,
  port                integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  credentials_ref     text,
  assignment_state    text NOT NULL DEFAULT 'available'
                        CHECK (assignment_state IN ('available','assigned','reserved','retired')),
  assigned_account_id uuid,                          -- FK adicionada abaixo (ciclo com accounts)
  health              text NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('healthy','degraded','down','unknown')),
  last_checked_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER proxies_set_updated_at
  BEFORE UPDATE ON proxies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- accounts (Account Registry)
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle               text NOT NULL UNIQUE,
  account_type         text NOT NULL CHECK (account_type IN ('business','creator','personal')),
  lifecycle_state      text NOT NULL DEFAULT 'new'
                         CHECK (lifecycle_state IN ('new','warmup','active','paused','disabled','failed')),
  health               text NOT NULL DEFAULT 'unknown'
                         CHECK (health IN ('healthy','degraded','rate_limited','checkpoint_required',
                                           'token_dead','suspended','unknown')),

  -- BYOC obrigatório: toda conta pertence a um Meta App.
  meta_app_id          uuid NOT NULL REFERENCES meta_apps(id) ON DELETE RESTRICT,

  -- Proxy dedicado obrigatório e único por conta (regra 10): a unicidade de
  -- proxy_id garante que um proxy não seja compartilhado entre contas.
  proxy_id             uuid NOT NULL,

  -- credenciais (segredos só por referência ao cofre)
  username             text NOT NULL,
  secret_ref           text,

  -- sessão (opcional; espelha AccountSession)
  session_status       text CHECK (session_status IN ('valid','expiring','expired','revoked')),
  access_token_ref     text,
  session_issued_at    timestamptz,
  session_expires_at   timestamptz,
  session_refreshed_at timestamptz,

  -- organização
  tags                 text[] NOT NULL DEFAULT '{}',
  groups               text[] NOT NULL DEFAULT '{}',
  failover_priority    integer NOT NULL DEFAULT 100,

  -- warmup (carência de conta nova — regra 7)
  warmup_started_at    timestamptz,
  warmup_completes_at  timestamptz,
  warmup_completed     boolean,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accounts_proxy_unique UNIQUE (proxy_id)
);

CREATE INDEX accounts_meta_app_idx ON accounts (meta_app_id);
CREATE INDEX accounts_health_idx ON accounts (health);
CREATE INDEX accounts_lifecycle_idx ON accounts (lifecycle_state);

CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fecha o ciclo de FKs entre accounts e proxies.
ALTER TABLE accounts
  ADD CONSTRAINT accounts_proxy_fk
  FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE RESTRICT;

ALTER TABLE proxies
  ADD CONSTRAINT proxies_assigned_account_fk
  FOREIGN KEY (assigned_account_id) REFERENCES accounts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- pipelines (Pipeline Definition — passos/operações como JSONB)
-- ---------------------------------------------------------------------------

CREATE TABLE pipelines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text NOT NULL,
  description            text,
  steps                  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- PipelineStep[]
  default_posting_window jsonb,                                -- PostingWindow
  enabled                boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER pipelines_set_updated_at
  BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- job_executions (Execution — uma corrida de pipeline)
-- ---------------------------------------------------------------------------

CREATE TABLE job_executions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id        uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  trigger            text NOT NULL CHECK (trigger IN ('manual','scheduled','event')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','running','completed','partially_failed',
                                         'failed','cancelled')),
  target_account_ids uuid[] NOT NULL DEFAULT '{}',
  count_total        integer NOT NULL DEFAULT 0,
  count_pending      integer NOT NULL DEFAULT 0,
  count_running      integer NOT NULL DEFAULT 0,
  count_succeeded    integer NOT NULL DEFAULT 0,
  count_failed       integer NOT NULL DEFAULT 0,
  count_dead_letter  integer NOT NULL DEFAULT 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_executions_pipeline_idx ON job_executions (pipeline_id);
CREATE INDEX job_executions_status_idx ON job_executions (status);

-- ---------------------------------------------------------------------------
-- jobs (unidade concreta de fila)
-- ---------------------------------------------------------------------------

CREATE TABLE jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Regra 9: idempotency key única em todo job — retry nunca duplica ação real.
  idempotency_key        text NOT NULL,

  execution_id           uuid NOT NULL REFERENCES job_executions(id) ON DELETE CASCADE,
  pipeline_id            uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  step_id                text NOT NULL,
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

  -- driver_class define a fila (filas segmentadas por classe de driver).
  driver_class           text NOT NULL
                           CHECK (driver_class IN ('graph_api','playwright','content_acquisition')),
  operation_kind         text NOT NULL
                           CHECK (operation_kind IN ('publish_media','publish_story','publish_highlight',
                                                     'fetch_insights','acquire_content','warmup_action',
                                                     'refresh_session')),
  payload                jsonb NOT NULL DEFAULT '{}'::jsonb,

  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','scheduled','queued','claimed','running',
                                             'succeeded','failed','retrying','dead_letter','cancelled')),
  priority               integer NOT NULL DEFAULT 100,

  attempts               integer NOT NULL DEFAULT 0,
  max_attempts           integer NOT NULL DEFAULT 5,
  backoff                text NOT NULL DEFAULT 'exponential' CHECK (backoff IN ('fixed','exponential')),
  base_delay_ms          integer NOT NULL DEFAULT 1000,
  max_delay_ms           integer,

  -- stagger/jitter (regra 5): despacho só quando scheduled_for <= now().
  scheduled_for          timestamptz,

  -- claim atômico (regra 4)
  claim_worker_id        text,
  claim_claimed_at       timestamptz,
  claim_lease_expires_at timestamptz,

  last_error             jsonb,                       -- OperationError serializado

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT jobs_idempotency_key_unique UNIQUE (idempotency_key)
);

-- Índice parcial que serve o claim: só linhas despacháveis, ordenáveis por
-- prioridade e chegada, segmentadas por classe de driver.
CREATE INDEX jobs_claimable_idx
  ON jobs (driver_class, priority, created_at)
  WHERE status IN ('pending','scheduled','queued');

CREATE INDEX jobs_execution_idx ON jobs (execution_id);
CREATE INDEX jobs_account_idx ON jobs (account_id);

CREATE TRIGGER jobs_set_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Claim atômico no banco (regra 4): SELECT ... FOR UPDATE SKIP LOCKED + UPDATE
-- na mesma transação. Duas invocações concorrentes nunca pegam o mesmo job.
-- Respeita scheduled_for (regra 5) e a segmentação por classe de driver.
CREATE OR REPLACE FUNCTION claim_next_job(
  p_worker_id     text,
  p_driver_class  text,
  p_lease_seconds integer DEFAULT 60
) RETURNS jobs
LANGUAGE plpgsql AS $$
DECLARE
  v_job jobs;
BEGIN
  SELECT * INTO v_job
  FROM jobs
  WHERE driver_class = p_driver_class
    AND status IN ('pending','scheduled','queued')
    AND (scheduled_for IS NULL OR scheduled_for <= now())
  ORDER BY priority ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE jobs
  SET status                 = 'claimed',
      attempts               = attempts + 1,
      claim_worker_id        = p_worker_id,
      claim_claimed_at       = now(),
      claim_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at             = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN v_job;
END;
$$;

-- ---------------------------------------------------------------------------
-- driver_capabilities (persistência do capability registry)
-- ---------------------------------------------------------------------------

CREATE TABLE driver_capabilities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_class   text NOT NULL
                   CHECK (driver_class IN ('graph_api','playwright','content_acquisition')),
  operation_kind text NOT NULL
                   CHECK (operation_kind IN ('publish_media','publish_story','publish_highlight',
                                             'fetch_insights','acquire_content','warmup_action',
                                             'refresh_session')),
  support        text NOT NULL CHECK (support IN ('primary','secondary')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_capabilities_unique UNIQUE (driver_class, operation_kind)
);

-- Seed do registry conforme as capacidades conhecidas de cada driver:
-- Graph API é o primário; Playwright cobre o que a API não cobre (Destaques);
-- Content Acquisition é o único que adquire conteúdo.
INSERT INTO driver_capabilities (driver_class, operation_kind, support) VALUES
  ('graph_api',          'publish_media',     'primary'),
  ('graph_api',          'publish_story',     'primary'),
  ('graph_api',          'fetch_insights',    'primary'),
  ('graph_api',          'warmup_action',     'primary'),
  ('graph_api',          'refresh_session',   'primary'),
  ('playwright',         'publish_highlight', 'primary'),
  ('playwright',         'publish_media',     'secondary'),
  ('playwright',         'publish_story',     'secondary'),
  ('playwright',         'warmup_action',     'secondary'),
  ('content_acquisition','acquire_content',   'primary');

-- ---------------------------------------------------------------------------
-- failover_events (histórico de failover — observabilidade)
-- ---------------------------------------------------------------------------

CREATE TABLE failover_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id    uuid REFERENCES job_executions(id) ON DELETE CASCADE,
  from_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id   uuid REFERENCES accounts(id) ON DELETE SET NULL,
  -- reason = FailureClass: a classificação é o que autoriza (ou não) a cascata
  -- de failover (regra 2). Guardá-la torna a decisão auditável.
  reason          text NOT NULL
                    CHECK (reason IN ('account_error','platform_outage','rate_limited',
                                      'checkpoint_required','token_dead','proxy_error',
                                      'network','invalid_input','unknown')),
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX failover_events_execution_idx ON failover_events (execution_id);
CREATE INDEX failover_events_from_account_idx ON failover_events (from_account_id);

-- ---------------------------------------------------------------------------
-- audit_log (log estruturado geral de mutações)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  event       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
