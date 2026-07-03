import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import { BALANCE, workerEfficiency } from '../content/balance';
import { Efficiency, Hunger, JobAssignment, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const EfficiencySystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  workers: queryComponents({
    hunger: Read(Hunger),
    job: Read(JobAssignment),
    efficiency: Write(Efficiency),
    coverage: Write(ToolCoverage),
  }),
})
  .withName('EfficiencySystem')
  .withRunFunction(({ stockpile, workers }) => {
    for (const { hunger, job, efficiency, coverage } of workers.iter()) {
      efficiency.value = workerEfficiency(hunger.value);
      if (coverage.remainingTicks > 0) {
        // wears down whether assigned or idle: simple and deterministic
        coverage.remainingTicks--;
      } else if (job.buildingId !== null && stockpile.take('tools', 1)) {
        coverage.remainingTicks = BALANCE.toolDurationTicks;
      }
    }
  })
  .build();
