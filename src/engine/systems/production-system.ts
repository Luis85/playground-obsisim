import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { Building, Efficiency, JobAssignment, Production, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({ building: Read(Building), production: Write(Production) }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const powerByBuilding = new Map<number, number>();
    for (const { job, efficiency, coverage } of workers.iter()) {
      if (job.buildingId === null) continue;
      const contribution = efficiency.value * (coverage.remainingTicks > 0 ? BALANCE.toolMultiplier : 1);
      powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
    }

    for (const { building, production } of buildings.iter()) {
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;

      const recipe = BUILDINGS[building.defId].recipe;
      if (!production.batchActive && stockpile.pay(recipe.inputs)) {
        production.batchActive = true;
        production.progress = 0;
      }
      if (!production.batchActive) continue;

      production.progress += workPower;
      while (production.batchActive && production.progress >= recipe.ticksPerBatch) {
        for (const [id, amount] of Object.entries(recipe.outputs)) {
          stockpile.add(id as ResourceId, amount);
        }
        // carry the remainder into the next batch (no throughput loss for
        // high-power buildings); chain by paying the next batch's inputs
        production.progress -= recipe.ticksPerBatch;
        production.batchActive = stockpile.pay(recipe.inputs);
      }
      if (!production.batchActive) production.progress = 0; // stalled: don't bank effort
    }
  })
  .build();
