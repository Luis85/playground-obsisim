import type { BuildingDefId, ResourceId } from '../shared/content-types';
import { isUnderConstruction } from '../shared/placement';
import { BALANCE, MAX_AGE_TICKS } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCE_IDS } from './content/resources';
import {
  Age, Building, Construction, Efficiency, HaulTrip, Home, Hunger, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation,
  ToolCoverage, Colonist, WorkerSlots,
} from './components';

/**
 * The one place each entity kind's component set is written down.
 *
 * An entity can enter the world by two independent paths — restored from a save
 * (`spawnBuilding`/`spawnColonist` in world.ts, at preptime) or created live by a
 * command (`handleConstructBuilding`/`handleRecruitWorker`, at runtime) — and
 * each used to list its own components. Forgetting one was silent, and it bit
 * twice inside a single increment: buildings constructed during play had no
 * `OutputBuffer`, and workers recruited during play had no `HaulTrip`, which
 * dropped them out of snapshots entirely because the snapshot query requires it
 * (OBS-4-02). The paths differ only in where initial values come from and in how
 * components get attached, never in *which* components an entity needs — so both
 * fill one of the specs below and the list exists exactly once.
 *
 * Adding a component is now one edit here. `COMPONENT_TYPES` in world.ts still
 * needs the type appended for save/restore round-tripping, and the parity tests
 * in tests/engine/systems/command-system.test.ts pin both entity kinds.
 */

/**
 * Balance-coupled clamps (spec 4.5 — saves survive balancing changes). A save
 * written under a larger recipe, `hungerMax` or `toolDurationTicks` still loads;
 * its values come down to what current balance allows instead of the load guard
 * rejecting the save. `isLoadableSave` deliberately does not bounds-check these.
 *
 * They live here because three callers must agree on them: both spawn paths, and
 * the restore path (`restoredColonists`, `buildInitialSnapshot`), which seeds a
 * snapshot that has to match the entities actually spawned.
 */
export function clampedProgress(defId: BuildingDefId, progress: number): number {
  const { recipe } = BUILDINGS[defId];
  // A shelter has no batch to be part-way through; any saved progress on one
  // is meaningless and clamps to nothing rather than being rejected.
  return recipe === null ? 0 : Math.min(progress, recipe.ticksPerBatch);
}

export function clampedHunger(hunger: number): number {
  return Math.min(hunger, BALANCE.hungerMax);
}

export function clampedStarving(ticks: number): number {
  return Math.max(0, Math.min(ticks, BALANCE.starvationDeathTicks));
}

export function clampedToolTicks(toolTicks: number): number {
  return Math.min(toolTicks, BALANCE.toolDurationTicks);
}

/**
 * A saved relocation countdown, clamped to what current balance can produce.
 * Exported (promoted back from module-private) because `buildInitialSnapshot`
 * needs it too: the seeded snapshot's `relocatingTicks` fact must
 * be clamped the same way `buildingComponents` below clamps the live
 * `Relocation` component, or the two would disagree about a saved building
 * that outlived a balance retune (same principle as clampedProgress,
 * clampedHunger and clampedToolTicks above).
 */
export function clampedRelocation(ticksLeft: number): number {
  return Math.max(0, Math.min(ticksLeft, BALANCE.maxRelocationTicks));
}

/**
 * A saved construction countdown, clamped to what current balance can produce
 * — `clampedRelocation`'s rule, applied to the other countdown a building
 * carries, and exported for the same second reader (`buildInitialSnapshot`).
 *
 * Without it a site saved before `buildTicks` was lowered keeps more build
 * time than a freshly ordered one, forever, and the paused snapshot advertises
 * a countdown the constant no longer allows.
 */
export function clampedConstruction(ticksLeft: number): number {
  return Math.max(0, Math.min(ticksLeft, BALANCE.buildTicks));
}

export function clampedAge(ticks: number): number {
  return Math.max(0, Math.min(ticks, MAX_AGE_TICKS));
}

