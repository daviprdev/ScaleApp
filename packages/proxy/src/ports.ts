/**
 * Portas do Proxy/Network Manager. Nenhuma delas depende de outro pacote nosso:
 *  - `SecretReader` é satisfeito pelo cofre do módulo 8 (`SecretVault.get`);
 *  - `HttpProbe` é satisfeito pelo `UndiciHttpClient` do driver.
 *
 * As duas são ligadas pelo composition root. O pool não importa nem o cofre nem
 * o driver — ele só precisa saber decifrar uma referência e mandar um GET por
 * um proxy.
 */

/** Lê um segredo do cofre pela referência (`vault://…`). */
export interface SecretReader {
  get(ref: string): Promise<string | null>;
}

export interface ProbeRequest {
  readonly method: "GET";
  readonly url: string;
  readonly proxyUrl: string;
  readonly timeoutMs: number;
}

export interface ProbeResponse {
  readonly status: number;
  readonly body: string;
}

/** Cliente HTTP capaz de sair por um proxy arbitrário. */
export interface HttpProbe {
  request(req: ProbeRequest): Promise<ProbeResponse>;
}
