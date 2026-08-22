<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import type { BuildingDefId } from '../../shared/content-types';
import { useUiStore } from '../stores/ui-store';
import WorldStage from './WorldStage.vue';
import BuildPalette from '../components/BuildPalette.vue';
import ResourceStrip from '../components/ResourceStrip.vue';
import WorldLegend from '../components/WorldLegend.vue';
import DockTabs from '../components/DockTabs.vue';
import DockBody from '../components/DockBody.vue';

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
 * The Inspector's remount key — LOAD BEARING, not decorative (see
 * `.superpowers/sdd/task-7-key-defect.md`). `TwoStepButton` holds its `armed`
 * ref internally, and Vue only tears a component down and rebuilds it when
 * its `:key` changes; without one, arming Demolish on building A and then
 * selecting building B would hand B a button one tap from confirming, because
 * nothing ever asked TwoStepButton to forget A. Keying on the selection is
 * what forces that remount on every subject change.
 *
 * `${kind}-${id}`, not a bare numeric id: spec §2.3 makes colonists selectable
 * alongside buildings, and building 3 / colonist 3 would otherwise share a key
 * and NOT remount between them — the exact bug this key exists to prevent,
 * just moved to a different pair of subjects.
 *
 * Extracted to a named computed, rather than restated inline in the template,
 * so `tests/app/dock-panels.test.ts`'s `mountKeyedInspector` helper — which
 * mounts the Inspector "the way WorldScreen does" — has one real expression to
 * point back at instead of a second copy of this string that could drift from
 * it unnoticed.
 */
const inspectorKey = computed(() => `${ui.selection.kind}-${'id' in ui.selection ? ui.selection.id : 0}`);

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
      v-if="ui.narrow" class="obsisim-rail-toggle" data-test="rail-toggle" :class="{ 'is-armed': railOpen }"
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
    <!-- Always mounted, outside the dock's own `v-if` — see DockTabs.vue's
         own comment for why it is a separate component and why it has to
         live here regardless of whether a panel is open. -->
    <DockTabs />
    <!-- The dock's body — see DockBody.vue's own comment for why the panel
         switch lives there rather than inline here, and for why
         `inspectorKey` is passed down rather than recomputed. -->
    <DockBody :inspector-key="inspectorKey" />
    <ResourceStrip class="obsisim-strip" />
    <WorldLegend />
  </div>
</template>
