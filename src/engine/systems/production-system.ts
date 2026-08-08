import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { RecipeDef, ResourceId } from '../../shared/content-types';
import { BALANCE, workerWorkPower } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { Building, Efficiency, Home, JobAssignment, OutputBuffer, Production, Relocation, ToolCoverage } from '../components';
import { ProductionLedger, Stockpile } from '../resources';

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
 * Every currently-assigned worker's contribution to its building's work
 * power this tick, summed by building id. Extracted out of the run function
 * purely to keep ITS OWN complexity (fallow scores CRAP per function, which
 * reads cyclomatic, not just cognitive) under the gate — same principle as
 * startBatch/completeBatches already being split out above.
 */
function sumWorkPower(
  workers: Iterable<{ job: JobAssignment; efficiency: Efficiency; coverage: ToolCoverage; home: Home }>,
): Map<number, number> {
  const powerByBuilding = new Map<number, number>();
  for (const { job, efficiency, coverage, home } of workers) {
    if (job.buildingId === null) continue;
    // Homelessness costs exactly what the worst possible commute costs
    // (BALANCE.homelessFactor) — Task 7 replaces this binary read with the
    // full commute factor.
    const placementFactor = home.buildingId === null ? BALANCE.homelessFactor : 1;
    const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks, placementFactor);
    powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
  }
  return powerByBuilding;
}

export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  ledger: WriteResource(ProductionLedger),
  buildings: queryComponents({
    building: Read(Building), production: Write(Production), buffer: Write(OutputBuffer), relocation: Write(Relocation),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage), home: Read(Home) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, ledger, buildings, workers }) => {
    const powerByBuilding = sumWorkPower(workers.iter());

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

    for (const { building, production, buffer, relocation } of buildings.iter()) {
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
