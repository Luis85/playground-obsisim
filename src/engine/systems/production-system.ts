import { createSystem, queryComponents, Read, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { CostMap, RecipeDef, ResourceId } from '../../shared/content-types';
import { isUnderConstruction, relocatingIdsOf, type TileRef } from '../../shared/placement';
import { commuteFactor } from '../../shared/population';
import { BALANCE, workerWorkPower } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { commuteTiles } from '../snapshot-builder';
import {
  Building, Construction, Efficiency, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage,
} from '../components';
import { PendingChanges, ProductionLedger } from '../resources';

/**
 * All-or-nothing draw against the building's OWN input buffer — never the
 * colony Stockpile. Since Task 3 that is the whole point: a recipe's inputs
 * have to physically be in THIS building before a batch can start, which is
 * what makes a hauler's delivery run meaningful instead of decorative.
 */
function payFrom(input: InputBuffer, cost: CostMap): boolean {
  const canAfford = Object.entries(cost).every(([id, amount]) => (input.amounts.get(id as ResourceId) ?? 0) >= amount);
  if (!canAfford) return false;
  for (const [id, amount] of Object.entries(cost)) input.take(id as ResourceId, amount);
  return true;
}

/**
 * Try to start a new batch when idle. Checked BEFORE paying inputs: a
 * building that could not bank the result must not eat the wheat it can do
 * nothing with.
 */
function startBatch(production: Production, input: InputBuffer, buffer: OutputBuffer, recipe: RecipeDef, perBatch: number): void {
  if (production.batchActive) return;
  if (buffer.room(BALANCE.outputBufferCap) < perBatch) return;
  if (payFrom(input, recipe.inputs)) {
    production.batchActive = true;
    production.progress = 0;
  }
}

/**
 * Bank every batch this tick's accumulated progress completes, chaining
 * straight into the next one when inputs and buffer room allow.
 */
function completeBatches(
  production: Production, input: InputBuffer, buffer: OutputBuffer, recipe: RecipeDef, perBatch: number, ledger: ProductionLedger,
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
    // high-power buildings); chain by paying the next batch's inputs out of
    // the SAME local buffer. This is the second of the two payment sites —
    // miss it and a building produces exactly one batch per delivery, which
    // looks like a balance problem and is not.
    production.progress -= recipe.ticksPerBatch;
    production.batchActive = payFrom(input, recipe.inputs);
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
 *
 * Neither does a crew whose building is mid-move (OBS-6-08). Their zero used to
 * be reached by control flow instead: a real contribution was computed and
 * stored here, then never read, because the loop below `continue`s past a
 * relocating building before it looks work power up. That answered correctly
 * while agreeing with the snapshot's own zero only by coincidence — both now
 * read `relocatingIdsOf`, so there is one membership question rather than two
 * differently-shaped tests of the same fact.
 */
function sumWorkPower(
  workers: Iterable<{ job: JobAssignment; efficiency: Efficiency; coverage: ToolCoverage; home: Home }>,
  tileById: ReadonlyMap<number, TileRef>,
  relocating: ReadonlySet<number>,
): Map<number, number> {
  const powerByBuilding = new Map<number, number>();
  for (const { job, efficiency, coverage, home } of workers) {
    if (job.buildingId === null || relocating.has(job.buildingId)) continue;
    const factor = placementFactorOf(home.buildingId, job.buildingId, tileById);
    const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks, factor);
    powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
  }
  return powerByBuilding;
}

export const ProductionSystem = () => createSystem({
  ledger: WriteResource(ProductionLedger),
  buildings: queryComponents({
    building: Read(Building), position: Read(Position), production: Write(Production), input: Write(InputBuffer),
    buffer: Write(OutputBuffer), relocation: Write(Relocation), construction: Read(Construction),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage), home: Read(Home) }),
  pending: ReadResource(PendingChanges),
})
  .withName('ProductionSystem')
  .withRunFunction(({ ledger, buildings, workers, pending }) => {
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
    // Read BEFORE the loop below, which decrements: this is therefore the
    // PRE-decrement answer, the same one `relocation.ticksLeft > 0` gave when
    // asked inside the loop, since each building is visited exactly once.
    const relocating = relocatingIdsOf(buildingRows.map((row) => ({ id: row.building.id, relocatingTicks: row.relocation.ticksLeft })));
    const powerByBuilding = sumWorkPower(workers.iter(), tileById, relocating);

    // Isolated so the run function itself stays a flat dispatch loop.
    const advanceBatches = (building: Building, production: Production, input: InputBuffer, buffer: OutputBuffer, workPower: number) => {
      // Non-null: this is only ever reached from the building loop below,
      // whose recipe-null `continue` guard runs before advanceBatches is
      // called, so no building without a recipe ever gets here. Keep that
      // guard in place — remove it and this assertion becomes a crash.
      const recipe = BUILDINGS[building.defId].recipe!;
      const perBatch = batchOutputUnits(recipe);
      startBatch(production, input, buffer, recipe, perBatch);
      if (!production.batchActive) return;
      production.progress += workPower;
      completeBatches(production, input, buffer, recipe, perBatch, ledger);
    };

    for (const { building, production, input, buffer, relocation, construction } of buildingRows) {
      // A construction site provides none of its service yet (spec §2.5) —
      // no batch has ever started, and a worker standing in one (unreachable
      // through the assign command since this task, but not through a saved
      // JobAssignment left dangling from before) must bank nothing. Checked
      // BEFORE the relocating skip below: a site's `Relocation.ticksLeft` is
      // always 0 (nothing has ever moved it), so a mutation to this guard
      // alone cannot hide behind the relocating one.
      if (isUnderConstruction(construction.ticksLeft)) continue;
      // A relocating building is out of action: its crew are carrying it, not
      // working. Haulers still collect from its buffer — goods already made
      // exist regardless of whether the crew is working.
      if (relocating.has(building.id)) {
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
      advanceBatches(building, production, input, buffer, workPower);
    }
  })
  .build();
