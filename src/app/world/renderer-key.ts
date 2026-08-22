import type { InjectionKey } from 'vue';
import type { BuildingDefId } from '../../shared/content-types';
import type { Snapshot } from '../../shared/snapshot';
import type { Selection } from '../stores/ui-store';
import type { WorldPick } from './layout';

/** The translucent placement preview: a def's visual on a tile, tinted by
 * whether the placement would be accepted. */
export interface GhostPreview {
  defId: BuildingDefId;
  col: number;
  row: number;
  valid: boolean;
}

export interface WorldRenderer {
  sync(snapshot: Snapshot): void;
  /** Hit-test the entity under a pointer position (page coordinates). */
  pick(pageX: number, pageY: number): WorldPick | null;
  /** The map tile under a pointer position (page coordinates), or null off-map. */
  tileAt(pageX: number, pageY: number): { col: number; row: number } | null;
  /** Show (or clear, with null) the placement preview. Drawing only — the
   * caller owns validity and mode logic. */
  setGhost(ghost: GhostPreview | null): void;
  /** Highlight the selected subject (or clear, with `{ kind: 'none' }`). The
   * ring follows moves and disappears with its subject; the caller still owns
   * selection state. Colonists gained a ring in increment 11 — they were
   * hover-only before, though `pick` has always returned them. */
  setSelection(selection: Selection): void;
  /** Pulse a set of buildings without selecting any of them — what a plural
   * panel row does (spec §2.3). Passing an empty array clears the pulse. */
  setHighlight(subjects: readonly Selection[]): void;
  /** Report an asynchronous fatal failure (e.g. the engine boot rejecting
   * after construction succeeded); the renderer is already torn down. */
  onFatal(listener: (message: string) => void): void;
  /** Resume the render clock (tab shown). */
  start(): void;
  /** Halt the render clock (tab hidden). */
  stop(): void;
  /** Tear down the engine and canvas (view closed). */
  dispose(): void;
}

export type WorldRendererFactory = (host: HTMLElement) => WorldRenderer;

/**
 * DI seam for the world renderer. The real Excalibur factory is provided only
 * by createGameApp; tests inject fakes. Load-bearing: excalibur cannot be
 * imported by tests (module-scope `window`, ~5 s evaluation under happy-dom),
 * so nothing on the WorldStage import path may touch it (spec §2.5).
 */
export const WORLD_RENDERER_KEY: InjectionKey<WorldRendererFactory> = Symbol('obsisim-world-renderer');
