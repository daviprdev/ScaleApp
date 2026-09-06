/**
 * Identidade e classificação do conteúdo: checksum, chave de storage, tipo de
 * mídia a partir do MIME. Tudo puro — dá para testar sem banco nem disco.
 */

import { createHash } from "node:crypto";

export type MediaKind = "image" | "video";
export type MediaUsage = "any" | "feed" | "story" | "reel";
export type MediaSource = "upload" | "import_url" | "acquisition";

/** MIMEs aceitos, com a extensão usada na chave e o tipo correspondente. */
const MIME_TABLE: ReadonlyMap<string, { ext: string; kind: MediaKind }> = new Map([
  ["image/jpeg", { ext: "jpg", kind: "image" }],
  ["image/png", { ext: "png", kind: "image" }],
  ["image/webp", { ext: "webp", kind: "image" }],
  ["image/heic", { ext: "heic", kind: "image" }],
  ["video/mp4", { ext: "mp4", kind: "video" }],
  ["video/quicktime", { ext: "mov", kind: "video" }],
  ["video/webm", { ext: "webm", kind: "video" }],
]);

export class UnsupportedMediaTypeError extends Error {
  constructor(readonly mimeType: string) {
    super(`tipo de mídia não suportado: ${mimeType}`);
    this.name = "UnsupportedMediaTypeError";
  }
}

/** Normaliza `image/jpeg; charset=…` → `image/jpeg`. */
export function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

export function isSupportedMime(mimeType: string): boolean {
  return MIME_TABLE.has(normalizeMime(mimeType));
}

/**
 * Tipo do arquivo a partir do MIME. É a única coisa que decide como o driver
 * publica (imagem vs vídeo) — por isso não é adivinhado por extensão do nome,
 * que o usuário controla.
 */
export function kindFromMime(mimeType: string): MediaKind {
  const entry = MIME_TABLE.get(normalizeMime(mimeType));
  if (!entry) throw new UnsupportedMediaTypeError(mimeType);
  return entry.kind;
}

export function extensionFromMime(mimeType: string): string {
  const entry = MIME_TABLE.get(normalizeMime(mimeType));
  if (!entry) throw new UnsupportedMediaTypeError(mimeType);
  return entry.ext;
}

/** Adivinha o MIME pela extensão — só como fallback quando a origem não diz. */
export function mimeFromFilename(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  for (const [mime, entry] of MIME_TABLE) {
    if (entry.ext === ext) return mime;
  }
  if (ext === "jpeg") return "image/jpeg";
  return undefined;
}

export function checksumOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Chave endereçada por conteúdo. Mesmo conteúdo ⇒ mesma chave ⇒ uma cópia só
 * no storage, sem ninguém precisar lembrar de conferir duplicata.
 */
export function storageKeyFor(checksum: string, mimeType: string): string {
  const ext = extensionFromMime(mimeType);
  return `sha256/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}.${ext}`;
}

/** Uso compatível com o tipo: story/reel só fazem sentido para vídeo/imagem. */
export function usageAllowedFor(kind: MediaKind, usage: MediaUsage): boolean {
  if (usage === "reel") return kind === "video";
  return true;
}
