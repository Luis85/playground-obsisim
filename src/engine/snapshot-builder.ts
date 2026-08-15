import type { IRuntimeWorld } from 'sim-ecs';
import type { ResourceId } from '../shared/content-types';
import type { SavedColonist } from '../shared/save';
import type { BuildingSnapshot, ColonistSnapshot } from '../shared/snapshot';
import { isUnderConstruction, relocatingIdsOf, type TileRef } from '../shared/placement';
import { CAMP_TILE } from '../shared/haul';
import { commuteFactor, mealsPerHead, stageOf } from '../shared/population';
import { BALANCE, workerWorkPower } from './content/balance';
import { MEAL_WEIGHTS } from './content/resources';
import {
  Age, Building, Construction, Efficiency, HaulTrip, Home, Hunger, InputBuffer, JobAssignment, OutputBuffer, Position, Production,
  Relocation, ToolCoverage, Colonist, WorkerSlots,
} from './components';
import type { BuildingFacts } from './snapshot-buildings';
import { buildingFactsOf, buildingSnapshotsOf } from './snapshot-buildings';
import { Stockpile } from './resources';

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
 * the third needs the second — it is `workerWorkPower` applied to
 * `commuteFactor` (OBS-6-06) — plus a third entity's state again, since a
 * workplace mid-relocation banks nothing (see deliveredWorkPowerOf). So
 * buildEntitySections computes all three below, where home, workplace, the
 * factor between them and the workplace's downtime are already in hand.
 */
