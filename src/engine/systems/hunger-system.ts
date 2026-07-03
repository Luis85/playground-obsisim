import { createSystem, queryComponents, Write, WriteResource } from 'sim-ecs';
import { BALANCE } from '../content/balance';
import { Hunger } from '../components';
import { Stockpile } from '../resources';

export const HungerSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  workers: queryComponents({ hunger: Write(Hunger) }),
})
  .withName('HungerSystem')
  .withRunFunction(({ stockpile, workers }) => {
    for (const { hunger } of workers.iter()) {
      hunger.value = Math.min(BALANCE.hungerMax, hunger.value + BALANCE.hungerPerTick);
      if (hunger.value < BALANCE.mealThreshold) continue;
      if (stockpile.take('bread', 1)) {
        hunger.value = 0;
      } else if (stockpile.take('berries', 1)) {
        hunger.value = Math.max(0, hunger.value - BALANCE.berriesHungerRestore);
      }
    }
  })
  .build();
