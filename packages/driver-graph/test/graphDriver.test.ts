/**
 * Testes do GraphApiDriver com um HttpClient fake — sem rede. Cobrem os fluxos
 * (imagem, vídeo com polling, carrossel, story, insights, refresh) e o
 * mapeamento de erro da Graph API para FailureClass (regras 2 e 3).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DriverClass,
  DriverOperationKind,
  FailureClass,
} from "@scaleapp/domain";
import type {
  DriverExecutionContext,
  DriverOperationKind as Kind,
  DriverOperationPayloadMap,
  DriverOperationRequest,
} from "@scaleapp/domain";
import { GraphApiDriver } from "../src/graphDriver.js";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/httpClient.js";
import { HttpTransportError } from "../src/httpClient.js";
import type { ProxyResolver, TokenSink } from "../src/ports.js";
import { EnvCredentialResolver, UrlMediaResolver } from "../src/devResolvers.js";

// --- Fakes -------------------------------------------------------------------

class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly handler: (req: HttpRequest) => HttpResponse) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.handler(req);
  }
}

class ThrowingHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly err: Error) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    throw this.err;
  }
}

const proxyOk: ProxyResolver = {
  async resolveProxy() {
    return { url: "http://user:pass@proxy.test:8080" };
  },
};

function json(status: number, body: unknown): HttpResponse {
  return { status, body: JSON.stringify(body) };
}

const IG = "17841400000000000";

function ctx(overrides: Partial<DriverExecutionContext> = {}): DriverExecutionContext {
  return {
    accountId: "acc-1" as never,
    metaAppId: "meta-1" as never,
    proxyId: "proxy-1" as never,
    accessTokenRef: "tok-abc",
    igUserId: IG,
    ...overrides,
  };
}

function req<K extends Kind>(
  kind: K,
  payload: DriverOperationPayloadMap[K],
  context = ctx(),
): DriverOperationRequest<K> {
  return {
    jobId: "job-1" as never,
    idempotencyKey: "idem-1" as never,
    kind,
    context,
    payload,
  };
}

/** Sink de teste: guarda o que o refresh mandaria persistir no cofre. */
class RecordingTokenSink implements TokenSink {
  readonly rotations: Array<{ ref: string; token: string; expiresAt: string }> = [];
  constructor(private readonly fail?: Error) {}
  async rotateToken(ref: string, token: string, expiresAt: string): Promise<void> {
    if (this.fail) throw this.fail;
    this.rotations.push({ ref, token, expiresAt });
  }
}

function makeDriver(
  http: HttpClient,
  media = new UrlMediaResolver(),
  tokenSink?: TokenSink,
): GraphApiDriver {
  return new GraphApiDriver({
    http,
    credentials: new EnvCredentialResolver(),
    proxies: proxyOk,
    media,
    ...(tokenSink ? { tokenSink } : {}),
    sleep: async () => {},
  });
}

// --- Fluxos de sucesso -------------------------------------------------------

test("publish_media (imagem): container → publish → permalink", async () => {
  const http = new FakeHttp((r) => {
    if (r.method === "POST" && r.url.includes(`/${IG}/media_publish`)) return json(200, { id: "POST999" });
    if (r.method === "POST" && r.url.includes(`/${IG}/media`)) return json(200, { id: "CREATION123" });
    if (r.method === "GET" && r.url.includes("permalink")) return json(200, { permalink: "https://ig/p/x" });
    return json(400, { error: { code: 100, message: "rota inesperada" } });
  });
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, {
      mediaIds: ["https://cdn.test/a.jpg" as never],
      caption: "olá",
    }),
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.value.externalPostId, "POST999");
    assert.equal(res.value.permalink, "https://ig/p/x");
  }
  // Regra 10: toda requisição saiu por proxy.
  assert.ok(http.requests.every((r) => r.proxyUrl === "http://user:pass@proxy.test:8080"));
  // Token vai no header, não na URL.
  assert.ok(http.requests.every((r) => r.headers?.authorization === "Bearer tok-abc"));
});