/**
 * A saved buffer trimmed to `cap`, counted across all resources in catalog
 * order. An over-cap buffer loads and trims rather than being refused.
 *
 * Takes the cap as an argument rather than reading one off the caller (e.g. a
 * component-typed parameter): `OutputBuffer` and `InputBuffer` have separate
 * caps that can retune independently, and a second copy of this trim loop is
 * how the input side would end up silently trimming to the output cap after
 * one of them moves.
 */
export function clampedBuffer(saved: Partial<Record<ResourceId, number>>, cap: number): Map<ResourceId, number> {
  const buffer = new Map<ResourceId, number>();
  let total = 0;
  for (const id of RESOURCE_IDS) {
    const amount = saved[id] ?? 0;
    if (amount <= 0) continue;
    const room = cap - total;
    if (room <= 0) break;
    const kept = Math.min(amount, room);
    buffer.set(id, kept);
    total += kept;
  }
  return buffer;
}

/**
 * `clampedBuffer` against `BALANCE.inputBufferCap` — the input-side counterpart
 * every `InputBuffer` seed (save restore, live construct, or a test fixture)
 * goes through, the same way `OutputBuffer` goes through `clampedBuffer`
 * directly with `BALANCE.outputBufferCap`.
 *
 * Module-private since save v7: both restore projections now reach it through
 * `restoredInputBuffer` below, which is what decides between a producer's cap
 * and a SITE's bill. Exporting it again would let a caller pick the wrong one
 * of the two — precisely the drift `restoredInputBuffer` exists to prevent.
 */
function clampedInputBuffer(saved: Partial<Record<ResourceId, number>>): Map<ResourceId, number> {
  return clampedBuffer(saved, BALANCE.inputBufferCap);
}

/**
 * A construction SITE's saved in-tray, bounded by its `cost` — PER RESOURCE,
 * never as one total, the same shape `inputRoomOf` (haul-construction.ts)
 * bounds an arriving load by.
 *
 * `clampedBuffer` cannot serve here, and passing it `sum(cost)` is the cheap
 * wrong answer: an aggregate cap is spent in catalog order, so after a
 * rebalance from 20 wood/10 planks to 10 wood/20 planks a site saved under the
 * old cost restores holding 20 wood — inside the aggregate 30, over
 * `cost.wood` — accepts 10 more planks, and clears 40 units against a 30-unit
 * bill on completion.
 *
 * `BALANCE.inputBufferCap` is deliberately NOT a second bound: the cap exists
 * because a producer's in-tray is a buffer against haul latency, while a
 * site's tray is the BILL, and a mill costs 30 units against a 12-unit cap
 * (again `inputRoomOf`'s own argument). Applying it would destroy 18 units the
 * ledger has already recorded as consumed.
 *
 * WHAT IS TRIMMED IS NOT DROPPED. `cost` is content, and content gets
 * rebalanced, so this is the first buffer clamp whose bound can legitimately
 * SHRINK between save and load — and a site's tray sits outside `Stockpile`,
 * so declined units have nowhere to fall back to. `refundTrimmedMaterials`
 * (restore.ts) banks the difference at the camp, through the restore-only path
 * `seedStoredGoods`' own spill uses.
 */
export function clampedToCost(saved: Partial<Record<ResourceId, number>>, defId: BuildingDefId): Map<ResourceId, number> {
  const { cost } = BUILDINGS[defId];
  const buffer = new Map<ResourceId, number>();
  for (const id of RESOURCE_IDS) {
    const kept = Math.min(saved[id] ?? 0, cost[id] ?? 0);
    if (kept > 0) buffer.set(id, kept);
  }
  return buffer;
}

/**
 * The in-tray a restored building actually holds: its BILL while it is still a
 * site, its buffer once it is finished. One function because both restore
 * projections must answer it identically — `buildingComponents` below builds
 * the live component from it, and `buildInitialSnapshot` publishes the paused
 * figure beside it.
 */
export function restoredInputBuffer(
  saved: Partial<Record<ResourceId, number>>, defId: BuildingDefId, constructionTicks: number,
): Map<ResourceId, number> {
  return isUnderConstruction(constructionTicks) ? clampedToCost(saved, defId) : clampedInputBuffer(saved);
}

