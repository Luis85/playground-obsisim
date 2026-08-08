<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { BALANCE } from '../../engine/content';
import { mealsClass } from '../labels';

/*
 * The four figures that say whether the colony can keep going: who is in it by
 * life stage, whether there is somewhere for them to sleep, how many have
 * nowhere, and whether the store can feed another mouth.
 *
 * One component rather than the same markup in two views. The Dashboard and
 * the Population view both need this block, and two copies of it are two
 * chances for the screens to disagree about a number the player is comparing
 * across tabs — beds free being the sharp one, since it is what the nomad
 * button is gated on. Reads the store directly, the way NoticeBanner does,
 * rather than taking a Snapshot prop: there is exactly one snapshot and every
 * other headline figure on both screens already comes from the same place.
 */
const store = useGameStore();

// Homelessness is a standing cost — BALANCE.homelessFactor off every one of
// their working ticks — rather than a countdown to a death, so it warns where
// the Population view's starvation clock goes straight to negative.
function homelessClass(homeless: number): string {
  return homeless > 0 ? 'obsisim-warning' : '';
}
</script>

<template>
  <template v-if="store.snapshot">
    <span>
      <strong data-test="stage-children">{{ store.snapshot.demographics.children }}</strong> children,
      <strong data-test="stage-adults">{{ store.snapshot.demographics.adults }}</strong> adults,
      <strong data-test="stage-elders">{{ store.snapshot.demographics.elders }}</strong> elders
    </span>
    <span data-test="beds">
      Beds: <strong>{{ store.snapshot.beds.occupied }} / {{ store.snapshot.beds.total }}</strong>
      ({{ store.bedsFree }} spare)
    </span>
    <span data-test="homeless" :class="homelessClass(store.snapshot.homeless)">
      Homeless: <strong>{{ store.snapshot.homeless }}</strong>
    </span>
    <span data-test="meals" :class="mealsClass(store.snapshot.mealsPerHead)">
      Meals/head: <strong>{{ store.snapshot.mealsPerHead.toFixed(1) }}</strong>
      (birth at {{ BALANCE.birthFoodPerHead }}, nomad at {{ BALANCE.nomadFoodPerHead }})
    </span>
  </template>
</template>