test("publish_media (vídeo): faz polling do container até FINISHED", async () => {
  let statusChecks = 0;
  const http = new FakeHttp((r) => {
    if (r.method === "POST" && r.url.includes("media_publish")) return json(200, { id: "VPOST" });
    if (r.method === "POST" && r.url.includes(`/${IG}/media`)) return json(200, { id: "VCONT" });
    if (r.method === "GET" && r.url.includes("status_code")) {
      statusChecks++;
      return json(200, { status_code: statusChecks < 2 ? "IN_PROGRESS" : "FINISHED" });
    }
    if (r.method === "GET" && r.url.includes("permalink")) return json(200, { permalink: "https://ig/reel" });
    return json(400, { error: { code: 100, message: "inesperado" } });
  });
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/v.mp4" as never] }),
  );
  assert.equal(res.ok, true);
  assert.ok(statusChecks >= 2, "esperava polling repetido");
});

test("publish_media (carrossel): cria filhos + pai e publica", async () => {
  const posted: string[] = [];
  const http = new FakeHttp((r) => {
    if (r.method === "POST" && r.url.includes("media_publish")) return json(200, { id: "CARPOST" });
    if (r.method === "POST" && r.url.includes(`/${IG}/media`)) {
      const isChild = r.body?.includes("is_carousel_item=true");
      const isParent = r.body?.includes("media_type=CAROUSEL");
      posted.push(isParent ? "parent" : isChild ? "child" : "?");
      return json(200, { id: isParent ? "PARENT" : `CHILD${posted.length}` });
    }
    if (r.method === "GET" && r.url.includes("permalink")) return json(200, {});
    return json(400, { error: { code: 100 } });
  });
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, {
      mediaIds: ["https://cdn.test/a.jpg" as never, "https://cdn.test/b.jpg" as never],
    }),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(posted, ["child", "child", "parent"]);
});

test("fetch_insights: agrega like_count + reach/plays", async () => {
  const http = new FakeHttp((r) => {
    if (r.url.includes("like_count")) return json(200, { like_count: 42 });
    if (r.url.includes("/insights")) {
      return json(200, {
        data: [
          { name: "reach", values: [{ value: 100 }] },
          { name: "plays", values: [{ value: 55 }] },
        ],
      });
    }
    return json(400, { error: { code: 100 } });
  });
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.FetchInsights, { externalPostId: "POST999" }),
  );
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.value.insights, { likes: 42, reach: 100, plays: 55 });
});

test("refresh_session: persiste o token novo e calcula expiresAt", async () => {
  const http = new FakeHttp(() => json(200, { access_token: "new-token", expires_in: 5184000 }));
  const sink = new RecordingTokenSink();
  const driver = makeDriver(http, new UrlMediaResolver(), sink);
  const res = await driver.execute(req(DriverOperationKind.RefreshSession, { force: true }));
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(Date.parse(res.value.expiresAt) > Date.now());
  // O token renovado tem que ir para o cofre; sem isso o refresh seria no-op.
  assert.equal(sink.rotations.length, 1);
  assert.deepEqual(
    { ref: sink.rotations[0]!.ref, token: sink.rotations[0]!.token },
    { ref: "tok-abc", token: "new-token" },
  );
});

test("refresh_session sem tokenSink falha em vez de fingir sucesso", async () => {
  const http = new FakeHttp(() => json(200, { access_token: "new-token", expires_in: 5184000 }));
  const driver = makeDriver(http);
  const res = await driver.execute(req(DriverOperationKind.RefreshSession, { force: true }));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "NO_TOKEN_SINK");
});

