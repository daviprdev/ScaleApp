/**
 * Porta HTTP do driver Graph API. A abstração existe por dois motivos:
 *  1. Testar o driver sem tocar a rede (um HttpClient fake nos testes).
 *  2. Rotear toda requisição em nome de uma conta por proxy dedicado (regra 10):
 *     `proxyUrl` é obrigatório no caminho real; o `UndiciHttpClient` cria um
 *     `ProxyAgent` por requisição a partir dele.
 */

import { ProxyAgent, request as undiciRequest } from "undici";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Corpo já serializado (form-urlencoded ou JSON). */
  readonly body?: string;
  /** URL do proxy dedicado (ex.: http://user:pass@host:port). */
  readonly proxyUrl?: string;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Erro de transporte (conexão/timeout) — distinto de uma resposta HTTP de erro. */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Se a falha ocorreu tentando falar com o proxy (regra 10). */
    readonly viaProxy: boolean,
  ) {
    super(message);
    this.name = "HttpTransportError";
  }
}

/** Implementação real sobre undici, com proxy por requisição. */
export class UndiciHttpClient implements HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const dispatcher = req.proxyUrl ? new ProxyAgent(req.proxyUrl) : undefined;
    try {
      const res = await undiciRequest(req.url, {
        method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(dispatcher ? { dispatcher } : {}),
        headersTimeout: req.timeoutMs ?? 30_000,
        bodyTimeout: req.timeoutMs ?? 30_000,
      });
      const body = await res.body.text();
      return { status: res.statusCode, body };
    } catch (err) {
      const code =
        (err as { code?: string }).code ?? (err instanceof Error ? err.name : "UNKNOWN");
      throw new HttpTransportError(
        err instanceof Error ? err.message : String(err),
        code,
        req.proxyUrl !== undefined,
      );
    } finally {
      await dispatcher?.close();
    }
  }
}
