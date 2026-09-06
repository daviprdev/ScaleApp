/**
 * @scaleapp/media — Biblioteca de Mídia: metadados no Postgres, bytes no
 * storage, deduplicação por checksum e o resolver real que o Execution Plane
 * consome no lugar do stub de desenvolvimento.
 *
 * O domínio não conhece filesystem nem provider: tudo passa por `MediaStorage`.
 */

export {
  MediaLibrary,
  MediaError,
} from "./mediaService.js";
export type {
  DeleteResult,
  IngestInput,
  IngestResult,
  MediaLibraryDeps,
} from "./mediaService.js";

export { MediaRepository, ROOT_FOLDER_ID } from "./repository.js";
export type {
  CreateAssetInput,
  Executor,
  ListAssetsOptions,
  MediaAsset,
  MediaFolder,
  MediaStatus,
  UpsertBlobInput,
} from "./repository.js";

export { FilesystemMediaStorage, StorageKeyError } from "./storage/filesystemStorage.js";

export { LibraryMediaResolver } from "./resolver.js";
export type {
  LibraryMediaResolverOptions,
  MediaResolverPort,
  ResolvedMedia,
} from "./resolver.js";

export { MediaServer, MediaServeError } from "./serve.js";
export type { MediaServerDeps, OpenedMedia, ServeFailure } from "./serve.js";

export { HttpMediaFetcher, MediaFetchError } from "./fetcher.js";
export type { HttpMediaFetcherOptions } from "./fetcher.js";

export {
  SignedUrlError,
  buildMediaUrl,
  signMediaAccess,
  verifyMediaAccess,
} from "./signedUrl.js";
export type { SignedMediaUrlParts } from "./signedUrl.js";

export {
  UnsupportedMediaTypeError,
  checksumOf,
  extensionFromMime,
  isSupportedMime,
  kindFromMime,
  mimeFromFilename,
  normalizeMime,
  storageKeyFor,
  usageAllowedFor,
} from "./content.js";
export type { MediaKind, MediaSource, MediaUsage } from "./content.js";

export { DEFAULT_MEDIA_CONFIG, loadMediaConfig } from "./config.js";
export type { MediaConfig } from "./config.js";

export type {
  FetchedMedia,
  MediaFetcher,
  MediaStorage,
  PutObjectInput,
  StoredObject,
  UrlSigner,
} from "./ports.js";
