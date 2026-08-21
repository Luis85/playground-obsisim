<script setup lang="ts">
import { computed, inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../stores/game-store';
import { ENGINE_KEY } from '../engine-key';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';
import { describePick, type WorldPick } from '../world/layout';
import { isTileBuildable } from '../../shared/placement';
import type { BuildingDefId } from '../../shared/content-types';
import WorldLegend from '../components/WorldLegend.vue';
import BuildPalette from '../components/BuildPalette.vue';
import SelectionPanel from '../components/SelectionPanel.vue';

// Lifecycle contract (increment 2 spec §2.2) unchanged: kept alive across
// tab switches, renderer created once per game-view open. NEW (increment 3
// spec §2.6): this view owns the interaction mode machine — idle / place /
// move — plus the selection; the renderer stays a dumb drawer behind the
// seam and the ENGINE stays the authority (a stale ghost just means the
// engine rejects with a notice).

defineOptions({ name: 'WorldView' }); // keep-alive include matches on this name
type Mode =
  | { kind: 'idle' }
  | { kind: 'place'; defId: BuildingDefId }
  | { kind: 'move'; buildingId: number };

const store = useGameStore();
const engine = inject(ENGINE_KEY)!;
const factory = inject(WORLD_RENDERER_KEY, null);
const host = ref<HTMLElement | null>(null);
const failure = ref<string | null>(null);
const hover = ref<{ x: number; y: number; pageX: number; pageY: number; pick: WorldPick } | null>(null);
const mode = ref<Mode>({ kind: 'idle' });
const selectedId = ref<number | null>(null);
/** Last tile the pointer hovered while a mode was armed — the ghost target. */
const lastTile = ref<{ col: number; row: number } | null>(null);
let renderer: WorldRenderer | null = null;
let hoverRecheck: ReturnType<typeof setTimeout> | null = null;

const armedDefId = computed(() => (mode.value.kind === 'place' ? mode.value.defId : null));

// Derived reactively so a stationary pointer keeps live details (batch
// progress, hunger, tool ticks) as snapshots tick underneath it; an entity
// vanishing mid-hover yields no lines and the tooltip hides itself.
const hoverLines = computed(() => {
  if (!hover.value || !store.snapshot) return [];
  return describePick(store.snapshot, hover.value.pick);
});

/** The def a ghost previews: the armed def, or the moved building's own. */
function ghostDefId(m: Mode): BuildingDefId | null {
  if (m.kind === 'place') return m.defId;
  if (m.kind === 'move') {
    return store.snapshot?.buildings.find((b) => b.id === m.buildingId)?.defId ?? null;
  }
  return null;
}

// Cosmetic pre-validation only — the engine revalidates and rejects with a
// notice, so a ghost can be wrong for at most one tick. A move's own tile
// counts as occupied (by the mover), which matches the engine's reject.
//
// Tile occupancy is the ONLY thing checked, for both modes alike. A place
// used to also read `store.affordableDefs[m.defId]` (spec §2.3's rule); §2.1
// drops that — ordering is a request, not a claim, so an unaffordable def
// previews exactly as valid as an affordable one, and the queue fills as
// goods arrive rather than being refused at the tile.
function tileValid(m: Mode, col: number, row: number): boolean {
  const snapshot = store.snapshot;
  if (!snapshot) return false;
  return isTileBuildable(snapshot.map, snapshot.buildings, col, row);
}

function refreshGhost() {
  if (!renderer) return;
  const m = mode.value;
  const defId = ghostDefId(m);
  if (m.kind === 'idle' || defId === null || lastTile.value === null) {
    renderer.setGhost(null);
    return;
  }
  const { col, row } = lastTile.value;
  renderer.setGhost({ defId, col, row, valid: tileValid(m, col, row) });
}

function cancelMode() {
  mode.value = { kind: 'idle' };
  lastTile.value = null;
  renderer?.setGhost(null);
}

function select(buildingId: number | null) {
  selectedId.value = buildingId;
  // WorldView is deleted whole in Task 6 (it still speaks in bare building
  // ids); this is the narrowest possible translation to the widened seam,
  // not a rewrite of this view's own selection model.
  renderer?.setSelection(buildingId === null ? { kind: 'none' } : { kind: 'building', id: buildingId });
}

function closeSelection() {
  // An armed move belongs to the selection it came from: closing the panel
  // must disarm it, or an invisible move keeps previewing and a canvas
  // click still dispatches moveBuilding for the deselected building.
  if (mode.value.kind === 'move') cancelMode();
  select(null);
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
  if (mode.value.kind !== 'idle') {
    // armed: the ghost is the feedback — tooltips would fight it
    hover.value = null;
    lastTile.value = renderer?.tileAt(event.pageX, event.pageY) ?? null;
    refreshGhost();
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
  lastTile.value = null;
  refreshGhost();
}

function clickWhilePlacing(m: Extract<Mode, { kind: 'place' }>, tile: { col: number; row: number } | null) {
  if (!tile || !tileValid(m, tile.col, tile.row)) return;
  // stays armed — Banished-style repeat placement (Escape/right-click/
  // palette-toggle disarm)
  engine.dispatch({ type: 'constructBuilding', buildingDefId: m.defId, at: tile });
}

function clickWhileMoving(m: Extract<Mode, { kind: 'move' }>, tile: { col: number; row: number } | null) {
  if (!tile || !tileValid(m, tile.col, tile.row)) return;
  engine.dispatch({ type: 'moveBuilding', buildingId: m.buildingId, to: tile });
  cancelMode(); // back to idle; the selection stays on the moved building
}

function clickIdle(pick: WorldPick | null) {
  // colonists are hover-only: clicking one neither selects nor deselects —
  // only a building selects, only empty ground clears
  if (pick?.kind === 'colonist') return;
  select(pick === null ? null : pick.id);
}

function onClick(event: MouseEvent) {
  if (!renderer) return;
  const m = mode.value;
  if (m.kind === 'place') {
    clickWhilePlacing(m, renderer.tileAt(event.pageX, event.pageY));
    return;
  }
  if (m.kind === 'move') {
    clickWhileMoving(m, renderer.tileAt(event.pageX, event.pageY));
    return;
  }
  clickIdle(renderer.pick(event.pageX, event.pageY));
}

function onContextMenu(event: MouseEvent) {
  if (mode.value.kind === 'idle') return;
  event.preventDefault();
  cancelMode();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (mode.value.kind !== 'idle') cancelMode();
  else select(null);
}

// Window-level Escape, registered only while something is cancellable AND
// the view is the visible tab — Obsidian owns the key otherwise, and the
// kept-alive hidden view must not eat Escape meant for another tab. The
// snapshot watch keeps firing while hidden (the store ticks on), so the
// viewActive guard also stops a hidden re-attach.
let escapeListening = false;
let viewActive = true;
function syncEscapeListener() {
  const needed = viewActive && (mode.value.kind !== 'idle' || selectedId.value !== null);
  if (needed && !escapeListening) window.addEventListener('keydown', onKeydown);
  if (!needed && escapeListening) window.removeEventListener('keydown', onKeydown);
  escapeListening = needed;
}
watch([mode, selectedId], syncEscapeListener);

function onArm(defId: BuildingDefId) {
  mode.value = { kind: 'place', defId };
  select(null); // a selection under an armed palette would double-claim clicks
  hover.value = null; // keyboard arming moves no pointer: hide the parked tooltip now
  refreshGhost(); // switching defs over a parked pointer must swap the ghost too
}

function onMoveRequest() {
  if (selectedId.value === null) return;
  mode.value = { kind: 'move', buildingId: selectedId.value };
  hover.value = null; // same suppression as onArm — no pointer event will do it for us
  // lastTile is always null here (cancelMode cleared it on the way to idle),
  // so this reduces to clearing any stale ghost; the preview appears on the
  // next pointer move.
  refreshGhost();
}

function onDemolish() {
  if (selectedId.value !== null) engine.dispatch({ type: 'demolishBuilding', buildingId: selectedId.value });
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
      (snapshot, previousSnapshot) => {
        if (snapshot) created.sync(snapshot);
        revalidateHover(true);
        // Colony reset recycles entity ids from 1 (Task 9 review): a
        // selected/armed-move id can survive into an unrelated new-timeline
        // building, which the id-based checks below would read as "still
        // there" and keep a stale selection ring on the wrong building. A
        // snapshot that doesn't advance past the previous one's tick is
        // exactly that reset — treat it as a full interaction reset before
        // the id-based checks run.
        if (previousSnapshot && snapshot && snapshot.tick <= previousSnapshot.tick) {
          select(null);
          cancelMode();
        }
        // id-based, reactive lifecycles: selection and move-mode die with
        // their building (demolition, colony reset)
        const m = mode.value;
        if (selectedId.value !== null && !snapshot?.buildings.some((b) => b.id === selectedId.value)) {
          select(null);
        }
        if (m.kind === 'move' && !snapshot?.buildings.some((b) => b.id === m.buildingId)) {
          cancelMode();
        }
        refreshGhost(); // occupancy/affordability may have moved under a stationary pointer
      },
      { immediate: true },
    );
  } catch (error) {
    // A rendering failure must never take the tables down (spec §2.2).
    failure.value = error instanceof Error ? error.message : String(error);
    renderer = null;
  }
});
onActivated(() => {
  viewActive = true;
  renderer?.start();
  syncEscapeListener();
});
onDeactivated(() => {
  viewActive = false;
  renderer?.stop();
  syncEscapeListener();
});
onBeforeUnmount(() => {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  if (escapeListening) window.removeEventListener('keydown', onKeydown);
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). The table views keep working.
  </div>
  <div v-else class="obsisim-world">
    <BuildPalette :armed-def-id="armedDefId" @arm="onArm" @disarm="cancelMode" />
    <div
      ref="host"
      class="obsisim-world-host"
      data-test="world-host"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @click="onClick"
      @contextmenu="onContextMenu"
    />
    <div
      v-if="hover && hoverLines.length > 0"
      class="obsisim-world-tooltip"
      data-test="world-tooltip"
      :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
    >
      <div v-for="line in hoverLines" :key="line">{{ line }}</div>
    </div>
    <SelectionPanel
      v-if="selectedId !== null"
      :key="selectedId"
      :building-id="selectedId"
      @move="onMoveRequest"
      @demolish="onDemolish"
      @close="closeSelection"
    />
    <WorldLegend />
  </div>
</template>
