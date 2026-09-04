/**
 * @scaleapp/driver-graph — driver primário (Graph API oficial) da porta
 * `AutomationDriver`. Depende só de portas injetadas (HTTP/Credential/Proxy/
 * Media); os módulos reais de Sessão (8), Proxy (9) e Biblioteca de mídia
 * implementam essas portas depois. Inclui stubs de desenvolvimento.
 */

export { GraphApiDriver } from "./graphDriver.js";
export type { GraphApiDriverDeps } from "./graphDriver.js";
export { DEFAULT_GRAPH_CONFIG } from "./config.js";
export type { GraphApiConfig } from "./config.js";
export { UndiciHttpClient, HttpTransportError } from "./httpClient.js";
export type { HttpClient, HttpRequest, HttpResponse } from "./httpClient.js";
export type {
  CredentialResolver,
  ProxyResolver,
  ProxyConnection,
  MediaResolver,
  ResolvedMedia,
  ResolvedMediaKind,
} from "./ports.js";
export {
  mapHttpError,
  mapTransportError,
  preconditionError,
  tokenUnresolved,
  proxyUnavailable,
  containerError,
} from "./errors.js";
export type { GraphErrorBody } from "./errors.js";
export {
  DbAccountProxyResolver,
  EnvCredentialResolver,
  UrlMediaResolver,
} from "./devResolvers.js";
