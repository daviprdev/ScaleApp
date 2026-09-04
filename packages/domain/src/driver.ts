/**
 * AutomationDriver: a porta entre o Control Plane e o Execution Plane. O núcleo
 * nunca importa Playwright, a Graph API nem SDK do Instagram — fala apenas com
 * este contrato.
 *
 * Existem múltiplos drivers (Graph API primário, Playwright secundário, Content
 * Acquisition) e as capacidades diferem por operação: a Graph API nunca cobriu
 * Destaques; só o driver de Content Acquisition adquire conteúdo. Por isso o
 * mapeamento operação → driver é resolvido por um capability registry, não por
 * um driver único.
 */

import type {
  AccountId,
  ContentSourceId,
  IdempotencyKey,
  IsoTimestamp,
  JobId,
  MediaId,
  MetaAppId,
  OperationError,
  ProxyId,
  Result,
} from "./common.js";
import type { VideoVariation } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Classes de driver e operações atômicas
// ---------------------------------------------------------------------------

export enum DriverClass {
  /** Primário — Graph API oficial. Fila própria (segmentada por classe). */
  GraphApi = "graph_api",
  /** Secundário — só o que a API não cobre (ex.: Destaques). */
  Playwright = "playwright",
  /** Scraping via contas dedicadas. */
  ContentAcquisition = "content_acquisition",
}

/**
 * Operação atômica que um driver executa. É a granularidade menor que as
 * operações de pipeline: uma campanha vira muitos `PublishMedia`, por exemplo.
 * Serve de chave do capability registry e dos mapas de payload/resultado.
 */
export enum DriverOperationKind {
  PublishMedia = "publish_media",
  PublishStory = "publish_story",
  /** Destaques — a Graph API nunca suportou; capacidade só do Playwright. */
  PublishHighlight = "publish_highlight",
  FetchInsights = "fetch_insights",
  /** Capacidade exclusiva do driver de Content Acquisition. */
  AcquireContent = "acquire_content",
  WarmupAction = "warmup_action",
  RefreshSession = "refresh_session",
}

// ---------------------------------------------------------------------------
// Capacidades e registry
// ---------------------------------------------------------------------------

export enum CapabilitySupport {
  /** Driver preferido para a operação. */
  Primary = "primary",
  /** Fallback quando o primário não está disponível. */
  Secondary = "secondary",
}

export interface DriverCapability {
  readonly kind: DriverOperationKind;
  readonly support: CapabilitySupport;
}

// ---------------------------------------------------------------------------
// Payloads e resultados por operação
// ---------------------------------------------------------------------------

export interface PublishMediaPayload {
  readonly mediaIds: readonly MediaId[];
  readonly caption?: string;
  /** Opt-in por job; ausente = sem reencode (regra 1). */
  readonly videoVariation?: VideoVariation;
}

export interface PublishStoryPayload {
  readonly mediaIds: readonly MediaId[];
}

export interface PublishHighlightPayload {
  readonly storyMediaIds: readonly MediaId[];
  readonly title: string;
}

export interface FetchInsightsPayload {
  readonly externalPostId: string;
}

export interface AcquireContentPayload {
  readonly contentSourceId: ContentSourceId;
  /** Sempre limitado explicitamente (regra 8). */
  readonly maxItems: number;
}

export interface WarmupActionPayload {
  readonly actionBudget: number;
}

export interface RefreshSessionPayload {
  /** Forçar refresh mesmo que ainda não esteja próximo da expiração. */
  readonly force: boolean;
}

export interface PublishMediaResult {
  readonly externalPostId: string;
  readonly permalink?: string;
}

export interface PublishStoryResult {
  readonly externalStoryId: string;
}

export interface PublishHighlightResult {
  readonly externalHighlightId: string;
}

/** Analytics por post — depende de Advanced Access da Meta. */
export interface PostInsights {
  readonly likes: number;
  readonly reach: number;
  readonly plays?: number;
}

export interface FetchInsightsResult {
  readonly insights: PostInsights;
}

export interface AcquireContentResult {
  readonly acquiredMediaIds: readonly MediaId[];
}

export interface WarmupActionResult {
  readonly actionsPerformed: number;
}

export interface RefreshSessionResult {
  readonly expiresAt: IsoTimestamp;
}