export interface ColonistFacts extends Omit<ColonistSnapshot, 'commuteTiles' | 'commuteFactor' | 'deliveredWorkPower'> {
  carryingResource: ResourceId | null;
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
 * The published ColonistSnapshot.deliveredWorkPower — and, because the
 * aggregation below sums exactly this, every term of BuildingSnapshot.workPower
 * too. One function for both, so the per-colonist column in the Population view
 * and the per-building column in the Buildings view cannot report different
 * answers to the same question.
 *
 * Null for anyone with no buildingId. `buildingId === null` is the exact guard
 * the aggregation loop below already uses to decide who feeds `powerByBuilding`,
 * and the one `sumWorkPower` (ProductionSystem) uses too — a hauler's
 * `buildingId` is null by construction (JobAssignment never sets both), and
 * their throughput is carried capacity, not work power (see `sumWorkPower`'s own
 * doc comment), so null is correct for them, not merely unset.
 *
 * ZERO — not null — when the workplace is relocating. ProductionSystem
 * `continue`s past a relocating building before it ever looks work power up, so
 * that crew banks nothing at all while the move runs. They ARE assigned and work
 * power IS the right unit for them; the number is measured, and it is zero. Null
 * would say "does not apply here" (the hauler reading), hiding the very stall
 * this column exists to explain — the same shape of mistake OBS-6-06 was raised
 * for, where the homeless row printed a word while every other row printed a
 * number, and so read as "not applicable" rather than "worst possible".
 */
function deliveredWorkPowerOf(w: ColonistFacts, factor: number, relocatingIds: ReadonlySet<number>): number | null {
  if (w.buildingId === null) return null;
  if (relocatingIds.has(w.buildingId)) return 0;
  return workerWorkPower(w.efficiency, w.toolTicks, factor);
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
  // Measured ONCE per colonist for the same reason tilesById is, and one step
  // stronger: the building total below is literally the sum of these published
  // per-colonist figures, not a parallel computation that happens to agree, so
  // the two columns cannot drift apart even in principle. (The two used to be
  // separate `workerWorkPower` calls with identical inputs — correct, but only
  // by inspection.) Mirrors ProductionSystem's own commute read, both going
  // through commuteTiles above, so neither disagrees with the power the
  // simulation actually spent.
  // `relocatingIdsOf`, the same derivation ProductionSystem's own skip reads
  // (OBS-6-08) — one boundary rather than two independently-maintained tests of
  // the same fact.
  //
  // THE BOUNDARY, and this project has already spent two rounds on this exact
  // one (task 6's `> 0` vs `> 1`): the `relocatingTicks` reaching this module is
  // the POST-decrement value. ProductionSystem skips the building and decrements
  // in the same arm, and the snapshot is published afterwards. So a published
  // `> 0` means "the next production pass will skip this building" — which is
  // precisely the forward-looking quantity `BuildingSnapshot.relocatingTicks` is
  // already documented as ("ticks until a moved building can work again"), and
  // precisely the boundary `buildingState` and `beds.total` in this same file
  // already draw.
  //
  // Read BACKWARDS it overstates by exactly one tick: on the landing tick this
  // returns full power for a tick whose work was genuinely skipped — the tick
  // production-system.ts's own comment names as "the one genuinely-charged tick
  // nothing ever displays as in-flight", where `state` reads 'producing' and the
  // Buildings view's Downtime column reads '—' for the same reason. That is
  // accepted rather than special-cased: the pre-decrement value is not in the
  // snapshot at all, and `buildEntitySections` also serves the save seed and the
  // post-step refresh, neither of which has a "this tick" to ask about. Putting
  // work power alone on some other boundary would leave it the only figure on
  // screen disagreeing with the other three about whether the building is moving.
  const relocatingIds = relocatingIdsOf(buildings);
  const deliveredById = new Map(workers.map((w): [number, number | null] => [
    w.id, deliveredWorkPowerOf(w, factorOf(w.id), relocatingIds),
  ]));
  // Read ONLY by `beds.total` below: `BuildingSnapshot.state` cannot carry
  // this boundary the way it carries `relocating` (a house or storehouse site
  // reports `housing`/`storing` exactly like a finished one — see
  // `buildingState` in snapshot-buildings.ts), so the published state alone
  // cannot tell a bed-bearing site apart from a bed-bearing finished house.
  // `constructionTicks` — optional exactly where `relocatingTicks` above is
  // not, since `SnapshotSystem`'s own live query does not carry `Construction`
  // (this function's OTHER caller, the post-step refresh, always does) —
  // defaults to 0 (finished) wherever it is absent, the same reading an
  // omitted field gets everywhere else in this file.
  const underConstructionIds = new Set(
    buildings.filter((b) => isUnderConstruction(b.constructionTicks ?? 0)).map((b) => b.id),
  );

  for (const w of workers) {
    if (w.buildingId === null) continue;
    const tooled = w.toolTicks > 0;
    staffCount.set(w.buildingId, (staffCount.get(w.buildingId) ?? 0) + 1);
    powerByBuilding.set(w.buildingId, (powerByBuilding.get(w.buildingId) ?? 0) + (deliveredById.get(w.id) ?? 0));
    if (tooled) tooledByBuilding.set(w.buildingId, (tooledByBuilding.get(w.buildingId) ?? 0) + 1);
  }

  const workerSnaps: ColonistSnapshot[] = workers
    .map((w) => {
      const factor = factorOf(w.id);
      return {
        id: w.id, hunger: w.hunger, starvingTicks: w.starvingTicks, efficiency: w.efficiency, buildingId: w.buildingId,
        hauling: w.hauling, haulTargetId: w.haulTargetId, haulPhase: w.haulPhase, haulTicksLeft: w.haulTicksLeft,
        haulKind: w.haulKind, haulPickedUp: w.haulPickedUp, haulLegTicks: w.haulLegTicks,
        haulLegFromCol: w.haulLegFromCol, haulLegFromRow: w.haulLegFromRow,
        haulLegToCol: w.haulLegToCol, haulLegToRow: w.haulLegToRow,
        haulAtCol: w.haulAtCol, haulAtRow: w.haulAtRow,
        carrying: w.carrying, toolTicks: w.toolTicks, ageTicks: w.ageTicks, stage: w.stage, homeId: w.homeId,
        // Null tiles are the homeless case: there is no distance to report, and
        // the whole charge lands in the factor instead.
        commuteTiles: tilesById.get(w.id) ?? 0, commuteFactor: factor,
        deliveredWorkPower: deliveredById.get(w.id) ?? null,
      };
    })
    .sort((a, b) => a.id - b.id);

  // Occupancy read from who points at a house, never counted on the building
  // itself — see Home's own doc comment on why that pair must never disagree.
  const occupantsByHouse = new Map<number, number>();
  for (const c of workerSnaps) {
    if (c.homeId !== null) occupantsByHouse.set(c.homeId, (occupantsByHouse.get(c.homeId) ?? 0) + 1);
  }

  const buildingSnaps: BuildingSnapshot[] = buildingSnapshotsOf(buildings, {
    staffed: staffCount, tooled: tooledByBuilding, power: powerByBuilding, occupants: occupantsByHouse,
  });

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
      // gates already exclude them — and so, since spec §2.5, is a house that
      // is still a construction site: homing and both gates refuse those too
      // (population-handlers.ts's `unavailable`). Counting either one's beds
      // here would let the Population view read spare capacity while the
      // engine refuses a nomad for want of a bed — the display contradicting
      // the rule it exists to explain. `total` therefore means beds you can
      // actually sleep in tonight, which is the only number a player can act
      // on.
      total: buildingSnaps
        .filter((b) => b.state !== 'relocating' && !underConstructionIds.has(b.id))
        .reduce((sum, b) => sum + b.beds, 0),
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
    // phase flip and is cleared only when the trip ends.
    haulTargetId: trip.targetId,
    haulPhase: trip.phase,
    haulTicksLeft: trip.ticksLeft,
    // Null when there is no trip to have a job on. `trip.kind` keeps its last
    // value through `clearTrip` (it resets to the 'collect' default), so
    // reading it unguarded would label every idle hauler a collector.
    haulKind: trip.phase === 'idle' ? null : trip.kind,
    // The cargo's ORIGIN, which is what a direction marker must read — see
    // ColonistSnapshot.haulPickedUp on why `haulKind` draws the round trip
    // backwards.
    haulPickedUp: trip.pickedUp,
    // The leg total and BOTH its frozen endpoints, published so the layout
    // reads them instead of recomputing from a building's live tile, which
    // desyncs once that building moves mid-leg (OBS-5-01). Both ends, not one:
    // neither end of a depot-to-building leg is the camp, so a lone endpoint
    // plus a hardcoded anchor cannot describe one.
    haulLegTicks: trip.legTicks,
    haulLegFromCol: trip.legFromCol,
    haulLegFromRow: trip.legFromRow,
    haulLegToCol: trip.legToCol,
    haulLegToRow: trip.legToRow,
    // Where a hauler with no leg running stands. Straight off the trip: `cancel`
    // is the only writer, and it interpolates along the leg it is ending, so the
    // resting tile the app draws is the one the sim priced the next leg from.
    haulAtCol: trip.atCol,
    haulAtRow: trip.atRow,
    carrying: trip.amount,
    carryingResource: trip.resource,
    toolTicks: coverage.remainingTicks,
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
  const stockpile = world.getResource(Stockpile);
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
        entity.getComponent(InputBuffer)!,
        stockpile.siteJSON(building.id),
        entity.getComponent(Construction)!,
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
