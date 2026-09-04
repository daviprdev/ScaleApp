/**
 * @scaleapp/domain — contratos do domínio do ScaleApp.
 *
 * Só tipos e portas: nenhuma lógica de negócio, nenhum acesso a Playwright,
 * Graph API, banco ou fila. É a linguagem comum entre Control Plane e
 * Execution Plane.
 */

export * from "./common.js";
export * from "./meta-app.js";
export * from "./proxy.js";
export * from "./account.js";
export * from "./media.js";
export * from "./content-source.js";
export * from "./pipeline.js";
export * from "./driver.js";
export * from "./job.js";
export * from "./execution.js";
export * from "./pipeline-execution.js";
