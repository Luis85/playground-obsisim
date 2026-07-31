<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS } from '../../engine/content';
// Presentation lives in labels.ts, not the shared contract: BUILDING_STATE_LABELS
// (used in the State cell below) is a Record keyed by the BuildingState union,
// so a state added to the union without a matching label is a type error here,
// not a silently-raw string in the rendered table.
import { BUILDING_STATE_LABELS, costLabel } from '../labels';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
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
          <td>{{ BUILDING_STATE_LABELS[b.state] }}</td>
          <td>{{ b.progressPct }}%</td>
          <td>{{ b.workPower.toFixed(2) }}</td>
          <td>{{ b.tooledWorkers > 0 ? `⚒ ${b.tooledWorkers}/${b.workers}` : '—' }}</td>
        </tr>
        <tr v-if="store.snapshot.buildings.length === 0">
          <td colspan="6">
            No buildings yet. Start with a Forester or Gatherer's Hut (10 wood each) from the
            list below, then assign your idle workers with <strong>+</strong>.
          </td>
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
              :disabled="!store.affordableDefs[id]"
              :title="store.affordableDefs[id] ? '' : 'Not enough resources'"
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
