/**
 * Registry em memória do capability registry (porta `DriverCapabilityRegistry`
 * de @scaleapp/domain). Roteia operação → driver com base nas capacidades
 * declaradas por cada driver. O Control Plane fala com a porta; quem registra
 * os drivers concretos é o composition root (ex.: apps/worker).
 */

import { CapabilitySupport } from "@scaleapp/domain";
import type {
  AutomationDriver,
  DriverCapabilityRegistry,
  DriverClass,
  DriverOperationKind,
  DriverResolution,
} from "@scaleapp/domain";

export class InMemoryDriverRegistry implements DriverCapabilityRegistry {
  private readonly byClass = new Map<DriverClass, AutomationDriver>();

  register(driver: AutomationDriver): void {
    this.byClass.set(driver.driverClass, driver);
  }

  resolve(kind: DriverOperationKind): readonly DriverResolution[] {
    const resolutions: DriverResolution[] = [];
    for (const driver of this.byClass.values()) {
      const capability = driver.capabilities.find((c) => c.kind === kind);
      if (capability) resolutions.push({ driver, support: capability.support });
    }
    // Primário antes de secundário.
    return resolutions.sort((a, b) =>
      a.support === b.support ? 0 : a.support === CapabilitySupport.Primary ? -1 : 1,
    );
  }

  primaryFor(kind: DriverOperationKind): AutomationDriver | undefined {
    const resolved = this.resolve(kind);
    return resolved.find((r) => r.support === CapabilitySupport.Primary)?.driver ?? resolved[0]?.driver;
  }

  get(driverClass: DriverClass): AutomationDriver | undefined {
    return this.byClass.get(driverClass);
  }
}
