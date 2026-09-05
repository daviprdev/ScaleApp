-- Módulo 9 — Proxy/Network Manager.
--
-- A tabela `proxies` já existia (0001) com o essencial: endereço, estado de
-- atribuição, saúde e a unicidade que garante proxy dedicado por conta
-- (regra 10). O que falta é o que o pool precisa para OPERAR: histórico de
-- checagem, contador de falhas consecutivas e o IP de saída observado.

ALTER TABLE proxies
  -- Apelido/provedor. Sem isso, diagnosticar "o provedor X caiu inteiro" exige
  -- inferir por faixa de host.
  ADD COLUMN label                 text,
  -- Falhas seguidas na checagem. É o contador que separa "uma falha" de "está
  -- morto": marcar down na primeira falha transforma soluço de rede em conta
  -- parada.
  ADD COLUMN consecutive_failures  integer NOT NULL DEFAULT 0,
  ADD COLUMN last_latency_ms       integer,
  ADD COLUMN last_error            text,
  -- IP de saída visto na última checagem. Existe por causa da regra 10: um
  -- proxy vendido como dedicado que na prática rotaciona (ou é compartilhado
  -- entre contas) só aparece comparando o IP observado entre proxies.
  ADD COLUMN last_exit_ip          text,
  ADD COLUMN assigned_at           timestamptz,
  ADD COLUMN released_at           timestamptz;

COMMENT ON COLUMN proxies.last_exit_ip IS
  'IP de saída observado na última checagem. Dois proxies com o mesmo IP indicam pool compartilhado/rotativo — viola a regra 10.';

-- Serve a atribuição do pool (pega o próximo disponível e saudável).
CREATE INDEX proxies_available_idx
  ON proxies (health, created_at)
  WHERE assignment_state = 'available';

-- Serve a varredura de health check (os mais desatualizados primeiro).
CREATE INDEX proxies_check_due_idx
  ON proxies (last_checked_at NULLS FIRST)
  WHERE assignment_state IN ('available','assigned','reserved');

-- Diagnóstico de proxy compartilhado/rotativo (regra 10).
CREATE INDEX proxies_exit_ip_idx ON proxies (last_exit_ip)
  WHERE last_exit_ip IS NOT NULL;
