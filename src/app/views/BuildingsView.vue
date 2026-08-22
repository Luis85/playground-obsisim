<script setup lang="ts">
import { inject, reactive, watch } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS } from '../../engine/content';
import { costLabel, recipeLabel } from '../labels';
import BuildingTableRow from '../components/BuildingTableRow.vue';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

/**
 * Per-building typed Move targets — the Ledger's own fallback for the
 * canvas's drag-a-ghost-and-click (spec §2.2). A `reactive<Record<...>>({})`
 * with nothing else would type-check and then throw the moment
 * `BuildingTableRow` reads `moveTarget.col` for a building that arrived
 * before this watch ever ran, which takes down the Ledger — the one route
 * that exists so a broken renderer stays survivable. So this is seeded, not
 * merely declared, and the watch keeps seeding: `immediate: true` covers the
 * first render, and every later run covers a building that appears WHILE
 * the Ledger is open (a construction site completing has nothing to do with
 * which route is showing).
 *
 * Defaulted to the building's CURRENT tile: a valid starting value, and the
 * useful one — the fields show where the building already is, so a mistyped
 * move reads as a visible edit rather than a jump from (0, 0). An existing
 * entry is never overwritten: `store.snapshot` refreshes roughly twice a
 * second, and clobbering whatever the player is halfway through typing on
 * every tick would make this control unusable while unpaused.
 *
 * Entries for a demolished building are left behind on purpose: nothing
 * reads a stale entry (the row it belonged to no longer renders), and
 * pruning it would only invite the id-reuse bug a colony reset already
 * causes elsewhere (`renderer.ts` recycles entity ids from 1) — a pruned-
 * then-recreated id would need reseeding anyway, which this watch already
 * does for free.
 *
 * That "id-reuse bug" is not hypothetical for THIS record — it is the exact
 * shape of the defect fixed here. Demolishing a building and a colony reset
 * both recycle ids, but only demolition is safe to handle by doing nothing:
 * a demolished building's row is gone, so a stale entry sits inert. A reset
 * is different — `GameEngine.reset()` publishes a fresh snapshot whose ids
 * restart at 1, so the NEW starter building at id 1 inherits whatever
 * coordinates a player had typed for the OLD id-1 building in the timeline
 * that just ended. If that stale tile happens to still be a valid move
 * target in the new colony, the Ledger renders an enabled Move button aimed
 * at the wrong destination with no visible sign anything is wrong. Fill-
 * only-missing (the loop below) cannot catch this on its own: the id is not
 * missing, it is present and wrong.
 *
 * Detected the same way `WorldStage.vue` already detects a reset — a
 * snapshot whose `tick` does not advance past the previous one's — and
 * deliberately matching that file's condition character-for-character
 * (`snapshot.tick <= previousSnapshot.tick`) rather than writing a second,
 * differently-worded reset check: two independent definitions of "this is a
 * reset" are two places that can silently drift apart if the engine's reset
 * semantics ever change. On a detected reset every entry is cleared before
 * the fill-only-missing loop runs, so every building in the new snapshot —
 * including one reusing an old id — reseeds from ITS OWN current tile
 * rather than surviving with the old timeline's typed value.
 */
const moveTargets = reactive<Record<number, { col: number; row: number }>>({});
watch(
  () => store.snapshot,
  (snapshot, previousSnapshot) => {
    if (previousSnapshot && snapshot && snapshot.tick <= previousSnapshot.tick) {
      for (const id of Object.keys(moveTargets)) delete moveTargets[Number(id)];
    }
    for (const b of snapshot?.buildings ?? []) {
      if (moveTargets[b.id] === undefined) moveTargets[b.id] = { col: b.col, row: b.row };
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="store.snapshot">
    <h3>Buildings</h3>
    <table class="obsisim-table">
      <thead>
        <tr>
          <th>Building</th><th>Tile</th><th>Waiting</th><th>In</th><th>Needs</th><th>Downtime</th><th>Ticks</th>
          <th>Workers</th><th>State</th><th>Batch / Beds</th><th>Work power</th><th>Tools</th><th>Move</th><th />
        </tr>
      </thead>
      <tbody>
        <!-- One row per building, in `BuildingTableRow.vue` — see that
             component's own comment for why the row is its own file. -->
        <BuildingTableRow
          v-for="b in store.snapshot.buildings" :key="b.id"
          :building="b" :idle-adults="store.snapshot.idleAdults"
          :map="store.snapshot.map" :buildings="store.snapshot.buildings"
          v-model:move-col="moveTargets[b.id].col" v-model:move-row="moveTargets[b.id].row"
        />
        <tr v-if="store.snapshot.buildings.length === 0">
          <td colspan="14">
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
                 now — the one place left that still says what is short, so
                 the unaffordable branch reads as advice about what happens
                 next rather than a reason the click was refused. The "picked
                 automatically" hint is true regardless of affordability, so
                 both branches carry it. -->
            <button
              :data-test="`construct-${id}`"
              :title="store.affordableDefs[id] ? 'Placed automatically — pick the tile yourself afterward, with Move or in World view' : 'Short on resources — placed now, fills in as goods arrive; pick the tile yourself afterward, with Move or in World view'"
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
