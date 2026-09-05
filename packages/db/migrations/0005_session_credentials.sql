-- Módulo 8 — Session/Credential Manager.
--
-- Até aqui `secret_ref` / `access_token_ref` eram ponteiros para um cofre que
-- não existia (o driver Graph usava stubs de dev que tratavam a própria
-- referência como o segredo). Esta migration cria o cofre de verdade:
-- criptografia em repouso (AES-256-GCM), chave versionada para permitir
-- rotação, e as colunas que o refresh preventivo (regra 6) precisa para não
-- ficar tentando refrescar em loop uma conta que já falhou.

-- ---------------------------------------------------------------------------
-- secrets (cofre — criptografia em repouso)
-- ---------------------------------------------------------------------------

-- O texto claro NUNCA entra aqui: a aplicação cifra antes de inserir e a chave
-- vive só no ambiente (SECRETS_KEYS), nunca no banco. Um dump do Postgres
-- sozinho não expõe token nenhum.
--
-- `key_id` é qual chave do keyring cifrou a linha: permite rotacionar a chave
-- ativa sem reescrever tudo de uma vez (linhas antigas continuam decifráveis
-- pela chave antiga, e a rotação varre em lotes limitados — regra 8).
CREATE TABLE secrets (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('account_access_token','account_password',
                                           'meta_app_secret','proxy_credentials')),
  key_id     text NOT NULL,
  algorithm  text NOT NULL DEFAULT 'aes-256-gcm',
  iv         bytea NOT NULL,
  auth_tag   bytea NOT NULL,
  ciphertext bytea NOT NULL,
  -- Incrementa a cada replace (refresh de token reescreve a mesma linha, para
  -- que `accounts.access_token_ref` permaneça estável).
  version    integer NOT NULL DEFAULT 1,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Serve a varredura de rotação de chave (WHERE key_id <> chave ativa).
CREATE INDEX secrets_key_id_idx ON secrets (key_id);

CREATE TRIGGER secrets_set_updated_at
  BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- accounts — estado do refresh preventivo
-- ---------------------------------------------------------------------------

-- Sem estas colunas, uma conta cujo refresh falha de forma persistente seria
-- re-enfileirada a cada varredura para sempre. `session_refresh_attempted_at`
-- dá o intervalo mínimo entre tentativas e `session_refresh_failures` permite
-- desistir (e distinguir "ainda não tentou" de "tenta e falha").
ALTER TABLE accounts
  ADD COLUMN session_refresh_attempted_at timestamptz,
  ADD COLUMN session_refresh_failures     integer NOT NULL DEFAULT 0;

-- Índice parcial que serve a seleção de contas a refrescar: só sessões vivas,
-- ordenáveis por expiração.
CREATE INDEX accounts_session_expiry_idx
  ON accounts (session_expires_at)
  WHERE session_status IN ('valid','expiring');

-- ---------------------------------------------------------------------------
-- Pipeline de sistema para jobs de manutenção
-- ---------------------------------------------------------------------------

-- `jobs` exige execution_id/pipeline_id (todo job nasce de um pipeline). O
-- refresh preventivo não vem de um pipeline do usuário, então ele nasce deste
-- pipeline de sistema, de id fixo e conhecido. Assim a manutenção aparece na
-- mesma observabilidade dos demais jobs, sem afrouxar o schema.
INSERT INTO pipelines (id, name, description, steps, enabled)
VALUES (
  '00000000-0000-0000-0000-000000000008',
  'system:session-refresh',
  'Pipeline de sistema: refresh preventivo de token (módulo 8). Não editar.',
  '[]'::jsonb,
  true
);
