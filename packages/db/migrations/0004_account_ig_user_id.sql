-- Fase 06 — driver Graph API real.
--
-- A publicação pela Graph API chama POST /{ig-user-id}/media, onde ig-user-id é
-- o id numérico da conta Instagram Business/Creator (distinto do handle e do
-- nosso uuid interno). O Account Registry ainda não guardava esse id — sem ele
-- o driver Graph API não tem como endereçar a conta. Adicionamos a coluna aqui.
--
-- Nullable: contas cadastradas antes da conversão Business/Creator (ou ainda em
-- onboarding) podem não ter o id resolvido; o driver trata ausência como
-- InvalidInput, não como falha de plataforma.

ALTER TABLE accounts
  ADD COLUMN ig_user_id text;

COMMENT ON COLUMN accounts.ig_user_id IS
  'Id numérico da conta IG Business/Creator, usado pela Graph API (/{ig-user-id}/media). Nullable até a conta ser convertida/resolvida.';
