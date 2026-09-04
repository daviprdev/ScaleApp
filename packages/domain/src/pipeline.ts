/**
 * Pipeline Definition: descreve *o quê* deve acontecer numa conta, sem saber
 * *como*. Não conhece Playwright, Graph API nem seletores — só operações de
 * alto nível e sua configuração. O Orchestrator (fase posterior) expande isso
 * em jobs concretos.
 */

import type {
  ContentSourceId,
  IsoTimestamp,
  MediaFolderId,
  MediaId,
  PipelineId,
  PipelineStepId,
} from "./common.js";

// ---------------------------------------------------------------------------
// Configurações de apoio
// ---------------------------------------------------------------------------

/** Horário humano: janela de postagem por timezone (regra operacional). */
export interface PostingWindow {
  /** Timezone IANA, ex.: "America/Sao_Paulo". */
  readonly timezone: string;
  /** Hora de início da janela (0-23). */
  readonly startHour: number;
  /** Hora de fim da janela (0-23). */
  readonly endHour: number;
  /** Dias permitidos (0=domingo … 6=sábado). Ausente = todos. */
  readonly weekdays?: readonly number[];
}

/** Pool de legendas com variações, sem repetição óbvia. */
export interface CaptionPool {
  readonly variations: readonly string[];
  /** Mínimo de posts antes de reusar uma variação. */
  readonly minGapBeforeReuse?: number;
}

export enum DistributionStrategy {
  /**
   * Tipo "quadrado latino": nunca o mesmo vídeo em várias contas dentro da
   * mesma janela — evita duplicata detectável entre contas.
   */
  LatinSquare = "latin_square",
}

export interface CampaignDistribution {
  readonly strategy: DistributionStrategy;
  /** Janela (horas) dentro da qual a anti-duplicata é garantida. */
  readonly windowHours: number;
}

/** Efeitos de variação de vídeo. */
export enum VideoEffect {
  Hue = "hue",
  Noise = "noise",
  Speed = "speed",
}

/**
 * Variação de vídeo. Sempre opt-in manual por pipeline (regra de design 1):
 * reencode automático em todo post derruba alcance. A ausência deste campo
 * significa: sem reencode.
 */
export interface VideoVariation {
  readonly effects: readonly VideoEffect[];
}

// ---------------------------------------------------------------------------
// Operações de pipeline (alto nível — "o quê")
// ---------------------------------------------------------------------------

export enum PipelineOperationType {
  /** Post único, potencialmente multi-conta. */
  PublishPost = "publish_post",
  /** Campanha em massa com distribuição anti-duplicata entre contas. */
  PublishCampaign = "publish_campaign",
  /** Loop de repostagem contínua por pasta. */
  RepostLoop = "repost_loop",
  PublishStory = "publish_story",
  /** Repostagem de story via template. */
  RepostStoryTemplate = "repost_story_template",
  Warmup = "warmup",
  AcquireContent = "acquire_content",
  /** Analytics por post — depende de Advanced Access da Meta. */
  FetchInsights = "fetch_insights",
}

/** Campos comuns às operações de publicação. */
interface PublishDefaults {
  readonly captionPool?: CaptionPool;
  readonly postingWindow?: PostingWindow;
  /** Opt-in explícito; ausente = sem reencode (regra 1). */
  readonly videoVariation?: VideoVariation;
}

export interface PublishPostOperation extends PublishDefaults {
  readonly type: PipelineOperationType.PublishPost;
  readonly mediaIds: readonly MediaId[];
}

export interface PublishCampaignOperation extends PublishDefaults {
  readonly type: PipelineOperationType.PublishCampaign;
  readonly sourceFolderId: MediaFolderId;
  readonly distribution: CampaignDistribution;
}

export interface RepostLoopOperation extends PublishDefaults {
  readonly type: PipelineOperationType.RepostLoop;
  readonly sourceFolderId: MediaFolderId;
  /** Intervalo do ciclo; o jitter proporcional (regra 5) é do Orchestrator. */
  readonly intervalMinutes: number;
}

export interface PublishStoryOperation extends PublishDefaults {
  readonly type: PipelineOperationType.PublishStory;
  readonly mediaIds: readonly MediaId[];
}

export interface RepostStoryTemplateOperation {
  readonly type: PipelineOperationType.RepostStoryTemplate;
  readonly templateId: string;
  readonly postingWindow?: PostingWindow;
}

export interface WarmupOperation {
  readonly type: PipelineOperationType.Warmup;
  /** Teto de ações por dia durante a carência; duração vem do warmup da conta. */
  readonly dailyActionBudget?: number;
}

export interface AcquireContentOperation {
  readonly type: PipelineOperationType.AcquireContent;
  readonly contentSourceId: ContentSourceId;
  /** Sempre limitado explicitamente (regra 8). */
  readonly maxItems: number;
}

export interface FetchInsightsOperation {
  readonly type: PipelineOperationType.FetchInsights;
  /** Coletar insights de posts desde este instante. */
  readonly sincePostAt?: IsoTimestamp;
}

export type PipelineOperation =
  | PublishPostOperation
  | PublishCampaignOperation
  | RepostLoopOperation
  | PublishStoryOperation
  | RepostStoryTemplateOperation
  | WarmupOperation
  | AcquireContentOperation
  | FetchInsightsOperation;

// ---------------------------------------------------------------------------
// Steps e pipeline
// ---------------------------------------------------------------------------

/** Condicional de execução do step; a avaliação real é do Orchestrator. */
export enum StepConditionType {
  Always = "always",
  OnPreviousSuccess = "on_previous_success",
  OnPreviousFailure = "on_previous_failure",
}

export interface PipelineStep {
  readonly id: PipelineStepId;
  readonly operation: PipelineOperation;
  readonly condition: StepConditionType;
}

export interface Pipeline {
  readonly id: PipelineId;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly PipelineStep[];
  /** Janela padrão aplicável aos steps de publicação sem janela própria. */
  readonly defaultPostingWindow?: PostingWindow;
  readonly enabled: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
