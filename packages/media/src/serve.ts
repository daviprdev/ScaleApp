/**
 * Entrega dos bytes. É o outro lado do resolver: a URL assinada que vai para a
 * Graph API é servida aqui.
 *
 * A verificação é sempre nesta ordem — assinatura, depois banco, depois
 * storage. Consultar o banco antes de validar a assinatura transformaria a
 * rota num oráculo de "este id existe?" para qualquer um na internet.
 */

import type { Readable } from "node:stream";
import type { MediaStorage, UrlSigner } from "./ports.js";
import type { MediaAsset, MediaRepository } from "./repository.js";
import { SignedUrlError, verifyMediaAccess } from "./signedUrl.js";

export interface OpenedMedia {
  readonly stream: Readable;
  readonly asset: MediaAsset;
  readonly mimeType: string;
  readonly byteSize: number;
}

export type ServeFailure = "invalid_signature" | "not_found" | "bytes_missing";

export interface MediaServerDeps {
  readonly repo: MediaRepository;
  readonly storage: MediaStorage;
  readonly signer: UrlSigner;
}

export class MediaServeError extends Error {
  constructor(
    readonly reason: ServeFailure,
    message: string,
  ) {
    super(message);
    this.name = "MediaServeError";
  }
}

export class MediaServer {
  constructor(private readonly deps: MediaServerDeps) {}

  /** Valida a URL assinada e abre o stream do arquivo. */
  async open(assetId: string, expiresAtSec: number, signature: string): Promise<OpenedMedia> {
    try {
      verifyMediaAccess(this.deps.signer, assetId, expiresAtSec, signature);
    } catch (err) {
      throw new MediaServeError(
        "invalid_signature",
        err instanceof SignedUrlError ? err.message : "assinatura inválida",
      );
    }

    const asset = await this.deps.repo.getAsset(assetId);
    if (!asset || asset.status === "deleted") {
      throw new MediaServeError("not_found", `mídia ${assetId} não disponível`);
    }

    if (!(await this.deps.storage.exists(asset.storageKey))) {
      // Metadado sem bytes: inconsistência real, e não um 404 comum. O nome do
      // erro é diferente de propósito para aparecer distinto no log.
      throw new MediaServeError(
        "bytes_missing",
        `mídia ${assetId} sem bytes no storage (${asset.storageKey})`,
      );
    }

    return {
      stream: await this.deps.storage.read(asset.storageKey),
      asset,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
    };
  }
}
