import { createSystem, ReadResource } from 'sim-ecs';
import type { IPreptimeWorld } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { SaveGameV5 } from '../../src/shared/save';
import { haulTicks } from '../../src/shared/haul';
import { autoPlacePosition, type TileRef, type WorldMapSize } from '../../src/shared/placement';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS } from '../../src/engine/content/buildings';
import { Building } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import {
  ALL_SYSTEMS, applyRemovals, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
  type TColonySystemFactory,
} from '../../src/engine/world';
import { StatsSystem } from '../../src/engine/systems/stats-system';
import { campAdjacentFreeTile, enqueue } from '../engine/fixtures';

/**
 * A balance experiment, reproducible from this descriptor alone: one building
 * at one tile, a fixed crew and hauler count, run for a fixed number of ticks.
 *
 * The instrument exists because increment 4 documented three constants as
 * "starting points, tuned in increment 5" and nothing could check the claim —
 * the engine is headless and deterministic, but nothing ran it as an
 * experiment. See docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md.
 */
export interface Scenario {
  defId: BuildingDefId;
  col: number;
  row: number;
  crew: number;
  haulers: number;
  ticks: number;
  /** The output resource to measure. */
  resource: ResourceId;
  /** Optionally relocate the building mid-run, to measure what downtime costs. */
  moveTo?: { col: number; row: number; atTick: number };
  /**
   * House the crew beside their building and the haulers beside the camp, so
   * commute is held at its neutral value (1.0, inside BALANCE.commute
   * .freeTiles) and this instrument keeps measuring logistics rather than
   * housing. Same principle as the FED berry stock holding hunger neutral.
   *
   * Defaults to `true`: housed and commute-neutral, preserving increment 5's
   * numbers exactly. Deliberately NOT keyed off `moveTo` — housing uniformity
   * is a property of the COMPARISON a scenario is measured against, not of
   * any single scenario, and no per-scenario default can supply that. A
   * relocation comparison's stationary controls (`from`/`to`) carry no
   * `moveTo` of their own, so a default keyed on "does THIS scenario have a
   * moveTo" silently houses the controls while leaving only the mover
   * unhoused — manufacturing, by construction, exactly the confound this
   * field exists to rule out: `moved.made < from.made` would then compare a
   * homeless run against two housed ones, and would stay green even if
   * relocation downtime stopped costing production entirely, because most of
   * the gap would be the homelessFactor penalty rather than the downtime.
   *
   * So a relocation comparison must pass `houseCrew: false` explicitly to
   * EVERY call it makes (see `relocating` in balance.test.ts) — uniformity is
   * the caller's job, because only the caller knows which runs belong to the
   * same comparison. Uniform-UNhoused, not uniform-housed: a moveTo scenario
   * houses its crew beside the building's STARTING tile, and increment 5's
   * relocation case moves from (10,0) to (3,7), ~9.9 tiles apart — there is
   * no tile inside BALANCE.commute.freeTiles of both endpoints, so after the
   * move the crew would carry a large commute penalty neither stationary
   * control pays, the same confound in the other direction. Unhoused,
   * `commuteFactor` returns the flat `homelessFactor` regardless of tile (see
   * production-system.ts), so all three runs in the comparison pay the exact
   * same penalty and the only variable left is the downtime — neutrality of
   * the COMPARISON, which is what a control needs, rather than neutrality of
   * the absolute number.
   */
  houseCrew?: boolean;
  /**
   * Put the crew's house at THIS tile instead of beside their building — the
   * only way to vary commute while holding everything else fixed, which is
   * what a "a distant house costs delivered goods" measurement needs. Task 12
   * depends on `runScenario` actually reading it; a `Scenario` field the
   * runner ignores makes the near and far worlds identical, so the test can
   * never fail and proves nothing.
   */
  crewHouseAt?: TileRef;
}

