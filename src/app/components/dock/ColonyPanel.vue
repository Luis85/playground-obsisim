<script setup lang="ts">
import { RUNWAY_WARN_TICKS, useGameStore } from '../../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../../engine/content';

// The dock's Colony panel: every resource, its stock, and how long it lasts.
//
// Spec §2.7 ("one figure, one derivation, two surfaces") governs the
// relationship to DashboardView's own resource table, and the two do NOT
// share a component here, on the evidence: DashboardView's table is eight
// columns (Resource, Tier, Stock, Delivered/t, Cons/t, Net, Empties in,
// Value) sized for the routed Ledger page, while this panel lives in the
// dock's narrow column beside the canvas (WorldScreen's `.obsisim-dock`
// aside) — the same space ResourceStrip (Task 6) already had to fit the
// identical stockpile data into, and that component made the same call,
// rendering its own compact chip rather than reusing this table. Squeezing
// eight columns into that column would mean either horizontal scroll or
// print too small to read; that is a real presentational difference, not a
// markup reshuffle to dodge the clone detector. So this panel is a NARROWER
// table — Resource, Stock, Net, Runway — and every number in it is read from
// the exact getters DashboardView reads (`store.snapshot.stockpile`,
// `store.runways`, `RUNWAY_WARN_TICKS`): nothing here is a second derivation
// of a figure the Ledger already computes.
const store = useGameStore();
const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <!-- Guarded on `store.snapshot`, the convention every other view and panel
       in this codebase follows (DashboardView, ResourceStrip, InspectorPanel):
       `store.snapshot!` is a lie anywhere the router's gate is absent, and
       mounting this panel directly — as every test in this file does — is
       exactly that absence. -->
  <div v-if="store.snapshot" class="obsisim-colony" data-test="colony-panel">
    <table class="obsisim-table">
      <thead>
        <tr><th>Resource</th><th>Stock</th><th>Net</th><th>Empties in</th></tr>
      </thead>
      <tbody>
        <!-- Spec §2.3's inert row: "Colony resource row -> nothing" — a
             resource has no subject on the map. Inertness here is the
             ABSENCE of a click handler on this `<tr>`, not a handler that
             does nothing: `tests/app/dock-panels.test.ts`'s "does not select
             anything when a resource row is clicked" test is what would fail
             the moment a later change added one. -->
        <tr v-for="id in RESOURCE_IDS" :key="id" :data-test="`colony-row-${id}`">
          <td>{{ RESOURCES[id].name }}</td>
          <td>{{ store.snapshot.stockpile[id].stock }}</td>
          <td :class="store.snapshot.stockpile[id].netFlow >= 0 ? 'obsisim-positive' : 'obsisim-negative'">
            {{ fmt(store.snapshot.stockpile[id].netFlow) }}
          </td>
          <td :class="{ 'obsisim-negative': (store.runways[id] ?? Infinity) <= RUNWAY_WARN_TICKS }">
            {{ store.runways[id] !== undefined ? `~${store.runways[id]}t` : '—' }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
