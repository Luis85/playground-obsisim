<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BALANCE, BUILDINGS } from '../../engine/content';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

// A worker's own JobAssignment only carries a buildingId, not the building's
// name, so this table needs a defId -> name lookup to render the Job column.
// Recomputed whenever the snapshot's buildings change, not once at mount.
const jobNames = computed(() => {
  const names = new Map<number, string>();
  for (const b of store.snapshot?.buildings ?? []) names.set(b.id, BUILDINGS[b.defId].name);
  return names;
});

// Pulled out of the template so the markup's own branching stays low: each
// helper is a single small unit rather than inline ternaries per cell.
// '?' rather than throwing: jobNames only tracks buildings still in the
// snapshot, so a stale buildingId (a building removed mid-tick) degrades to
// an unknown label instead of crashing the whole table.
function jobLabel(buildingId: number | null, hauling: boolean): string {
  if (hauling) return 'Hauling';
  if (buildingId === null) return 'Idle';
  return jobNames.value.get(buildingId) ?? '?';
}

// Tool coverage counts down to zero rather than toggling off, so the em-dash
// here mirrors the "—" used for an unstaffed building's tooled-worker column.
function toolLabel(toolTicks: number): string {
  return toolTicks > 0 ? `⚒ ${toolTicks}t` : '—';
}

// hunger reads backwards next to efficiency (higher = worse), so the cell is
// colored once the worker is at the meal threshold and again when fully
// starving. Bound to the hunger <td> only (Step 3): efficiency already has
// its own column, and coloring both would say the same thing twice.
//
// Reuses BALANCE.mealThreshold/hungerMax rather than new literals, so a
// balance retune can't silently desync this coloring from workerEfficiency()
// in content/balance.ts. The `>=` here (vs. workerEfficiency's `<=`) is
// deliberate: the warning fires at hunger === mealThreshold itself, one tick
// before efficiency actually starts to drop.
function hungerClass(hunger: number): string {
  if (hunger >= BALANCE.hungerMax) return 'obsisim-negative';
  if (hunger >= BALANCE.mealThreshold) return 'obsisim-warning';
  return '';
}
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
          <td>{{ jobLabel(w.buildingId, w.hauling) }}</td>
          <td :data-test="`hunger-${w.id}`" :class="hungerClass(w.hunger)">{{ w.hunger }} / {{ BALANCE.hungerMax }}</td>
          <td>{{ (w.efficiency * 100).toFixed(0) }}%</td>
          <td>{{ toolLabel(w.toolTicks) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
