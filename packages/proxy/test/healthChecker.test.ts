/**
 * Testes do health check. O núcleo é a regra 2 aplicada ao pool: um lote que
 * falha inteiro é outage do provedor, não centenas de proxies mortos — e o
 * limiar precisa de percentual E contagem mínima, porque cada metade sozinha
 * erra num sentido diferente.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProxyHealthStatus } from "@scaleapp/domain";
import {
  DEFAULT_HEALTH_CONFIG,
  decideHealth,
  parseExitIp,
  probeProxy,
  probeSpacingMs,
  runHealthSweep,
  suspectsOutage,
} from "../src/healthChecker.js";
import type { HttpProbe, ProbeRequest, ProbeResponse } from "../src/ports.js";
import type { CheckOutcome, ProxyRecord, ProxyRepository } from "../src/proxyRepository.js";
import type { ProxyResolverPort } from "../src/resolver.js";

const CFG = DEFAULT_HEALTH_CONFIG; // down após 3 falhas; outage: >=50% E >=5

class FakeProbe implements HttpProbe {
  readonly requests: ProbeRequest[] = [];
  constructor(private readonly handler: (req: ProbeRequest) => ProbeResponse) {}
  async request(req: ProbeRequest): Promise<ProbeResponse> {
    this.requests.push(req);
    return this.handler(req);
  }
}

// --- suspeita de outage (regra 2) -------------------------------------------

test("lote pequeno com percentual alto NÃO é outage (falta contagem mínima)", () => {
  // 2 de 3 = 67%, acima do ratio, mas 2 falhas não são um provedor caindo.
  assert.equal(suspectsOutage(2, 3, CFG), false);
});

test("muitas falhas mas percentual baixo NÃO é outage", () => {
  // 6 de 100 = 6%: seis proxies ruins, não um provedor fora.
  assert.equal(suspectsOutage(6, 100, CFG), false);
});

test("percentual alto E contagem alta é outage", () => {
  assert.equal(suspectsOutage(30, 40, CFG), true);
  assert.equal(suspectsOutage(5, 10, CFG), true, "borda exata dos dois limiares");
});

test("lote vazio nunca é outage", () => {
  assert.equal(suspectsOutage(0, 0, CFG), false);
});

// --- decisão de saúde --------------------------------------------------------

test("sucesso volta a healthy mesmo com histórico de falhas", () => {
  assert.equal(decideHealth({ ok: true }, 5, CFG, false), ProxyHealthStatus.Healthy);
});

test("primeira falha degrada, não mata", () => {
  assert.equal(decideHealth({ ok: false }, 0, CFG, false), ProxyHealthStatus.Degraded);
});

test("falhas seguidas chegam a down", () => {
  assert.equal(decideHealth({ ok: false }, 2, CFG, false), ProxyHealthStatus.Down);
});

test("sob suspeita de outage, nenhum proxy é condenado a down", () => {
  assert.equal(decideHealth({ ok: false }, 10, CFG, true), ProxyHealthStatus.Degraded);
});

// --- sonda --------------------------------------------------------------------

test("probeProxy: 2xx vira ok com latência e IP de saída", async () => {
  let t = 1000;
  const probe = new FakeProbe(() => ({ status: 200, body: '{"ip":"203.0.113.7"}' }));
  const out = await probeProxy(probe, "http://u:p@proxy.test:8080", CFG, () => (t += 150));
  assert.equal(out.ok, true);
  assert.equal(out.exitIp, "203.0.113.7");
  assert.ok((out.latencyMs ?? 0) > 0);
  assert.equal(probe.requests[0]!.proxyUrl, "http://u:p@proxy.test:8080");
});

test("probeProxy: erro HTTP e exceção viram falha, sem lançar", async () => {
  const ruim = await probeProxy(new FakeProbe(() => ({ status: 503, body: "" })), "http://p", CFG);
  assert.equal(ruim.ok, false);

  const explode = await probeProxy(
    { async request() { throw new Error("ECONNREFUSED"); } },
    "http://p",
    CFG,
  );
  assert.equal(explode.ok, false);
  assert.match(explode.error!, /ECONNREFUSED/);
});

test("parseExitIp aceita JSON e texto puro, e ignora lixo", () => {
  assert.equal(parseExitIp('{"ip":"198.51.100.2"}'), "198.51.100.2");
  assert.equal(parseExitIp("  198.51.100.9\n"), "198.51.100.9");
  assert.equal(parseExitIp("<html>bloqueado</html>"), undefined);
});

// --- espaçamento (regra 5) ----------------------------------------------------

test("espaçamento das sondas cabe no ciclo", () => {
  const cycle = 600_000;
  const spacing = probeSpacingMs(100, cycle);
  assert.ok(spacing * 100 <= cycle, "o lote inteiro precisa caber no ciclo");
  assert.equal(probeSpacingMs(1, cycle), 0);
  assert.equal(probeSpacingMs(50, 0), 0);
});

// --- varredura completa --------------------------------------------------------

function proxyRec(id: string, consecutiveFailures = 0): ProxyRecord {
  return {
    id,
    label: null,
    protocol: "http" as never,
    host: `${id}.test`,
    port: 8080,
    credentialsRef: null,
    assignmentState: "assigned" as never,
    assignedAccountId: null,
    health: "unknown" as never,
    consecutiveFailures,
    lastCheckedAt: null,
    lastLatencyMs: null,
    lastError: null,
    lastExitIp: null,
  };
}

class FakeRepo {
  readonly recorded: Array<{ id: string; health: ProxyHealthStatus; outcome: CheckOutcome }> = [];
  constructor(private readonly due: ProxyRecord[]) {}
  async findDueForCheck(limit: number): Promise<readonly ProxyRecord[]> {
    return this.due.slice(0, limit);
  }
  async recordCheck(id: string, outcome: CheckOutcome, health: ProxyHealthStatus): Promise<void> {
    this.recorded.push({ id, outcome, health });
  }
}

const resolverOk: ProxyResolverPort = {
  async resolveProxy(id) {
    return { url: `http://${id}.test:8080` };
  },
};

function sweep(repo: FakeRepo, probe: HttpProbe, resolver = resolverOk) {
  return runHealthSweep({
    repo: repo as unknown as ProxyRepository,
    resolver,
    probe,
    config: CFG,
    limit: 100,
    staleAfterMs: 60_000,
    cycleIntervalMs: 600_000,
    sleep: async () => {},
  });
}

test("varredura saudável marca todos healthy", async () => {
  const repo = new FakeRepo([proxyRec("p1"), proxyRec("p2")]);
  const res = await sweep(repo, new FakeProbe(() => ({ status: 200, body: '{"ip":"1.2.3.4"}' })));
  assert.deepEqual(
    { checked: res.checked, healthy: res.healthy, down: res.down, outage: res.suspectedOutage },
    { checked: 2, healthy: 2, down: 0, outage: false },
  );
});

test("lote inteiro falhando é tratado como outage: degrada, não mata (regra 2)", async () => {
  // 8 proxies já com 2 falhas cada: individualmente, a próxima falha seria down.
  const repo = new FakeRepo(Array.from({ length: 8 }, (_, i) => proxyRec(`p${i}`, 2)));
  const res = await sweep(repo, new FakeProbe(() => ({ status: 502, body: "" })));

  assert.equal(res.suspectedOutage, true);
  assert.equal(res.down, 0, "nenhum proxy pode ser condenado durante outage");
  assert.equal(res.degraded, 8);
  assert.ok(repo.recorded.every((r) => r.health === ProxyHealthStatus.Degraded));
});

test("falha isolada em lote saudável mata só o proxy ruim", async () => {
  const due = [proxyRec("bom1"), proxyRec("bom2"), proxyRec("bom3"), proxyRec("ruim", 2)];
  const repo = new FakeRepo(due);
  const probe = new FakeProbe((req) =>
    req.proxyUrl.includes("ruim") ? { status: 500, body: "" } : { status: 200, body: "1.2.3.4" },
  );

  const res = await sweep(repo, probe);

  assert.equal(res.suspectedOutage, false);
  assert.equal(res.down, 1);
  assert.equal(res.healthy, 3);
  assert.equal(
    repo.recorded.find((r) => r.id === "ruim")!.health,
    ProxyHealthStatus.Down,
  );
});

test("proxy não resolvível conta como falha, sem sonda", async () => {
  const repo = new FakeRepo([proxyRec("sem-credencial")]);
  const probe = new FakeProbe(() => ({ status: 200, body: "" }));
  const res = await sweep(repo, probe, { async resolveProxy() { return null; } });

  assert.equal(res.checked, 1);
  assert.equal(res.healthy, 0);
  assert.equal(probe.requests.length, 0, "não faz sentido sondar sem URL");
  assert.match(repo.recorded[0]!.outcome.error!, /não resolvível/);
});

test("nada vencido: varredura não sonda ninguém", async () => {
  const res = await sweep(new FakeRepo([]), new FakeProbe(() => ({ status: 200, body: "" })));
  assert.deepEqual(res, { checked: 0, healthy: 0, degraded: 0, down: 0, suspectedOutage: false });
});
