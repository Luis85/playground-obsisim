<script setup lang="ts">
import { inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../stores/game-store';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';

defineOptions({ name: 'WorldView' }); // keep-alive include matches on this name
const store = useGameStore();
const factory = inject(WORLD_RENDERER_KEY, null);
const host = ref<HTMLElement | null>(null);
const failure = ref<string | null>(null);
let renderer: WorldRenderer | null = null;

onMounted(() => {
  if (!factory) {
    failure.value = 'no renderer is registered';
    return;
  }
  try {
    renderer = factory(host.value!);
    if (store.snapshot) renderer.sync(store.snapshot);
  } catch (error) {
    // A rendering failure must never take the tables down (spec §2.2).
    failure.value = error instanceof Error ? error.message : String(error);
    renderer = null;
  }
});
watch(
  () => store.snapshot,
  (snapshot) => {
    if (snapshot && renderer) renderer.sync(snapshot);
  },
);
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
onBeforeUnmount(() => {
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). The table views keep working.
  </div>
  <div v-else ref="host" class="obsisim-world-host" data-test="world-host" />
</template>
