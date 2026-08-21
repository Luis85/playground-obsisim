import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import { isTileBuildable } from '../../shared/placement';
import type { Command } from '../../shared/commands';
import { useGameStore } from '../stores/game-store';
import { useUiStore, type Mode } from '../stores/ui-store';
import type { GhostPreview } from './renderer-key';
import type { WorldPick } from './layout';

export interface Tile { col: number; row: number; }

/**
 * The idle / place / move machine, lifted out of WorldView so it can be
 * exercised with no canvas, no WebGL and no DOM (spec §2.6). The mode itself
 * lives in the UI store, because §2.1's cancel invariant has to sit beside
 * the selection it is coupled to; this composable is the behaviour over it.
 *
 * Validity here is COSMETIC only. The engine revalidates and rejects with a
 * notice, so a stale ghost is wrong for at most one tick. Tile occupancy is
 * the only thing checked, for both modes alike: since increment 10 an order
 * is a request, so an unaffordable def previews exactly as valid as an
 * affordable one and the queue fills as goods arrive.
 */
export function useWorldInteraction(): {
  ghost: ComputedRef<GhostPreview | null>;
  hoverTile: Ref<Tile | null>;
  setHoverTile(tile: Tile | null): void;
  clickTile(tile: Tile | null): Command | null;
  clickPick(pick: WorldPick | null): void;
} {
  const store = useGameStore();
  const ui = useUiStore();
  const hoverTile = ref<Tile | null>(null);

  function tileValid(col: number, row: number): boolean {
    const snapshot = store.snapshot;
    if (!snapshot) return false;
    return isTileBuildable(snapshot.map, snapshot.buildings, col, row);
  }

  /** The def a ghost previews: the armed def, or the moved building's own. */
  const ghostDefId = computed(() => {
    const mode: Mode = ui.mode;
    if (mode.kind === 'place') return mode.defId;
    if (mode.kind === 'move') {
      return store.snapshot?.buildings.find((b) => b.id === mode.buildingId)?.defId ?? null;
    }
    return null;
  });

  const ghost = computed<GhostPreview | null>(() => {
    const defId = ghostDefId.value;
    const tile = hoverTile.value;
    if (defId === null || tile === null) return null;
    return { defId, col: tile.col, row: tile.row, valid: tileValid(tile.col, tile.row) };
  });

  function setHoverTile(tile: Tile | null) { hoverTile.value = tile; }

  /*
   * A remembered tile must not outlive the mode that used it.
   * `WorldView.cancelMode()` cleared `lastTile` alongside the mode, in one
   * function, because the two were owned by the same component. This split
   * separates them — the mode lives in the store now — so EVERY store path
   * that returns to idle (Escape, a panel switch, a selection change, a
   * completed move) would otherwise leave the tile behind. Arm from a focused
   * palette button by keyboard, with no pointer event to refresh it, and the
   * ghost reappears at a position the pointer left long ago.
   *
   * Watched rather than fixed at each cancel site, for the same reason the
   * cancel invariant lives in the selection setter: there are five ways in and
   * only one of them is this composable's own.
   *
   * `flush: 'sync'` is required, not merely convenient. `hoverTile` and the
   * mode were one fact that WorldView's `cancelMode()` used to update in one
   * function — `mode.value = idle; lastTile.value = null; setGhost(null)` in
   * three consecutive lines — precisely so the two could never be observed
   * apart. `ghost` above is a computed over `hoverTile`, so with the default
   * `pre` flush there is a window, between the store going idle and the
   * scheduler running this watcher, in which the mode already reads idle but
   * `hoverTile` (and therefore `ghost`, for a `move`'s own building only —
   * `ghostDefId` already reads null for `place` once idle) still holds the
   * stale tile. `sync` closes that window instead of merely narrating it.
   */
  watch(() => ui.mode.kind, (kind) => {
    if (kind === 'idle') hoverTile.value = null;
  }, { flush: 'sync' });

  function clickTile(tile: Tile | null): Command | null {
    const mode: Mode = ui.mode;
    if (mode.kind === 'idle' || tile === null) return null;
    if (!tileValid(tile.col, tile.row)) return null;
    if (mode.kind === 'place') {
      // stays armed — Banished-style repeat placement
      return { type: 'constructBuilding', buildingDefId: mode.defId, at: tile };
    }
    ui.cancelMode(); // back to idle; the selection stays on the moved building
    return { type: 'moveBuilding', buildingId: mode.buildingId, to: tile };
  }

  function clickPick(pick: WorldPick | null) {
    if (pick === null) { ui.clearSelection(); return; }
    if (pick.kind === 'colonist') { ui.selectColonist(pick.id); return; }
    ui.selectBuilding(pick.id);
  }

  return { ghost, hoverTile, setHoverTile, clickTile, clickPick };
}
