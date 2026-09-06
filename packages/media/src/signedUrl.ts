/**
 * URL pública assinada da mídia.
 *
 * A Graph API não recebe bytes: ela recebe uma URL e baixa o arquivo sozinha.
 * Ou seja, a biblioteca precisa ser alcançável da internet — e uma URL
 * adivinhável por id exporia o acervo inteiro. Daí assinatura HMAC com
 * expiração curta: a URL vale para uma mídia, por uma janela, e só.
 *
 * A janela precisa cobrir o tempo que o Instagram leva para baixar o arquivo
 * (vídeo grande, fila do lado deles), não só o tempo do nosso job.
 */

import { timingSafeEqual } from "node:crypto";
import type { UrlSigner } from "./ports.js";

export interface SignedMediaUrlParts {
  readonly assetId: string;
  readonly expiresAtSec: number;
  readonly signature: string;
}

export class SignedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedUrlError";
  }
}

/** Payload assinado. Inclui a expiração para que ela não possa ser esticada. */
function payload(assetId: string, expiresAtSec: number): string {
  return `${assetId}.${expiresAtSec}`;
}

export function signMediaAccess(
  signer: UrlSigner,
  assetId: string,
  ttlMs: number,
  now: number = Date.now(),
): SignedMediaUrlParts {
  const expiresAtSec = Math.floor((now + ttlMs) / 1000);
  return {
    assetId,
    expiresAtSec,
    signature: signer.sign(payload(assetId, expiresAtSec)),
  };
}

/** Monta a URL completa que vai para a Graph API. */
export function buildMediaUrl(baseUrl: string, parts: SignedMediaUrlParts): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({
    exp: String(parts.expiresAtSec),
    sig: parts.signature,
  });
  return `${base}/media/${parts.assetId}/raw?${query.toString()}`;
}

/**
 * Verifica assinatura e validade. Comparação em tempo constante — a assinatura
 * é o único obstáculo entre a internet e a biblioteca.
 */
export function verifyMediaAccess(
  signer: UrlSigner,
  assetId: string,
  expiresAtSec: number,
  signature: string,
  now: number = Date.now(),
): void {
  if (!Number.isFinite(expiresAtSec)) throw new SignedUrlError("expiração inválida");
  if (expiresAtSec * 1000 <= now) throw new SignedUrlError("URL expirada");

  const expected = Buffer.from(signer.sign(payload(assetId, expiresAtSec)), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new SignedUrlError("assinatura inválida");
  }
}
