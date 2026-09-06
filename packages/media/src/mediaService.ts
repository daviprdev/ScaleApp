/**
 * Serviço da biblioteca: é aqui que a ordem das operações entre banco e
 * storage é decidida — e a ordem é a coisa que importa nesta camada.
 *
 * **Ingestão**: bytes primeiro, metadados depois. Se o processo morrer no meio,
 * sobra um objeto no storage sem linha no banco: invisível, inofensivo e
 * recolhível. A ordem inversa produziria o contrário — uma linha apontando
 * para bytes que não existem, ou seja, uma mídia que o pipeline promete
 * publicar e não consegue.
 *
 * **Remoção**: banco primeiro, storage depois. Assim que a referência sai, nada
 * mais resolve para aquele arquivo; os bytes viram trabalho pendente
 * (`pending_delete`) que o coletor termina. Falha parcial fica registrada como
 * pendência, nunca como lixo silencioso.
 */

import type { Pool } from "pg";
import {
  UnsupportedMediaTypeError,
  checksumOf,
  kindFromMime,
  mimeFromFilename,
  normalizeMime,
  storageKeyFor,
  usageAllowedFor,
  type MediaKind,
  type MediaSource,
  type MediaUsage,
} from "./content.js";
import type { MediaFetcher, MediaStorage } from "./ports.js";
import {
  MediaRepository,
  ROOT_FOLDER_ID,
  type ListAssetsOptions,
  type MediaAsset,
} from "./repository.js";

export class MediaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

export interface IngestInput {
  readonly bytes: Buffer;
  readonly name: string;
  /** MIME declarado pela origem; se ausente, inferido do nome do arquivo. */
  readonly mimeType?: string;
  readonly folderId?: string;
  readonly usage?: MediaUsage;
  readonly source?: MediaSource;
  readonly sourceRef?: string;
}

export interface IngestResult {
  readonly asset: MediaAsset;
  /** Verdadeiro quando o conteúdo já existia na pasta e nada foi duplicado. */
  readonly deduplicated: boolean;
  /** Verdadeiro quando os bytes já estavam no storage (mesmo checksum). */
  readonly bytesReused: boolean;
}

export interface DeleteResult {
  readonly deleted: boolean;
  /** Bytes removidos do storage (só quando ninguém mais referenciava). */
  readonly bytesRemoved: boolean;
  /**
   * Metadado removido, bytes não. A referência já sumiu (nada resolve mais para
   * ela) e a limpeza ficou pendente para o coletor — falha parcial explícita.
   */
  readonly pendingStorageCleanup: boolean;
}

export interface MediaLibraryDeps {
  readonly pool: Pool;
  readonly storage: MediaStorage;
  readonly fetcher?: MediaFetcher;
  /** Teto de bytes por arquivo. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;

export class MediaLibrary {
  private readonly repo: MediaRepository;
  private readonly maxBytes: number;

  constructor(private readonly deps: MediaLibraryDeps) {
    this.repo = new MediaRepository(deps.pool);
    this.maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get repository(): MediaRepository {
    return this.repo;
  }

  // --- pastas ------------------------------------------------------------------

  async createFolder(name: string, parentId?: string): Promise<{ id: string; name: string }> {
    if (parentId && !(await this.repo.getFolder(parentId))) {
      throw new MediaError(`pasta pai ${parentId} não existe`, "FOLDER_NOT_FOUND");
    }
    return this.repo.createFolder(name, parentId ?? null);
  }

  async listFolders(limit: number, parentId?: string | null) {
    return this.repo.listFolders(limit, parentId);
  }

  /** Só apaga pasta vazia — perder mídia por apagar pasta seria irreversível. */
  async deleteFolder(id: string): Promise<void> {
    if (id === ROOT_FOLDER_ID) {
      throw new MediaError("a pasta raiz não pode ser removida", "ROOT_FOLDER");
    }
    const remaining = await this.repo.countAssetsInFolder(id);
    if (remaining > 0) {
      throw new MediaError(`pasta tem ${remaining} mídia(s); esvazie antes`, "FOLDER_NOT_EMPTY");
    }
    if (!(await this.repo.deleteFolder(id))) {
      throw new MediaError(`pasta ${id} não existe`, "FOLDER_NOT_FOUND");
    }
  }

  // --- ingestão -----------------------------------------------------------------

  /** Cadastra bytes já em mãos (upload). */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const folderId = input.folderId ?? ROOT_FOLDER_ID;
    if (input.bytes.byteLength === 0) {
      throw new MediaError("arquivo vazio", "EMPTY_FILE");
    }
    if (input.bytes.byteLength > this.maxBytes) {
      throw new MediaError(
        `arquivo com ${input.bytes.byteLength} bytes excede o limite de ${this.maxBytes}`,
        "TOO_LARGE",
      );
    }
    if (!(await this.repo.getFolder(folderId))) {
      throw new MediaError(`pasta ${folderId} não existe`, "FOLDER_NOT_FOUND");
    }

