/**
 * Driver Graph API (primário). Implementa a porta `AutomationDriver` falando com
 * a Instagram Graph API oficial. Cobre o fluxo core:
 *  - publish_media: cria container (imagem/vídeo/carrossel) → publica; para vídeo
 *    faz polling do status do container até FINISHED (processamento é assíncrono).
 *  - publish_story, fetch_insights, refresh_session, warmup_action.
 *
 * NÃO cobre publish_highlight (a Graph API nunca suportou Destaques — é do
 * Playwright) nem acquire_content (é do driver de Content Acquisition): para
 * essas, `supports()` retorna false e o capability registry roteia para outro
 * driver.
 *
 * Toda I/O passa por portas injetadas (HttpClient/Credential/Proxy/Media) — o
 * driver não abre conexão, não lê o cofre nem o banco direto. Regra 10: sem
 * proxy dedicado resolvido, a operação falha (nunca sai pelo IP da infra).
 */

import {
  CapabilitySupport,
  DriverClass,
  DriverOperationKind,
  FailureClass,
} from "@scaleapp/domain";
import type {
  AutomationDriver,
  DriverCapability,
  DriverHealth,
  DriverOperationRequest,
  DriverOperationResult,
  FetchInsightsPayload,
  IsoTimestamp,
  OperationError,
  PublishMediaPayload,
  PublishStoryPayload,
  RefreshSessionPayload,
  Result,
  WarmupActionPayload,
} from "@scaleapp/domain";
import { DEFAULT_GRAPH_CONFIG, type GraphApiConfig } from "./config.js";
import {
  containerError,
  mapHttpError,
  mapTransportError,
  preconditionError,
  proxyUnavailable,
  tokenUnresolved,
} from "./errors.js";
import { HttpTransportError, type HttpClient } from "./httpClient.js";
import type { CredentialResolver, MediaResolver, ProxyResolver, TokenSink } from "./ports.js";

export interface GraphApiDriverDeps {
  readonly http: HttpClient;
  readonly credentials: CredentialResolver;
  readonly proxies: ProxyResolver;
  readonly media: MediaResolver;
  /**
   * Destino do token rotacionado pelo refresh. Opcional só para os testes que
   * não exercitam refresh: sem ele, `refresh_session` FALHA em vez de fingir
   * sucesso — um refresh que não persiste é pior que um refresh que não roda.
   */
  readonly tokenSink?: TokenSink;
  readonly config?: Partial<GraphApiConfig>;
  /** Injetável para os testes não esperarem de verdade no polling. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Operações que este driver cobre (as demais roteiam para outro driver). */
const SUPPORTED: readonly DriverOperationKind[] = [
  DriverOperationKind.PublishMedia,
  DriverOperationKind.PublishStory,
  DriverOperationKind.FetchInsights,
  DriverOperationKind.RefreshSession,
  DriverOperationKind.WarmupAction,
];

interface CallOk {
  readonly ok: true;
  readonly json: Record<string, unknown>;
}
type CallResult = CallOk | { readonly ok: false; readonly error: OperationError };

/** Contexto de rede resolvido uma vez por execução. */
interface NetContext {
  readonly token: string;
  readonly proxyUrl: string;
}

function iso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString() as IsoTimestamp;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GraphApiDriver implements AutomationDriver {
  readonly driverClass = DriverClass.GraphApi;
  readonly capabilities: readonly DriverCapability[] = SUPPORTED.map((kind) => ({
    kind,
    support: CapabilitySupport.Primary,
  }));

  private readonly cfg: GraphApiConfig;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GraphApiDriverDeps) {
    this.cfg = { ...DEFAULT_GRAPH_CONFIG, ...deps.config };
    this.sleep = deps.sleep ?? defaultSleep;
  }

  supports(kind: DriverOperationKind): boolean {
    return SUPPORTED.includes(kind);
  }

  async execute<K extends DriverOperationKind>(
    request: DriverOperationRequest<K>,
  ): Promise<DriverOperationResult<K>> {
    let out: Result<unknown, OperationError>;
    switch (request.kind) {
      case DriverOperationKind.PublishMedia:
        out = await this.publishMedia(request.context, request.payload as PublishMediaPayload);
        break;
      case DriverOperationKind.PublishStory:
        out = await this.publishStory(request.context, request.payload as PublishStoryPayload);
        break;
      case DriverOperationKind.FetchInsights:
        out = await this.fetchInsights(request.context, request.payload as FetchInsightsPayload);
        break;
      case DriverOperationKind.RefreshSession:
        out = await this.refreshSession(request.context, request.payload as RefreshSessionPayload);
        break;
      case DriverOperationKind.WarmupAction:
        out = await this.warmupAction(request.context, request.payload as WarmupActionPayload);
        break;
      default:
        out = {
          ok: false,
          error: preconditionError(
            "UNSUPPORTED_OP",
            `Graph API driver não cobre a operação ${request.kind}`,
          ),
        };
    }
    return out as DriverOperationResult<K>;
  }

