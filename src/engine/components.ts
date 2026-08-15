import type { BuildingDefId, RecipeDef, ResourceId } from '../shared/content-types';
import { CAMP_SITE_ID, CAMP_TILE, haulTicksBetween, legPositionOf, type HaulKind, type HaulPhase } from '../shared/haul';
import type { TileRef } from '../shared/placement';

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

// Defined in src/shared/haul.ts (the snapshot publishes them, and shared may
// not import the engine); re-exported here so component consumers need one import.
export type { HaulKind, HaulPhase };

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
 * Relocation's precedent, applied to a building's birth rather than its move
 * (spec §2.5, "Construction as Work"): while this exists with `ticksLeft > 0`
 * (`isUnderConstruction`, src/shared/placement.ts), the building is a
 * construction site occupying its tile and providing nothing — no
 * production, no beds, no storage — until material delivery (later tasks)
 * counts it down to 0. Mirrors `Relocation` field for field: a fresh building
 * defaults to 0 (settled/finished), the same value a completed relocation
 * ends at, so an entity that has never been under construction and one that
 * finished being under construction are indistinguishable — same as
 * Relocation is for a building that has never moved.
 *
 * Registered nowhere else yet: nothing sets this above 0 or reads it below 0
 * until the tasks that wire construction into the construct command and the
 * haul system. Attached here only so save/restore and live construct agree on
 * every building's component set from the start (`buildingComponents`,
 * spawn.ts) — the same OBS-4-02 reason `Relocation` is unconditional.
 */
export class Construction {
  constructor(public ticksLeft = 0) {}
}

/**
 * Empty hands, no job, no leg — everything about a trip except where the
 * hauler stands.
 *
 * A module-private FUNCTION rather than a private method, and the reason is
 * sim-ecs rather than taste: a query row's type is `Required<Omit<HaulTrip,
 * never>>`, which drops private members, and TypeScript then compares the two
 * nominally and rejects every row a system iterates. Being unreachable from
 * outside this file is the point either way — `cancel` is the only way to end
 * a trip, because every branch that ends one first has to say where its hauler
 * stopped.
 */
function clearTrip(trip: HaulTrip): void {
  trip.phase = 'idle';
  trip.kind = 'collect';
  trip.targetId = null;
  trip.ticksLeft = 0;
  trip.resource = null;
  trip.amount = 0;
  trip.plannedAmount = 0;
  trip.sourceSiteId = CAMP_SITE_ID;
  trip.destSiteId = CAMP_SITE_ID;
  trip.pickedUp = false;
  trip.staging = false;
  trip.legTicks = 0;
  trip.legFromCol = 0;
  trip.legFromRow = 0;
  trip.legToCol = 0;
  trip.legToRow = 0;
}

/**
 * A hauler's current trip. Runtime-only: it never enters the save — a hauler
 * caught mid-trip banks its load into the saved stockpile instead — so nothing
 * here needs a load guard or a migration. Present on every worker; anyone who
 * is not hauling simply sits at 'idle'.
 *
 * `legTicks` and the two leg endpoints freeze facts about the CURRENT leg at
 * the moment it begins, so the snapshot can publish them instead of the app
 * layer re-deriving them from the building's live position — which desyncs a
 * returning hauler's drawn walk once its building moves mid-leg (OBS-5-01).
 */