/** Initial values for a building, from a save record or from a build command. */
export interface BuildingSpec {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  progress?: number;
  batchActive?: boolean;
  buffer?: Partial<Record<ResourceId, number>>;
  // Persisted since save v6 (`SavedBuilding.inputBuffer`), so a reload no
  // longer empties a building's in-tray. Optional here because the live
  // construct path has nothing to put in one yet, and a fixture may not care.
  inputBuffer?: Partial<Record<ResourceId, number>>;
  relocatingTicks?: number;
  // The construction countdown, threaded exactly like `relocatingTicks` above
  // and for the same reason: `handleConstructBuilding` spawns a SITE (spec
  // §2.5), and the shared component list is the only place a building's
  // components may be written down. Persisted since save v7
  // (`SavedBuilding.constructionTicks`), so the restore path supplies one too.
  // Optional because a fixture (or a caller with nothing to restore) means a
  // finished building, which is a countdown of 0.
  constructionTicks?: number;
}

/** Every component a building needs, in one list. Order is not significant. */
export function buildingComponents(spec: BuildingSpec): object[] {
  // Clamped ONCE and read twice: the component below and the in-tray bound
  // above must agree about whether this building is a site, or a countdown
  // clamped to zero would still be restored with a site's tray.
  const constructionTicks = clampedConstruction(spec.constructionTicks ?? 0);
  return [
    new Building(spec.id, spec.defId),
    new WorkerSlots(BUILDINGS[spec.defId].workerSlots),
    new Production(clampedProgress(spec.defId, spec.progress ?? 0), spec.batchActive ?? false),
    new Position(spec.col, spec.row),
    new OutputBuffer(clampedBuffer(spec.buffer ?? {}, BALANCE.outputBufferCap)),
    new InputBuffer(restoredInputBuffer(spec.inputBuffer ?? {}, spec.defId, constructionTicks)),
    new Relocation(clampedRelocation(spec.relocatingTicks ?? 0)),
    // Unconditional, like Relocation above, and clamped exactly as it is now
    // that save v7 makes an out-of-range value expressible: the live construct
    // path hands in `BALANCE.buildTicks`, and the restore path hands in
    // whatever the save wrote under whatever balance was current then.
    new Construction(constructionTicks),
  ];
}

/** Initial values for a worker, from a save record or from a recruit command. */
export interface ColonistSpec {
  id: number;
  hunger?: number;
  starvingTicks?: number;
  buildingId?: number | null;
  hauling?: boolean;
  efficiency?: number;
  toolTicks?: number;
  ageTicks?: number;
  homeId?: number | null;
}

/** Every component a worker needs, in one list. Order is not significant. */
export function colonistComponents(spec: ColonistSpec): object[] {
  return [
    new Colonist(spec.id),
    new Hunger(clampedHunger(spec.hunger ?? 0), clampedStarving(spec.starvingTicks ?? 0)),
    new JobAssignment(spec.buildingId ?? null, spec.hauling ?? false),
    new Efficiency(spec.efficiency ?? 1),
    new ToolCoverage(clampedToolTicks(spec.toolTicks ?? 0)),
    // Runtime-only, never saved — but every worker carries one, so a hauler can
    // be assigned without the snapshot query losing sight of them.
    new HaulTrip(),
    // Defaults to a founder's starting age, not 0: an unspecified age means
    // "a spec that does not care", and BALANCE.startingAgeTicks (spec 2.2) is
    // already the documented age new founders begin at. 0 would make every
    // colonist created without an explicit age a child — including every
    // fixture colonist — silently ineligible for the assign command.
    new Age(clampedAge(spec.ageTicks ?? BALANCE.startingAgeTicks)),
    // Saved since v5, so a restored colonist wakes in the bed they went to
    // sleep in rather than homeless until the next rehome pass. Unspecified
    // still means homeless: a colonist created by a command without one (an
    // arrival whose gate found no bed) genuinely has nowhere to live.
    new Home(spec.homeId ?? null),
  ];
}
