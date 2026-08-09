import type { IRuntimeWorld } from 'sim-ecs';
import type { BuildingDefId, RecipeDef, ResourceId } from '../shared/content-types';
import type { SavedBuilding, SavedColonist } from '../shared/save';
import type { BuildingSnapshot, BuildingState, ColonistSnapshot } from '../shared/snapshot';
import type { TileRef } from '../shared/placement';
import { CAMP_TILE } from '../shared/haul';
import { commuteFactor, mealsPerHead, stageOf } from '../shared/population';
import { BALANCE, workerWorkPower } from './content/balance';
import { MEAL_WEIGHTS } from './content/resources';
import { batchOutputUnits, BUILDINGS } from './content/buildings';
import {
  Age, Building, Efficiency, HaulTrip, Home, Hunger, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage, Colonist,
  WorkerSlots,
} from './components';

/**
 * Plain per-entity facts, decoupled from sim-ecs and from where they came
 * from (live components during a tick, or a save file being restored).
 * The single shared aggregation below (buildEntitySections) is fed from
 * either source so the worker/building snapshot derivation logic — tool
 * multiplier, staffing state, progress percent — exists exactly once.
 *
 * A worker's facts ARE its published snapshot, field for field, with two
 * exceptions: unlike a building, nothing about one worker's own snapshot is
 * aggregated across other entities (compare BuildingFacts below, which is a
 * genuinely smaller set — staffing and power are counted from the whole
 * roster). ColonistFacts therefore extends ColonistSnapshot instead of
 * repeating its field list, plus the one thing a snapshot never needed: which
 * resource is in hand (the amount alone, `carrying`, is what the app and the
 * save both actually use).
 *
 * `commuteTiles`/`commuteFactor`/`deliveredWorkPower` are the exception, and
 * the reason this is an Omit rather than a bare extends: the first two need
 * the HOME's tile and the WORKPLACE's, which no single entity can supply, and
 * the third needs the second — it IS `workerWorkPower` applied to
 * `commuteFactor` (OBS-6-06) — so buildEntitySections computes all three
 * below, where home, workplace and the factor between them are already in
 * hand.
 */
export interface ColonistFacts extends Omit<ColonistSnapshot, 'commuteTiles' | 'commuteFactor' | 'deliveredWorkPower'> {
  carryingResource: ResourceId | null;
}

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
  relocatingTicks: number;
}