export class HaulTrip {
  constructor(
    public phase: HaulPhase = 'idle',
    /** The job this hauler was dispatched on, frozen at dispatch. It stops
     * describing the CARGO the moment the round trip works as intended — a
     * supply trip carrying collected output home is still `'supply'` — so
     * anything asking "what is in this hauler's hands" reads `pickedUp`. For
     * a transfer, though, `kind` DOES describe the whole trip accurately,
     * unlike for supply: a transfer never picks up a building's output, so
     * there is no cargo/round-trip gap for it to paper over. */
    public kind: HaulKind = 'collect',
    public targetId: number | null = null,
    public ticksLeft = 0,
    public resource: ResourceId | null = null,
    /** Units in hand right now, and only that. A fetching hauler carries
     * nothing until it arrives, which is why the quantity it PLANS to take
     * is a separate field: `buildSaveFromWorld` banks `amount` into the save
     * as real cargo, so folding a planned take in here would duplicate goods
     * on any save written mid-fetch. */
    public amount = 0,
    /** How much a fetching trip intends to take from `sourceSiteId` — its
     * claim on that site's stock, so two haulers cannot both plan the same
     * last six wheat. Becomes 0 the moment `takeAt` returns the real figure. */
    public plannedAmount = 0,
    public sourceSiteId = CAMP_SITE_ID,
    /** Where the return leg is headed, and the reservation of room there:
     * every bounded site's free space is measured net of what returning
     * haulers have already been promised. */
    public destSiteId = CAMP_SITE_ID,
    /** Whether the load in hand came out of a building's output buffer. The
     * flow-accounting discriminator: by the time a load reaches a site, a
     * genuine delivery (`addAt`) and an undelivered supply remainder
     * (`refundAt`) are indistinguishable without it. */
    public pickedUp = false,
    /**
     * Set at dispatch, for a transfer only: whether this trip is topping up a
     * site below its staging target (`true`) or draining one above its
     * demand-plus-floor (`false` — also the value for every `collect` and
     * `supply` trip, which is the truth rather than a default). The two
     * classes share every line of trip machinery and no arrival handler tells
     * them apart, so this rides on the trip rather than becoming a fourth
     * `HaulKind`. Nothing in the engine reads it; §4.2's measurement does,
     * because the class is unrecoverable from anything else published on the
     * trip — the snapshot has no site ids, and the route is not a
     * discriminator either, since the camp is an ordinary site in the pull
     * rule and a depot -> camp move can legitimately be either class.
     */
    public staging = false,
    // What the leg was charged when it began — frozen, unlike `ticksLeft`,
    // which counts down. Set beside `ticksLeft` at every site that assigns it.
    public legTicks = 0,
    // BOTH endpoints of whichever leg is running, frozen when that leg begins
    // — every leg, not only the return one, because a fetching or outbound
    // trip cancelled part-way needs the same interpolation to say where its
    // hauler stopped. Tiles, not site ids: a depot that relocates mid-leg
    // resolves the same id to a different tile, leaving no origin to price
    // the onward leg from (OBS-5-01).
    public legFromCol = 0,
    public legFromRow = 0,
    public legToCol = 0,
    public legToRow = 0,
    // Where this hauler physically STANDS when no leg is running. A position
    // rather than a site id, so a demolished storehouse leaves no membership
    // dangling. Defaults to the camp tile, not (0, 0): every other number here
    // defaults to zero, and a fresh or restored hauler starting in the map's
    // corner would price and draw its first leg from a tile it has never
    // stood on.
    public atCol = CAMP_TILE.col,
    public atRow = CAMP_TILE.row,
  ) {}

  /**
   * Begin a leg, freezing everything about it that must survive the walk: its
   * length, and BOTH endpoints. Setting one and leaving the rest at their
   * defaults is the failure the four-field model exists to prevent, so every
   * leg in the engine starts here rather than by assigning the fields by hand.
   *
   * `cancel`'s mirror image, and beside it deliberately: the one way a leg
   * begins next to the one way a trip ends, both writing the same six fields
   * one of them freezes and the other interpolates. `tilesPerTick` is a
   * parameter for the reason `fullestResource` takes its catalog order — the
   * component stays free of content dependencies, and BALANCE belongs to the
   * engine's content layer, not to the shape of a trip.
   */
  startLeg(phase: HaulPhase, from: TileRef, to: TileRef, tilesPerTick: number): void {
    const ticks = haulTicksBetween(from, to, tilesPerTick);
    this.phase = phase;
    this.ticksLeft = ticks;
    this.legTicks = ticks;
    this.legFromCol = from.col;
    this.legFromRow = from.row;
    this.legToCol = to.col;
    this.legToRow = to.row;
  }

  /**
   * End this trip where the hauler is actually standing.
   *
   * THE way a trip ends — `reset` is private precisely so every branch comes
   * through here, including the ones added later by someone reading the
   * surrounding code rather than this comment. While a leg runs,
   * `legFrom`/`legTo` name its endpoints and `atCol`/`atRow` still hold its
   * ORIGIN, so resetting without this would snap the hauler back over every
   * tile it had walked — and the arrival-time cancellations are the sharp
   * case, since they fire with the leg fully walked. `legPositionOf` decides
   * how far it got — the shared law `handleMoveBuilding` re-prices a retargeted
   * leg from, so a cancellation and a move can never disagree about where the
   * same hauler is standing.
   */
  cancel(): void {
    // An idle trip has no leg to interpolate — its endpoints are cleared, and
    // reading them would teleport a standing hauler to the map's corner.
    if (this.phase !== 'idle') {
      const at = legPositionOf(this);
      this.atCol = at.col;
      this.atRow = at.row;
    }
    clearTrip(this);
  }
}
