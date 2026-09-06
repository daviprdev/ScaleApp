/**
 * Acesso a dados da biblioteca: pastas, blobs (conteúdo) e assets (item
 * lógico).
 *
 * Regra 8 aqui não é detalhe: uma biblioteca com milhares de vídeos e um
 * `SELECT` sem `LIMIT` é o caminho mais curto para derrubar a API. Toda
 * listagem tem teto explícito.
 *
 * Concorrência: inserção de blob e de asset usam `ON CONFLICT DO NOTHING` e o
 * chamador relê o que já existia. Dois uploads simultâneos do mesmo arquivo
 * terminam com uma linha só, sem erro e sem corrida — a unicidade decide,
 * não a ordem.
 */

import type { Pool, PoolClient } from "pg";
import type { MediaKind, MediaSource, MediaUsage } from "./content.js";

export type Executor = Pool | PoolClient;

/** Pasta raiz criada pela migration 0007. */
export const ROOT_FOLDER_ID = "00000000-0000-0000-0000-0000000000f0";

export type MediaStatus = "pending" | "ready" | "failed" | "deleted";

export interface MediaFolder {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly createdAt: string;
}

/** Item lógico já unido ao conteúdo — é o que a API e o resolver devolvem. */
export interface MediaAsset {
  readonly id: string;
  readonly folderId: string;
  readonly name: string;
  readonly kind: MediaKind;
  readonly usage: MediaUsage;
  readonly source: MediaSource;
  readonly sourceRef: string | null;
  readonly status: MediaStatus;
  readonly checksum: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AssetRow {
  id: string;
  folder_id: string;
  name: string;
  kind: MediaKind;
  usage: MediaUsage;
  source: MediaSource;
  source_ref: string | null;
  status: MediaStatus;
  checksum: string;
  storage_key: string;
  mime_type: string;
  byte_size: string | number;
  created_at: Date;
  updated_at: Date;
}

const ASSET_SELECT = `
  SELECT a.id, a.folder_id, a.name, a.kind, a.usage, a.source, a.source_ref, a.status,
         a.checksum, b.storage_key, b.mime_type, b.byte_size, a.created_at, a.updated_at
  FROM media_assets a JOIN media_blobs b ON b.checksum = a.checksum
`;

function toAsset(r: AssetRow): MediaAsset {
  return {
    id: r.id,
    folderId: r.folder_id,
    name: r.name,
    kind: r.kind,
    usage: r.usage,
    source: r.source,
    sourceRef: r.source_ref,
    status: r.status,
    checksum: r.checksum,
    storageKey: r.storage_key,
    mimeType: r.mime_type,
    byteSize: Number(r.byte_size),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface ListAssetsOptions {
  /** Teto explícito (regra 8). */
  readonly limit: number;
  readonly offset?: number;
  readonly folderId?: string;
  readonly kind?: MediaKind;
  readonly usage?: MediaUsage;
  /** Por padrão, itens apagados não aparecem. */
  readonly includeDeleted?: boolean;
}

export interface CreateAssetInput {
  readonly folderId: string;
  readonly checksum: string;
  readonly name: string;
  readonly kind: MediaKind;
  readonly usage: MediaUsage;
  readonly source: MediaSource;
  readonly sourceRef?: string;
}

export interface UpsertBlobInput {
  readonly checksum: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
}

export class MediaRepository {
  constructor(private readonly pool: Pool) {}

  // --- pastas ----------------------------------------------------------------

  async createFolder(
    name: string,
    parentId: string | null = null,
    executor: Executor = this.pool,
  ): Promise<MediaFolder> {
    const res = await executor.query<{
      id: string;
      name: string;
      parent_id: string | null;
      created_at: Date;
    }>(
      `INSERT INTO media_folders (name, parent_id) VALUES ($1, $2)
       RETURNING id, name, parent_id, created_at`,
      [name.trim(), parentId],
    );
    const r = res.rows[0]!;
    return { id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at.toISOString() };
  }

  async listFolders(limit: number, parentId?: string | null): Promise<readonly MediaFolder[]> {
    // `parentId === undefined` lista tudo; `null` lista só as raízes.
    const filterRoot = parentId === null;
    const res = await this.pool.query<{
      id: string;
      name: string;
      parent_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, name, parent_id, created_at FROM media_folders
       WHERE ($1::boolean IS FALSE OR parent_id IS NULL)
         AND ($2::uuid IS NULL OR parent_id = $2)
       ORDER BY name
       LIMIT $3`,
      [filterRoot, parentId ?? null, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async getFolder(id: string, executor: Executor = this.pool): Promise<MediaFolder | null> {
    const res = await executor.query<{
      id: string;
      name: string;
      parent_id: string | null;
      created_at: Date;
    }>(`SELECT id, name, parent_id, created_at FROM media_folders WHERE id = $1`, [id]);
    const r = res.rows[0];
    return r
      ? { id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at.toISOString() }
      : null;
  }

  /** Quantos itens vivos a pasta tem — usado antes de apagar a pasta. */
  async countAssetsInFolder(folderId: string, executor: Executor = this.pool): Promise<number> {
    const res = await executor.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_assets
       WHERE folder_id = $1 AND status <> 'deleted'`,
      [folderId],
    );
    return res.rows[0]?.n ?? 0;
  }

  async deleteFolder(id: string, executor: Executor = this.pool): Promise<boolean> {
    const res = await executor.query<{ id: string }>(
      `DELETE FROM media_folders WHERE id = $1 RETURNING id`,
      [id],
    );
    return res.rows.length > 0;
  }

  // --- blobs (conteúdo) --------------------------------------------------------

  /**
   * Registra o conteúdo. Idempotente por checksum: se já existe, volta para
   * `ready` (cobre o caso de um blob que estava marcado para remoção e voltou
   * a ser referenciado antes do GC passar).
   */
  async upsertBlob(input: UpsertBlobInput, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `INSERT INTO media_blobs (checksum, storage_key, byte_size, mime_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (checksum) DO UPDATE SET state = 'ready', updated_at = now()`,
      [input.checksum, input.storageKey, input.byteSize, input.mimeType],
    );
  }

  async getBlobStorageKey(checksum: string, executor: Executor = this.pool): Promise<string | null> {
    const res = await executor.query<{ storage_key: string }>(
      `SELECT storage_key FROM media_blobs WHERE checksum = $1`,
      [checksum],
    );
    return res.rows[0]?.storage_key ?? null;
  }

  /** Itens vivos que ainda referenciam o conteúdo (contagem de referências). */
  async countLiveReferences(checksum: string, executor: Executor = this.pool): Promise<number> {
    const res = await executor.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_assets
       WHERE checksum = $1 AND status <> 'deleted'`,
      [checksum],
    );
    return res.rows[0]?.n ?? 0;
  }

  async markBlobPendingDelete(checksum: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(
      `UPDATE media_blobs SET state = 'pending_delete' WHERE checksum = $1`,
      [checksum],
    );
  }

  /**
   * Trava a linha do conteúdo para reivindicá-la. `FOR UPDATE` serializa esta
   * remoção com o `upsertBlob` de uma ingestão concorrente: enquanto a trava
   * está de pé, ninguém consegue marcar o mesmo conteúdo como `ready` no meio
   * da remoção dos bytes.
   */
  async lockBlob(
    checksum: string,
    executor: Executor,
  ): Promise<{ storageKey: string; state: string } | null> {
    const res = await executor.query<{ storage_key: string; state: string }>(
      `SELECT storage_key, state FROM media_blobs WHERE checksum = $1 FOR UPDATE`,
      [checksum],
    );
    const row = res.rows[0];
    return row ? { storageKey: row.storage_key, state: row.state } : null;
  }

  /** Volta o blob para `ready` (voltou a ser referenciado antes do coletor). */
  async markBlobReady(checksum: string, executor: Executor = this.pool): Promise<void> {
    await executor.query(`UPDATE media_blobs SET state = 'ready' WHERE checksum = $1`, [checksum]);
  }

  /** Remove a linha do blob — só depois que os bytes sumiram do storage. */
  async deleteBlobRow(checksum: string, executor: Executor = this.pool): Promise<boolean> {
    const res = await executor.query<{ checksum: string }>(
      `DELETE FROM media_blobs
       WHERE checksum = $1
         AND state = 'pending_delete'
         AND NOT EXISTS (
           SELECT 1 FROM media_assets a WHERE a.checksum = $1 AND a.status <> 'deleted'
         )
       RETURNING checksum`,
      [checksum],
    );
    return res.rows.length > 0;
  }

  /** Blobs cujos bytes ainda precisam sair do storage (limitado — regra 8). */
  async findPendingDeleteBlobs(
    limit: number,
  ): Promise<readonly { checksum: string; storageKey: string }[]> {
    const res = await this.pool.query<{ checksum: string; storage_key: string }>(
      `SELECT checksum, storage_key FROM media_blobs
       WHERE state = 'pending_delete'
       ORDER BY updated_at
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ checksum: r.checksum, storageKey: r.storage_key }));
  }

  // --- assets (item lógico) ------------------------------------------------------

  /**
   * Cria o item. Devolve null quando já existe item vivo com o mesmo conteúdo
   * na mesma pasta — é a deduplicação, decidida pelo índice único e não por um
   * `SELECT` antes do `INSERT` (que teria janela de corrida).
   */
  async createAsset(
    input: CreateAssetInput,
    executor: Executor = this.pool,
  ): Promise<MediaAsset | null> {
    const res = await executor.query<{ id: string }>(
      `INSERT INTO media_assets (folder_id, checksum, name, kind, usage, source, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        input.folderId,
        input.checksum,
        input.name,
        input.kind,
        input.usage,
        input.source,
        input.sourceRef ?? null,
      ],
    );
    const id = res.rows[0]?.id;
    return id ? await this.getAsset(id, executor) : null;
  }

  async getAsset(id: string, executor: Executor = this.pool): Promise<MediaAsset | null> {
    const res = await executor.query<AssetRow>(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
    const row = res.rows[0];
    return row ? toAsset(row) : null;
  }

  async findLiveAssetByChecksum(
    folderId: string,
    checksum: string,
    executor: Executor = this.pool,
  ): Promise<MediaAsset | null> {
    const res = await executor.query<AssetRow>(
      `${ASSET_SELECT} WHERE a.folder_id = $1 AND a.checksum = $2 AND a.status <> 'deleted'`,
      [folderId, checksum],
    );
    const row = res.rows[0];
    return row ? toAsset(row) : null;
  }

  async listAssets(opts: ListAssetsOptions): Promise<readonly MediaAsset[]> {
    const res = await this.pool.query<AssetRow>(
      `${ASSET_SELECT}
       WHERE ($1::uuid IS NULL OR a.folder_id = $1)
         AND ($2::text IS NULL OR a.kind = $2)
         AND ($3::text IS NULL OR a.usage = $3)
         AND ($4::boolean IS TRUE OR a.status <> 'deleted')
       ORDER BY a.created_at DESC, a.id
       LIMIT $5 OFFSET $6`,
      [
        opts.folderId ?? null,
        opts.kind ?? null,
        opts.usage ?? null,
        opts.includeDeleted ?? false,
        opts.limit,
        opts.offset ?? 0,
      ],
    );
    return res.rows.map(toAsset);
  }

  async countAssets(opts: Omit<ListAssetsOptions, "limit" | "offset">): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_assets a
       WHERE ($1::uuid IS NULL OR a.folder_id = $1)
         AND ($2::text IS NULL OR a.kind = $2)
         AND ($3::text IS NULL OR a.usage = $3)
         AND ($4::boolean IS TRUE OR a.status <> 'deleted')`,
      [opts.folderId ?? null, opts.kind ?? null, opts.usage ?? null, opts.includeDeleted ?? false],
    );
    return res.rows[0]?.n ?? 0;
  }

  async moveAsset(
    id: string,
    folderId: string,
    executor: Executor = this.pool,
  ): Promise<MediaAsset | null> {
    const res = await executor.query<{ id: string }>(
      `UPDATE media_assets SET folder_id = $2
       WHERE id = $1 AND status <> 'deleted'
       RETURNING id`,
      [id, folderId],
    );
    return res.rows[0] ? await this.getAsset(id, executor) : null;
  }

  async renameAsset(
    id: string,
    name: string,
    executor: Executor = this.pool,
  ): Promise<MediaAsset | null> {
    const res = await executor.query<{ id: string }>(
      `UPDATE media_assets SET name = $2 WHERE id = $1 AND status <> 'deleted' RETURNING id`,
      [id, name.trim()],
    );
    return res.rows[0] ? await this.getAsset(id, executor) : null;
  }

  /**
   * Marca o item como apagado. Condicional em `status <> 'deleted'`, então
   * duas remoções concorrentes do mesmo item: uma vence, a outra vê `false`
   * e não repete o trabalho de storage.
   */
  async markAssetDeleted(id: string, executor: Executor = this.pool): Promise<MediaAsset | null> {
    const res = await executor.query<AssetRow>(
      `WITH upd AS (
         UPDATE media_assets SET status = 'deleted', deleted_at = now()
         WHERE id = $1 AND status <> 'deleted'
         RETURNING id, folder_id, name, kind, usage, source, source_ref, status, checksum,
                   created_at, updated_at
       )
       SELECT upd.id, upd.folder_id, upd.name, upd.kind, upd.usage, upd.source, upd.source_ref,
              upd.status, upd.checksum, b.storage_key, b.mime_type, b.byte_size,
              upd.created_at, upd.updated_at
       FROM upd JOIN media_blobs b ON b.checksum = upd.checksum`,
      [id],
    );
    const row = res.rows[0];
    return row ? toAsset(row) : null;
  }
}
