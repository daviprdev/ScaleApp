-- Fase 07 — Biblioteca de Mídia.
--
-- Separação central: o Postgres guarda METADADOS, o storage guarda BYTES.
-- Nada de bytea/large object aqui — um banco com vídeos dentro fica impossível
-- de fazer backup e de replicar, e todo SELECT vira risco de memória.
--
-- Duas tabelas em vez de uma, de propósito:
--  - `media_blobs` é o conteúdo, endereçado por checksum: bytes idênticos
--    ocupam UMA cópia no storage, não importa quantas vezes sejam cadastrados.
--    É isso que torna a deduplicação uma consequência do modelo, e não uma
--    verificação que alguém pode esquecer de chamar.
--  - `media_assets` é o item lógico: pasta, nome, tipo, uso, origem. O mesmo
--    vídeo pode aparecer em várias pastas sem duplicar arquivo — que é
--    exatamente o caso de "story/reel" ser classificação de uso, não cópia.

-- ---------------------------------------------------------------------------
-- media_folders
-- ---------------------------------------------------------------------------

CREATE TABLE media_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  -- NULL = pasta raiz. ON DELETE RESTRICT: apagar pasta com filha é erro
  -- explícito, não remoção silenciosa de uma árvore inteira.
  parent_id  uuid REFERENCES media_folders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Nome único entre irmãs. COALESCE porque, em UNIQUE do Postgres, NULLs são
-- distintos entre si — sem isso, duas pastas raiz homônimas passariam.
CREATE UNIQUE INDEX media_folders_sibling_name_idx
  ON media_folders (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE INDEX media_folders_parent_idx ON media_folders (parent_id);

CREATE TRIGGER media_folders_set_updated_at
  BEFORE UPDATE ON media_folders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Pasta raiz padrão, de id fixo: dá um destino válido para upload sem que o
-- cliente precise criar pasta antes.
INSERT INTO media_folders (id, name)
VALUES ('00000000-0000-0000-0000-0000000000f0', 'Biblioteca');

-- ---------------------------------------------------------------------------
-- media_blobs (o conteúdo — uma linha por checksum)
-- ---------------------------------------------------------------------------

CREATE TABLE media_blobs (
  -- sha256 hex do conteúdo. Chave primária natural: é o próprio conteúdo.
  checksum    text PRIMARY KEY CHECK (checksum ~ '^[0-9a-f]{64}$'),
  -- Caminho no storage. Opaco para o banco: quem interpreta é a porta de
  -- storage, para o backend poder trocar (FS → S3/MinIO) sem migration.
  storage_key text NOT NULL UNIQUE,
  byte_size   bigint NOT NULL CHECK (byte_size > 0),
  mime_type   text NOT NULL,
  -- `pending_delete`: o item lógico já sumiu, mas os bytes ainda não foram
  -- removidos (ou a remoção falhou). Existe para que falha parcial vire
  -- trabalho pendente rastreável, e não lixo invisível no disco.
  state       text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','pending_delete')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_blobs_pending_delete_idx ON media_blobs (updated_at)
  WHERE state = 'pending_delete';

CREATE TRIGGER media_blobs_set_updated_at
  BEFORE UPDATE ON media_blobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- media_assets (o item lógico)
-- ---------------------------------------------------------------------------

CREATE TABLE media_assets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id  uuid NOT NULL REFERENCES media_folders(id) ON DELETE RESTRICT,
  checksum   text NOT NULL REFERENCES media_blobs(checksum) ON DELETE RESTRICT,

  -- O que o arquivo É. Só isto decide a chamada do driver (image_url vs
  -- video_url).
  kind       text NOT NULL CHECK (kind IN ('image','video')),
  -- Para que ele SERVE. Classificação de uso: mudar de 'feed' para 'story'
  -- não copia byte nenhum.
  usage      text NOT NULL DEFAULT 'any' CHECK (usage IN ('any','feed','story','reel')),

  name       text NOT NULL CHECK (length(trim(name)) > 0),
  source     text NOT NULL CHECK (source IN ('upload','import_url','acquisition')),
  -- URL/identificador de origem quando importada — rastreabilidade de onde veio.
  source_ref text,

  status     text NOT NULL DEFAULT 'ready'
               CHECK (status IN ('pending','ready','failed','deleted')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX media_assets_folder_idx ON media_assets (folder_id, created_at DESC);
CREATE INDEX media_assets_checksum_idx ON media_assets (checksum);
CREATE INDEX media_assets_status_idx ON media_assets (status);

-- Deduplicação no nível do item: o mesmo conteúdo duas vezes na MESMA pasta é
-- sempre engano. Em pastas diferentes é legítimo (a mesma criação usada em
-- campanhas distintas) e continua sem duplicar bytes, porque o blob é um só.
CREATE UNIQUE INDEX media_assets_folder_checksum_idx
  ON media_assets (folder_id, checksum)
  WHERE status <> 'deleted';

CREATE TRIGGER media_assets_set_updated_at
  BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
