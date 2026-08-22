<script setup lang="ts">
import { useGameStore } from '../../stores/game-store';
import ResourceTable from '../ResourceTable.vue';

// The dock's Colony panel: spec §2.3 (lines 314-316) names this table
// twice over — "the Dashboard's resource table in full: tier, stock,
// delivered/t, consumed/t, net, runway, value... the strip along the
// bottom is the summary; this is the detail behind it" — meaning
// ResourceStrip (Task 6) is the abbreviated surface this panel is measured
// against, not DashboardView's own table. Task 8's original narrower
// four-column table (Resource, Stock, Net, Empties in) answered a
// share-or-separate framing this file used to argue at length in its own
// comment; that framing was the error (see task-8 fix notes), not a
// finding the columns should have stayed narrow. Reopened per §2.7 with
// the columns restored: with all seven figures present this table and
// DashboardView's are the same markup, not two similarly-shaped tables
// (contrast EconomyPanel/EconomyView, whose column COUNTS genuinely
// differ), so they now share one component — see ResourceTable.vue's own
// comment for why a shared component rather than a shared composable, and
// for what deliberately stayed OUTSIDE it (DashboardView's headline has no
// equivalent here).
const store = useGameStore();
</script>

<template>
  <!-- Guarded on `store.snapshot`, the house convention every other view and
       panel in this codebase follows (DashboardView, ResourceStrip,
       InspectorPanel). -->
  <div v-if="store.snapshot" class="obsisim-colony" data-test="colony-panel">
    <ResourceTable />
  </div>
</template>
