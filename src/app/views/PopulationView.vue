<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS } from '../../engine/content/buildings';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

const jobNames = computed(() => {
  const names = new Map<number, string>();
  for (const b of store.snapshot?.buildings ?? []) names.set(b.id, BUILDINGS[b.defId].name);
  return names;
});
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <button
        data-test="recruit"
        :disabled="store.recruitCooldownRemaining > 0"
        @click="engine.dispatch({ type: 'recruitWorker' })"
      >
        Recruit worker
      </button>
      <span v-if="store.recruitCooldownRemaining > 0">available in {{ store.recruitCooldownRemaining }} ticks</span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Worker</th><th>Job</th><th>Hunger</th><th>Efficiency</th><th>Tool</th></tr>
      </thead>
      <tbody>
        <tr v-for="w in store.snapshot.workers" :key="w.id">
          <td>#{{ w.id }}</td>
          <td>{{ w.buildingId === null ? 'Idle' : jobNames.get(w.buildingId) ?? '?' }}</td>
          <td>{{ w.hunger }} / 100</td>
          <td>{{ (w.efficiency * 100).toFixed(0) }}%</td>
          <td>{{ w.toolTicks > 0 ? `⚒ ${w.toolTicks}t` : '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
