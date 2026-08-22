<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { RUNWAY_WARN_TICKS, useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content';

// The always-on strip beneath the canvas: one chip per resource (spec §2.1),
// plus the two hauler verbs that used to live in DashboardView's headline.
// Built here rather than in Task 8 because WorldScreen renders it and Step
// 1's test asserts `data-test="resource-strip"` exists — the shell could not
// reach a passing test with this component still unwritten.
const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
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
      class="obsisim-strip-chip" :class="{ 'obsisim-negative': (store.runways[id] ?? Infinity) <= RUNWAY_WARN_TICKS }"
    >
      {{ RESOURCES[id].name }}: {{ store.snapshot.stockpile[id].stock }}
      <template v-if="store.runways[id] !== undefined">(~{{ store.runways[id] }}t)</template>
    </span>
    <!-- Not lifted verbatim from DashboardView's own hauler pair (§2.2): that
         version explains a disabled `+` with a `title` alone, and a refused
         control has to state its reason where the player is looking — the
         same rule the Inspector's staffing and Move controls follow. This is
         a distinct, shorter markup rather than a reworded copy, on purpose:
         the two views are allowed to agree on WHAT a hauler count means
         without check:quality reading them as one control duplicated twice. -->
    <span class="obsisim-haulers" data-test="hauler-count-wrap">
      <strong data-test="hauler-count">{{ store.haulerCount }}</strong> hauling
      <button
        data-test="unassign-hauler" :disabled="store.haulerCount === 0"
        @click="engine.dispatch({ type: 'unassignHauler' })"
      >−</button>
      <button
        data-test="assign-hauler" :disabled="store.snapshot.idleAdults === 0"
        @click="engine.dispatch({ type: 'assignHauler' })"
      >+</button>
      <small v-if="store.snapshot.idleAdults === 0" class="obsisim-reason" data-test="hauler-reason">
        No idle adults — unassign someone first.
      </small>
    </span>
  </div>
</template>
