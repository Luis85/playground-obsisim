<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { CHAINS } from '../../engine/content/chains';
import { BUILDINGS } from '../../engine/content/buildings';
import { RESOURCES } from '../../engine/content/resources';

const store = useGameStore();

function buildingCount(defId: string): { total: number; staffed: number } {
  const buildings = (store.snapshot?.buildings ?? []).filter((b) => b.defId === defId);
  return { total: buildings.length, staffed: buildings.filter((b) => b.workers > 0).length };
}
</script>

<template>
  <div v-if="store.snapshot">
    <section v-for="chain in CHAINS" :key="chain.name">
      <h3>{{ chain.name }} chain</h3>
      <table class="obsisim-table">
        <thead>
          <tr><th>Stage</th><th>Buildings (staffed)</th><th>Output</th><th>Prod/t</th><th>Cons/t</th><th>Stock</th></tr>
        </thead>
        <tbody>
          <tr v-for="step in chain.steps" :key="step.building">
            <td>{{ BUILDINGS[step.building].name }}</td>
            <td>{{ buildingCount(step.building).total }} ({{ buildingCount(step.building).staffed }})</td>
            <td>{{ RESOURCES[step.output].name }}</td>
            <td>{{ store.snapshot.stockpile[step.output].productionRate.toFixed(2) }}</td>
            <td>{{ store.snapshot.stockpile[step.output].consumptionRate.toFixed(2) }}</td>
            <td>{{ store.snapshot.stockpile[step.output].stock }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
