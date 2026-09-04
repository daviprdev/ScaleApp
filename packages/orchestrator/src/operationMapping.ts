/**
 * Traduz uma `PipelineOperation` de alto nível (o "o quê") na operação atômica
 * de driver que o sistema de execução (Fase 03) sabe rodar. O Orchestrator não
 * conhece driver concreto — só produz `driverClass`/`operationKind`/`payload`
 * que o worker resolve via a porta `AutomationDriver`.
 *
 * Escopo Fase 04: uma conta alvo por execução. Campanha/loop (multi-conta,
 * quadrado latino) NÃO são expandidos aqui — isso é funcionalidade de produto,
 * fora do escopo desta fase; mapeamos ao equivalente atômico mais próximo.
 */

import {
  DriverClass,
  DriverOperationKind,
  type PipelineOperation,
  PipelineOperationType,
} from "@scaleapp/domain";

export interface MappedOperation {
  readonly driverClass: DriverClass;
  readonly operationKind: DriverOperationKind;
  readonly payload: Record<string, unknown>;
}

/** Copia uma diretiva de mock anexada à operação (usada em teste). */
function mockOf(operation: PipelineOperation): Record<string, unknown> {
  const directive = (operation as unknown as Record<string, unknown>).__mock;
  return directive === undefined ? {} : { __mock: directive };
}

function firstCaption(op: { captionPool?: { variations: readonly string[] } }): Record<string, unknown> {
  const caption = op.captionPool?.variations[0];
  return caption === undefined ? {} : { caption };
}

export function mapOperation(operation: PipelineOperation): MappedOperation {
  const mock = mockOf(operation);

  switch (operation.type) {
    case PipelineOperationType.PublishPost:
    case PipelineOperationType.PublishCampaign:
    case PipelineOperationType.RepostLoop: {
      const mediaIds =
        operation.type === PipelineOperationType.PublishPost ? operation.mediaIds : [];
      return {
        driverClass: DriverClass.GraphApi,
        operationKind: DriverOperationKind.PublishMedia,
        payload: { mediaIds, ...firstCaption(operation), ...mock },
      };
    }
    case PipelineOperationType.PublishStory:
      return {
        driverClass: DriverClass.GraphApi,
        operationKind: DriverOperationKind.PublishStory,
        payload: { mediaIds: operation.mediaIds, ...mock },
      };
    case PipelineOperationType.RepostStoryTemplate:
      return {
        driverClass: DriverClass.GraphApi,
        operationKind: DriverOperationKind.PublishStory,
        payload: { mediaIds: [], templateId: operation.templateId, ...mock },
      };
    case PipelineOperationType.Warmup:
      return {
        driverClass: DriverClass.GraphApi,
        operationKind: DriverOperationKind.WarmupAction,
        payload: { actionBudget: operation.dailyActionBudget ?? 5, ...mock },
      };
    case PipelineOperationType.FetchInsights:
      return {
        driverClass: DriverClass.GraphApi,
        operationKind: DriverOperationKind.FetchInsights,
        payload: { externalPostId: "unknown", ...mock },
      };
    case PipelineOperationType.AcquireContent:
      return {
        driverClass: DriverClass.ContentAcquisition,
        operationKind: DriverOperationKind.AcquireContent,
        payload: { contentSourceId: operation.contentSourceId, maxItems: operation.maxItems, ...mock },
      };
    default: {
      // Exaustividade: se um novo PipelineOperationType surgir, isto falha o build.
      const _exhaustive: never = operation;
      throw new Error(`operação de pipeline não mapeada: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