  async healthCheck(): Promise<DriverHealth> {
    return {
      driverClass: this.driverClass,
      healthy: true,
      checkedAt: iso(Date.now()),
      detail: `graph_api ${this.cfg.apiVersion}`,
    };
  }

  // --- Resolução de contexto de rede -----------------------------------------

  private async resolveNet(
    accessTokenRef: string,
    proxyId: string,
  ): Promise<Result<NetContext, OperationError>> {
    const token = await this.deps.credentials.resolveToken(accessTokenRef);
    if (!token) return { ok: false, error: tokenUnresolved() };
    const proxy = await this.deps.proxies.resolveProxy(proxyId);
    if (!proxy) return { ok: false, error: proxyUnavailable() };
    return { ok: true, value: { token, proxyUrl: proxy.url } };
  }

  // --- Chamada HTTP genérica à Graph API -------------------------------------

  private url(path: string): string {
    return `${this.cfg.baseUrl}/${this.cfg.apiVersion}/${path}`;
  }

  private async call(
    net: NetContext,
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
  ): Promise<CallResult> {
    const search = new URLSearchParams(params).toString();
    const isGet = method === "GET";
    const url = isGet && search ? `${this.url(path)}?${search}` : this.url(path);
    try {
      const res = await this.deps.http.request({
        method,
        url,
        proxyUrl: net.proxyUrl,
        timeoutMs: this.cfg.requestTimeoutMs,
        headers: {
          authorization: `Bearer ${net.token}`,
          ...(isGet ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        },
        ...(isGet ? {} : { body: search }),
      });
      if (res.status >= 200 && res.status < 300) {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(res.body) as Record<string, unknown>;
        } catch {
          // 2xx sem JSON válido — trata como corpo vazio.
        }
        return { ok: true, json };
      }
      return { ok: false, error: mapHttpError(res.status, res.body) };
    } catch (e) {
      if (e instanceof HttpTransportError) return { ok: false, error: mapTransportError(e) };
      throw e;
    }
  }

  // --- Publicação de mídia ----------------------------------------------------

  private async publishMedia(
    ctx: DriverExecutionCtx,
    payload: PublishMediaPayload,
  ): Promise<Result<{ externalPostId: string; permalink?: string }, OperationError>> {
    if (!ctx.igUserId) {
      return { ok: false, error: preconditionError("NO_IG_USER_ID", "conta sem ig_user_id resolvido") };
    }
    if (payload.mediaIds.length === 0) {
      return { ok: false, error: preconditionError("NO_MEDIA", "publish_media sem mídia") };
    }
    const netR = await this.resolveNet(ctx.accessTokenRef, ctx.proxyId);
    if (!netR.ok) return netR;
    const net = netR.value;

    // Container(s): item único → um container; múltiplos → carrossel.
    let creationId: string;
    if (payload.mediaIds.length === 1) {
      const single = await this.createMediaContainer(net, ctx.igUserId, payload.mediaIds[0]!, {
        ...(payload.caption ? { caption: payload.caption } : {}),
      });
      if (!single.ok) return single;
      creationId = single.value;
    } else {
      const carousel = await this.createCarousel(net, ctx.igUserId, payload);
      if (!carousel.ok) return carousel;
      creationId = carousel.value;
    }

    return this.publishContainer(net, ctx.igUserId, creationId);
  }

  /** Cria um container de mídia; para vídeo, espera o processamento terminar. */
  private async createMediaContainer(
    net: NetContext,
    igUserId: string,
    mediaId: string,
    extra: Record<string, string>,
    asCarouselItem = false,
  ): Promise<Result<string, OperationError>> {
    const media = await this.deps.media.resolveMedia(mediaId);
    if (!media) {
      return { ok: false, error: preconditionError("MEDIA_NOT_FOUND", `mídia ${mediaId} não encontrada`) };
    }
    const params: Record<string, string> = { ...extra };
    if (media.kind === "video") {
      params.media_type = "REELS";
      params.video_url = media.url;
    } else {
      params.image_url = media.url;
    }
    if (asCarouselItem) params.is_carousel_item = "true";

    const created = await this.call(net, "POST", `${igUserId}/media`, params);
    if (!created.ok) return created;
    const creationId = String(created.json.id ?? "");
    if (!creationId) {
      return { ok: false, error: preconditionError("NO_CREATION_ID", "container sem id") };
    }
    if (media.kind === "video") {
      const ready = await this.waitForContainer(net, creationId);
      if (!ready.ok) return ready;
    }
    return { ok: true, value: creationId };
  }

