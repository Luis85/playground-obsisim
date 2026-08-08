import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import { BALANCE, colonistEfficiency } from '../content/balance';
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
      efficiency.value = colonistEfficiency(hunger.value);
      if (coverage.remainingTicks > 0) {
        // wears down whether assigned or idle: simple and deterministic
        coverage.remainingTicks--;
      }
      // renew in the same tick coverage hits 0, so a continuously staffed
      // worker never has an untooled gap tick (exactly 1 tool per 300 ticks)
      if (coverage.remainingTicks === 0 && job.buildingId !== null && stockpile.take('tools', 1)) {
        coverage.remainingTicks = BALANCE.toolDurationTicks;
      }
    }
  })
  .build();
