<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { useEconomyChains } from '../economy';

// The three backlog sentences (output, input, build) — byte-for-byte the
// same three `<p>` elements in both EconomyView (the Ledger's wide table)
// and EconomyPanel (the dock's narrower one): same classes, same data-test
// hooks, same wording. Spec §2.7: "where a whole block is identical in both
// surfaces, share the component" — this is that block, extracted rather
// than pasted twice, the same call PopulationRoster.vue made for its own
// identical headline block (Task 9). The chain TABLE below it, in each
// caller, is the OTHER half of §2.7: the two tables differ (nine columns vs
// four, inert vs clickable), so that part stays two templates over one
// shared derivation (`useEconomyChains`) rather than one shared component.
const store = useGameStore();
const { haulPressure, inputPressure, buildPressure, haulNegative, inputNegative } = useEconomyChains();
</script>

<template>
  <!-- Guarded on `store.snapshot`, belt-and-braces the way PopulationRoster
       guards itself: both callers already guard their own root on this same
       condition, so this never actually renders with no snapshot, but a
       future third caller gets the same safety without having to remember. -->
  <template v-if="store.snapshot">
    <p class="obsisim-haul-pressure" data-test="haul-pressure" :class="{ 'obsisim-negative': haulNegative }">
      {{ haulPressure }}
    </p>
    <p class="obsisim-haul-pressure" data-test="input-pressure" :class="{ 'obsisim-negative': inputNegative }">
      {{ inputPressure }}
    </p>
    <!-- No obsisim-negative here, deliberately: unlike the two backlogs
         above, a site under construction is not a stall — it is the queue
         doing exactly what the player asked for (buildPressureLabel's own
         comment states the same reasoning). -->
    <p class="obsisim-haul-pressure" data-test="build-pressure">
      {{ buildPressure }}
    </p>
  </template>
</template>
