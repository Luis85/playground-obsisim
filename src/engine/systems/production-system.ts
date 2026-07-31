import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE, workerWorkPower } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { Building, Efficiency, JobAssignment, OutputBuffer, Production, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({
    building: Read(Building), production: Write(Production), buffer: Write(OutputBuffer),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const powerByBuilding = new Map<number, number>();
    for (const { job, efficiency, coverage } of workers.iter()) {
      if (job.buildingId === null) continue;
      const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks);
      powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
    }

    // Isolated so the run function itself stays a flat dispatch loop.
    const advanceBatches = (building: Building, production: Production, buffer: OutputBuffer, workPower: number) => {
      const recipe = BUILDINGS[building.defId].recipe;
      const perBatch = batchOutputUnits(recipe);
      // Checked BEFORE paying inputs: a building that could not bank the result
      // must not eat the wheat it can do nothing with.
      if (!production.batchActive && buffer.room(BALANCE.outputBufferCap) < perBatch) return;
      if (!production.batchActive && stockpile.pay(recipe.inputs)) {
        production.batchActive = true;
        production.progress = 0;
      }
      if (!production.batchActive) return;

      production.progress += workPower;
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
        }
        // carry the remainder into the next batch (no throughput loss for
        // high-power buildings); chain by paying the next batch's inputs
        production.progress -= recipe.ticksPerBatch;
        production.batchActive = stockpile.pay(recipe.inputs);
      }
      if (!production.batchActive) production.progress = 0; // stalled: don't bank effort
    };

    for (const { building, production, buffer } of buildings.iter()) {
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;
      advanceBatches(building, production, buffer, workPower);
    }
  })
  .build();