export interface BalanceResult {
  /**
   * Gross production: units that reached the store, plus units still sitting
   * in the building's buffer, plus units in a hauler's hands. A unit a hauler
   * has picked up but not yet deposited has left the buffer and not arrived
   * at the store, so it must be counted separately from both.
   */
  made: number;
  /**
   * Cumulative hauler inflow — the running sum of every deposit HaulSystem
   * banked into the stockpile, NOT the stockpile's net change over the run.
   * Net change also nets out whatever any consumer (HungerSystem, chiefly)
   * took from the same resource, which understates delivery for any measured
   * resource that is also eaten, and can go negative with no haulers keeping
   * up. A gatherer's hut measuring berries — its own output — is exactly that
   * case: crew hunger eats the same resource the hut makes.
   */
  delivered: number;
  /** Ticks the building spent in `outputFull`. */
  stalledTicks: number;
  /** Ticks the building spent out of action after a move. */
  relocatingTicks: number;
  /** Hauler-ticks spent at the camp with no trip (over-provisioning). */
  haulerIdleTicks: number;
  /** Units still waiting at the building when the run ended. */
  finalBuffer: number;
  /** One-way trip length in ticks from the scenario's STARTING tile, for reference. */
  legTicks: number;
  /**
   * Units the crew could produce with hauling never a constraint, assuming
   * baseline work power of 1 per fed, untooled crew member. A `workshop`
   * scenario breaks that assumption: recipe inputs are seeded, so it can
   * produce and deliver its own `tools`, which EfficiencySystem then spends
   * to grant its own crew the 1.5x tool multiplier — work power this figure
   * never counted. For that one case, `ceiling` is a lower bound, not a
   * ceiling.
   */
  ceiling: number;
}

/**
 * Stock level for every seeded resource (see SEEDED_RESOURCE_IDS): large
 * enough that neither hunger nor a recipe's input can ever run it dry over
 * any scenario this harness runs.
 */
const FED = 1_000_000;

/**
 * Resources this instrument seeds at FED: `berries`, so HungerSystem never
 * starves the crew, plus every resource that is a recipe INPUT somewhere in
 * the catalog (today wheat, flour, wood, and planks — mill, bakery, sawmill,
 * and workshop, respectively) so ProductionSystem can always pay a batch's
 * cost. A scenario against any of those four used to silently report zero
 * production against a positive `ceiling`, for want of a raw material this
 * instrument never supplied. Derived from BUILDINGS rather than hand-listed,
 * so a future recipe change cannot drift out of sync with what actually needs
 * seeding.
 *
 * Deliberately NOT every `ResourceId`. `tools` is one but is never a recipe
 * input — EfficiencySystem spends it on an unrelated mechanic, granting
 * `BALANCE.toolMultiplier` (1.5x) work power while a worker stays tooled,
 * gated only on stock being available. Seeding it was tried and measured:
 * the (10,0) forester regression scenario jumped from 128 to 195 delivered,
 * because every worker is permanently tooled instead of never tooled, which
 * is what an unmodified run gets today — a real change to an existing
 * measurement, not just a generalisation of the instrument. `bread` is the
 * other non-input `ResourceId`; seeding it measured harmless (hunger never
 * crosses `colonistEfficiency`'s threshold under either meal choice — see
 * BALANCE.mealThreshold), but it stays out on the same principle: it is not
 * a recipe input, so seeding it is not this fix's job.
 */
const SEEDED_RESOURCE_IDS: readonly ResourceId[] = [
  ...new Set<ResourceId>([
    'berries',
    ...Object.values(BUILDINGS).flatMap((def) => Object.keys(def.recipe?.inputs ?? {}) as ResourceId[]),
  ]),
];

/**
 * A harness-only stage, spliced into the pipeline immediately before
 * StatsSystem — the only point at which `Stockpile.producedThisTick` still
 * holds this tick's hauler deliveries. StatsSystem's own `resetTickFlows()`
 * clears that map before `world.step()` returns control to the tick loop
 * below (`tests/engine/systems/stats-system.test.ts` asserts
 * `producedThisTick.size` is 0 right after a step), so summing it from
 * outside `step()` would always see an empty map. Every system from
 * ALL_SYSTEMS keeps its place and relative order; this only adds an
 * observer — the same technique `stats-system.test.ts`'s DepositWoodSystem
 * uses for test-only wiring, applied here without displacing anything real.
 */
