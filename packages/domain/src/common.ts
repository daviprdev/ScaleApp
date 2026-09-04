/**
 * Tipos de apoio compartilhados por todo o domínio: IDs tipados, timestamps,
 * paginação, e a classificação de falha/resultado que atravessa os dois planos.
 *
 * Sem lógica — só contratos.
 */

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

declare const brand: unique symbol;

/** Marca nominal para distinguir tipos primitivos estruturalmente idênticos. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AccountId = Brand<string, "AccountId">;
export type JobId = Brand<string, "JobId">;
export type PipelineId = Brand<string, "PipelineId">;
export type PipelineStepId = Brand<string, "PipelineStepId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type ProxyId = Brand<string, "ProxyId">;
export type MetaAppId = Brand<string, "MetaAppId">;
export type MediaId = Brand<string, "MediaId">;
export type MediaFolderId = Brand<string, "MediaFolderId">;
export type ContentSourceId = Brand<string, "ContentSourceId">;
export type PipelineExecutionId = Brand<string, "PipelineExecutionId">;
export type PipelineStepExecutionId = Brand<string, "PipelineStepExecutionId">;

/** Chave de idempotência — obrigatória em todo job (regra de design 9). */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/**
 * Timestamp ISO-8601 em UTC. String (não `Date`) para serializar sem perda
 * em JSONB de job e no payload da fila.
 */
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

// ---------------------------------------------------------------------------
// Paginação (regra de design 8: toda listagem é limitada explicitamente)
// ---------------------------------------------------------------------------

export interface PaginationParams {
  /** Teto explícito — nunca assumir que "sem limit" significa "sem teto". */
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly limit: number;
  readonly nextCursor?: string;
}

// ---------------------------------------------------------------------------
// Classificação de falha (regras de design 2 e 3)
// ---------------------------------------------------------------------------

/**
 * Classe da falha. Distinguir estes casos é decisão de arquitetura, não
 * detalhe: `PlatformOutage` vs `AccountError` decide se a cascata de failover
 * dispara (regra 2); `CheckpointRequired` vs `TokenDead` decide a remediação
 * (regra 3) — login manual não é a mesma coisa que reemitir token.
 */
export enum FailureClass {
  /** Falha isolada de uma conta específica. */
  AccountError = "account_error",
  /** Indício de outage da plataforma — não marcar contas como erradas. */
  PlatformOutage = "platform_outage",
  RateLimited = "rate_limited",
  /** Checkpoint de segurança: precisa de login/verificação manual. */
  CheckpointRequired = "checkpoint_required",
  /** Token morto/revogado: precisa de novo fluxo de auth. */
  TokenDead = "token_dead",
  ProxyError = "proxy_error",
  Network = "network",
  InvalidInput = "invalid_input",
  Unknown = "unknown",
}

export interface OperationError {
  readonly failureClass: FailureClass;
  readonly code: string;
  readonly message: string;
  /** Se um retry pode ter sentido — ortogonal à classe da falha. */
  readonly retryable: boolean;
  readonly occurredAt: IsoTimestamp;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Resultado explícito em vez de exceção, para carregar a classificação acima. */
export type Result<T, E = OperationError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