export interface EntitySections {
  colonists: ColonistSnapshot[];
  buildings: BuildingSnapshot[];
  population: number;
  idleAdults: number;
  homeless: number;
  beds: { total: number; occupied: number };
  demographics: { children: number; adults: number; elders: number };
  mealsPerHead: number;
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
 * The state ladder for one building. Relocating dominates everything: it is
 * the reason nothing is happening, and it is also why a relocating house
 * shelters nobody. A shelter has no other state to be in — it is never
 * unstaffed (no slots) and never producing.
 *
 * Extracted (rather than one inline nested ternary in buildEntitySections)
 * purely to keep that function's own branch count — and CRAP score — down as
 * this ladder grows. Same principle as save-guard.ts's isValidAgeTicks /
 * isValidStarvingTicks / isValidHunger / isValidToolTicks splitting out of
 * isColonistRecordValid.
 */
function buildingState(
  recipe: RecipeDef | null, relocatingTicks: number, staffed: number, outputBlocked: boolean, batchActive: boolean,
): BuildingState {
  if (relocatingTicks > 0) return 'relocating';
  if (recipe === null) return 'housing';
  if (staffed === 0) return 'unstaffed';
  if (outputBlocked) return 'outputFull';
  return batchActive ? 'producing' : 'waitingForInput';
}

/** 0-100 display progress; a shelter has no batch to show progress on. */
function progressPercent(recipe: RecipeDef | null, progress: number): number {
  return recipe === null ? 0 : Math.min(100, Math.round((progress / recipe.ticksPerBatch) * 100));
}

/**
 * THE bed-to-job distance, in tiles. Null means "no bed" — the homeless case
 * `commuteFactor` charges flat, kept distinct from 0 because a colonist living
 * next door and a colonist living nowhere are opposite ends of the same scale.
 * 0 means housed with nowhere to walk to (unassigned), which costs nothing.
 *
 * Exported because ProductionSystem measures the same commute from live
 * components while this module measures it from facts, and the two must never
 * disagree — the UI would then report a work power the simulation never used.
 * Same reason `workerWorkPower` lives in exactly one place.
 */
export function commuteTiles(homeTile: TileRef | null, workTile: TileRef | null): number | null {
  if (homeTile === null) return null;
  if (workTile === null) return 0;
  return Math.hypot(homeTile.col - workTile.col, homeTile.row - workTile.row);
}

/**
 * The tile a colonist's job is at. A hauler's round trip begins and ends at
 * the camp store, so that — not whichever building they happen to be walking
 * to this tick — is what their commute is measured to; anything else would
 * make one colonist's work power depend on another building's backlog.
 */
function workTileOf(c: ColonistFacts, tileById: ReadonlyMap<number, TileRef>): TileRef | null {
  if (c.hauling) return CAMP_TILE;
  return c.buildingId === null ? null : tileById.get(c.buildingId) ?? null;
}

/**
 * The published ColonistSnapshot.deliveredWorkPower: null for anyone with no
 * buildingId, `workerWorkPower` otherwise. `buildingId === null` is the exact
 * guard the aggregation loop below already uses to decide who feeds
 * `powerByBuilding`, and the one `sumWorkPower` (ProductionSystem) uses too —
 * a hauler's `buildingId` is null by construction (JobAssignment never sets
 * both), and their throughput is carried capacity, not work power (see
 * `sumWorkPower`'s own doc comment), so null is correct for them, not merely
 * unset.
 */
function deliveredWorkPowerOf(w: ColonistFacts, factor: number): number | null {
  return w.buildingId === null ? null : workerWorkPower(w.efficiency, w.toolTicks, factor);
}

/** Pure aggregation shared by SnapshotSystem, the initial-snapshot seed, and the post-step refresh. */
export function buildEntitySections(
  workers: readonly ColonistFacts[],
  buildings: readonly BuildingFacts[],
  stock: Readonly<Record<string, number>>,
): EntitySections {
  const staffCount = new Map<number, number>();
  const powerByBuilding = new Map<number, number>();
  const tooledByBuilding = new Map<number, number>();

  const tileById = new Map(buildings.map((b): [number, TileRef] => [b.id, { col: b.col, row: b.row }]));
  // Measured ONCE per colonist and read by both the aggregation below and the
  // published snapshot, so the multiplier the player is shown is literally the
  // number the aggregation spent, not a second computation that mirrors it.
  const tilesById = new Map(workers.map((w): [number, number | null] => [
    w.id, commuteTiles(w.homeId === null ? null : tileById.get(w.homeId) ?? null, workTileOf(w, tileById)),
  ]));
  const factorOf = (id: number) => commuteFactor(tilesById.get(id) ?? null, BALANCE.commute, BALANCE.homelessFactor);

  for (const w of workers) {
    if (w.buildingId === null) continue;
    const tooled = w.toolTicks > 0;
    staffCount.set(w.buildingId, (staffCount.get(w.buildingId) ?? 0) + 1);
    // Mirrors ProductionSystem's own commute read (both go through
    // commuteTiles above), so the displayed workPower never disagrees with
    // the power the simulation actually used.
    powerByBuilding.set(
      w.buildingId,
      (powerByBuilding.get(w.buildingId) ?? 0) + workerWorkPower(w.efficiency, w.toolTicks, factorOf(w.id)),
    );
    if (tooled) tooledByBuilding.set(w.buildingId, (tooledByBuilding.get(w.buildingId) ?? 0) + 1);
  }

  const workerSnaps: ColonistSnapshot[] = workers
    .map((w) => {
      // Measured once per colonist, same principle as tilesById above: this
      // one factor feeds both commuteFactor and deliveredWorkPower below, so
      // the two published numbers can never independently drift apart.
      const factor = factorOf(w.id);
      return {
        id: w.id, hunger: w.hunger, starvingTicks: w.starvingTicks, efficiency: w.efficiency, buildingId: w.buildingId,
        hauling: w.hauling, haulTargetId: w.haulTargetId, haulPhase: w.haulPhase, haulTicksLeft: w.haulTicksLeft,
        haulLegTicks: w.haulLegTicks, haulPickupCol: w.haulPickupCol, haulPickupRow: w.haulPickupRow,
        carrying: w.carrying, toolTicks: w.toolTicks, ageTicks: w.ageTicks, stage: w.stage, homeId: w.homeId,
        // Null tiles are the homeless case: there is no distance to report, and
        // the whole charge lands in the factor instead.
        commuteTiles: tilesById.get(w.id) ?? 0, commuteFactor: factor,
        deliveredWorkPower: deliveredWorkPowerOf(w, factor),
      };
    })
    .sort((a, b) => a.id - b.id);

  // Occupancy read from who points at a house, never counted on the building
  // itself — see Home's own doc comment on why that pair must never disagree.
  const occupantsByHouse = new Map<number, number>();
  for (const c of workerSnaps) {
    if (c.homeId !== null) occupantsByHouse.set(c.homeId, (occupantsByHouse.get(c.homeId) ?? 0) + 1);
  }

  const buildingSnaps: BuildingSnapshot[] = buildings
    .map((b) => {
      const def = BUILDINGS[b.defId];
      const staffed = staffCount.get(b.id) ?? 0;
      const outputBlocked = isOutputBlocked(def.recipe, b.buffered);
      const state = buildingState(def.recipe, b.relocatingTicks, staffed, outputBlocked, b.batchActive);
      return {
        id: b.id,
        defId: b.defId,
        col: b.col, row: b.row,
        workers: staffed,
        workerSlots: b.workerSlots,
        state,
        progress: b.progress,
        batchActive: b.batchActive,
        progressPct: progressPercent(def.recipe, b.progress),
        tooledWorkers: tooledByBuilding.get(b.id) ?? 0,
        workPower: powerByBuilding.get(b.id) ?? 0,
        buffered: b.buffered,
        relocatingTicks: b.relocatingTicks,
        beds: def.beds,
        occupants: occupantsByHouse.get(b.id) ?? 0,
      };
    })
    .sort((a, b) => a.id - b.id);

  return {
    colonists: workerSnaps,
    buildings: buildingSnaps,
    population: workerSnaps.length,
    // Children and elders are not idle, they are ineligible — counting them
    // here would advertise labour the assign command will refuse.
    idleAdults: workerSnaps.filter((c) => c.stage === 'adult' && c.buildingId === null && !c.hauling).length,
    homeless: workerSnaps.filter((c) => c.homeId === null).length,
    beds: {
      // Relocating houses are excluded, because homing and both admission
      // gates already exclude them. Counting their beds here would let the
      // Population view read "0 / 4 free" while the engine refuses a nomad
      // for want of a bed — the display contradicting the rule it exists to
      // explain. `total` therefore means beds you can actually sleep in
      // tonight, which is the only number a player can act on.
      total: buildingSnaps.filter((b) => b.state !== 'relocating').reduce((sum, b) => sum + b.beds, 0),
      occupied: buildingSnaps.reduce((sum, b) => sum + b.occupants, 0),
    },
    // Spec 2.13's stage counts. Aggregated here beside the other cross-entity
    // sections rather than recomputed in each view: the Population view and
    // the Dashboard both show them, and two independent reductions over the
    // roster are two chances to disagree about what a stage is.
    // Computed HERE, not in SnapshotSystem. That system runs before the
    // post-step sync, so on any tick with a birth, a nomad or a death,
    // refreshEntitySections replaces the population sections afterwards while
    // a separately-computed ratio keeps the OLD denominator — a paused manual
    // step would then show the new population against the previous tick's
    // figure indefinitely. Beside population/demographics/beds, it is
    // refreshed by the same pass that changes what it divides by.
    mealsPerHead: mealsPerHead(stock, MEAL_WEIGHTS, workerSnaps.length),
    demographics: {
      children: workerSnaps.filter((c) => c.stage === 'child').length,
      adults: workerSnaps.filter((c) => c.stage === 'adult').length,
      elders: workerSnaps.filter((c) => c.stage === 'elder').length,
    },
  };
}

/**
 * THE component -> facts conversion for a live world, one function per entity
 * kind. Both live-world readers go through these: SnapshotSystem's ECS queries
 * (component instances destructured from the query) and gatherEntityFacts's
 * getEntities() walk (the same instances via getComponent). A new worker or
 * building field is therefore ONE edit here plus its Facts interface, instead of
 * drifting between access paths (increment-1 review: 3-site edit risk).
 *
 * Save records are NOT convertible here — buildInitialSnapshot runs before any
 * entity exists and maps SavedColonist/SavedBuilding instead.
 */
export function colonistFactsOf(
  worker: Colonist, hunger: Hunger, job: JobAssignment, efficiency: Efficiency, coverage: ToolCoverage, trip: HaulTrip, age: Age,
  home: Home,
): ColonistFacts {
  return {
    id: worker.id,
    hunger: hunger.value,
    starvingTicks: hunger.starvingTicks,
    efficiency: efficiency.value,
    buildingId: job.buildingId,
    hauling: job.hauling,
    ageTicks: age.ticks,
    stage: stageOf(age.ticks, BALANCE.lifeBands),
    homeId: home.buildingId,
    // Published on BOTH legs now: the layout interpolates the dot along the
    // camp<->building line, so a returning hauler still needs to know which
    // building it is walking back from (OBS-4-09). `trip.targetId` survives the
    // phase flip and is cleared only by trip.reset().
    haulTargetId: trip.targetId,
    haulPhase: trip.phase,
    haulTicksLeft: trip.ticksLeft,
    // The leg total and the return leg's origin, frozen by HaulTrip when the
    // leg began — published so the layout reads them instead of recomputing
    // from the building's live tile, which desyncs once the building moves
    // mid-leg (OBS-5-01).
    haulLegTicks: trip.legTicks,
    haulPickupCol: trip.pickupCol,
    haulPickupRow: trip.pickupRow,
    carrying: trip.amount,
    carryingResource: trip.resource,
    toolTicks: coverage.remainingTicks,
  };
}

export function buildingFactsOf(
  building: Building, slots: WorkerSlots, production: Production, position: Position, buffer: OutputBuffer, relocation: Relocation,
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
    relocatingTicks: relocation.ticksLeft,
  };
}

