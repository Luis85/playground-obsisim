import type { BuildingDefId, RecipeDef, ResourceId } from '../shared/content-types';
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

export class Colonist {
  constructor(public id: number) {}
}

export class Hunger {
  /**
   * `starvingTicks` counts consecutive ticks pinned at `hungerMax` with
   * nothing eaten. HungerSystem is its ONLY writer — it already owns this
   * component and is the one place that knows whether this colonist ate this
   * tick; PopulationSystem only reads it. Two systems writing one counter is
   * how a starvation clock ends up advancing twice on a tick where a colonist
   * both starved and was fed.
   *
   * Saved (v5) for the reason relocatingTicks is: it is a penalty already
   * incurred, and dropping it would let save-and-reload cancel a starvation
   * in progress.
   */
  constructor(public value = 0, public starvingTicks = 0) {}
}

/**
 * How long this colonist has been alive, in ticks. The single source of their
 * life stage — `stageOf` derives child/adult/elder from it, so there is no
 * maturity flag beside the age that could disagree with it, and moving a band
 * needs no migration.
 *
 * Saved (v5): plainly persistent state, not runtime scratch like HaulTrip.
 * Magnitude is clamped at load by `clampedAge` rather than bounds-checked in
 * the load guard, so a save written under a longer lifespan still opens.
 */
export class Age {
  constructor(public ticks = 0) {}
}

export class JobAssignment {
  constructor(public buildingId: number | null = null, public hauling = false) {}
}

/**
 * The house this colonist sleeps in, or null when homeless. Occupancy is read
 * from these references rather than counted on the building, so a house and
 * its residents cannot disagree about who lives there.
 *
 * Saved (v5): where a colonist lives is a decision, not derived state — the
 * homing phase would re-derive *a* valid assignment on load, but not
 * necessarily the same one, which would silently reshuffle commutes.
 */
export class Home {
  constructor(public buildingId: number | null = null) {}
}

export class Efficiency {
  constructor(public value = 1) {}
}

/** A building's tile on the world map. Colonists have none: their spots stay
 * derived by the app-layer layout (spec §2.3). */
export class Position {
  constructor(public col: number, public row: number) {}
}

/**
 * The arithmetic `OutputBuffer` and `InputBuffer` share: both are just a
 * capped pile of resources, one filled by a building's own production, the
 * other filled (later, by a hauler) for it to consume. A real base class
 * rather than the "two small classes" the design otherwise prefers, because
 * the alternative — each class redeclaring `total`/`room`/`add`/`take` as
 * one-line delegations to shared free functions — still puts the SAME four
 * method signatures in two places, which is exactly the duplication the
 * quality gate (pinned at zero) catches. Inheriting them once is the only
 * way to have the identical arithmetic exist in the file exactly once.
 * `OutputBuffer` and `InputBuffer` stay the two real, independently
 * documented, independently registered component types — this only factors
 * out what they always agreed on anyway.
 */
abstract class ResourceBuffer {
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
}

/**
 * Finished goods waiting at the building that made them until a hauler carries
 * them to the camp store. The cap is counted across ALL resources: buildings
 * produce one resource today, and a total keeps the cap meaningful if a recipe
 * ever yields two.
 */
export class OutputBuffer extends ResourceBuffer {
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

/**
 * Raw goods a building has pulled in for its OWN recipe, waiting to be
 * consumed — the input-side mirror of `OutputBuffer`. Since Task 3, a
 * building's batches are paid out of this, never out of the colony
 * `Stockpile`: goods must physically arrive here (a hauler's job, in later
 * tasks) before a recipe can spend them. Same shape as `OutputBuffer`
 * (`amounts`, `total`, `room`, `add`, `take`, inherited from `ResourceBuffer`
 * above) — the two differ only in their one extra method (`shortestOf` vs
 * `fullestResource`).
 */
export class InputBuffer extends ResourceBuffer {
  /**
   * The resource a hauler should refill next: whichever input this building
   * is proportionally shortest of, relative to what one batch of its recipe
   * wants — `fullestResource`'s opposite, and `OutputBuffer`'s reason for
   * ties, applied to intake instead of pickup. Ties (including a recipe with
   * no inputs, where every ratio is undefined) break by catalog order, so a
   * hauler's choice and any UI preview can only ever derive it one way.
   *
   * `room` and `add` have no caller yet — a hauler that fills an `InputBuffer`
   * is Task 6's supply leg — but this method does not wait for that caller to
   * exist: it is unit-tested directly (tests/engine/components.test.ts), the
   * same way `fullestResource` is exercised by HaulSystem's tests, so the
   * ratio-vs-absolute choice and its catalog-order tie-break both ship with
   * real coverage rather than a dead-code suppression. Kept here now so
   * `HaulSystem` and any UI preview cannot derive the choice differently once
   * they exist, rather than added piecemeal later.
   */
  shortestOf(recipe: RecipeDef, order: readonly ResourceId[]): ResourceId | null {
    let best: ResourceId | null = null;
    let bestRatio = Infinity;
    for (const id of order) {
      const wanted = recipe.inputs[id];
      if (wanted === undefined) continue;
      const ratio = (this.amounts.get(id) ?? 0) / wanted;
      if (ratio < bestRatio) {
        best = id;
        bestRatio = ratio;
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
 *
 * `legTicks` and the pickup tile freeze facts about the CURRENT leg at the
 * moment it begins, so the snapshot can publish them instead of the app layer
 * re-deriving them from the building's live position — which desyncs a
 * returning hauler's drawn walk once its building moves mid-leg (OBS-5-01).
 */
export class HaulTrip {
  constructor(
    public phase: HaulPhase = 'idle',
    public targetId: number | null = null,
    public ticksLeft = 0,
    public resource: ResourceId | null = null,
    public amount = 0,
    // What `haulTicks` charged for the CURRENT leg — frozen, unlike `ticksLeft`,
    // which counts down. Set beside `ticksLeft` at every site that assigns it.
    public legTicks = 0,
    // The return leg's origin tile: the building's position at the moment this
    // hauler loaded, frozen for the rest of that leg. Meaningful only once
    // `phase` is 'returning'.
    public pickupCol = 0,
    public pickupRow = 0,
  ) {}

  /** Back to standing at the camp with empty hands. */
  reset(): void {
    this.phase = 'idle';
    this.targetId = null;
    this.ticksLeft = 0;
    this.resource = null;
    this.amount = 0;
    this.legTicks = 0;
    this.pickupCol = 0;
    this.pickupRow = 0;
  }
}