  /** Cria os filhos e o container-pai do carrossel. */
  private async createCarousel(
    net: NetContext,
    igUserId: string,
    payload: PublishMediaPayload,
  ): Promise<Result<string, OperationError>> {
    const childIds: string[] = [];
    for (const mediaId of payload.mediaIds) {
      const child = await this.createMediaContainer(net, igUserId, mediaId, {}, true);
      if (!child.ok) return child;
      childIds.push(child.value);
    }
    const params: Record<string, string> = {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      ...(payload.caption ? { caption: payload.caption } : {}),
    };
    const parent = await this.call(net, "POST", `${igUserId}/media`, params);
    if (!parent.ok) return parent;
    const creationId = String(parent.json.id ?? "");
    if (!creationId) {
      return { ok: false, error: preconditionError("NO_CREATION_ID", "carrossel sem id") };
    }
    return { ok: true, value: creationId };
  }

  /** Polling do status do container de vídeo até FINISHED (ou erro/expiração). */
  private async waitForContainer(
    net: NetContext,
    creationId: string,
  ): Promise<Result<true, OperationError>> {
    for (let attempt = 0; attempt < this.cfg.containerPollMaxAttempts; attempt++) {
      const res = await this.call(net, "GET", creationId, { fields: "status_code" });
      if (!res.ok) return res;
      const status = String(res.json.status_code ?? "");
      if (status === "FINISHED") return { ok: true, value: true };
      if (status === "ERROR") return { ok: false, error: containerError("ERROR", false) };
      if (status === "EXPIRED") return { ok: false, error: containerError("EXPIRED", false) };
      // IN_PROGRESS / PUBLISHED-pending: aguarda e tenta de novo.
      await this.sleep(this.cfg.containerPollIntervalMs);
    }
    return { ok: false, error: containerError("TIMEOUT", true) };
  }

  private async publishContainer(
    net: NetContext,
    igUserId: string,
    creationId: string,
  ): Promise<Result<{ externalPostId: string; permalink?: string }, OperationError>> {
    const published = await this.call(net, "POST", `${igUserId}/media_publish`, {
      creation_id: creationId,
    });
    if (!published.ok) return published;
    const externalPostId = String(published.json.id ?? "");
    if (!externalPostId) {
      return { ok: false, error: preconditionError("NO_PUBLISH_ID", "media_publish sem id") };
    }
    // Permalink é best-effort: falha aqui não invalida a publicação já feita.
    const perma = await this.call(net, "GET", externalPostId, { fields: "permalink" });
    const permalink = perma.ok ? (perma.json.permalink as string | undefined) : undefined;
    return { ok: true, value: { externalPostId, ...(permalink ? { permalink } : {}) } };
  }

  // --- Story ------------------------------------------------------------------

  private async publishStory(
    ctx: DriverExecutionCtx,
    payload: PublishStoryPayload,
  ): Promise<Result<{ externalStoryId: string }, OperationError>> {
    if (!ctx.igUserId) {
      return { ok: false, error: preconditionError("NO_IG_USER_ID", "conta sem ig_user_id resolvido") };
    }
    if (payload.mediaIds.length === 0) {
      return { ok: false, error: preconditionError("NO_MEDIA", "publish_story sem mídia") };
    }
    const netR = await this.resolveNet(ctx.accessTokenRef, ctx.proxyId);
    if (!netR.ok) return netR;
    const net = netR.value;

    const media = await this.deps.media.resolveMedia(payload.mediaIds[0]!);
    if (!media) {
      return { ok: false, error: preconditionError("MEDIA_NOT_FOUND", "mídia do story não encontrada") };
    }
    const params: Record<string, string> = { media_type: "STORIES" };
    if (media.kind === "video") params.video_url = media.url;
    else params.image_url = media.url;

    const created = await this.call(net, "POST", `${ctx.igUserId}/media`, params);
    if (!created.ok) return created;
    const creationId = String(created.json.id ?? "");
    if (!creationId) {
      return { ok: false, error: preconditionError("NO_CREATION_ID", "story sem id de container") };
    }
    if (media.kind === "video") {
      const ready = await this.waitForContainer(net, creationId);
      if (!ready.ok) return ready;
    }
    const published = await this.call(net, "POST", `${ctx.igUserId}/media_publish`, {
      creation_id: creationId,
    });
    if (!published.ok) return published;
    const externalStoryId = String(published.json.id ?? "");
    if (!externalStoryId) {
      return { ok: false, error: preconditionError("NO_PUBLISH_ID", "story sem id publicado") };
    }
    return { ok: true, value: { externalStoryId } };
  }

  // --- Insights ---------------------------------------------------------------

