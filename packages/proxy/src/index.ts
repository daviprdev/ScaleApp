/**
 * @scaleapp/proxy — Proxy/Network Manager (módulo 9): pool com atribuição
 * atômica, proxy dedicado por conta (regra 10), health check com distinção
 * entre proxy morto e outage do provedor (regra 2), e o resolver real que
 * substitui o stub de dev do driver.
 *
 * Não conhece o cofre nem o driver: recebe um `SecretReader` e um `HttpProbe`
 * por injeção.
 */

export { ProxyRepository } from "./proxyRepository.js";
export type {
  CheckOutcome,
  CreateProxyInput,
  ListProxiesOptions,
  ProxyRecord,
  SharedExitIp,
  Executor,
} from "./proxyRepository.js";

export { ProxyAssignmentService, ProxyPoolExhaustedError } from "./assignmentService.js";
export type { ProxySwapResult } from "./assignmentService.js";

export { PoolProxyResolver, buildProxyUrl } from "./resolver.js";
export type {
  PoolProxyResolverOptions,
  ProxyConnection,
  ProxyResolverPort,
} from "./resolver.js";

export {
  DEFAULT_HEALTH_CONFIG,
  decideHealth,
  parseExitIp,
  probeProxy,
  probeSpacingMs,
  runHealthSweep,
  suspectsOutage,
} from "./healthChecker.js";
export type {
  HealthCheckConfig,
  HealthSweepOptions,
  HealthSweepResult,
} from "./healthChecker.js";

export { createProxyFailureHandler } from "./failureHandler.js";
export type { ProxyFailureHandlerOptions, ProxyFailureInfo } from "./failureHandler.js";

export { startProxyHealthSweep } from "./sweep.js";
export type { ProxySweepHandle, ProxySweepOptions } from "./sweep.js";

export { DEFAULT_PROXY_CONFIG, loadProxyConfig } from "./config.js";
export type { ProxyConfig } from "./config.js";

export type { HttpProbe, ProbeRequest, ProbeResponse, SecretReader } from "./ports.js";
