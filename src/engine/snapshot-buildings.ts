import type { BuildingDefId, CostMap, RecipeDef, ResourceId } from '../shared/content-types';
import type { SavedBuilding } from '../shared/save';
import type { BuildingSnapshot, BuildingState } from '../shared/snapshot';
import { isRelocating, isUnderConstruction } from '../shared/placement';
import { BALANCE } from './content/balance';
import { batchOutputUnits, BUILDINGS, unitsOf } from './content/buildings';
import { Building, Construction, InputBuffer, OutputBuffer, Position, Production, Relocation, WorkerSlots } from './components';

/**
 * The building half of the snapshot builder: one building's plain facts, the
 * state ladder derived from them, and the two projections that consume them
 * (the published `BuildingSnapshot` and the `SavedBuilding` record).
 *
 * Split out of snapshot-builder.ts when that file approached the 500-line cap,
 * along the seam the module already had — the colonist half needs none of this,
 * and `buildEntitySections` keeps the cross-entity aggregation that genuinely
 * spans both. The same mechanical split initial-snapshot.ts and save-guard.ts
 * came out of world.ts by.
 */
export interface BuildingFacts {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  workerSlots: number;
  progress: number;
  batchActive: boolean;
  buffered: number;
  buffer: Partial<Record<ResourceId, number>>;
  /** This building's own in-tray, and its share of the colony ledger. Both are
   * published in a `BuildingSnapshot` (§2.10) and persisted by save v6 through
   * `savedBuildingOf` below — and a fact the save needs but the facts do not
   * carry is precisely how a producer ends up writing `{}` for a depot full of
   * goods. */
  inputBuffer: Partial<Record<ResourceId, number>>;
  stored: Partial<Record<ResourceId, number>>;
  relocatingTicks: number;
  /** Ticks left before this building stops being a construction site (spec
   * §2.5), threaded exactly like `relocatingTicks` above — and required
   * exactly as it is, since save v7 gives every projection of a building a
   * countdown to read: the two live callers take it off the `Construction`
   * component, and `buildInitialSnapshot` takes it off the save record. */
  constructionTicks: number;
}

/**
 * Cross-entity tallies `buildEntitySections` counts off the roster, in the
 * shape one building's row needs them. Passed as one object rather than four
 * positional maps of identical type, which is four chances to hand them over
 * in the wrong order with nothing to catch it.
 */
export interface BuildingTallies {
  staffed: ReadonlyMap<number, number>;
  tooled: ReadonlyMap<number, number>;
  power: ReadonlyMap<number, number>;
  occupants: ReadonlyMap<number, number>;
}

/**
 * A staffed building that cannot bank another batch is stalled on output,
 * whether or not its current batch has finished — the player's remedy is the
 * same either way: send a hauler. A shelter has no batch to stall on, so it
 * is never output-blocked.
 */
function isOutputBlocked(recipe: RecipeDef | null, buffered: number): boolean {
  return recipe !== null && BALANCE.outputBufferCap - buffered < batchOutputUnits(recipe);
}

/**
 * The state ladder for one building. Construction dominates even relocation
 * (spec §2.5, §2.10): a site cannot be relocating (`handleMoveBuilding`
 * refuses one), so the two are mutually exclusive in practice, but the order
 * is written down anyway — `underConstruction` is checked first because it is
 * first in the precedence chain, a formality that stays true even if that
 * exclusivity ever broke. Relocating dominates everything below it: it is the
 * reason nothing is happening, and it is also why a relocating house shelters
 * nobody and a relocating storehouse stores nothing. A shelter or a store has
 * no other state to be in — neither is ever unstaffed (no slots) or
 * producing.
 *
 * Storage is checked BEFORE housing, and both are derived from the def
 * (`storage`/`recipe`) rather than from `recipe === null` alone: a storehouse
 * has `recipe: null` exactly like a house does, so testing recipe first would
 * report every storehouse as 'housing'.
 *
 * Extracted (rather than one inline nested ternary in buildingSnapshotsOf)
 * purely to keep that function's own branch count — and CRAP score — down as
 * this ladder grows. Same principle as save-guard.ts's isValidAgeTicks /
 * isValidStarvingTicks / isValidHunger / isValidToolTicks splitting out of
 * isColonistRecordValid.
 */
function buildingState(
  recipe: RecipeDef | null, storage: number, relocatingTicks: number, staffed: number, outputBlocked: boolean, batchActive: boolean,
  constructionTicks: number,
): BuildingState {
  if (isUnderConstruction(constructionTicks)) return 'underConstruction';
  if (isRelocating(relocatingTicks)) return 'relocating';
  if (storage > 0) return 'storing';
  if (recipe === null) return 'housing';
  if (staffed === 0) return 'unstaffed';
  if (outputBlocked) return 'outputFull';
  return batchActive ? 'producing' : 'waitingForInput';
}

/**
 * What THIS site still owes, per material — `max(0, cost[r] - inputBuffer[r])`
 * for each resource its own def's `cost` names. Mirrors `outstandingMaterials`'s
 * `owe` closure (placement-handlers.ts) one building at a time rather than
 * summed across the colony's whole queue — that colony-wide sum is
 * `affordableDefs`'s job (game-store.ts), reading this per-building figure
 * back rather than recomputing it a third time. Resources already fully
 * delivered are OMITTED, not zeroed, so a partial-record consumer (`costLabel`,
 * `unitsOf`) reads "what is still short" without a caller filtering zeros out.
 */
