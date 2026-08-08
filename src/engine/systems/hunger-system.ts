import { createSystem, queryComponents, Write, WriteResource } from 'sim-ecs';
import { BALANCE } from '../content/balance';
import { Hunger } from '../components';
import { Stockpile } from '../resources';

export const HungerSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  colonists: queryComponents({ hunger: Write(Hunger) }),
})
  .withName('HungerSystem')
  .withRunFunction(({ stockpile, colonists }) => {
    for (const { hunger } of colonists.iter()) {
      hunger.value = Math.min(BALANCE.hungerMax, hunger.value + BALANCE.hungerPerTick);
      if (hunger.value >= BALANCE.mealThreshold) {
        if (stockpile.take('bread', 1)) hunger.value = 0;
        else if (stockpile.take('berries', 1)) hunger.value = Math.max(0, hunger.value - BALANCE.berriesHungerRestore);
      }
      // Anything eaten drops hunger below the cap, so this one expression is
      // both the "still starving" increment and the "ate something" reset.
      hunger.starvingTicks = hunger.value >= BALANCE.hungerMax ? hunger.starvingTicks + 1 : 0;
    }
  })
  .build();
