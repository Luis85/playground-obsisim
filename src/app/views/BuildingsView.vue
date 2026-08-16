<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS } from '../../engine/content';
// Presentation lives in labels.ts, not the shared contract: BUILDING_STATE_LABELS
// (used in the State cell below) is a Record keyed by the BuildingState union,
// so a state added to the union without a matching label is a type error here,
// not a silently-raw string in the rendered table.
import { batchLabel, BUILDING_STATE_LABELS, costLabel, downtimeLabel, needsLabel, recipeLabel, waitingLabel } from '../labels';
import TwoStepButton from '../components/TwoStepButton.vue';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
</script>

<template>
  <div v-if="store.snapshot">
    <h3>Buildings</h3>
    <table class="obsisim-table">
      <thead>
        <tr><th>Building</th><th>Tile</th><th>Waiting</th><th>In</th><th>Needs</th><th>Downtime</th><th>Workers</th><th>State</th><th>Batch / Beds</th><th>Work power</th><th>Tools</th><th /></tr>
      </thead>
      <tbody>
        <tr v-for="b in store.snapshot.buildings" :key="b.id" :data-test="`building-row-${b.id}`">
          <td>{{ BUILDINGS[b.defId].name }}</td>
          <td>({{ b.col }}, {{ b.row }})</td>
          <td :data-test="`waiting-${b.id}`">{{ waitingLabel(b.storage, b.stored, b.buffered) }}</td>
          <td :data-test="`in-${b.id}`">{{ b.inputBuffered }}</td>
          <!-- A site's shortfall, per material (§2.10's "needs 14 wood") — the
               only way to tell a site that is WAITING from one that is
               STUCK, both of which read `underConstruction` alike. `{}` for
               everything that is not a site, which needsLabel renders as
               the same em dash `downtimeLabel` uses for "nothing to show". -->
          <td :data-test="`needs-${b.id}`">{{ needsLabel(b.constructionNeeds) }}</td>
          <td :data-test="`downtime-${b.id}`">{{ downtimeLabel(b.relocatingTicks) }}</td>
          <td>
            <button :data-test="`unassign-${b.id}`" :disabled="b.workers === 0" @click="engine.dispatch({ type: 'unassignWorker', buildingId: b.id })">−</button>
            {{ b.workers }} / {{ b.workerSlots }}
            <button :data-test="`assign-${b.id}`" :disabled="b.workers >= b.workerSlots || store.snapshot.idleAdults === 0" @click="engine.dispatch({ type: 'assignWorker', buildingId: b.id })">+</button>
          </td>
          <td>{{ BUILDING_STATE_LABELS[b.state] }}</td>
          <td :data-test="`batch-${b.id}`">{{ batchLabel(b.beds, b.occupants, b.progressPct) }}</td>
          <td>{{ b.workPower.toFixed(2) }}</td>
          <td>{{ b.tooledWorkers > 0 ? `⚒ ${b.tooledWorkers}/${b.workers}` : '—' }}</td>
          <td>
            <TwoStepButton
              label="Demolish" confirm-label="Confirm demolish?" :data-test="`demolish-${b.id}`"
              @confirm="engine.dispatch({ type: 'demolishBuilding', buildingId: b.id })"
            />
          </td>
        </tr>
        <tr v-if="store.snapshot.buildings.length === 0">
          <td colspan="12">
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
          <td>{{ recipeLabel(BUILDINGS[id]) }}</td>
          <td>
            <!-- NOT disabled on affordability (spec §2.1, increment 10): an
                 order is a request the queue fills over time, so this button
                 always dispatches. `affordableDefs` only informs the tooltip
                 now — the one place left that still says what is short. -->
            <button
              :data-test="`construct-${id}`"
              :title="store.affordableDefs[id] ? 'Placed automatically — pick the tile yourself in the World tab' : 'Not enough resources'"
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