    const declared = input.mimeType ? normalizeMime(input.mimeType) : undefined;
    const mimeType = declared ?? mimeFromFilename(input.name);
    if (!mimeType) {
      throw new MediaError(
        `não foi possível determinar o tipo de "${input.name}" — informe o content-type`,
        "UNKNOWN_MIME",
      );
    }

    let kind: MediaKind;
    try {
      kind = kindFromMime(mimeType);
    } catch (err) {
      if (err instanceof UnsupportedMediaTypeError) {
        throw new MediaError(err.message, "UNSUPPORTED_TYPE");
      }
      throw err;
    }

    const usage = input.usage ?? "any";
    if (!usageAllowedFor(kind, usage)) {
      throw new MediaError(`uso "${usage}" não se aplica a ${kind}`, "USAGE_MISMATCH");
    }

    const checksum = checksumOf(input.bytes);
    const storageKey = storageKeyFor(checksum, mimeType);

    // 1) Bytes primeiro (idempotente por conteúdo).
    const bytesReused = await this.deps.storage.exists(storageKey);
    await this.deps.storage.put({ key: storageKey, bytes: input.bytes, contentType: mimeType });

    // 2) Metadados, numa transação: blob e item nascem juntos ou não nascem.
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await this.repo.upsertBlob(
        { checksum, storageKey, byteSize: input.bytes.byteLength, mimeType },
        client,
      );
      const created = await this.repo.createAsset(
        {
          folderId,
          checksum,
          name: input.name,
          kind,
          usage,
          source: input.source ?? "upload",
          ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
        },
        client,
      );
      if (created) {
        await client.query("COMMIT");
        await this.ensureBytesPresent(storageKey, input.bytes, mimeType);
        return { asset: created, deduplicated: false, bytesReused };
      }