/**
 * Facts -> save records. SavedColonist is deliberately a SUBSET of ColonistFacts:
 * `efficiency` is recomputed from hunger every tick by EfficiencySystem, so
 * storing it would be a second source of truth. That subsetting is why this
 * cannot be derived automatically — but keeping it here, beside colonistFactsOf,
 * means the persist decision for a new fact is one obvious edit rather than a
 * whitelist buried inside the serializer.
 */
export function savedColonistOf(facts: ColonistFacts): SavedColonist {
  return {
    id: facts.id, hunger: facts.hunger, buildingId: facts.buildingId,
    toolTicks: facts.toolTicks, hauling: facts.hauling,
    // A decision, not a derivation: rehome picks a bed once and the colonist
    // keeps it until something evicts them. Dropping it here would restore
    // every colony wholly homeless — at homelessFactor work power, on a
    // PAUSED engine, until the player unpauses and the first homing pass
    // reshuffles everyone into different houses than they went to sleep in.
    homeId: facts.homeId,
    // Unlike efficiency/stage, ageTicks is NOT recomputed from anything else —
    // it is the source PopulationSystem ages and stage is derived from, so
    // dropping it here would reset every colonist to the default starting age
    // on every save/reload, silently undoing however much of a lifespan it
    // had already lived.
    ageTicks: facts.ageTicks,
    // Same reasoning as ageTicks: starvingTicks is a penalty already incurred
    // (HungerSystem is its only writer), not recomputable from anything else,
    // so dropping it here would let save-and-reload cancel a starvation in
    // progress — exactly what relocatingTicks (increment 5 §2.4) exists to
    // prevent for a moved building.
    starvingTicks: facts.starvingTicks,
  };
}

