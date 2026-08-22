<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useGameStore } from './stores/game-store';
import { useUiStore } from './stores/ui-store';
import TopBar from './components/TopBar.vue';
import NoticeBanner from './components/NoticeBanner.vue';

// Two routes now (Task 12), not five: the canvas at `/` is the primary play
// surface, and `/ledger` is everything the canvas can do restated as tables
// (spec §2.5). The old five-tab `<nav>` is gone with the four routes it
// pointed at; what replaces it is one toggle, not a strip, because there is
// only one other place left to go.
const store = useGameStore();
const ui = useUiStore();
const route = useRoute();
const router = useRouter();

/*
 * A renderer failure — boot or post-boot alike — lands the player on the
 * Ledger with a banner naming it (spec §2.5's third criterion). Watched here,
 * not handled as an event from WorldStage or WorldScreen: `App.vue` has no
 * template handle on whatever the router is currently showing, so an
 * `emit('fatal')` from a routed child would reach nobody. `ui.rendererFailure`
 * (ui-store.ts) is the seam WorldScreen already writes on both failure paths
 * — `onFatal(message)` covers a synchronous factory throw AND the async
 * `created.onFatal` callback registered only after a successful boot — so
 * one watcher here covers both without this file needing to know which kind
 * fired.
 *
 * Not reset on navigating back to `/`: once the renderer has failed there is
 * nothing that un-fails it (a fresh boot only happens on a full reload), so
 * the banner and the redirect both stay live until then. `void`, matching
 * the router's own fire-and-forget convention elsewhere in this file (see
 * `toggleRoute` below) — a rejected navigation here is not actionable.
 */
watch(() => ui.rendererFailure, (failure) => {
  if (failure !== null) void router.push('/ledger');
});

function toggleRoute() {
  void router.push(route.path === '/ledger' ? '/' : '/ledger');
}
</script>

<template>
  <div class="obsisim">
    <TopBar />
    <div v-if="store.error" class="obsisim-error" data-test="error-banner">
      Simulation paused on error: {{ store.error }}
    </div>
    <!-- Persistent, not tied to WorldScreen's own local fallback (which only
         covers the one frame before this navigation lands, and only while
         `/` is the active route — see WorldScreen.vue's own comment on why
         it keeps a local `failure` ref too): this banner is what the player
         sees regardless of which route they are on once the canvas has
         failed. -->
    <div v-if="ui.rendererFailure" class="obsisim-error" data-test="renderer-banner">
      World view unavailable ({{ ui.rendererFailure }}). Showing the Ledger.
    </div>
    <NoticeBanner />
    <nav class="obsisim-route-toggle">
      <button data-test="ledger-toggle" @click="toggleRoute">
        {{ route.path === '/ledger' ? 'World' : 'Ledger' }}
      </button>
    </nav>
    <main v-if="store.snapshot">
      <!-- WorldScreen stays alive across the Ledger round trip: its Excalibur
           engine (and WebGL context) must boot once per view open, not once
           per visit. `include` matches on the component's own
           `defineOptions({ name })` — WorldView was renamed to WorldScreen in
           the increment-11 split (Task 6), and this string has to move in
           the same commit as any future rename or keep-alive silently stops
           applying (no error, no failing test — the WebGL context is torn
           down and rebuilt on every `/ledger` trip; criterion 5 is what
           catches this if it ever drifts again — see
           tests/app/ledger-view.test.ts). -->
      <router-view v-slot="{ Component }">
        <keep-alive include="WorldScreen">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
    <main v-else class="obsisim-loading">Starting simulation…</main>
  </div>
</template>
