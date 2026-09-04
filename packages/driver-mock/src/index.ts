/**
 * @scaleapp/driver-mock — driver de automação falso para validar o pipeline de
 * execução sem integração real. Lado do Execution Plane; injetado via porta.
 */

export { MockDriver, withMockDirective } from "./mockDriver.js";
export type { MockDirective } from "./mockDriver.js";
export { InMemoryDriverRegistry } from "./registry.js";
