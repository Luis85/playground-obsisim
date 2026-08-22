<script setup lang="ts">
// The dock's Population panel: stage counts, beds, "Welcome a nomad", and the
// colonist table — all of it PopulationRoster.vue, the same component
// PopulationView.vue renders on the routed Ledger page. See that file's own
// comment for why the markup is shared rather than copied: this is the first
// dock panel whose rows select something on the map (spec §2.3 — a Population
// colonist row selects that colonist), and that behaviour, like every other
// cell in the table, lives in the one component both surfaces mount.
//
// Guarded on `store.snapshot`, the house convention every other view/panel in
// this codebase follows (DashboardView, ResourceStrip, InspectorPanel,
// ColonyPanel) — PopulationRoster guards itself too, so this is belt-and-
// braces rather than load-bearing, but it is what lets this panel render
// nothing (not an empty wrapper div) before the first snapshot arrives, the
// same as every sibling panel.
import { useGameStore } from '../../stores/game-store';
import PopulationRoster from '../PopulationRoster.vue';

const store = useGameStore();
</script>

<template>
  <div v-if="store.snapshot" class="obsisim-population" data-test="population-panel">
    <PopulationRoster />
  </div>
</template>
