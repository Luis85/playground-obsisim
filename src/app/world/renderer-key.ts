import type { InjectionKey } from 'vue';
import type { Snapshot } from '../../shared/snapshot';

export interface WorldRenderer {
  sync(snapshot: Snapshot): void;
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
 * so nothing on the WorldView import path may touch it (spec §2.5).
 */
export const WORLD_RENDERER_KEY: InjectionKey<WorldRendererFactory> = Symbol('obsisim-world-renderer');