function captureDeliveredSystem(resource: ResourceId, onDeliver: (amount: number) => void): TColonySystemFactory {
  return () => createSystem({ stockpile: ReadResource(Stockpile) })
    .withName('CaptureDelivered')
    .withRunFunction(({ stockpile }) => {
      onDeliver(stockpile.producedThisTick.get(resource) ?? 0);
    })
    .build();
}

/**
 * A buildable tile adjacent to `col` — where the crew house goes. Adjacency is
 * the point: it lands inside BALANCE.commute.freeTiles, so commuteFactor is
 * exactly 1 and every increment-5 measurement is preserved by construction
 * rather than by luck.
 */
function adjacentCol(map: WorldMapSize, col: number): number {
  return col + 1 < map.cols ? col + 1 : col - 1;
}

/**
 * Enough real shelter for `group` colonists. The FIRST house lands on
 * `preferred` — a tile the caller chose to be inside BALANCE.commute.freeTiles
 * of wherever that group works, so their commuteFactor is exactly 1 and this
 * instrument keeps measuring logistics rather than housing. Any overflow house
 * falls back to autoPlacePosition, which is arbitrary and therefore NOT
 * commute-neutral; runScenario refuses a group that would need one.
 *
 * `occupied` is mutated as each house is placed, so a second house never lands
 * on the first — and so the caller's next call (the haulers' house) can see
 * this one. spawnBuilding writes tiles directly without consulting
 * isTileBuildable, so nothing else would catch a stack.
 *
 * A real house, not a sentinel homeId reusing the measured building's own
 * id: this harness runs ALL_SYSTEMS, so PopulationSystem's rehome executes
 * every tick and evicts any Home pointing at a building that isn't an actual
 * shelter (rehome's `shelter === undefined` branch) — a fake homeId would be
 * evicted on tick 1, leaving the group homeless (and at half work power or
 * half carry capacity) for the rest of the run, and silently invalidating
 * every threshold this instrument is calibrated against.
 *
 * Split out of runScenario purely to keep its own cognitive complexity under
 * the gate — same principle as population-handlers.ts's rehome splitting
 * into freeBeds/settleExistingHome/claimOpening.
 */
function spawnShelters(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, group: number, occupied: TileRef[], preferred: TileRef,
): number[] {
  const homeIds: number[] = [];
  while (homeIds.length * BALANCE.houseBeds < group) {
    const at = homeIds.length === 0 ? preferred : autoPlacePosition(map, occupied);
    if (at === null) throw new Error('balance harness: no free tile left for a shelter house');
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
    homeIds.push(house.getComponent(Building)!.id);
    occupied.push(at);
  }
  return homeIds;
}

/**
 * Where each colonist of a group sleeps: houses fill in order, houseBeds
 * apiece, and an unhoused group (relocation scenarios) reports null for
 * everyone. Named so the two spawn loops below read the same way.
 */
function homeOf(homeIds: readonly number[], index: number): number | null {
  return homeIds[Math.floor(index / BALANCE.houseBeds)] ?? null;
}

/**
 * Where each group sleeps: a commute-neutral house apiece, or nowhere for a
 * relocation scenario. Empty lists mean an unhoused group, which `homeOf`
 * turns into a null home for everyone in it.
 *
 * Separate from `populateColony` below because these are two questions, not
 * one — where the houses go, and who gets spawned into them — and folding
 * them together put the pair over the CRAP gate at cyclomatic 10. Every
 * branch in this harness lives on this side of the split; the spawning side
 * has none.
 */
