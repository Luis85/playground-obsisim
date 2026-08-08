import { createSystem, queryComponents, Read, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { RecipeDef, ResourceId } from '../../shared/content-types';
import type { TileRef } from '../../shared/placement';
import { commuteFactor } from '../../shared/population';
import { BALANCE, workerWorkPower } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { commuteTiles } from '../snapshot-builder';
import { Building, Efficiency, Home, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage } from '../components';
import { PendingChanges, ProductionLedger, Stockpile } from '../resources';

/**
 * Try to start a new batch when idle. Checked BEFORE paying inputs: a
 * building that could not bank the result must not eat the wheat it can do
 * nothing with.
 */
function startBatch(production: Production, buffer: OutputBuffer, stockpile: Stockpile, recipe: RecipeDef, perBatch: number): void {
  if (production.batchActive) return;
  if (buffer.room(BALANCE.outputBufferCap) < perBatch) return;
  if (stockpile.pay(recipe.inputs)) {
    production.batchActive = true;
    production.progress = 0;
  }
}

/**
 * Bank every batch this tick's accumulated progress completes, chaining
 * straight into the next one when inputs and buffer room allow.
 */
function completeBatches(
  production: Production, buffer: OutputBuffer, stockpile: Stockpile, recipe: RecipeDef, perBatch: number, ledger: ProductionLedger,
): void {
  while (production.batchActive && production.progress >= recipe.ticksPerBatch) {
    // A batch completes only with room for ALL of its outputs. Otherwise the
    // building holds one finished batch at full progress — the outputFull
    // stall — until a hauler frees space. Effort beyond that one batch is
    // not banked: the crew is standing beside a full pile.
    if (buffer.room(BALANCE.outputBufferCap) < perBatch) {
      production.progress = recipe.ticksPerBatch;
      return;
    }
    for (const [id, amount] of Object.entries(recipe.outputs)) {
      buffer.add(id as ResourceId, amount);
      ledger.add(id as ResourceId, amount); // gross production, before any hauling
    }
    // carry the remainder into the next batch (no throughput loss for
    // high-power buildings); chain by paying the next batch's inputs
    production.progress -= recipe.ticksPerBatch;
    production.batchActive = stockpile.pay(recipe.inputs);
  }
  if (!production.batchActive) production.progress = 0; // stalled: don't bank effort
}

/**
 * How much of this worker's effort survives the walk from their bed. Split out
 * of sumWorkPower so that loop keeps its flat shape (and its CRAP score) while
 * the two map lookups the distance needs live somewhere named.
 *
 * `commuteTiles` is imported rather than re-derived: buildEntitySections
 * measures the same walk from ColonistFacts, and a second copy of the
 * arithmetic here is exactly how a displayed work power drifts away from the
 * simulated one.
 */
function placementFactorOf(homeId: number | null, buildingId: number, tileById: ReadonlyMap<number, TileRef>): number {
  const homeTile = homeId === null ? null : tileById.get(homeId) ?? null;
  const tiles = commuteTiles(homeTile, tileById.get(buildingId) ?? null);
  return commuteFactor(tiles, BALANCE.commute, BALANCE.homelessFactor);
}

/**
 * Every currently-assigned worker's contribution to its building's work
 * power this tick, summed by building id. Extracted out of the run function
 * purely to keep ITS OWN complexity (fallow scores CRAP per function, which
 * reads cyclomatic, not just cognitive) under the gate — same principle as
 * startBatch/completeBatches already being split out above.
 *
 * Haulers never reach the accumulation: their `buildingId` is null, and their
 * commute is charged against carry capacity in HaulSystem instead, because
 * their output is goods moved rather than batches produced.
 */
function sumWorkPower(
  workers: Iterable<{ job: JobAssignment; efficiency: Efficiency; coverage: ToolCoverage; home: Home }>,
  tileById: ReadonlyMap<number, TileRef>,
): Map<number, number> {
  const powerByBuilding = new Map<number, number>();
  for (const { job, efficiency, coverage, home } of workers) {
    if (job.buildingId === null) continue;
    const factor = placementFactorOf(home.buildingId, job.buildingId, tileById);
    const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks, factor);
    powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
  }
  return powerByBuilding;
}

export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  ledger: WriteResource(ProductionLedger),
  buildings: queryComponents({
    building: Read(Building), position: Read(Position), production: Write(Production), buffer: Write(OutputBuffer),
    relocation: Write(Relocation),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage), home: Read(Home) }),
  pending: ReadResource(PendingChanges),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, ledger, buildings, workers, pending }) => {
    // Materialized because the rows are needed twice: once to map every
    // building's tile (a worker's commute is measured against their HOUSE's
    // tile, which is another row in this same query) and once to advance them.
    const buildingRows = [...buildings.iter()];
    const tileById = new Map(buildingRows.map((row): [number, TileRef] => [row.building.id, row.position]));
    // Buildings constructed earlier THIS tick are absent from the query until
    // the post-step sync, but homing has already seated colonists in them, so
    // resolving a homeId against the query alone would charge a colonist
    // homelessFactor on the very tick they were housed. Folded into the map
    // rather than handled at each lookup: placementFactorOf resolves a home
    // tile and a workplace tile, and neither has any business knowing which
    // side of the sync its building came from.
    for (const built of pending.constructed) tileById.set(built.id, { col: built.col, row: built.row });
    const powerByBuilding = sumWorkPower(workers.iter(), tileById);

    // Isolated so the run function itself stays a flat dispatch loop.
    const advanceBatches = (building: Building, production: Production, buffer: OutputBuffer, workPower: number) => {
      // Non-null: this is only ever reached from the building loop below,
      // whose recipe-null `continue` guard runs before advanceBatches is
      // called, so no building without a recipe ever gets here. Keep that
      // guard in place — remove it and this assertion becomes a crash.
      const recipe = BUILDINGS[building.defId].recipe!;
      const perBatch = batchOutputUnits(recipe);
      startBatch(production, buffer, stockpile, recipe, perBatch);
      if (!production.batchActive) return;
      production.progress += workPower;
      completeBatches(production, buffer, stockpile, recipe, perBatch, ledger);
    };

    for (const { building, production, buffer, relocation } of buildingRows) {
      // A relocating building is out of action: its crew are carrying it, not
      // working. Haulers still collect from its buffer — goods already made
      // exist regardless of whether the crew is working.
      if (relocation.ticksLeft > 0) {
        relocation.ticksLeft--;
        // Decrementing here means the tick that brings this to 0 is
        // worked-through-zero: this tick's work is still skipped (continue,
        // below) but the snapshot published right after already reads 0
        // ticks left, i.e. "not relocating". A one-tick relocation therefore
        // never visibly reports `relocating` at all — its only tick resolves
        // to 0 before anything reads it. Not a bug: "0 ticks left" is true
        // the moment it's read. Just the one genuinely-charged tick nothing
        // ever displays as in-flight.
        continue;
      }
      // A shelter has no recipe. Skipped before work power is even looked up,
      // so a colonist mistakenly assigned to one can never bank anything.
      // advanceBatches' recipe! assertion depends on this guard running first.
      if (BUILDINGS[building.defId].recipe === null) continue;
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;
      advanceBatches(building, production, buffer, workPower);
    }
  })
  .build();
