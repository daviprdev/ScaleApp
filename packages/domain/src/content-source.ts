/**
 * Content Acquisition: fonte de conteúdo lida por scraping via conta dedicada
 * (não Apify — Apify não pega conteúdo privado nem lista completa). Reutiliza a
 * mesma infra de conta+proxy do driver de postagem, só que para leitura.
 */

import type {
  AccountId,
  ContentSourceId,
  IsoTimestamp,
  MediaFolderId,
} from "./common.js";

export enum ContentSourceType {
  /** Perfil — inclui privado, o que exige conta autenticada. */
  Profile = "profile",
  Hashtag = "hashtag",
  Audio = "audio",
}

export enum ContentSourceStatus {
  Active = "active",
  Paused = "paused",
  Error = "error",
}

export interface ContentSource {
  readonly id: ContentSourceId;
  readonly type: ContentSourceType;
  /** Handle, hashtag ou id de áudio conforme o `type`. */
  readonly target: string;

  /** Conta dedicada de scraping (com seu proxy dedicado) que faz a leitura. */
  readonly acquisitionAccountId: AccountId;
  /** Pasta de destino do conteúdo adquirido. */
  readonly destinationFolderId: MediaFolderId;

  readonly status: ContentSourceStatus;
  /** Cadência baixa/humana da coleta recorrente. */
  readonly pollIntervalMinutes?: number;
  readonly lastAcquiredAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}
