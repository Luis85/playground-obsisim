<script setup lang="ts">
import { computed, inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../stores/game-store';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';
import { describePick, type WorldPick } from '../world/layout';
import WorldLegend from '../components/WorldLegend.vue';

// Lifecycle contract (spec §2.2): this view is kept alive by App.vue, so the
// renderer — and its WebGL context — is created once per game-view open, not
// once per tab visit. Tab switches only stop and restart the render clock
// (onDeactivated/onActivated); real teardown happens when the Obsidian view
// closes and the app unmounts (onBeforeUnmount -> dispose).

defineOptions({ name: 'WorldView' }); // keep-alive include matches on this name
const store = useGameStore();
const factory = inject(WORLD_RENDERER_KEY, null);
const host = ref<HTMLElement | null>(null);
const failure = ref<string | null>(null);
const hover = ref<{ x: number; y: number; pageX: number; pageY: number; pick: WorldPick } | null>(null);
let renderer: WorldRenderer | null = null;
let hoverRecheck: ReturnType<typeof setTimeout> | null = null;

// Derived reactively so a stationary pointer keeps live details (batch
// progress, hunger, tool ticks) as snapshots tick underneath it; an entity
// vanishing mid-hover yields no lines and the tooltip hides itself.
const hoverLines = computed(() => {
  if (!hover.value || !store.snapshot) return [];
  return describePick(store.snapshot, hover.value.pick);
});

// A stationary pointer must not keep describing a worker that walked away:
// re-run the live hit-test at the stored pointer position on every snapshot,
// and once more after the walk animation has settled (no snapshots arrive
// for the animation tail, none at all while paused — review round 9).
function armHoverRecheck() {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  hoverRecheck = setTimeout(() => revalidateHover(false), 2000);
}

function revalidateHover(scheduleTail: boolean) {
  if (!hover.value || !renderer) return;
  const fresh = renderer.pick(hover.value.pageX, hover.value.pageY);
  if (!fresh) {
    hover.value = null;
    return;
  }
  hover.value = { ...hover.value, pick: fresh };
  if (scheduleTail) armHoverRecheck();
}

function onPointerMove(event: MouseEvent) {
  const pick = renderer?.pick(event.pageX, event.pageY) ?? null;
  if (!pick || !host.value) {
    hover.value = null;
    return;
  }
  const rect = host.value.getBoundingClientRect();
  hover.value = {
    x: event.clientX - rect.left + 14,
    y: event.clientY - rect.top + 14,
    pageX: event.pageX,
    pageY: event.pageY,
    pick,
  };
  armHoverRecheck();
}

onMounted(() => {
  if (!factory) {
    failure.value = 'no renderer is registered';
    return;
  }
  try {
    const created = factory(host.value!);
    renderer = created;
    created.onFatal((message) => {
      // async engine failure after a successful boot: same fallback path
      failure.value = message;
      renderer = null;
    });
    // registered only on success, immediate: the watcher both replays an
    // already-present snapshot and follows every later ingest
    watch(
      () => store.snapshot,
      (snapshot) => {
        if (snapshot) created.sync(snapshot);
        revalidateHover(true);
      },
      { immediate: true },
    );
  } catch (error) {
    // A rendering failure must never take the tables down (spec §2.2).
    failure.value = error instanceof Error ? error.message : String(error);
    renderer = null;
  }
});
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
onBeforeUnmount(() => {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). The table views keep working.
  </div>
  <div v-else class="obsisim-world">
    <div
      ref="host"
      class="obsisim-world-host"
      data-test="world-host"
      @pointermove="onPointerMove"
      @pointerleave="hover = null"
    />
    <div
      v-if="hover && hoverLines.length > 0"
      class="obsisim-world-tooltip"
      data-test="world-tooltip"
      :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
    >
      <div v-for="line in hoverLines" :key="line">{{ line }}</div>
    </div>
    <WorldLegend />
  </div>
</template>
