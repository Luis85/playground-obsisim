<script setup lang="ts">
import { useGameStore } from '../stores/game-store';

// Keyed by notice.id, not tick+kind+message: one tick can drain several
// identical commands (two assign clicks on the same building before the
// next step), which would otherwise produce a duplicate Vue key and let Vue
// reuse or drop rows on the next update. id is a store-monotonic counter, so
// it stays unique even for byte-identical notices in the same tick.
//
// The kind-based class ('is-success' / 'is-rejection', see styles.css) is
// what makes a success visually distinct from a rejection at a glance,
// rather than the reader having to parse the message text itself.
const store = useGameStore();
</script>

<template>
  <div v-if="store.recentNotices.length" class="obsisim-notices">
    <div
      v-for="notice in store.recentNotices"
      :key="notice.id"
      :class="['obsisim-notice', `is-${notice.kind}`]"
    >
      [t{{ notice.tick }}] {{ notice.message }}
    </div>
  </div>
</template>
