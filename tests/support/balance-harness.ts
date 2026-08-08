import { createSystem, ReadResource } from 'sim-ecs';
import type { IPreptimeWorld } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { SaveGameV4 } from '../../src/shared/save';
import { haulTicks } from '../../src/shared/haul';
import { autoPlacePosition, type TileRef, type WorldMapSize } from '../../src/shared/placement';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS } from '../../src/engine/content/buildings';
import { Building } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist, type TColonySystemFactory,
} from '../../src/engine/world';
import { StatsSystem } from '../../src/engine/systems/stats-system';
import { enqueue } from '../engine/fixtures';

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
 * Enough real shelter to house `crew`, placed by autoPlacePosition so this
 * instrument never collides with a scenario's own tiles. `occupied` is
 * mutated as each house is placed, so a second (or third) house never lands
 * on the first.
 *
 * A real house, not a sentinel homeId reusing the measured building's own
 * id: this harness runs ALL_SYSTEMS, so PopulationSystem's rehome executes
 * every tick and evicts any Home pointing at a building that isn't an actual
 * shelter (rehome's `shelter === undefined` branch) — a fake homeId would be
 * evicted on tick 1, leaving the crew homeless (and at half work power, via
 * Task 6's placementFactor) for the rest of the run, and silently
 * invalidating every threshold this instrument is calibrated against.
 *
 * Split out of runScenario purely to keep its own cognitive complexity under
 * the gate — same principle as population-handlers.ts's rehome splitting
 * into freeBeds/settleExistingHome/claimOpening.
 */
function spawnShelters(prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, crew: number, occupied: TileRef[]): number[] {
  const homeIds: number[] = [];
  while (homeIds.length * BALANCE.houseBeds < crew) {
    const at = autoPlacePosition(map, occupied);
    if (at === null) throw new Error('balance harness: no free tile left for a shelter house');
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
    homeIds.push(house.getComponent(Building)!.id);
    occupied.push(at);
  }
  return homeIds;
}

export async function runScenario(scenario: Scenario): Promise<BalanceResult> {
  const { defId, col, row, crew, haulers, ticks, resource, moveTo } = scenario;
  const seededStockpile = Object.fromEntries(SEEDED_RESOURCE_IDS.map((id): [ResourceId, number] => [id, FED]));
  const save: SaveGameV4 = {
    ...initialSave(),
    workers: [],
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
  // Avoids the measured building's own tile and the move destination (if
  // any) — see spawnShelters for why this crew needs a REAL house rather
  // than a sentinel homeId.
  const occupiedForHousing: TileRef[] = [{ col, row }];
  if (moveTo) occupiedForHousing.push({ col: moveTo.col, row: moveTo.row });
  const homeIds = spawnShelters(prep, ids, save.map, crew, occupiedForHousing);
  for (let i = 0; i < crew; i++) {
    spawnColonist(prep, ids, { buildingId, homeId: homeIds[Math.floor(i / BALANCE.houseBeds)] });
  }
  for (let i = 0; i < haulers; i++) spawnColonist(prep, ids, { hauling: true });
  const world = await prep.prepareRun();

  let stalledTicks = 0;
  let relocatingTicks = 0;
  let haulerIdleTicks = 0;
  // Whether the PREVIOUS tick ended with the countdown still running — see the
  // downtime comment below for why this, not the snapshot's `relocating`
  // state, is what counting downtime requires.
  let wasRelocating = false;

  for (let t = 0; t < ticks; t++) {
    world.getResource(SimClock).tick++;
    const issuingMove = moveTo !== undefined && t === moveTo.atTick;
    if (issuingMove) {
      enqueue(world, { type: 'moveBuilding', buildingId, to: { col: moveTo!.col, row: moveTo!.row } });
    }
    await world.step();
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