function shelterPlan(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, scenario: Scenario,
): { crew: number[]; haulers: number[] } {
  const { col, row, crew, haulers, moveTo } = scenario;
  // Commute-neutral by default — see Scenario.houseCrew for why this cannot
  // be keyed off moveTo: uniformity is a property of the comparison the
  // caller is building, not of this one scenario, so the caller (not this
  // default) must pass houseCrew explicitly to every run in a comparison
  // that needs uniform housing.
  const housed = scenario.houseCrew ?? true;
  if (!housed) return { crew: [], haulers: [] };
  // One house holds BALANCE.houseBeds and the largest group this instrument
  // runs is 4, so a single commute-neutral house per group suffices. Asserted
  // rather than assumed: spawnShelters places any overflow house with
  // autoPlacePosition, i.e. outside the free radius, and that group would then
  // quietly start paying a commute that moves every measurement here.
  if (Math.max(crew, haulers) > BALANCE.houseBeds) {
    throw new Error('balance harness: a group needs more beds than one house provides — place a second commute-neutral house before measuring');
  }
  // Avoids the measured building's own tile and the move destination (if
  // any) — see spawnShelters for why these groups need REAL houses rather
  // than a sentinel homeId.
  const occupied: TileRef[] = [{ col, row }];
  if (moveTo) occupied.push({ col: moveTo.col, row: moveTo.row });
  // crewHouseAt wins when given; otherwise beside the building, which lands
  // inside BALANCE.commute.freeTiles and scores exactly 1.0. The haulers'
  // house is resolved AFTER the crew's is placed, so campAdjacentFreeTile sees
  // it in `occupied` and cannot stack on it.
  const crewTile = scenario.crewHouseAt ?? { col: adjacentCol(map, col), row };
  return {
    crew: spawnShelters(prep, ids, map, crew, occupied, crewTile),
    haulers: spawnShelters(prep, ids, map, haulers, occupied, campAdjacentFreeTile(occupied)),
  };
}

/**
 * The colony this measurement runs on: the crew at their building, the
 * haulers at the camp, each in the home `shelterPlan` assigned them.
 *
 * Split out of `runScenario` for the reason `spawnShelters` was split out of
 * it in the previous task: housing is the third concern that function had
 * accumulated (world setup, population, then the 600-tick measurement loop).
 * Same remedy as `rehome` splitting into freeBeds/settleExistingHome/
 * claimOpening — extract the named thing, leave the baseline alone.
 */
function populateColony(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, scenario: Scenario, buildingId: number,
): void {
  const homes = shelterPlan(prep, ids, map, scenario);
  for (let i = 0; i < scenario.crew; i++) {
    spawnColonist(prep, ids, { buildingId, homeId: homeOf(homes.crew, i) });
  }
  for (let i = 0; i < scenario.haulers; i++) {
    spawnColonist(prep, ids, { hauling: true, homeId: homeOf(homes.haulers, i) });
  }
}