/** Mapa operação → payload, para tipar `execute` por operação. */
export interface DriverOperationPayloadMap {
  [DriverOperationKind.PublishMedia]: PublishMediaPayload;
  [DriverOperationKind.PublishStory]: PublishStoryPayload;
  [DriverOperationKind.PublishHighlight]: PublishHighlightPayload;
  [DriverOperationKind.FetchInsights]: FetchInsightsPayload;
  [DriverOperationKind.AcquireContent]: AcquireContentPayload;
  [DriverOperationKind.WarmupAction]: WarmupActionPayload;
  [DriverOperationKind.RefreshSession]: RefreshSessionPayload;
}

/** Mapa operação → resultado de sucesso. */
export interface DriverOperationResultMap {
  [DriverOperationKind.PublishMedia]: PublishMediaResult;
  [DriverOperationKind.PublishStory]: PublishStoryResult;
  [DriverOperationKind.PublishHighlight]: PublishHighlightResult;
  [DriverOperationKind.FetchInsights]: FetchInsightsResult;
  [DriverOperationKind.AcquireContent]: AcquireContentResult;
  [DriverOperationKind.WarmupAction]: WarmupActionResult;
  [DriverOperationKind.RefreshSession]: RefreshSessionResult;
}

// ---------------------------------------------------------------------------
// Requisição, resultado e contexto de execução
// ---------------------------------------------------------------------------

/**
 * Amarração conta → App/proxy/sessão resolvida no Execution Plane e passada ao
 * driver. Toda requisição em nome de uma conta sai por proxy dedicado
 * (regras 7 e 10), nunca pelo IP da infraestrutura.
 */
export interface DriverExecutionContext {
  readonly accountId: AccountId;
  readonly metaAppId: MetaAppId;
  readonly proxyId: ProxyId;
  /** Token resolvido pelo Session Manager — referência ao cofre. */
  readonly accessTokenRef: string;
  /**
   * Id numérico da conta IG Business, endereço da conta na Graph API
   * (/{ig-user-id}/media). Ausente até a conta ser convertida/resolvida; o
   * driver Graph trata ausência como InvalidInput. Drivers que não usam a Graph
   * API (Playwright, Content Acquisition) ignoram este campo.
   */
  readonly igUserId?: string;
}

export interface DriverOperationRequest<K extends DriverOperationKind> {
  readonly jobId: JobId;
  /** Regra de design 9: retry nunca pode duplicar uma ação real. */
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: K;
  readonly context: DriverExecutionContext;
  readonly payload: DriverOperationPayloadMap[K];
}

/**
 * Resultado como `Result`, não exceção, para carregar a `FailureClass` — é ela
 * que distingue outage de plataforma de falha de conta (regra 2) e checkpoint
 * de token morto (regra 3).
 */
export type DriverOperationResult<K extends DriverOperationKind> = Result<
  DriverOperationResultMap[K],
  OperationError
>;

export interface DriverHealth {
  readonly driverClass: DriverClass;
  readonly healthy: boolean;
  readonly checkedAt: IsoTimestamp;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// A porta e o registry
// ---------------------------------------------------------------------------

export interface AutomationDriver {
  readonly driverClass: DriverClass;
  readonly capabilities: readonly DriverCapability[];
  /** Se este driver cobre a operação. */
  supports(kind: DriverOperationKind): boolean;
  execute<K extends DriverOperationKind>(
    request: DriverOperationRequest<K>,
  ): Promise<DriverOperationResult<K>>;
  healthCheck(): Promise<DriverHealth>;
}

export interface DriverResolution {
  readonly driver: AutomationDriver;
  readonly support: CapabilitySupport;
}

/**
 * Capability registry: resolve qual driver executa cada operação. Não é um
 * driver — é o roteador que conhece as capacidades de todos eles.
 */
export interface DriverCapabilityRegistry {
  register(driver: AutomationDriver): void;
  /** Drivers que cobrem a operação, ordenados primário → secundário. */
  resolve(kind: DriverOperationKind): readonly DriverResolution[];
  /** Driver preferido (primário) para a operação, se houver. */
  primaryFor(kind: DriverOperationKind): AutomationDriver | undefined;
  get(driverClass: DriverClass): AutomationDriver | undefined;
}
