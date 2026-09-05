/**
 * @scaleapp/session — Session/Credential Manager (módulo 8): cofre com
 * criptografia em repouso, login OAuth, refresh preventivo de token e as
 * transições de saúde de sessão (checkpoint ≠ token morto).
 *
 * Não conhece Instagram: a troca OAuth entra pela porta `OAuthTokenExchange`,
 * implementada no pacote do driver e ligada pelo composition root.
 */

export { Keyring, KeyringError, SECRET_ALGORITHM, secretAad } from "./crypto.js";
export type { EncryptedPayload } from "./crypto.js";

export {
  PostgresSecretVault,
  VAULT_SCHEME,
  isVaultRef,
  parseVaultRef,
  toVaultRef,
} from "./vault.js";
export type { SecretVault, SecretKind, Executor } from "./vault.js";

export { SessionRepository } from "./sessionRepository.js";
export type {
  AccountAuthContext,
  FindDueForRefreshOptions,
  RefreshCandidate,
  SessionSnapshot,
} from "./sessionRepository.js";

export { computeSessionStatus, staggerDelayMs } from "./status.js";

export { VaultCredentialResolver, VaultTokenSink } from "./resolvers.js";
export type {
  CredentialResolverPort,
  TokenSinkPort,
  VaultCredentialResolverOptions,
} from "./resolvers.js";

export {
  SESSION_REFRESH_PIPELINE_ID,
  SESSION_REFRESH_STEP_ID,
  planPreventiveRefresh,
  refreshIdempotencyKey,
} from "./refreshPlanner.js";
export type { PlanRefreshOptions, PlanRefreshResult } from "./refreshPlanner.js";

export { OAuthStateError, signOAuthState, verifyOAuthState } from "./oauthState.js";
export type { OAuthStateClaims } from "./oauthState.js";

export { AccountLoginService, DEFAULT_SCOPES, LoginError } from "./loginService.js";
export type {
  AccountLoginServiceDeps,
  AuthorizationStart,
  LoginCompletion,
} from "./loginService.js";

export type {
  LongLivedToken,
  OAuthTokenExchange,
  ProfileIdentity,
  ProxyConnection,
  ProxyResolverPort,
  ShortLivedToken,
} from "./ports.js";

export { createSessionFailureHandler } from "./failureHandler.js";
export type { SessionFailureHandlerOptions } from "./failureHandler.js";

export { startSessionRefreshSweep } from "./sweep.js";
export type { SessionSweepHandle, SessionSweepOptions } from "./sweep.js";

export { DEFAULT_SESSION_CONFIG, loadSessionConfig } from "./config.js";
export type { SessionConfig } from "./config.js";
