<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useGameStore } from './stores/game-store';
import TopBar from './components/TopBar.vue';
import NoticeBanner from './components/NoticeBanner.vue';

const store = useGameStore();
const route = useRoute();
const tabs = [
  { to: '/', label: 'Dashboard' },
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
      <router-view />
    </main>
    <main v-else class="obsisim-loading">Starting simulation…</main>
  </div>
</template>