function constructionNeedsOf(cost: CostMap, inputBuffer: Partial<Record<ResourceId, number>>): CostMap {
  const needs: CostMap = {};
  for (const [resource, amount] of Object.entries(cost)) {
    const id = resource as ResourceId;
    const short = amount - (inputBuffer[id] ?? 0);
    if (short > 0) needs[id] = short;
  }
  return needs;
}

/** 0-100 display progress; a shelter has no batch to show progress on. */
function progressPercent(recipe: RecipeDef | null, progress: number): number {
  return recipe === null ? 0 : Math.min(100, Math.round((progress / recipe.ticksPerBatch) * 100));
}

/** The published building section, id-ordered. */
export function buildingSnapshotsOf(buildings: readonly BuildingFacts[], tallies: BuildingTallies): BuildingSnapshot[] {
  return buildings
    .map((b) => {
      const def = BUILDINGS[b.defId];
      const staffed = tallies.staffed.get(b.id) ?? 0;
      const outputBlocked = isOutputBlocked(def.recipe, b.buffered);
      const state = buildingState(def.recipe, def.storage, b.relocatingTicks, staffed, outputBlocked, b.batchActive, b.constructionTicks);
      const site = isUnderConstruction(b.constructionTicks);
      return {
        id: b.id,
        defId: b.defId,
        col: b.col, row: b.row,
        workers: staffed,
        // A site's def carries its finished `workerSlots` like any other
        // (`command-handlers.ts`'s own comment on `handleAssignWorker`), so
        // publishing it unguarded would enable a producer site's assign
        // button for a command the engine refuses outright (spec §2.10) — the
        // same "capacity it does not have" `beds`/`storage` are zeroed for
        // below.
        workerSlots: site ? 0 : b.workerSlots,
        state,
        progress: b.progress,
        batchActive: b.batchActive,
        progressPct: progressPercent(def.recipe, b.progress),
        tooledWorkers: tallies.tooled.get(b.id) ?? 0,
        workPower: tallies.power.get(b.id) ?? 0,
        buffered: b.buffered,
        // Two piles at one building, summed from their OWN maps: the in-tray
        // only this building can spend, and its share of the colony ledger any
        // hauler may draw on. Neither is the other, and neither is `buffered`.
        inputBuffered: unitsOf(b.inputBuffer),
        stored: unitsOf(b.stored),
        // From the DEF, never from what is standing there: a depot's fill ring
        // and the table's `held / capacity` both need the denominator, and an
        // empty depot still has one — EXCEPT a site, which is not a store
        // destination yet (§2.5) and must not offer the finished building's
        // capacity while it is still a hole in the ground.
        storage: site ? 0 : def.storage,
        relocatingTicks: b.relocatingTicks,
        constructionTicks: b.constructionTicks,
        // Same "capacity it does not have" rule as `storage` just above: a
        // house site shelters nobody (spec §2.5's acceptance criterion 2),
        // and `beds.total` (snapshot-builder.ts) already excludes it from the
        // colony-wide count — this is that same exclusion, per building.
        beds: site ? 0 : def.beds,
        occupants: tallies.occupants.get(b.id) ?? 0,
        // {} for a finished building — see the field's own doc comment.
        constructionNeeds: site ? constructionNeedsOf(def.cost, b.inputBuffer) : {},
      };
    })
    .sort((a, b) => a.id - b.id);
}

/**
 * `stored` arrives as an argument rather than being read off a component,
 * because it is not one: a building's share of the ledger lives in the
 * `Stockpile` resource, keyed by the building's own id (`siteJSON`). Both
 * callers hold that resource already.
 */
export function buildingFactsOf(
  building: Building, slots: WorkerSlots, production: Production, position: Position, buffer: OutputBuffer, relocation: Relocation,
  input: InputBuffer, stored: Partial<Record<ResourceId, number>>, construction: Construction,
): BuildingFacts {
  return {
    id: building.id,
    defId: building.defId,
    col: position.col,
    row: position.row,
    workerSlots: slots.max,
    progress: production.progress,
    batchActive: production.batchActive,
    buffered: buffer.total(),
    buffer: Object.fromEntries(buffer.amounts) as Partial<Record<ResourceId, number>>,
    inputBuffer: Object.fromEntries(input.amounts) as Partial<Record<ResourceId, number>>,
    stored,
    relocatingTicks: relocation.ticksLeft,
    constructionTicks: construction.ticksLeft,
  };
}

export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return {
    id: facts.id, defId: facts.defId, col: facts.col, row: facts.row,
    progress: facts.progress, batchActive: facts.batchActive, buffer: facts.buffer,
    // Goods, not derivations, and neither is recoverable from anything else in
    // the save: the in-tray holds inputs a hauler already walked out and the
    // colony already paid for, and `stored` is THE serialization of a
    // storehouse's share of the ledger — `Stockpile.toJSON` writes the camp
    // alone, so a `{}` here is not an empty depot, it is a deleted one.
    inputBuffer: facts.inputBuffer,
    stored: facts.stored,
    relocatingTicks: facts.relocatingTicks,
    // Save v7. Without it every site completed for free on reload: the record
    // came back with no countdown, restore defaulted it to zero, and a
    // building nobody paid for was standing there finished.
    constructionTicks: facts.constructionTicks,
  };
}
