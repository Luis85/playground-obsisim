import type { BuildingDefId, ResourceId } from '../shared/content-types';
import type { HaulPhase } from '../shared/haul';

export class Building {
  constructor(public id: number, public defId: BuildingDefId) {}
}

export class WorkerSlots {
  constructor(public max: number) {}
}

export class Production {
  constructor(public progress = 0, public batchActive = false) {}
}

export class ToolCoverage {
  constructor(public remainingTicks = 0) {}
}

export class Worker {
  constructor(public id: number) {}
}

export class Hunger {
  constructor(public value = 0) {}
}

export class JobAssignment {
  constructor(public buildingId: number | null = null, public hauling = false) {}
}

export class Efficiency {
  constructor(public value = 1) {}
}

/** A building's tile on the world map. Workers have none: their spots stay
 * derived by the app-layer layout (spec §2.3). */
export class Position {
  constructor(public col: number, public row: number) {}
}

/**
 * Finished goods waiting at the building that made them until a hauler carries
 * them to the camp store. The cap is counted across ALL resources: buildings
 * produce one resource today, and a total keeps the cap meaningful if a recipe
 * ever yields two.
 */
export class OutputBuffer {
  constructor(public readonly amounts = new Map<ResourceId, number>()) {}

  total(): number {
    let sum = 0;
    for (const amount of this.amounts.values()) sum += amount;
    return sum;
  }

  room(cap: number): number {
    return Math.max(0, cap - this.total());
  }

  add(id: ResourceId, amount: number): void {
    this.amounts.set(id, (this.amounts.get(id) ?? 0) + amount);
  }

  /** Remove up to `amount` of one resource; returns what was actually taken. */
  take(id: ResourceId, amount: number): number {
    const held = this.amounts.get(id) ?? 0;
    const taken = Math.min(amount, held);
    if (taken <= 0) return 0;
    if (held === taken) this.amounts.delete(id);
    else this.amounts.set(id, held - taken);
    return taken;
  }

  /**
   * The resource a hauler would load: whichever this building holds most of.
   * Ties break by catalog order — passed in rather than imported, so the
   * component stays free of content dependencies — which keeps the choice
   * deterministic instead of Map-insertion-ordered.
   */
  fullestResource(order: readonly ResourceId[]): ResourceId | null {
    let best: ResourceId | null = null;
    let bestAmount = 0;
    for (const id of order) {
      const amount = this.amounts.get(id) ?? 0;
      if (amount > bestAmount) {
        best = id;
        bestAmount = amount;
      }
    }
    return best;
  }
}

// Defined in src/shared/haul.ts (the snapshot publishes it, and shared may
// not import the engine); re-exported here so component consumers need one import.
export type { HaulPhase };

/**
 * Ticks a building is still out of action after being moved. Unlike HaulTrip,
 * this DOES survive a save (save v4) — it is a penalty already incurred, and
 * dropping it would let save-and-reload cancel it for free. `savedBuildingOf`
 * writes `SavedBuilding.relocatingTicks` (required since v4) and
 * `buildingComponents` restores it on load. The load guard only rejects a
 * negative or fractional countdown (a record no engine version could write);
 * magnitude is clamped to current balance by `clampedRelocation` instead, so a
 * save written under a slower `relocationTilesPerTick` still loads.
 */
export class Relocation {
  constructor(public ticksLeft = 0) {}
}

/**
 * A hauler's current trip. Runtime-only: it never enters the save — a hauler
 * caught mid-trip banks its load into the saved stockpile instead — so nothing
 * here needs a load guard or a migration. Present on every worker; anyone who
 * is not hauling simply sits at 'idle'.
 */
export class HaulTrip {
  constructor(
    public phase: HaulPhase = 'idle',
    public targetId: number | null = null,
    public ticksLeft = 0,
    public resource: ResourceId | null = null,
    public amount = 0,
  ) {}

  /** Back to standing at the camp with empty hands. */
  reset(): void {
    this.phase = 'idle';
    this.targetId = null;
    this.ticksLeft = 0;
    this.resource = null;
    this.amount = 0;
  }
}
