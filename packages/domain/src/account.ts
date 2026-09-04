/**
 * Account Registry: cadastro de conta Instagram — credenciais, sessão, proxy
 * dedicado, Meta App, tags/grupos, saúde, prioridade de failover e estado de
 * warmup.
 *
 * Só o contrato: nada aqui sabe como logar, refrescar token ou detectar
 * checkpoint — isso é do Execution Plane / Session Manager.
 */

import type {
  AccountId,
  IsoTimestamp,
  MetaAppId,
  ProxyId,
} from "./common.js";

/** Graph API primária exige Business/Creator; `Personal` só para diagnóstico. */
export enum InstagramAccountType {
  Business = "business",
  Creator = "creator",
  Personal = "personal",
}

export enum AccountLifecycleState {
  /** Recém-cadastrada, ainda não iniciou warmup. */
  New = "new",
  /** Período de carência (regra de design 7): cadência baixa, sync não agressivo. */
  Warmup = "warmup",
  Active = "active",
  Paused = "paused",
  Disabled = "disabled",
  Failed = "failed",
}

/**
 * Saúde operacional. `CheckpointRequired` e `TokenDead` são estados distintos
 * de propósito (regra de design 3): tratá-los como o mesmo erro trava contas
 * que só precisavam de login manual.
 */
export enum AccountHealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  RateLimited = "rate_limited",
  CheckpointRequired = "checkpoint_required",
  TokenDead = "token_dead",
  Suspended = "suspended",
  Unknown = "unknown",
}

/** `Expiring` existe para o refresh preventivo, antes do erro (regra 6). */
export enum SessionStatus {
  Valid = "valid",
  Expiring = "expiring",
  Expired = "expired",
  Revoked = "revoked",
}

export interface AccountSession {
  /** Referência ao token no cofre criptografado — nunca o token em texto. */
  readonly accessTokenRef: string;
  readonly status: SessionStatus;
  readonly issuedAt?: IsoTimestamp;
  /** Base para o refresh preventivo (regra 6). */
  readonly expiresAt?: IsoTimestamp;
  readonly refreshedAt?: IsoTimestamp;
}

export interface AccountCredentials {
  readonly username: string;
  /** Referência a segredos no cofre — criptografia em repouso (módulo 8). */
  readonly secretRef?: string;
}

/** Carência de conta nova (regra 7), implementada de verdade desde o início. */
export interface WarmupState {
  readonly startedAt: IsoTimestamp;
  /** Fim previsto do período de carência. */
  readonly completesAt: IsoTimestamp;
  readonly completed: boolean;
}

export interface Account {
  readonly id: AccountId;
  readonly handle: string;
  readonly accountType: InstagramAccountType;
  readonly lifecycleState: AccountLifecycleState;
  readonly health: AccountHealthStatus;

  /** Qual Meta App a conta usa (distribuição BYOC obrigatória). */
  readonly metaAppId: MetaAppId;
  /** Proxy dedicado obrigatório (regra 10). */
  readonly proxyId: ProxyId;

  readonly credentials: AccountCredentials;
  readonly session?: AccountSession;

  readonly tags: readonly string[];
  readonly groups: readonly string[];

  /** Prioridade de failover: menor = preferida para assumir carga. */
  readonly failoverPriority: number;

  /** Presente enquanto a conta está em carência; ausente após o warmup. */
  readonly warmup?: WarmupState;

  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
