/**
 * Download para importação por URL. Usa o `fetch` nativo do Node (>=18) — sem
 * dependência nova.
 *
 * O teto de bytes é aplicado enquanto o corpo chega, não depois: confiar no
 * `content-length` significa aceitar que um servidor mentiroso encha a memória
 * do processo. Aqui o download é abortado assim que passa do limite.
 *
 * Este download é da nossa infraestrutura para uma URL pública — não é
 * requisição em nome de uma conta, então não passa por proxy dedicado
 * (a regra 7 é sobre tráfego atribuível a uma conta).
 */

import type { FetchedMedia, MediaFetcher } from "./ports.js";

export class MediaFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MediaFetchError";
  }
}

export interface HttpMediaFetcherOptions {
  readonly timeoutMs?: number;
}

export class HttpMediaFetcher implements MediaFetcher {
  constructor(private readonly options: HttpMediaFetcherOptions = {}) {}

  async fetch(url: string, maxBytes: number): Promise<FetchedMedia> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new MediaFetchError(`URL inválida: ${url}`, "INVALID_URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new MediaFetchError(`protocolo não suportado: ${parsed.protocol}`, "INVALID_URL");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await globalThis.fetch(parsed, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) {
        throw new MediaFetchError(`origem respondeu HTTP ${res.status}`, "HTTP_ERROR");
      }

      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        throw new MediaFetchError(
          `arquivo de ${declared} bytes excede o limite de ${maxBytes}`,
          "TOO_LARGE",
        );
      }

      const chunks: Buffer[] = [];
      let total = 0;
      // O corpo do fetch é async-iterável no Node — dá para aplicar o teto
      // enquanto os pedaços chegam, em vez de depois do arquivo inteiro.
      for await (const chunk of res.body ?? []) {
        const buf = Buffer.from(chunk as Uint8Array);
        total += buf.byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new MediaFetchError(
            `download excedeu o limite de ${maxBytes} bytes`,
            "TOO_LARGE",
          );
        }
        chunks.push(buf);
      }
      if (total === 0) throw new MediaFetchError("origem devolveu corpo vazio", "EMPTY_BODY");

      const contentType = res.headers.get("content-type") ?? undefined;
      return { bytes: Buffer.concat(chunks), ...(contentType ? { contentType } : {}) };
    } catch (err) {
      if (err instanceof MediaFetchError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new MediaFetchError("download expirou", "TIMEOUT");
      }
      throw new MediaFetchError(
        err instanceof Error ? err.message : String(err),
        "FETCH_FAILED",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