test("refresh_session: falha de persistência não vira sucesso (retryável)", async () => {
  const http = new FakeHttp(() => json(200, { access_token: "new-token", expires_in: 5184000 }));
  const sink = new RecordingTokenSink(new Error("cofre indisponível"));
  const driver = makeDriver(http, new UrlMediaResolver(), sink);
  const res = await driver.execute(req(DriverOperationKind.RefreshSession, { force: true }));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, "TOKEN_PERSIST_FAILED");
    assert.equal(res.error.retryable, true);
  }
});

// --- Mapeamento de erro (regras 2 e 3) --------------------------------------

test("erro 190 subcode 460 → CheckpointRequired, não retryável (regra 3)", async () => {
  const http = new FakeHttp(() =>
    json(400, { error: { code: 190, error_subcode: 460, message: "senha alterada" } }),
  );
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.failureClass, FailureClass.CheckpointRequired);
    assert.equal(res.error.retryable, false);
  }
});

test("erro 190 sem subcode → TokenDead (regra 3)", async () => {
  const http = new FakeHttp(() => json(400, { error: { code: 190, message: "token inválido" } }));
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.failureClass, FailureClass.TokenDead);
});

test("erro 4 → RateLimited, retryável", async () => {
  const http = new FakeHttp(() => json(400, { error: { code: 4, message: "rate limit" } }));
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.failureClass, FailureClass.RateLimited);
    assert.equal(res.error.retryable, true);
  }
});

test("HTTP 500 → PlatformOutage, retryável (regra 2: não culpar a conta)", async () => {
  const http = new FakeHttp(() => json(500, { error: { code: 2, message: "serviço" } }));
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.failureClass, FailureClass.PlatformOutage);
    assert.equal(res.error.retryable, true);
  }
});

test("falha de transporte via proxy → ProxyError, retryável (regra 10)", async () => {
  const http = new ThrowingHttp(new HttpTransportError("conn reset", "ECONNRESET", true));
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.failureClass, FailureClass.ProxyError);
    assert.equal(res.error.retryable, true);
  }
});

// --- Pré-condições -----------------------------------------------------------

test("sem ig_user_id → InvalidInput (não chama a rede)", async () => {
  const http = new FakeHttp(() => json(200, {}));
  const driver = makeDriver(http);
  const res = await driver.execute(
    req(
      DriverOperationKind.PublishMedia,
      { mediaIds: ["https://cdn.test/a.jpg" as never] },
      ctx({ igUserId: undefined }),
    ),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.failureClass, FailureClass.InvalidInput);
  assert.equal(http.requests.length, 0);
});

test("proxy indisponível → ProxyError (regra 10, nunca IP direto)", async () => {
  const http = new FakeHttp(() => json(200, { id: "x" }));
  const driver = new GraphApiDriver({
    http,
    credentials: new EnvCredentialResolver(),
    proxies: { async resolveProxy() { return null; } },
    media: new UrlMediaResolver(),
    sleep: async () => {},
  });
  const res = await driver.execute(
    req(DriverOperationKind.PublishMedia, { mediaIds: ["https://cdn.test/a.jpg" as never] }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.failureClass, FailureClass.ProxyError);
  assert.equal(http.requests.length, 0);
});

// --- Capacidades -------------------------------------------------------------

test("supports(): cobre publish/insights/refresh/warmup, não highlight/acquire", () => {
  const driver = makeDriver(new FakeHttp(() => json(200, {})));
  assert.equal(driver.driverClass, DriverClass.GraphApi);
  assert.equal(driver.supports(DriverOperationKind.PublishMedia), true);
  assert.equal(driver.supports(DriverOperationKind.PublishStory), true);
  assert.equal(driver.supports(DriverOperationKind.FetchInsights), true);
  assert.equal(driver.supports(DriverOperationKind.RefreshSession), true);
  assert.equal(driver.supports(DriverOperationKind.WarmupAction), true);
  assert.equal(driver.supports(DriverOperationKind.PublishHighlight), false);
  assert.equal(driver.supports(DriverOperationKind.AcquireContent), false);
});
