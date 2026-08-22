<script setup lang="ts">
// The Ledger's Population page. All of the behaviour lives in
// PopulationRoster.vue (headline + colonist table), shared verbatim with the
// dock's Population panel — see that file's own comment for why this is one
// component with two render sites rather than two copies of the same table.
// This file stays as its own route/component (spec §2.7: PopulationView loses
// its route in a later task, not its table, and not yet in this one).
import PopulationRoster from '../components/PopulationRoster.vue';
</script>

<template>
  <PopulationRoster />
</template>
