/**
 * `LibraryMediaResolver` — implementação real da porta `MediaResolver` que o
 * driver consome. Substitui o `UrlMediaResolver` de desenvolvimento, que só
 * sabia devolver a própria string quando ela já era uma URL http(s).
 *
 * O que o driver recebe é uma URL assinada e temporária apontando para a nossa
 * API, porque a Graph API baixa a mídia por conta própria. O `kind` sai do MIME
 * persistido — é ele que decide `image_url` vs `video_url` na publicação.
 *
 * Devolve null (o driver traduz para `InvalidInput`) quando a mídia não existe,
 * foi apagada ou não está pronta: melhor falhar o job do que mandar o
 * Instagram baixar 404.
 */

import type { MediaKind } from "./content.js";
import type { UrlSigner } from "./ports.js";
import type { MediaRepository } from "./repository.js";
import { buildMediaUrl, signMediaAccess } from "./signedUrl.js";

export interface ResolvedMedia {
  readonly url: string;
  readonly kind: MediaKind;
}

/** Mesma forma da porta `MediaResolver` do driver (sem depender dele). */
export interface MediaResolverPort {
  resolveMedia(mediaId: string): Promise<ResolvedMedia | null>;
}

export interface LibraryMediaResolverOptions {
  /**
   * Base pública da API, alcançável pela internet — é daqui que o Instagram
   * baixa o arquivo. `http://localhost` só funciona em teste.
   */
  readonly publicBaseUrl: string;
  /**
   * Validade da URL. Precisa cobrir o download do lado da Meta (vídeo grande +
   * fila deles), não só a duração do nosso job.
   */
  readonly urlTtlMs?: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LibraryMediaResolver implements MediaResolverPort {
  private readonly ttlMs: number;

  constructor(
    private readonly repo: MediaRepository,
    private readonly signer: UrlSigner,
    private readonly options: LibraryMediaResolverOptions,
  ) {
    this.ttlMs = options.urlTtlMs ?? DEFAULT_TTL_MS;
  }

  async resolveMedia(mediaId: string): Promise<ResolvedMedia | null> {
    // Id malformado nunca vira consulta (uuid inválido explodiria no Postgres).
    if (!UUID_RE.test(mediaId)) return null;

    const asset = await this.repo.getAsset(mediaId);
    if (!asset || asset.status !== "ready") return null;

    const parts = signMediaAccess(this.signer, asset.id, this.ttlMs);
    return {
      url: buildMediaUrl(this.options.publicBaseUrl, parts),
      kind: asset.kind,
    };
  }
}
