<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
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

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Colony wealth: <strong>{{ store.snapshot.colonyWealth.toFixed(0) }}</strong></span>
      <span>Population: <strong>{{ store.snapshot.population }}</strong> ({{ store.snapshot.idleAdults }} idle)</span>
      <PopulationSummary />
      <span>Buildings: <strong>{{ store.snapshot.buildings.length }}</strong></span>
      <span class="obsisim-haulers">
        Haulers: <strong data-test="hauler-count">{{ store.haulerCount }}</strong>
        <button
          data-test="unassign-hauler"
          :disabled="store.haulerCount === 0"
          title="Send a hauler back to the idle camp"
          @click="engine.dispatch({ type: 'unassignHauler' })"
        >−</button>
        <button
          data-test="assign-hauler"
          :disabled="store.snapshot.idleAdults === 0"
          title="Put an idle worker on hauling duty"
          @click="engine.dispatch({ type: 'assignHauler' })"
        >+</button>
      </span>
    </div>
    <ResourceTable />
  </div>
</template>
