<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import type { BuildingDefId } from '../../shared/content-types';
import { useUiStore, type DockPanel } from '../stores/ui-store';
import WorldStage from './WorldStage.vue';
import BuildPalette from '../components/BuildPalette.vue';
import ResourceStrip from '../components/ResourceStrip.vue';
import WorldLegend from '../components/WorldLegend.vue';

// The shell that composes what WorldView used to own in one 339-line file
// (spec §2.1 / the increment-11 split): the rail (BuildPalette), the canvas
// (WorldStage, Task 5), the dock (Tasks 7-11 fill its five panels; this task
// renders only the slot and its overlay behaviour), the resource strip, and
// the legend. What stays HERE rather than moving to WorldStage or the store
// is exactly what depended on the PANE'S OWN geometry or its own visibility
// as a routed, kept-alive view: the narrow-layout ResizeObserver and the
// window-level Escape ladder (worldview-inventory E19-E21, E38).

defineOptions({ name: 'WorldScreen' }); // keep-alive include matches on this name — see App.vue

const ui = useUiStore();
const failure = ref<string | null>(null);
const root = ref<HTMLElement | null>(null);

/*
 * Two consumers, deliberately. The local ref renders the inline fallback for
 * the frame before navigation lands (and for a WorldScreen mounted outside the
 * router, which the tests do). The store write is what `App.vue` watches to
 * reach the Ledger at all — see ui-store's comment on `rendererFailure`.
 */
function onFatal(message: string) {
  failure.value = message;
  ui.reportRendererFailure(message);
}

/** Below this the dock overlays the canvas instead of shrinking it, and the
 * rail collapses. Measured on the PANE, not the window: this view can be
 * dragged into an Obsidian sidebar beside a full-width note (spec §2.1). */
const NARROW_PX = 720;

/*
 * In a narrow pane the rail collapses to one Build control that opens the
 * palette as a popover (spec §2.1). This has to be state rather than CSS: CSS
 * can hide or shrink the palette, but it cannot make an operable popover, and a
 * rail that collapsed with no replacement control would put constructBuilding
 * out of reach in exactly the layout the collapse is for.
 */
const railOpen = ref(false);
const paletteVisible = computed(() => !ui.narrow || railOpen.value);

/**
 * A placeholder label for the panel Tasks 7-11 have not built yet. Reading
 * `DockPanel` here rather than leaving the dock a bare box does two things at
 * once: it gives the player SOME feedback that their click landed (rather
 * than an empty grey rectangle that looks broken), and it is a genuine call
 * site for the `DockPanel` type — which otherwise has no consumer outside the
 * file that declares it until Task 7 lands, and would be flagged as dead
 * code by `check:quality` in the meantime.
 */
const DOCK_PANEL_LABELS: Record<DockPanel, string> = {
  inspector: 'Inspector', colony: 'Colony', population: 'Population', economy: 'Economy', attention: 'Attention',
};

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (ui.escape()) event.preventDefault();
}

/*
 * The listener is bound to VISIBILITY, not to mount, and that distinction is
 * load-bearing: this component stays under <keep-alive>, so a trip to /ledger
 * deactivates it without unmounting it. A mount-scoped listener would keep
 * running behind the Ledger — clearing the hidden world's mode, selection or
 * dock, and swallowing an Escape the Ledger or Obsidian itself wanted.
 *
 * This is `WorldView`'s `viewActive` guard in its new home (worldview-
 * inventory E20/E21). It was written for the tab switches this increment
 * deletes; the one route trip that survives — World to the Ledger and back —
 * is exactly the case it still covers.
 */
let listening = false;
function listen(on: boolean) {
  if (on === listening) return;
  if (on) window.addEventListener('keydown', onKeydown);
  else window.removeEventListener('keydown', onKeydown);
  listening = on;
}

let observer: ResizeObserver | null = null;
onMounted(() => {
  listen(true);
  if (root.value !== null && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(([entry]) => ui.setNarrow(entry.contentRect.width < NARROW_PX));
    observer.observe(root.value);
  }
});
onActivated(() => listen(true));
onDeactivated(() => listen(false));
onBeforeUnmount(() => {
  listen(false); // worldview-inventory E38
  observer?.disconnect();
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). Open the Ledger to keep playing.
  </div>
  <div v-else ref="root" class="obsisim-world-screen" :class="{ 'is-narrow': ui.narrow }">
    <button
      v-if="ui.narrow" data-test="rail-toggle" :class="{ 'is-armed': railOpen }"
      @click="railOpen = !railOpen"
    >
      Build
    </button>
    <BuildPalette
      v-if="paletteVisible" class="obsisim-rail"
      :armed-def-id="ui.mode.kind === 'place' ? ui.mode.defId : null"
      @arm="(id: BuildingDefId) => { ui.armPlace(id); railOpen = false; }" @disarm="ui.cancelMode"
    />
    <WorldStage class="obsisim-stage" @fatal="onFatal" />
    <!-- `is-overlay` is state, not a media query, so criterion 7's other half
         is assertable in jsdom: the CSS keys off this class rather than off a
         container query alone, and a test can prove the dock stops taking a
         grid column instead of only proving the rail collapsed. -->
    <aside v-if="ui.panel" class="obsisim-dock" :class="{ 'is-overlay': ui.narrow }" data-test="dock">
      <!-- Tasks 7-11 replace this with the five panels. -->
      {{ DOCK_PANEL_LABELS[ui.panel] }}
    </aside>
    <ResourceStrip class="obsisim-strip" />
    <WorldLegend />
  </div>
</template>
