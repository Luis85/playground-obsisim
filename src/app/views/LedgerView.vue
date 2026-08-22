<script setup lang="ts">
// The fallback surface spec §2.5 promises: everything the canvas can do,
// restated as plain tables and buttons that dispatch the same commands.
// LedgerView owns no figures and no derivations of its own — every number
// and every control here is one of the four Ledger-era views, mounted in
// sequence, reading the SAME store getters the dock's panels do (§2.7's "one
// figure, one derivation, two surfaces"). Composing them here rather than
// re-flattening their markup into one file keeps that sharing real: a change
// to, say, BuildingsView's Needs column reaches both its dock twin
// (Inspector) and this page without this file ever being touched.
import DashboardView from './DashboardView.vue';
import BuildingsView from './BuildingsView.vue';
import PopulationView from './PopulationView.vue';
import EconomyView from './EconomyView.vue';
</script>

<template>
  <div class="obsisim-ledger" data-test="ledger">
    <DashboardView />
    <BuildingsView />
    <PopulationView />
    <EconomyView />
  </div>
</template>