export async function runScenario(scenario: Scenario): Promise<BalanceResult> {
  // `haulers` is not destructured here: populateColony owns every use of it.
  const { defId, col, row, crew, ticks, resource, moveTo } = scenario;
  const seededStockpile = Object.fromEntries(SEEDED_RESOURCE_IDS.map((id): [ResourceId, number] => [id, FED]));
  const save: SaveGameV5 = {
    ...initialSave(),
    // Both, and for different reasons. `colonists` because v5 renamed the
    // roster key — clearing `workers` would leave the real array untouched.
    // `buildings` because initialSave() now ships a starter house, whose id
    // (1, which `nextEntityId: 1` would mint again) and tile (the first plot,
    // which campAdjacentFreeTile does not know to avoid) would both collide
    // with what this harness places below. Either collision corrupts the
    // distance and relocation sweeps silently.
    colonists: [],
    buildings: [],
    stockpile: seededStockpile as Partial<Record<ResourceId, number>>,
    nextEntityId: 1,
  };

  let delivered = 0;
  // ALL_SYSTEMS with one observer stage spliced in — see captureDeliveredSystem.
  const statsIndex = ALL_SYSTEMS.indexOf(StatsSystem);
  const systems: TColonySystemFactory[] = [
    ...ALL_SYSTEMS.slice(0, statsIndex),
    captureDeliveredSystem(resource, (amount) => { delivered += amount; }),
    ...ALL_SYSTEMS.slice(statsIndex),
  ];
  const prep = buildColonyPrepWorld({ save, systems });
  const ids = getPrepResource(prep, IdCounter);
  const entity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false, col, row, relocatingTicks: 0 });
  const buildingId = entity.getComponent(Building)!.id;
  populateColony(prep, ids, save.map, scenario, buildingId);
  const world = await prep.prepareRun();

  let stalledTicks = 0;
  let relocatingTicks = 0;
  let haulerIdleTicks = 0;
  // Whether the PREVIOUS tick ended with the countdown still running — see the
  // downtime comment below for why this, not the snapshot's `relocating`
  // state, is what counting downtime requires.
  let wasRelocating = false;

  for (let t = 0; t < ticks; t++) {
    // Mirrors the PRE-step retry both sanctioned drivers now perform
    // (GameEngine.runStep, stepTick): anything a previous tick's detach threw
    // on and re-queued must be gone before this tick's systems read the world,
    // or PopulationSystem can rehome someone into a shelter that is already
    // doomed. A bare `applyRemovals` touches no snapshot — unlike `stepTick`,
    // which also refreshes entity sections and would re-time every reading
    // this loop takes — so this is a measured no-op today (see the drain
    // below: nothing this harness runs ever queues a removal) kept for
    // symmetry with the post-step drain, not a fix for an observed defect.
    applyRemovals(world);
    world.getResource(SimClock).tick++;
    const issuingMove = moveTo !== undefined && t === moveTo.atTick;
    if (issuingMove) {
      enqueue(world, { type: 'moveBuilding', buildingId, to: { col: moveTo!.col, row: moveTo!.row } });
    }
    await world.step();
    // Deaths and demolitions go onto RemovalLedger and come off it here and
    // nowhere else (OBS-6-02). No scenario this harness runs today queues one —
    // measured, not assumed: a drain-and-count probe over all 15 balance cases
    // and all 4 harness cases reported zero, the longest run being 600 ticks
    // against a ~5,300-tick lifespan with hunger held neutral by the FED stock.
    // The drain is here so that stays a fact about the FIXTURES rather than a
    // silent property of the loop: a scenario that outlives a founder, or one
    // that ever issues `demolishBuilding`, would otherwise measure a colony in
    // which nobody can die and nothing can be torn down.
    //
    // Deliberately the drain ALONE, not `stepTick`. stepTick also calls
    // `refreshEntitySections`, which rebuilds the snapshot's `colonists` and
    // `buildings` from post-step entity state — and this loop reads exactly
    // those sections (`state`, `relocatingTicks`, `haulPhase`) as its
    // measurements. Refreshing would re-time every reading in the increment-5
    // sweep against a mid-tick baseline it was calibrated on. Same reasoning as
    // command-system.test.ts's `ticker`: the drain is the one post-step step an
    // instrumented driver cannot do without.
    applyRemovals(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    const building = snapshot.buildings.find((b) => b.id === buildingId);
    if (building?.state === 'outputFull') stalledTicks++;
    // Downtime is ticks the building could not WORK, which is not the same as
    // snapshots reporting `relocating`: ProductionSystem skips work and then
    // decrements, so the tick that lands the move and the tick the countdown
    // reaches zero are both worked-through-zero — the first is not yet in a
    // snapshot, the last already reads 0. Counting the skip itself makes this
    // match `relocationTicks()` exactly, including a 1-tick nudge.
    if (issuingMove || wasRelocating) relocatingTicks++;
    wasRelocating = (building?.relocatingTicks ?? 0) > 0;
    haulerIdleTicks += snapshot.colonists.filter((w) => w.hauling && w.haulPhase === 'idle').length;
  }

  const snapshot = world.getResource(SnapshotStore).latest!;
  const finalBuffer = snapshot.buildings.find((b) => b.id === buildingId)?.buffered ?? 0;
  const inTransit = snapshot.colonists.reduce((sum, w) => sum + w.carrying, 0);
  // Gross production, derived rather than sampled: madeRate is a rolling mean
  // over statsWindowTicks and would understate a short run. Everything made
  // either reached the store, is still in the buffer, or is in a hauler's
  // hands — a unit a hauler has picked up but not yet deposited has left the
  // buffer and not arrived at the store, so omitting it under-reports every
  // run that ends mid-trip.
  const made = delivered + finalBuffer + inTransit;

  const recipe = BUILDINGS[defId].recipe;
  if (recipe === null) throw new Error(`Scenario building ${defId} has no recipe to measure`);
  const perBatch = Object.values(recipe.outputs).reduce((sum, n) => sum + n, 0);
  return {
    made,
    delivered,
    stalledTicks,
    relocatingTicks,
    haulerIdleTicks,
    finalBuffer,
    legTicks: haulTicks(col, row, BALANCE.haulTilesPerTick),
    ceiling: (ticks * crew * perBatch) / recipe.ticksPerBatch,
  };
}
