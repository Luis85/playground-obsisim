import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { SaveGameV3 } from '../../src/shared/save';
import { haulTicks } from '../../src/shared/haul';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS } from '../../src/engine/content/buildings';
import { Building } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import { ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../src/engine/world';

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
}

export interface BalanceResult {
  /** Units banked into the building's buffer — gross production. */
  made: number;
  /** Units that reached the stockpile. */
  delivered: number;
  /** Ticks the building spent in `outputFull`. */
  stalledTicks: number;
  /** Hauler-ticks spent at the camp with no trip (over-provisioning). */
  haulerIdleTicks: number;
  /** Units still waiting at the building when the run ended. */
  finalBuffer: number;
  /** One-way trip length in ticks, for reference. */
  legTicks: number;
  /** Units the crew could produce with hauling never a constraint. */
  ceiling: number;
}

/**
 * Workers are fed from a large berry stock on purpose: this instrument
 * measures logistics, not starvation, and a crew that degrades mid-run would
 * confound every throughput number with hunger.
 */
const FED = 1_000_000;

export async function runScenario(scenario: Scenario): Promise<BalanceResult> {
  const { defId, col, row, crew, haulers, ticks, resource } = scenario;
  const save: SaveGameV3 = { ...initialSave(), workers: [], stockpile: { berries: FED }, nextEntityId: 1 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const entity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false, col, row });
  const buildingId = entity.getComponent(Building)!.id;
  for (let i = 0; i < crew; i++) spawnWorker(prep, ids, { buildingId });
  for (let i = 0; i < haulers; i++) spawnWorker(prep, ids, { hauling: true });
  const world = await prep.prepareRun();

  let stalledTicks = 0;
  let haulerIdleTicks = 0;
  const before = world.getResource(Stockpile).get(resource);

  for (let t = 0; t < ticks; t++) {
    world.getResource(SimClock).tick++;
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    const building = snapshot.buildings.find((b) => b.id === buildingId);
    if (building?.state === 'outputFull') stalledTicks++;
    haulerIdleTicks += snapshot.workers.filter((w) => w.hauling && w.haulPhase === 'idle').length;
  }

  const snapshot = world.getResource(SnapshotStore).latest!;
  const finalBuffer = snapshot.buildings.find((b) => b.id === buildingId)?.buffered ?? 0;
  const delivered = world.getResource(Stockpile).get(resource) - before;
  // Gross production, derived rather than sampled: madeRate is a rolling mean
  // over statsWindowTicks and would understate a short run. Everything made
  // either reached the store or is still in the buffer.
  const made = delivered + finalBuffer;

  const recipe = BUILDINGS[defId].recipe;
  const perBatch = Object.values(recipe.outputs).reduce((sum, n) => sum + n, 0);
  return {
    made,
    delivered,
    stalledTicks,
    haulerIdleTicks,
    finalBuffer,
    legTicks: haulTicks(col, row, BALANCE.haulTilesPerTick),
    ceiling: (ticks * crew * perBatch) / recipe.ticksPerBatch,
  };
}
