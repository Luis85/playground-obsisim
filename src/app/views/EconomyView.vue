<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, CHAINS, RESOURCES } from '../../engine/content';

// The chain view exists to make bottlenecks visible (PRD §5): a starving
// stage is the signal that the stage before it is too slow. Verdicts come
// precomputed from the store (stageStatuses); rows are assembled here so
// the template stays flat interpolation.
const store = useGameStore();

// One sentence, because a number nobody can interpret is not a diagnostic:
// this is the answer to "my production fell and I did not change anything".
const haulPressure = computed(() => {
  if (store.unitsWaiting === 0) return 'Hauling is keeping up: nothing is waiting at a building.';
  const haulers = `${store.haulerCount} hauler${store.haulerCount === 1 ? '' : 's'}`;
  const stalled = `${store.stalledBuildings} stalled`;
  return `${store.unitsWaiting} units waiting for collection — ${stalled} — ${haulers} on duty.`;
});

const chains = computed(() => {
  const snapshot = store.snapshot;
  if (!snapshot) return [];
  return CHAINS.map((chain) => ({
    name: chain.name,
    steps: chain.steps.map((step) => {
      const staffing = store.staffingByDef[step.building] ?? { total: 0, staffed: 0, starved: 0 };
      const status = store.stageStatuses[step.building] ?? { label: 'not built', starved: false };
      const runway = store.runways[step.output];
      const stats = snapshot.stockpile[step.output];
      return {
        building: step.building,
        stage: BUILDINGS[step.building].name,
        crew: `${staffing.total} (${staffing.staffed})`,
        status: status.label,
        starved: status.starved,
        output: RESOURCES[step.output].name,
        // Store inflow, not gross output: since increment 4 goods reach the
        // stockpile when a hauler delivers them, not when they are made. The
        // column is headed "Delivered/t" for that reason — a fully staffed
        // building with no haulers reads "producing" and 0.00 at the same
        // time, and under the old "Prod/t" heading that was a contradiction
        // rather than the haul backlog it actually is (OBS-4-06).
        delivered: stats.productionRate.toFixed(2),
        cons: stats.consumptionRate.toFixed(2),
        stock: stats.stock,
        outputId: step.output,
        runway: runway !== undefined ? `~${runway}t` : '—',
      };
    }),
  }));
});
</script>

<template>
  <div v-if="store.snapshot">
    <p
      class="obsisim-haul-pressure"
      data-test="haul-pressure"
      :class="{ 'obsisim-negative': store.stalledBuildings > 0 }"
    >
      {{ haulPressure }}
    </p>
    <section v-for="chain in chains" :key="chain.name">
      <h3>{{ chain.name }} chain</h3>
      <table class="obsisim-table">
        <thead>
          <tr><th>Stage</th><th>Buildings (staffed)</th><th>Status</th><th>Output</th><th data-test="inflow-heading">Delivered/t</th><th>Cons/t</th><th>Stock</th><th>Empties in</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in chain.steps" :key="row.building" :class="{ 'obsisim-starved': row.starved }">
            <td>{{ row.stage }}</td>
            <td>{{ row.crew }}</td>
            <td :data-test="`status-${row.building}`">{{ row.status }}</td>
            <td>{{ row.output }}</td>
            <td :data-test="`delivered-${row.building}`">{{ row.delivered }}</td>
            <td>{{ row.cons }}</td>
            <td>{{ row.stock }}</td>
            <td :data-test="`runway-${row.outputId}`">{{ row.runway }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
