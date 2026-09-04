/**
 * @scaleapp/orchestrator — executa um Pipeline como sequência de etapas
 * dependentes sobre o sistema de execução da Fase 03. Control Plane: não conhece
 * driver concreto, não implementa fila nem retry (reusa BullMQ/worker).
 */

export { PipelineOrchestrator } from "./orchestrator.js";
export type { PipelineOrchestratorDeps, AdvanceOutcome } from "./orchestrator.js";
export { OrchestratorRepository } from "./orchestratorRepository.js";
export type { StartInput } from "./orchestratorRepository.js";
export { PipelineRepository } from "./pipelineRepository.js";
export type { CreatePipelineInput } from "./pipelineRepository.js";
export { mapOperation } from "./operationMapping.js";
export type { MappedOperation } from "./operationMapping.js";
