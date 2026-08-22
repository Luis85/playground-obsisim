<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content';

/*
 * The colony's resource table — tier, stock, delivered/t, consumed/t, net,
 * runway, value — one row per resource. Spec §2.3 names this table twice:
 * once as the Dashboard's own table, and once, "in full", as the Colony
 * panel's (lines 314-316: "the strip along the bottom is the summary; this
 * is the detail behind it" — ResourceStrip, not this table, is the
 * abbreviated surface). Read literally, that is the same seven-column table
 * asked for at both call sites, which is what makes this Task 8's OTHER
 * error, not just the missing columns: the original panel narrowed the
 * table to justify NOT sharing it, when the spec had already settled that
 * a full table belongs in both places.
 *
 * Shared as a component, not a composable, because unlike EconomyPanel's
 * chain table (economy.ts's own comment) the two callers' MARKUP is not
 * just similarly shaped — it is the same markup: same columns in the same
 * order, same formatting, same absence of a click handler on every row
 * (neither DashboardView nor the dock's ColonyPanel has ever wired one).
 * ChainTable.vue needed header/cell slots because EconomyView and
 * EconomyPanel render genuinely different column sets (nine vs four); this
 * table has nothing left that differs, so there is nothing for a slot to
 * hold. That is also why this is a full standalone component reading the
 * store itself (PopulationSummary's own precedent, cited in its own
 * comment) rather than a props-driven one: both callers already read
 * `useGameStore()` for everything AROUND this table (DashboardView's
 * headline, ColonyPanel's guard), so a `Snapshot` prop here would just be a
 * second name for the one store both already hold.
 *
 * What stays OUTSIDE this component, on purpose: DashboardView's headline
 * (wealth, population, buildings, the hauler +/- buttons) has no Colony-panel
 * equivalent at all — the dock has no room for it and no reason to repeat
 * it — so only the `<table>` itself moved here, not the view around it.
 */
const store = useGameStore();
const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <!-- Guarded on `store.snapshot`, the convention every other view and panel
       in this codebase follows (DashboardView, ColonyPanel, ResourceStrip,
       InspectorPanel): both callers already gate their own root on the same
       condition, but a table mounted anywhere that guard is ever loosened
       must not be the thing that turns `store.snapshot!` into a lie. -->
  <table v-if="store.snapshot" class="obsisim-table">
    <thead>
      <tr><th>Resource</th><th>Tier</th><th>Stock</th><th data-test="resource-inflow-heading">Delivered/t</th><th>Cons/t</th><th>Net</th><th>Empties in</th><th>Value</th></tr>
    </thead>
    <tbody>
      <!-- Spec §2.3's inert resource row ("Colony resource row -> nothing"):
           a resource has no subject on the map, in either the routed Ledger
           table or the dock panel. Inertness is the ABSENCE of a click
           handler on this `<tr>` — see PopulationRoster.vue's own comment
           on why a no-op handler would not do the same job — which is what
           `tests/app/dock-panels.test.ts`'s "does not select anything when a
           resource row is clicked" pins down. -->
      <tr v-for="id in RESOURCE_IDS" :key="id" :data-test="`resource-row-${id}`">
        <td>{{ RESOURCES[id].name }}</td>
        <td>{{ RESOURCES[id].tier }}</td>
        <td>{{ store.snapshot.stockpile[id].stock }}</td>
        <td>{{ fmt(store.snapshot.stockpile[id].deliveredRate) }}</td>
        <td>{{ fmt(store.snapshot.stockpile[id].consumptionRate) }}</td>
        <td :class="store.snapshot.stockpile[id].netFlow >= 0 ? 'obsisim-positive' : 'obsisim-negative'">
          {{ fmt(store.snapshot.stockpile[id].netFlow) }}
        </td>
        <td :data-test="`runway-${id}`" :class="{ 'obsisim-negative': store.runwayLow(id) }">
          {{ store.runways[id] !== undefined ? `~${store.runways[id]}t` : '—' }}
        </td>
        <td>{{ store.snapshot.stockpile[id].stockValue.toFixed(0) }}</td>
      </tr>
    </tbody>
  </table>
</template>
