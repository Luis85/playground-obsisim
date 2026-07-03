<script setup lang="ts">
import { useGameStore } from '../stores/game-store';

const store = useGameStore();
</script>

<template>
  <div v-if="store.recentNotices.length" class="obsisim-notices">
    <div v-for="notice in store.recentNotices" :key="notice.tick + notice.message" class="obsisim-notice">
      [t{{ notice.tick }}] {{ notice.message }}
    </div>
  </div>
</template>
