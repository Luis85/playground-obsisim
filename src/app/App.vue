<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useGameStore } from './stores/game-store';
import TopBar from './components/TopBar.vue';
import NoticeBanner from './components/NoticeBanner.vue';

const store = useGameStore();
const route = useRoute();
const tabs = [
  { to: '/', label: 'Dashboard' },
  { to: '/world', label: 'World' },
  { to: '/buildings', label: 'Buildings' },
  { to: '/population', label: 'Population' },
  { to: '/economy', label: 'Economy' },
];
</script>

<template>
  <div class="obsisim">
    <TopBar />
    <div v-if="store.error" class="obsisim-error" data-test="error-banner">
      Simulation paused on error: {{ store.error }}
    </div>
    <NoticeBanner />
    <nav class="obsisim-nav">
      <router-link
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="obsisim-tab"
        :class="{ 'is-active': route.path === tab.to }"
      >
        {{ tab.label }}
      </router-link>
    </nav>
    <main v-if="store.snapshot">
      <!-- WorldScreen stays alive across tab switches: its Excalibur engine
           (and WebGL context) must boot once per view open, not per visit.
           `include` matches on the component's `defineOptions({ name })` —
           WorldView was renamed to WorldScreen in the increment-11 split
           (Task 6), and this string has to move in the same commit or
           keep-alive silently stops applying (no error, no failing test —
           the WebGL context is torn down and rebuilt on every tab visit). -->
      <router-view v-slot="{ Component }">
        <keep-alive include="WorldScreen">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
    <main v-else class="obsisim-loading">Starting simulation…</main>
  </div>
</template>
