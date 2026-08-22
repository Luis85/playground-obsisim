<script setup lang="ts">
import { RUNWAY_WARN_TICKS, useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content';
import type { ResourceId } from '../../shared/content-types';
import HaulerControls from './HaulerControls.vue';
import Icon from './Icon.vue';

// The always-on strip beneath the canvas: one chip per resource (spec §2.1),
// plus the two hauler verbs that used to live in DashboardView's headline —
// `HaulerControls` now, shared with DashboardView's own copy of the same
// pair (see that component's own comment for why a shared component rather
// than each view's own markup). Built here rather than in Task 8 because
// WorldScreen renders it and Step 1's test asserts `data-test="resource-
// strip"` exists — the shell could not reach a passing test with this
// component still unwritten.
const store = useGameStore();

/** Spec §2.2's runway-warning rule, read by both the chip's colour class and
 * the icon below — one predicate, so a chip that LOOKS low-runway and a chip
 * that shows the warning icon cannot disagree about which resources qualify
 * (the same reason AttentionPanel.vue's `isInert` is shared between its
 * click guard and its template). */
function isLow(id: ResourceId): boolean {
  return (store.runways[id] ?? Infinity) <= RUNWAY_WARN_TICKS;
}
</script>

<template>
  <!-- Guarded on `store.snapshot` the way every other view in this codebase
       already is (BuildingsView, DashboardView, EconomyView, PopulationView,
       PopulationSummary, TopBar). `store.snapshot!` is a lie anywhere the
       router's gate is absent, and mounting this component directly — every
       test in this file does, before seeding — is exactly that absence. -->
  <div v-if="store.snapshot" class="obsisim-strip" data-test="resource-strip">
    <span
      v-for="id in RESOURCE_IDS" :key="id" :data-test="`strip-${id}`"
      class="obsisim-strip-chip" :class="{ 'obsisim-negative': isLow(id) }"
    >
      <!-- The chrome icon spec §2.9 asks for here (this component had no
           emoji before this task — see the task report for why a runway
           warning, mirroring TopBar's own low-food `⚠`, is the icon this
           strip gained rather than a per-resource identity glyph). -->
      <Icon v-if="isLow(id)" name="warning" />
      {{ RESOURCES[id].name }}: {{ store.snapshot.stockpile[id].stock }}
      <template v-if="store.runways[id] !== undefined">(~{{ store.runways[id] }}t)</template>
    </span>
    <HaulerControls />
  </div>
</template>
