-- Fase 03 — persistência de resultado de job.
--
-- O resultado de sucesso do driver e o instante de conclusão passam a ser
-- gravados na própria linha do job. `last_error` (Fase 02) já guarda a falha;
-- aqui adicionamos o lado do sucesso e um índice por status para o recompute
-- de contagens da execução.

ALTER TABLE jobs
  ADD COLUMN result       jsonb,
  ADD COLUMN completed_at timestamptz;

CREATE INDEX jobs_status_idx ON jobs (status);
