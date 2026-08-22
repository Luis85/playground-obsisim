<script setup lang="ts">
import { computed, inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import type { Snapshot } from '../../shared/snapshot';
import { useGameStore } from '../stores/game-store';
import { useUiStore } from '../stores/ui-store';
import { useWorldInteraction } from '../world/interaction';
import { ENGINE_KEY } from '../engine-key';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';
import { describePick, type WorldPick } from '../world/layout';

// The canvas host, and nothing else (spec §2.6 / the increment-11 split).
// WorldView owned six concerns in one file; this component keeps exactly the
// four that touch the renderer directly — boot/dispose lifecycle, snapshot
// sync, hover/tooltip, and the watchers that forward store state through the
// seam. Mode and selection STATE live in the UI store (Task 1); the mode
// machine's BEHAVIOUR (what a click while armed does) lives in
// useWorldInteraction (Task 4). The rail, the dock and the legend are
// WorldScreen's (Task 6) — this component never renders them.
//
// Lifecycle contract unchanged from WorldView: kept alive across tab
// switches by WorldScreen's <keep-alive>, renderer created once per game-view
// open. A rendering failure (sync throw, or an async one reported later via
// onFatal) must never take the tables down — it is reported upward via the
// `fatal` emit, and WorldScreen decides what to show instead.

defineOptions({ name: 'WorldStage' }); // keep-alive include matches on this name

const emit = defineEmits<{ fatal: [message: string] }>();

const store = useGameStore();
const ui = useUiStore();
const interaction = useWorldInteraction();
const engine = inject(ENGINE_KEY)!;
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

/**
 * A selection dies with its subject — and which list decides that depends on
 * what the subject IS. WorldView's original check read a bare numeric
 * `selectedId` against `snapshot.buildings` alone, which was correct back
 * when only a building could be selected. Building and colonist ids are
 * independent counters (spec §2.3 makes a colonist selectable), so applied to
 * a `Selection` that same check would clear a living colonist whose id
 * happens to match no building, and — the sharper failure — KEEP a dead
 * colonist selected whose id happens to match a building that is still
 * there. Move mode's own lifecycle stays building-only regardless, because
 * only a building can ever be moved.
 */
function pruneSelection(snapshot: Snapshot | null) {
  const selection = ui.selection;
  if (selection.kind === 'building' && !snapshot?.buildings.some((b) => b.id === selection.id)) ui.clearSelection();
  if (selection.kind === 'colonist' && !snapshot?.colonists.some((c) => c.id === selection.id)) ui.clearSelection();
  const mode = ui.mode;
  if (mode.kind === 'move' && !snapshot?.buildings.some((b) => b.id === mode.buildingId)) ui.cancelMode();
}

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
  if (ui.mode.kind !== 'idle') {
    // armed: the ghost is the feedback — a tooltip would fight it
    hover.value = null;
    interaction.setHoverTile(renderer?.tileAt(event.pageX, event.pageY) ?? null);
    return;
  }
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

function onPointerLeave() {
  hover.value = null;
  // a ghost left floating at the last hovered tile would outlive the pointer
  interaction.setHoverTile(null);
}

function onContextMenu(event: MouseEvent) {
  if (ui.mode.kind === 'idle') return;
  event.preventDefault();
  ui.cancelMode();
}

// clickTile RETURNS a Command and dispatches nothing itself, so Task 4's
// composable stays testable with no engine at all. That makes this the only
// thing standing between an armed placement and a building: drop the
// dispatch line and every construct/move click still updates the UI, arms,
// disarms and previews correctly while the colony never actually changes.
function onClick(event: MouseEvent) {
  // Preserved from WorldView (inventory E17), deliberately, not by default.
  // The host div below only renders while `renderer` is non-null in steady
  // state (see the template's `v-if="!failure"`, and `failure` and
  // `renderer` are always set together) — so this guard looks redundant.
  // It is not: `created.onFatal`'s callback nulls `renderer` and sets
  // `failure` in the same synchronous tick, one microtask ahead of the
  // re-render that will actually remove the host div. A click landing in
  // that narrow window would otherwise fall through to
  // `interaction.clickPick(null)`, which CLEARS the selection — a spurious
  // deselection caused by a race that is about to hide the canvas anyway.
  // Kept because dropping it trades a silent, rare misbehaviour for a
  // simpler line, which is the wrong trade for a single guard clause.
  if (!renderer) return;
  if (ui.mode.kind !== 'idle') {
    const command = interaction.clickTile(renderer.tileAt(event.pageX, event.pageY));
    if (command !== null) engine.dispatch(command);
    return;
  }
  interaction.clickPick(renderer.pick(event.pageX, event.pageY));
}

// Deletion-inventory A19: arming from a focused palette button by keyboard
// moves no pointer. WorldView's own onArm/onMoveRequest cleared `hover`
// directly because both lived beside it; now arming happens in the store
// (BuildPalette and the Inspector call `ui.armPlace`/`ui.armMove` directly,
// with no seam back into this component's local `hover` ref) and the
// tooltip lives here. Watching the mode's KIND leaving idle is the
// seam-crossing equivalent — every arming path goes through the store, so
// this catches all of them alike, with no per-call-site duplication.
watch(() => ui.mode.kind, (kind) => {
  if (kind !== 'idle') hover.value = null;
});

// The three watchers that forward state through the renderer seam,
// replacing what WorldView used to do inline in the functions that changed
// each piece of state. `renderer` can be null (no factory, a boot failure,
// an async fatal) — every forward is a no-op then, which is correct: there
// is nothing left to draw on.
watch(() => ui.selection, (selection) => renderer?.setSelection(selection), { deep: true });
watch(() => ui.highlight, (subjects) => renderer?.setHighlight(subjects), { deep: true });
// The ghost is the third, and the easiest to forget: WorldView called
// `setGhost` from its own `refreshGhost()`, and that function left with
// WorldView. Task 4 moved the COMPUTATION into `useWorldInteraction().ghost`;
// nothing draws it until this line. Without it, an armed place or move
// dispatches correctly on click and previews nothing at all, and a validity
// change under a stationary pointer (a tile getting built on next to it)
// never reaches the canvas.
watch(interaction.ghost, (ghost) => renderer?.setGhost(ghost), { deep: true });

onMounted(() => {
  if (!factory) {
    // Distinct from a throwing factory below: no provider was registered at
    // all (deletion-inventory A5). Still a fatal condition for this
    // component, so it is still reported the same way.
    failure.value = 'no renderer is registered';
    emit('fatal', failure.value);
    return;
  }
  try {
    const created = factory(host.value!);
    renderer = created;
    created.onFatal((message) => {
      // async engine failure after a successful boot: same fallback path
      failure.value = message;
      renderer = null;
      emit('fatal', message);
    });
    // Registered only on success, and `{ immediate: true }` (deletion-
    // inventory A2): this watcher both replays an already-present snapshot
    // on mount and follows every later ingest. Every test that only ingests
    // AFTER mount stays green with the flag missing, which is exactly why it
    // is called out by name rather than left to be caught incidentally.
    watch(
      () => store.snapshot,
      (snapshot, previousSnapshot) => {
        if (snapshot) created.sync(snapshot);
        revalidateHover(true);
        // Colony reset recycles entity ids from 1: a selected/armed-move id
        // can survive into an unrelated new-timeline building, which the
        // id-based checks in pruneSelection would read as "still there" and
        // keep a stale selection ring on the wrong building. A snapshot that
        // doesn't advance past the previous one's tick is exactly that
        // reset — treat it as a full interaction reset before the id-based
        // checks run. clearSelection() deliberately leaves ui.highlight
        // alone — that is what lets the plural-row flow do
        // clearSelection() then setHighlight(...) without the highlight
        // getting wiped out from under it — so a reset has to clear the
        // highlight itself, or a highlight naming old-timeline ids (e.g.
        // buildings 2 and 3) keeps pulsing whatever now holds those
        // recycled ids in the new colony.
        if (previousSnapshot && snapshot && snapshot.tick <= previousSnapshot.tick) {
          ui.clearSelection();
          ui.cancelMode();
          ui.setHighlight([]);
        }
        pruneSelection(snapshot);
      },
      { immediate: true },
    );
  } catch (error) {
    // A rendering failure must never take the tables down (spec §2.2).
    const message = error instanceof Error ? error.message : String(error);
    failure.value = message;
    renderer = null;
    emit('fatal', message);
  }
});

// Not optional, and not obsolete after the split: WorldScreen stays under
// <keep-alive>, so a trip to /ledger deactivates this component without
// unmounting it. Without these the Excalibur clock keeps running behind the
// Ledger and only final unmount ever stops it.
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
onBeforeUnmount(() => {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div>
    <!--
      A SINGLE root, not the two sibling divs (host, tooltip) this template
      used to render directly (Task 13 fix). `WorldScreen.vue` passes
      `class="obsisim-stage"` to this component, and Vue only forwards a
      fallthrough attribute onto a component's root element automatically
      when that component HAS exactly one root — a multi-root ("fragment")
      template gets no automatic target for it at all. In production that
      failure is silent: the class simply never lands anywhere,
      `.obsisim-stage`'s CSS (the grid-area placement, the `position:
      relative` the hover tooltip below anchors against) never applies, and
      nothing throws. Under `@vue/test-utils` it is not silent — Vue's dev
      build logs an "extraneous non-props attributes... could not be
      automatically inherited" warning on every mount. This wrapper is that
      single root: `class="obsisim-stage"` now lands on it via ordinary
      fallthrough (no `inheritAttrs: false` or manual `v-bind="$attrs"`
      needed, since a single-root component inherits by default), and the
      host/tooltip divs below keep their own `data-test` attributes
      unchanged, so no existing pointer-event or hover test needs to change
      what it queries. (The comment lives INSIDE the root div, not before
      it: a comment as a template-level SIBLING of the root element still
      leaves Vue's own attr fallthrough working, but it also becomes a
      leading child of `$el`'s parent, which is what made an earlier
      version of this comment — placed exactly there — read by
      `@vue/test-utils` as the component's root node instead of the div,
      failing `wrapper.classes()` for a reason that had nothing to do with
      the fix itself.)
    -->
    <div
      v-if="!failure"
      ref="host"
      class="obsisim-world-host"
      data-test="world-host"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @click="onClick"
      @contextmenu="onContextMenu"
    />
    <div
      v-if="!failure && hover && hoverLines.length > 0"
      class="obsisim-world-tooltip"
      data-test="world-tooltip"
      :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
    >
      <div v-for="line in hoverLines" :key="line">{{ line }}</div>
    </div>
  </div>
</template>
