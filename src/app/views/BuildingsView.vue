<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS } from '../../engine/content/buildings';
import { RESOURCES } from '../../engine/content/resources';
import type { BuildingDefId, CostMap, ResourceId } from '../../shared/content-types';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}

const affordable = computed(() => {
  const snapshot = store.snapshot;
  return Object.fromEntries(
    BUILDING_IDS.map((id) => [
      id,
      snapshot !== null &&
        Object.entries(BUILDINGS[id].cost).every(
          ([res, amount]) => snapshot.stockpile[res as ResourceId].stock >= amount,
        ),
    ]),
  ) as Record<BuildingDefId, boolean>;
});
</script>

<template>
  <div v-if="store.snapshot">
    <h3>Buildings</h3>
    <table class="obsisim-table">
      <thead>
        <tr><th>Building</th><th>Workers</th><th>State</th><th>Batch</th><th>Work power</th><th>Tools</th></tr>
      </thead>
      <tbody>
        <tr v-for="b in store.snapshot.buildings" :key="b.id">
          <td>{{ BUILDINGS[b.defId].name }}</td>
          <td>
            <button :data-test="`unassign-${b.id}`" :disabled="b.workers === 0" @click="engine.dispatch({ type: 'unassignWorker', buildingId: b.id })">−</button>
            {{ b.workers }} / {{ b.workerSlots }}
            <button :data-test="`assign-${b.id}`" :disabled="b.workers >= b.workerSlots || store.snapshot.idleWorkers === 0" @click="engine.dispatch({ type: 'assignWorker', buildingId: b.id })">+</button>
          </td>
          <td>{{ b.state }}</td>
          <td>{{ b.progressPct }}%</td>
          <td>{{ b.workPower.toFixed(2) }}</td>
          <td>{{ b.tooledWorkers > 0 ? `⚒ ${b.tooledWorkers}/${b.workers}` : '—' }}</td>
        </tr>
        <tr v-if="store.snapshot.buildings.length === 0">
          <td colspan="6">No buildings yet — construct one below.</td>
        </tr>
      </tbody>
    </table>

    <h3>Construct</h3>
    <table class="obsisim-table">
      <thead>
        <tr><th>Building</th><th>Cost</th><th>Slots</th><th>Recipe</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="id in BUILDING_IDS" :key="id">
          <td>{{ BUILDINGS[id].name }}</td>
          <td>{{ costLabel(BUILDINGS[id].cost) }}</td>
          <td>{{ BUILDINGS[id].workerSlots }}</td>
          <td>
            {{ costLabel(BUILDINGS[id].recipe.inputs) || '—' }} → {{ costLabel(BUILDINGS[id].recipe.outputs) }}
            ({{ BUILDINGS[id].recipe.ticksPerBatch }}wt)
          </td>
          <td>
            <button
              :data-test="`construct-${id}`"
              :disabled="!affordable[id]"
              :title="affordable[id] ? '' : 'Not enough resources'"
              @click="engine.dispatch({ type: 'constructBuilding', buildingDefId: id })"
            >
              Build
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
