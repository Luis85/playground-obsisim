<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
// Shared with the Population view rather than restated here: both screens show
// the same stage counts, beds and meals-per-head, and two copies of that block
// are two chances for them to disagree about a number the player is comparing
// across tabs.
import PopulationSummary from '../components/PopulationSummary.vue';
// The resource table itself is shared with the dock's ColonyPanel, per §2.7
// re-opened at Task 8's fix: once ColonyPanel carries all seven columns
// spec §2.3 asks for, the two tables are the same markup, not two similarly-
// shaped ones — see ResourceTable.vue's own comment for the full reasoning
// and for what deliberately stayed here instead (this headline block).
import ResourceTable from '../components/ResourceTable.vue';
// The hauler count and its two verbs, shared with ResourceStrip's own copy
// of this exact pair — see HaulerControls.vue's own comment for why a
// shared component, not each view's own markup: §2.2 requires BOTH
// directions to state their refusal in the panel (not a `title`), and once
// this file's hauler pair was brought up to that same standard the two
// blocks were no longer merely similar, they were identical.
import HaulerControls from '../components/HaulerControls.vue';

const store = useGameStore();
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Colony wealth: <strong>{{ store.snapshot.colonyWealth.toFixed(0) }}</strong></span>
      <span>Population: <strong>{{ store.snapshot.population }}</strong> ({{ store.snapshot.idleAdults }} idle)</span>
      <PopulationSummary />
      <span>Buildings: <strong>{{ store.snapshot.buildings.length }}</strong></span>
      <HaulerControls />
    </div>
    <ResourceTable />
  </div>
</template>
