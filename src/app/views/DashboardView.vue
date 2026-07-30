<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content';

const store = useGameStore();
const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Colony wealth: <strong>{{ store.snapshot.colonyWealth.toFixed(0) }}</strong></span>
      <span>Population: <strong>{{ store.snapshot.population }}</strong> ({{ store.snapshot.idleWorkers }} idle)</span>
      <span>Buildings: <strong>{{ store.snapshot.buildings.length }}</strong></span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Resource</th><th>Tier</th><th>Stock</th><th>Prod/t</th><th>Cons/t</th><th>Net</th><th>Empties in</th><th>Value</th></tr>
      </thead>
      <tbody>
        <tr v-for="id in RESOURCE_IDS" :key="id">
          <td>{{ RESOURCES[id].name }}</td>
          <td>{{ RESOURCES[id].tier }}</td>
          <td>{{ store.snapshot.stockpile[id].stock }}</td>
          <td>{{ fmt(store.snapshot.stockpile[id].productionRate) }}</td>
          <td>{{ fmt(store.snapshot.stockpile[id].consumptionRate) }}</td>
          <td :class="store.snapshot.stockpile[id].netFlow >= 0 ? 'obsisim-positive' : 'obsisim-negative'">
            {{ fmt(store.snapshot.stockpile[id].netFlow) }}
          </td>
          <td :data-test="`runway-${id}`" :class="{ 'obsisim-negative': (store.runways[id] ?? Infinity) <= 30 }">
            {{ store.runways[id] !== undefined ? `~${store.runways[id]}t` : '—' }}
          </td>
          <td>{{ store.snapshot.stockpile[id].stockValue.toFixed(0) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
