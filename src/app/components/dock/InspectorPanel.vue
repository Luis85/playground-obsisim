<script setup lang="ts">
import { computed, inject } from 'vue';
import { BUILDINGS } from '../../../engine/content';
import { ENGINE_KEY } from '../../engine-key';
import { useGameStore } from '../../stores/game-store';
import { useUiStore } from '../../stores/ui-store';
// Presentation lives in labels.ts, never in the template — the same
// convention BuildingsView and PopulationView already follow, so a building
// or colonist figure the Inspector shows is never a second derivation of a
// number one of those views also renders (spec §2.7).
import { BUILDING_STATE_LABELS } from '../../labels';
import InspectorColonist from './InspectorColonist.vue';
import InspectorFooter from './InspectorFooter.vue';
import InspectorHouse from './InspectorHouse.vue';
import InspectorProducer from './InspectorProducer.vue';
import InspectorStorehouse from './InspectorStorehouse.vue';

// SelectionPanel is what this becomes (spec §2.3): the same building card,
// now driven by the shared selection (colonists are selectable too, and this
// panel is the one that lists a house's occupants as a route TO that), plus
// staffing controls the canvas never had, plus one detail region per building
// kind instead of a flat card that showed every field for every kind.
//
// The per-kind detail (InspectorProducer/House/Storehouse) and the shared
// footer (InspectorFooter: construction/relocation countdowns, Move,
// Demolish) each live in their own file rather than as branches of this
// template — a single template carrying every kind's fields plus the footer
// tripped fallow's cognitive-complexity gate (`complexFunctions` in
// `scripts/check-quality.mjs`), and the split follows spec §2.3's own table:
// one component per row, exactly as `recipeLabel` already branches on the
// same distinction between a producer, a house and a storehouse.
const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const ui = useUiStore();

const building = computed(() => {
  // Read once into a local: `ui.selection` is a Pinia getter, and narrowing a
  // discriminated union across two SEPARATE reads of the same getter (one for
  // `.kind`, one for `.id`) is not something TS's control-flow analysis does
  // — the local binding is what makes `.id` visible after the `.kind` check.
  const selection = ui.selection;
  if (selection.kind !== 'building') return null;
  return store.snapshot?.buildings.find((b) => b.id === selection.id) ?? null;
});

const colonist = computed(() => {
  const selection = ui.selection;
  if (selection.kind !== 'colonist') return null;
  return store.snapshot?.colonists.find((c) => c.id === selection.id) ?? null;
});

/**
 * A house's occupants, as rows the player can click through to the colonist
 * (spec §2.3's table: "Inspector occupant row -> selects that colonist").
 * Derived from who points home HERE, never stored — so it cannot desync from
 * the colonists the way a locally cached list could.
 */
const occupants = computed(() => {
  const b = building.value;
  if (b === null) return [];
  return store.snapshot?.colonists.filter((c) => c.homeId === b.id) ?? [];
});

/**
 * Which detail region a selected building gets (spec §2.3's table has four,
 * one per row). A site under construction wins regardless of what it will
 * become: `progressPct`, `workPower` and the rest have no meaning yet, and
 * `constructionTicks` is the only figure worth showing while it stands. Once
 * settled, the def's own shape (a recipe, beds, or storage) decides the rest
 * — the exact branching `recipeLabel` already uses, restated here because a
 * building card needs to pick ONE region to render, not just one string.
 * 'site' has no component of its own: InspectorFooter already renders the
 * construction countdown for any building whose `constructionTicks > 0`, so a
 * site simply gets none of the three per-kind components below.
 */
type BuildingKind = 'site' | 'producer' | 'house' | 'storehouse';
const kind = computed<BuildingKind | null>(() => {
  const b = building.value;
  if (b === null) return null;
  if (b.constructionTicks > 0) return 'site';
  const def = BUILDINGS[b.defId];
  if (def.recipe !== null) return 'producer';
  if (def.beds > 0) return 'house';
  return 'storehouse';
});

/**
 * Why Assign is disabled, or null when it isn't — one helper `:disabled` and
 * the reason text both read, so the two can never name different conditions
 * (spec §2.2). Three branches, all stated: a site refuses staffing outright
 * (`handleAssignWorker`) even though it keeps its def's `workerSlots`, a full
 * building has nowhere to put another worker, and an empty labour pool is a
 * colony-wide fact rather than anything about this building.
 */
const staffingReason = computed(() => {
  const b = building.value;
  if (b === null) return null;
  if (b.constructionTicks > 0) return 'A construction site cannot be staffed until it is finished.';
  if (b.workers >= b.workerSlots) return 'Every slot is filled.';
  if (store.snapshot!.idleAdults === 0) return 'No idle adults — unassign someone first.';
  return null;
});
</script>

<template>
  <div v-if="building" class="obsisim-inspector" data-test="inspector">
    <header class="obsisim-inspector-header">
      <strong>{{ BUILDINGS[building.defId].name }}</strong>
      <span>({{ building.col }}, {{ building.row }})</span>
      <span>{{ BUILDING_STATE_LABELS[building.state] }}</span>
    </header>

    <!-- Stated in the panel rather than in a `title`: spec §2.2 makes explicit
         what SelectionPanel already argued for Move — a control the engine
         would refuse must say so where the player is looking. -->
    <div class="obsisim-inspector-staffing">
      <button
        data-test="inspector-unassign" :disabled="building.workers === 0"
        @click="engine.dispatch({ type: 'unassignWorker', buildingId: building.id })"
      >−</button>
      <span>{{ building.workers }} / {{ building.workerSlots }}</span>
      <button
        data-test="inspector-assign" :disabled="staffingReason !== null"
        @click="engine.dispatch({ type: 'assignWorker', buildingId: building.id })"
      >+</button>
    </div>
    <p v-if="staffingReason" class="obsisim-reason" data-test="inspector-staffing-reason">{{ staffingReason }}</p>

    <InspectorProducer v-if="kind === 'producer'" :building="building" />
    <InspectorHouse v-else-if="kind === 'house'" :building="building" :occupants="occupants" />
    <InspectorStorehouse v-else-if="kind === 'storehouse'" :building="building" />

    <InspectorFooter :building="building" />
  </div>
  <InspectorColonist v-else-if="colonist" :colonist="colonist" />
</template>
