import { createSystem, WriteResource } from 'sim-ecs';
import { StatsHistory, Stockpile } from '../resources';

export const StatsSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  stats: WriteResource(StatsHistory),
})
  .withName('StatsSystem')
  .withRunFunction(({ stockpile, stats }) => {
    stats.record(stockpile.producedThisTick, stockpile.consumedThisTick);
    stockpile.resetTickFlows();
  })
  .build();