      // Conflito: já existe item vivo com este conteúdo nesta pasta. Devolve o
      // existente em vez de criar um irmão idêntico.
      const existing = await this.repo.findLiveAssetByChecksum(folderId, checksum, client);
      await client.query("COMMIT");
      await this.ensureBytesPresent(storageKey, input.bytes, mimeType);
      if (!existing) {
        throw new MediaError("conflito de deduplicação sem item correspondente", "DEDUP_RACE");
      }
      return { asset: existing, deduplicated: true, bytesReused };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Importa de uma URL externa (o download é nosso, não de uma conta). */
  async importFromUrl(input: {
    readonly url: string;
    readonly name?: string;
    readonly folderId?: string;
    readonly usage?: MediaUsage;
  }): Promise<IngestResult> {
    if (!this.deps.fetcher) {
      throw new MediaError("importação por URL não está configurada", "NO_FETCHER");
    }
    const fetched = await this.deps.fetcher.fetch(input.url, this.maxBytes);
    const fallbackName = input.name ?? nameFromUrl(input.url);
    return this.ingest({
      bytes: fetched.bytes,
      name: fallbackName,
      ...(fetched.contentType ? { mimeType: fetched.contentType } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      source: "import_url",
      sourceRef: input.url,
    });
  }

  // --- consulta --------------------------------------------------------------------

  async get(id: string): Promise<MediaAsset | null> {
    return this.repo.getAsset(id);
  }

  async list(opts: ListAssetsOptions): Promise<{
    readonly items: readonly MediaAsset[];
    readonly total: number;
    readonly limit: number;
    readonly offset: number;
  }> {
    const [items, total] = await Promise.all([
      this.repo.listAssets(opts),
      this.repo.countAssets({
        ...(opts.folderId !== undefined ? { folderId: opts.folderId } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
        ...(opts.includeDeleted !== undefined ? { includeDeleted: opts.includeDeleted } : {}),
      }),
    ]);
    return { items, total, limit: opts.limit, offset: opts.offset ?? 0 };
  }

  // --- movimentação ------------------------------------------------------------------

  async move(id: string, folderId: string): Promise<MediaAsset> {
    const asset = await this.repo.getAsset(id);
    if (!asset || asset.status === "deleted") {
      throw new MediaError(`mídia ${id} não existe`, "NOT_FOUND");
    }
    if (!(await this.repo.getFolder(folderId))) {
      throw new MediaError(`pasta ${folderId} não existe`, "FOLDER_NOT_FOUND");
    }
    if (asset.folderId === folderId) return asset;

    // Mover NÃO copia bytes: só muda o vínculo do item. O conteúdo continua
    // sendo o mesmo blob, com a mesma chave de storage.
    try {
      const moved = await this.repo.moveAsset(id, folderId);
      if (!moved) throw new MediaError(`mídia ${id} não existe`, "NOT_FOUND");
      return moved;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new MediaError(
          "a pasta de destino já tem esta mídia (mesmo checksum)",
          "DUPLICATE_IN_TARGET",
        );
      }
      throw err;
    }
  }

  async rename(id: string, name: string): Promise<MediaAsset> {
    const renamed = await this.repo.renameAsset(id, name);
    if (!renamed) throw new MediaError(`mídia ${id} não existe`, "NOT_FOUND");
    return renamed;
  }

  // --- remoção ------------------------------------------------------------------------

  /**
   * Remove o item e, se ninguém mais referenciar o conteúdo, os bytes.
   * Nunca apaga bytes ainda referenciados por outra pasta — é o outro lado da
   * deduplicação: conteúdo compartilhado só some quando o último item some.
   */
  async delete(id: string): Promise<DeleteResult> {
    const client = await this.deps.pool.connect();
    let checksum: string;
    let storageKey: string;
    let orphan: boolean;
    try {
      await client.query("BEGIN");
      const removed = await this.repo.markAssetDeleted(id, client);
      if (!removed) {
        await client.query("ROLLBACK");
        // Já estava apagado (ou nunca existiu): remoção é idempotente, e uma
        // segunda chamada concorrente não repete o trabalho de storage.
        return { deleted: false, bytesRemoved: false, pendingStorageCleanup: false };
      }
      checksum = removed.checksum;
      storageKey = removed.storageKey;
      orphan = (await this.repo.countLiveReferences(checksum, client)) === 0;
      if (orphan) await this.repo.markBlobPendingDelete(checksum, client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    if (!orphan) return { deleted: true, bytesRemoved: false, pendingStorageCleanup: false };

    const reclaimed = await this.reclaimBlob(checksum, storageKey);
    return {
      deleted: true,
      bytesRemoved: reclaimed.bytesRemoved,
      pendingStorageCleanup: !reclaimed.bytesRemoved,
    };
  }

  /**
   * Remove os bytes de um conteúdo sem referências, com a linha travada.
   *
   * A trava é mantida durante o `delete` no storage de propósito: é uma
   * operação curta, e sem ela uma ingestão concorrente do MESMO arquivo
   * poderia marcar o conteúdo como vivo entre a checagem e a remoção — o item
   * novo nasceria apontando para bytes que acabaram de sumir. (O outro lado
   * dessa proteção é `ensureBytesPresent`, na ingestão.)
   *
   * Se o storage falhar, a transação é desfeita e a linha continua
   * `pending_delete`: a pendência sobrevive para o coletor tentar de novo.
   */
  private async reclaimBlob(
    checksum: string,
    storageKey: string,
  ): Promise<{ bytesRemoved: boolean; keptAlive: boolean }> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await this.repo.lockBlob(checksum, client);
      if (!locked || locked.state !== "pending_delete") {
        await client.query("COMMIT");
        return { bytesRemoved: false, keptAlive: false };
      }
      if ((await this.repo.countLiveReferences(checksum, client)) > 0) {
        // Voltou a ser referenciado enquanto esperávamos: os bytes ficam.
        await this.repo.markBlobReady(checksum, client);
        await client.query("COMMIT");
        return { bytesRemoved: false, keptAlive: true };
      }
      await this.deps.storage.delete(locked.storageKey || storageKey);
      await this.repo.deleteBlobRow(checksum, client);
      await client.query("COMMIT");
      return { bytesRemoved: true, keptAlive: false };
    } catch {
      await client.query("ROLLBACK");
      // Falha parcial: metadado do item já saiu, bytes seguem pendentes.
      return { bytesRemoved: false, keptAlive: false };
    } finally {
      client.release();
    }
  }

  /**
   * Garante que os bytes existem ao fim da ingestão. Fecha a janela em que uma
   * remoção concorrente do mesmo conteúdo apagou o arquivo logo depois do
   * nosso `put` — barato (um `stat`) e só reescreve no caso raro.
   */
  private async ensureBytesPresent(
    storageKey: string,
    bytes: Buffer,
    mimeType: string,
  ): Promise<void> {
    if (await this.deps.storage.exists(storageKey)) return;
    await this.deps.storage.put({ key: storageKey, bytes, contentType: mimeType });
  }

  /**
   * Coletor das pendências: apaga do storage o que já não tem referência e
   * fecha a linha do blob. Lote limitado (regra 8). Também recolhe blobs que
   * voltaram a ser referenciados no meio do caminho — nesse caso o `DELETE`
   * condicional não remove a linha, e os bytes precisam existir.
   */
  async collectPendingDeletes(limit: number): Promise<{ removed: number; kept: number }> {
    const pending = await this.repo.findPendingDeleteBlobs(limit);
    let removed = 0;
    let kept = 0;
    for (const blob of pending) {
      const result = await this.reclaimBlob(blob.checksum, blob.storageKey);
      if (result.bytesRemoved) removed++;
      else kept++;
    }
    return { removed, kept };
  }
}

function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? decodeURIComponent(last) : "importado";
  } catch {
    return "importado";
  }
}
