<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BALANCE, BUILDINGS } from '../../engine/content';
// The engine's own rejection strings, not a view-side paraphrase of them: the
// sentence beside the disabled button is exactly the notice a click would
// produce, because both sides read this one Record.
import { NOMAD_REJECTIONS } from '../../shared/population';
// Presentation lives in labels.ts, never in the template: LIFE_STAGE_LABELS is
// a Record keyed by the LifeStage union, so a stage added without a label is a
// type error here rather than a raw union member in the rendered cell.
import { ageLabel, commuteLabel, LIFE_STAGE_LABELS, starvingLabel } from '../labels';

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
// balance retune can't silently desync this coloring from colonistEfficiency()
// in content/balance.ts. The `>=` here (vs. colonistEfficiency's `<=`) is
// deliberate: the warning fires at hunger === mealThreshold itself, one tick
// before efficiency actually starts to drop.
function hungerClass(hunger: number): string {
  if (hunger >= BALANCE.hungerMax) return 'obsisim-negative';
  if (hunger >= BALANCE.mealThreshold) return 'obsisim-warning';
  return '';
}

// Warning, not negative: a homeless colonist is losing half their work power
// (BALANCE.homelessFactor), which is a standing cost the player should fix —
// but unlike the starvation clock below, nothing is counting down to a death.
function commuteClass(homeId: number | null): string {
  return homeId === null ? 'obsisim-warning' : '';
}

// The starvation clock is the one cell on this screen that names a deadline, so
// it goes straight to negative the moment it starts rather than passing through
// a warning tier: by the time starvingTicks is above zero the colonist is
// already pinned at hungerMax, and the hunger cell beside it is red too.
function starvingClass(starvingTicks: number): string {
  return starvingTicks > 0 ? 'obsisim-negative' : '';
}

// Both arrival thresholds at once, because the store crossing either one
// changes what the colony can do: below the birth bar it cannot grow at all,
// between the two it can only grow its own, and above both a nomad may join.
// Reads BALANCE rather than repeating 6 and 10, so a retune moves the colours
// with the rules.
function mealsClass(perHead: number): string {
  if (perHead < BALANCE.birthFoodPerHead) return 'obsisim-negative';
  if (perHead < BALANCE.nomadFoodPerHead) return 'obsisim-warning';
  return 'obsisim-positive';
}

// Homelessness is a standing cost (BALANCE.homelessFactor off every one of
// their working ticks) rather than a countdown to a death, so it warns where
// the starvation clock goes straight to negative.
function homelessClass(homeless: number): string {
  return homeless > 0 ? 'obsisim-warning' : '';
}
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>
        Population: <strong>{{ store.snapshot.population }}</strong> —
        <strong data-test="stage-children">{{ store.snapshot.demographics.children }}</strong> children,
        <strong data-test="stage-adults">{{ store.snapshot.demographics.adults }}</strong> adults,
        <strong data-test="stage-elders">{{ store.snapshot.demographics.elders }}</strong> elders
      </span>
      <span data-test="beds">
        Beds: <strong>{{ store.snapshot.beds.occupied }} / {{ store.snapshot.beds.total }}</strong>
        ({{ store.bedsFree }} spare)
      </span>
      <span data-test="homeless" :class="homelessClass(store.snapshot.homeless)">
        Homeless: <strong>{{ store.snapshot.homeless }}</strong>
      </span>
      <span data-test="meals" :class="mealsClass(store.snapshot.mealsPerHead)">
        Meals/head: <strong>{{ store.snapshot.mealsPerHead.toFixed(1) }}</strong>
        (birth at {{ BALANCE.birthFoodPerHead }}, nomad at {{ BALANCE.nomadFoodPerHead }})
      </span>
      <button
        data-test="recruit"
        :disabled="store.nomadBlocker !== null"
        @click="engine.dispatch({ type: 'recruitWorker' })"
      >
        Welcome a nomad
      </button>
      <span v-if="store.nomadBlocker" data-test="recruit-reason">{{ NOMAD_REJECTIONS[store.nomadBlocker] }}</span>
      <span v-if="store.nomadBlocker === 'cooldown'" data-test="recruit-wait">{{ store.recruitCooldownRemaining }}t</span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Colonist</th><th>Age</th><th>Stage</th><th>Home</th><th>Job</th><th>Hunger</th><th>Starving</th><th>Efficiency</th><th>Tool</th></tr>
      </thead>
      <tbody>
        <tr v-for="w in store.snapshot.colonists" :key="w.id">
          <td>#{{ w.id }}</td>
          <td :data-test="`age-${w.id}`">{{ ageLabel(w.ageTicks) }}</td>
          <td :data-test="`stage-${w.id}`">{{ LIFE_STAGE_LABELS[w.stage] }}</td>
          <td :data-test="`commute-${w.id}`" :class="commuteClass(w.homeId)">{{ commuteLabel(w.homeId, w.commuteTiles, w.commuteFactor) }}</td>
          <td>{{ jobLabel(w.buildingId, w.hauling) }}</td>
          <td :data-test="`hunger-${w.id}`" :class="hungerClass(w.hunger)">{{ w.hunger }} / {{ BALANCE.hungerMax }}</td>
          <td :data-test="`starving-${w.id}`" :class="starvingClass(w.starvingTicks)">{{ starvingLabel(w.starvingTicks) }}</td>
          <td>{{ (w.efficiency * 100).toFixed(0) }}%</td>
          <td>{{ toolLabel(w.toolTicks) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
