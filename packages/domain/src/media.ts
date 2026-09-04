/**
 * Biblioteca de mídia com pastas. Fonte do conteúdo publicado (post único,
 * campanha, loop de repostagem) e destino do Content Acquisition.
 *
 * `storageRef`/`checksum` são referências e metadados — o domínio não carrega
 * bytes de mídia.
 */

import type { IsoTimestamp, MediaFolderId, MediaId } from "./common.js";

export enum MediaType {
  Image = "image",
  Video = "video",
  Carousel = "carousel",
}

export enum MediaOrigin {
  Uploaded = "uploaded",
  /** Veio do Content Acquisition (scraping via conta dedicada). */
  Acquired = "acquired",
}

export interface MediaFolder {
  readonly id: MediaFolderId;
  readonly name: string;
  readonly parentId?: MediaFolderId;
  readonly createdAt: IsoTimestamp;
}

export interface MediaItem {
  readonly id: MediaId;
  readonly folderId: MediaFolderId;
  readonly type: MediaType;
  readonly origin: MediaOrigin;
  /** Referência no storage (não os bytes). */
  readonly storageRef: string;
  readonly durationSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  /** Usado pela distribuição anti-duplicata da campanha em massa. */
  readonly checksum?: string;
  readonly createdAt: IsoTimestamp;
}
