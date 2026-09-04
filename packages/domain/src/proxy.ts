/**
 * Proxy. Dedicado por conta, obrigatório, nunca rotativo por padrão
 * (regra de design 10) — rotacionar o IP no meio de uma operação é fonte real
 * de bloqueio. O pool faz atribuição/liberação e health check.
 */

import type { AccountId, IsoTimestamp, ProxyId } from "./common.js";

export enum ProxyProtocol {
  Http = "http",
  Https = "https",
  Socks5 = "socks5",
}

export enum ProxyHealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  Down = "down",
  Unknown = "unknown",
}

export enum ProxyAssignmentState {
  /** Disponível no pool para atribuição. */
  Available = "available",
  /** Dedicado a uma conta (regra 10). */
  Assigned = "assigned",
  Reserved = "reserved",
  Retired = "retired",
}

export interface Proxy {
  readonly id: ProxyId;
  readonly protocol: ProxyProtocol;
  readonly host: string;
  readonly port: number;
  /** Referência a user:pass no cofre — nunca credenciais em texto no domínio. */
  readonly credentialsRef?: string;

  readonly assignmentState: ProxyAssignmentState;
  /** Conta à qual este proxy está dedicado, quando atribuído. */
  readonly assignedAccountId?: AccountId;

  readonly health: ProxyHealthStatus;
  readonly lastCheckedAt?: IsoTimestamp;
}
