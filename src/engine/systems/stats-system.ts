import { createSystem, WriteResource } from 'sim-ecs';
import { ProductionLedger, StatsHistory, Stockpile } from '../resources';

export const StatsSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  ledger: WriteResource(ProductionLedger),
  stats: WriteResource(StatsHistory),
})
  .withName('StatsSystem')
  .withRunFunction(({ stockpile, ledger, stats }) => {
    stats.record(stockpile.producedThisTick, stockpile.consumedThisTick, ledger.madeThisTick);
    stockpile.resetTickFlows();
    ledger.reset();
  })
  .build();
