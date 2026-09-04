/** Configuração do driver Graph API (endpoint, versão, polling de container). */
export interface GraphApiConfig {
  /**
   * Base da API. Instagram Login API usa `graph.instagram.com`. Configurável
   * para apontar a um mock/sandbox nos testes end-to-end.
   */
  readonly baseUrl: string;
  readonly apiVersion: string;
  /** Intervalo entre checagens de status do container de vídeo. */
  readonly containerPollIntervalMs: number;
  /** Máximo de checagens antes de desistir (evita loop infinito). */
  readonly containerPollMaxAttempts: number;
  /** Timeout por requisição HTTP. */
  readonly requestTimeoutMs: number;
}

export const DEFAULT_GRAPH_CONFIG: GraphApiConfig = {
  baseUrl: "https://graph.instagram.com",
  apiVersion: "v21.0",
  containerPollIntervalMs: 3_000,
  containerPollMaxAttempts: 20,
  requestTimeoutMs: 30_000,
};