  private async fetchInsights(
    ctx: DriverExecutionCtx,
    payload: FetchInsightsPayload,
  ): Promise<Result<{ insights: { likes: number; reach: number; plays?: number } }, OperationError>> {
    const netR = await this.resolveNet(ctx.accessTokenRef, ctx.proxyId);
    if (!netR.ok) return netR;
    const net = netR.value;

    // like_count vem dos campos da mídia; reach/plays da API de insights
    // (depende de Advanced Access — pode retornar erro de permissão).
    const fields = await this.call(net, "GET", payload.externalPostId, { fields: "like_count" });
    if (!fields.ok) return fields;
    const likes = Number(fields.json.like_count ?? 0);

    const insightsRes = await this.call(net, "GET", `${payload.externalPostId}/insights`, {
      metric: "reach,plays",
    });
    if (!insightsRes.ok) return insightsRes;
    const parsed = parseInsights(insightsRes.json);

    return {
      ok: true,
      value: {
        insights: {
          likes,
          reach: parsed.reach ?? 0,
          ...(parsed.plays !== undefined ? { plays: parsed.plays } : {}),
        },
      },
    };
  }

  // --- Refresh de token -------------------------------------------------------

  private async refreshSession(
    ctx: DriverExecutionCtx,
    _payload: RefreshSessionPayload,
  ): Promise<Result<{ expiresAt: IsoTimestamp }, OperationError>> {
    const netR = await this.resolveNet(ctx.accessTokenRef, ctx.proxyId);
    if (!netR.ok) return netR;
    const net = netR.value;

    if (!this.deps.tokenSink) {
      return {
        ok: false,
        error: preconditionError(
          "NO_TOKEN_SINK",
          "driver sem tokenSink: o token renovado não teria onde ser persistido",
        ),
      };
    }

    // Instagram Login: troca o long-lived token por um novo (mesma validade base).
    const res = await this.call(net, "GET", "refresh_access_token", {
      grant_type: "ig_refresh_token",
    });
    if (!res.ok) return res;

    const newToken = String(res.json.access_token ?? "");
    const expiresInSec = Number(res.json.expires_in ?? 0);
    if (!newToken || expiresInSec <= 0) {
      return {
        ok: false,
        error: preconditionError("NO_REFRESHED_TOKEN", "refresh sem access_token/expires_in"),
      };
    }
    const expiresAt = iso(Date.now() + expiresInSec * 1000);

    // Persistir ANTES de reportar sucesso: se a gravação falha, o job falha e
    // retenta. Reportar sucesso com o cofre desatualizado deixaria a conta com
    // token velho e expiração nova — ela pararia de ser candidata a refresh.
    try {
      await this.deps.tokenSink.rotateToken(ctx.accessTokenRef, newToken, expiresAt);
    } catch (e) {
      return {
        ok: false,
        error: {
          failureClass: FailureClass.Unknown,
          code: "TOKEN_PERSIST_FAILED",
          message: `token renovado mas não persistido: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
          occurredAt: iso(Date.now()),
        },
      };
    }

    return { ok: true, value: { expiresAt } };
  }

  // --- Warmup ------------------------------------------------------------------

  private async warmupAction(
    ctx: DriverExecutionCtx,
    payload: WarmupActionPayload,
  ): Promise<Result<{ actionsPerformed: number }, OperationError>> {
    if (!ctx.igUserId) {
      return { ok: false, error: preconditionError("NO_IG_USER_ID", "conta sem ig_user_id resolvido") };
    }
    const netR = await this.resolveNet(ctx.accessTokenRef, ctx.proxyId);
    if (!netR.ok) return netR;
    const net = netR.value;

    // Warmup conservador (regra 7): um toque benigno de baixo risco para
    // exercitar a sessão sem cadência agressiva. A estratégia real de warmup é
    // um módulo próprio; aqui garantimos que a conta responde.
    const res = await this.call(net, "GET", ctx.igUserId, { fields: "id" });
    if (!res.ok) return res;
    return { ok: true, value: { actionsPerformed: Math.min(1, Math.max(0, payload.actionBudget)) } };
  }
}

/** Subconjunto do contexto que o driver usa (evita importar o tipo genérico). */
interface DriverExecutionCtx {
  readonly accessTokenRef: string;
  readonly proxyId: string;
  readonly igUserId?: string;
}

/** Extrai reach/plays da resposta da API de insights (data[].name/values). */
function parseInsights(json: Record<string, unknown>): { reach?: number; plays?: number } {
  const out: { reach?: number; plays?: number } = {};
  const data = json.data;
  if (!Array.isArray(data)) return out;
  for (const item of data as Array<Record<string, unknown>>) {
    const name = String(item.name ?? "");
    const values = item.values;
    const value = Array.isArray(values) && values.length > 0
      ? Number((values[0] as Record<string, unknown>).value ?? 0)
      : 0;
    if (name === "reach") out.reach = value;
    if (name === "plays") out.plays = value;
  }
  return out;
}