export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return {
    id: facts.id, defId: facts.defId, col: facts.col, row: facts.row,
    progress: facts.progress, batchActive: facts.batchActive, buffer: facts.buffer,
    relocatingTicks: facts.relocatingTicks,
  };
}

export interface EntityFacts {
  workers: ColonistFacts[];
  buildings: BuildingFacts[];
}

/**
 * The getEntities() walk, shared by the post-step snapshot refresh and save
 * serialization. Built on the mappers above, so it can never disagree with
 * SnapshotSystem about what a worker or building is.
 */
export function gatherEntityFacts(world: IRuntimeWorld): EntityFacts {
  const workers: ColonistFacts[] = [];
  const buildings: BuildingFacts[] = [];
  for (const entity of world.getEntities()) {
    const building = entity.getComponent(Building);
    if (building) {
      buildings.push(buildingFactsOf(
        building,
        entity.getComponent(WorkerSlots)!,
        entity.getComponent(Production)!,
        entity.getComponent(Position)!,
        entity.getComponent(OutputBuffer)!,
        entity.getComponent(Relocation)!,
      ));
      continue;
    }
    const worker = entity.getComponent(Colonist);
    if (worker) {
      workers.push(colonistFactsOf(
        worker,
        entity.getComponent(Hunger)!,
        entity.getComponent(JobAssignment)!,
        entity.getComponent(Efficiency)!,
        entity.getComponent(ToolCoverage)!,
        entity.getComponent(HaulTrip)!,
        entity.getComponent(Age)!,
        entity.getComponent(Home)!,
      ));
    }
  }
  return { workers, buildings };
}
