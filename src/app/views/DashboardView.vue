<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Colony wealth: <strong>{{ store.snapshot.colonyWealth.toFixed(0) }}</strong></span>
      <span>Population: <strong>{{ store.snapshot.population }}</strong> ({{ store.snapshot.idleAdults }} idle)</span>
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
    <table class="obsisim-table">
      <thead>
        <tr><th>Resource</th><th>Tier</th><th>Stock</th><th data-test="inflow-heading">Delivered/t</th><th>Cons/t</th><th>Net</th><th>Empties in</th><th>Value</th></tr>
      </thead>
      <tbody>
        <tr v-for="id in RESOURCE_IDS" :key="id">
          <td>{{ RESOURCES[id].name }}</td>
          <td>{{ RESOURCES[id].tier }}</td>
          <td>{{ store.snapshot.stockpile[id].stock }}</td>
          <td>{{ fmt(store.snapshot.stockpile[id].deliveredRate) }}</td>
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
