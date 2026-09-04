/**
 * Driver mock: implementação de `AutomationDriver` (a porta de @scaleapp/domain)
 * sem tocar em nada real do Instagram. Serve para validar o pipeline de
 * execução (fila → worker → driver → persistência) antes de existir qualquer
 * integração concreta.
 *
 * Comportamento controlado por uma diretiva embutida no payload do job
 * (`__mock`), que sobrevive à serialização por Redis/Postgres — assim o mesmo
 * mock funciona tanto nos testes em processo quanto no worker real em processo
 * separado. Um contador em memória por `idempotencyKey` permite às asserções
 * verificar quantas vezes a ação foi de fato executada.
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
  DriverOperationResultMap,
  IsoTimestamp,
  OperationError,
} from "@scaleapp/domain";

/** Diretiva de comportamento do mock, embutida no payload sob a chave `__mock`. */
export interface MockDirective {
  /** Nº de tentativas que falham antes de uma suceder (default 0 = sucesso já na 1ª). */
  readonly failuresBeforeSuccess?: number;
  /** Classe da falha simulada (default `network`). */
  readonly failureClass?: FailureClass;
  /** Se a falha simulada é retryável (default true). */
  readonly retryable?: boolean;
  /** Latência artificial em ms antes de responder. */
  readonly latencyMs?: number;
}

const MOCK_KEY = "__mock";

/** Anexa uma diretiva de mock a um payload, sem alterar seus campos de domínio. */
export function withMockDirective<P extends object>(
  payload: P,
  directive: MockDirective,
): P & { readonly __mock: MockDirective } {
  return { ...payload, [MOCK_KEY]: directive };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buildResult(
  kind: DriverOperationKind,
  jobId: string,
): DriverOperationResultMap[DriverOperationKind] {
  switch (kind) {
    case DriverOperationKind.PublishMedia:
      return { externalPostId: `mock-post-${jobId}`, permalink: `https://mock.local/p/${jobId}` };
    case DriverOperationKind.PublishStory:
      return { externalStoryId: `mock-story-${jobId}` };
    case DriverOperationKind.PublishHighlight:
      return { externalHighlightId: `mock-highlight-${jobId}` };
    case DriverOperationKind.FetchInsights:
      return { insights: { likes: 0, reach: 0, plays: 0 } };
    case DriverOperationKind.AcquireContent:
      return { acquiredMediaIds: [] };
    case DriverOperationKind.WarmupAction:
      return { actionsPerformed: 1 };
    case DriverOperationKind.RefreshSession:
      return { expiresAt: new Date(Date.now() + 3_600_000).toISOString() as IsoTimestamp };
    default:
      return { externalPostId: `mock-post-${jobId}` };
  }
}

export class MockDriver implements AutomationDriver {
  readonly driverClass: DriverClass;
  readonly capabilities: readonly DriverCapability[];

  /** Quantas vezes `execute` foi chamado por idempotencyKey (inclui falhas). */
  private readonly calls = new Map<string, number>();
  /** Quantas vezes a ação teve sucesso por idempotencyKey. */
  private readonly successes = new Map<string, number>();

  constructor(driverClass: DriverClass = DriverClass.GraphApi) {
    this.driverClass = driverClass;
    this.capabilities = Object.values(DriverOperationKind).map((kind) => ({
      kind,
      support: CapabilitySupport.Primary,
    }));
  }

  supports(kind: DriverOperationKind): boolean {
    return this.capabilities.some((c) => c.kind === kind);
  }

  async execute<K extends DriverOperationKind>(
    request: DriverOperationRequest<K>,
  ): Promise<DriverOperationResult<K>> {
    const key = request.idempotencyKey as unknown as string;
    const attempt = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, attempt);

    const directive = (request.payload as unknown as Record<string, unknown>)[MOCK_KEY] as
      | MockDirective
      | undefined;

    if (directive?.latencyMs) await delay(directive.latencyMs);

    const failuresBeforeSuccess = directive?.failuresBeforeSuccess ?? 0;
    if (attempt <= failuresBeforeSuccess) {
      const error: OperationError = {
        failureClass: directive?.failureClass ?? FailureClass.Network,
        code: "MOCK_FAILURE",
        message: `mock: falha simulada na tentativa ${attempt}`,
        retryable: directive?.retryable ?? true,
        occurredAt: new Date().toISOString() as IsoTimestamp,
      };
      return { ok: false, error };
    }

    this.successes.set(key, (this.successes.get(key) ?? 0) + 1);
    const value = buildResult(
      request.kind,
      request.jobId as unknown as string,
    ) as DriverOperationResultMap[K];
    return { ok: true, value };
  }

  async healthCheck(): Promise<DriverHealth> {
    return {
      driverClass: this.driverClass,
      healthy: true,
      checkedAt: new Date().toISOString() as IsoTimestamp,
      detail: "mock",
    };
  }

  /** Nº de execuções (incl. falhas) observadas para uma idempotencyKey. */
  executionCount(idempotencyKey: string): number {
    return this.calls.get(idempotencyKey) ?? 0;
  }

  /** Nº de sucessos efetivos para uma idempotencyKey. */
  successCount(idempotencyKey: string): number {
    return this.successes.get(idempotencyKey) ?? 0;
  }

  reset(): void {
    this.calls.clear();
    this.successes.clear();
  }
}
