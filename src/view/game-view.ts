import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { App as VueApp } from 'vue';
import { GameEngine } from '../engine/game-engine';
import { createGameApp } from '../app';
import type ObsiSimPlugin from '../main';

export const VIEW_TYPE_OBSISIM = 'obsisim-game';

export class GameView extends ItemView {
  private engine: GameEngine | null = null;
  private vueApp: VueApp<Element> | null = null;
  private lastError: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ObsiSimPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OBSISIM;
  }

  getDisplayText(): string {
    return 'ObsiSim';
  }

  getIcon(): string {
    return 'factory';
  }

  async onOpen(): Promise<void> {
    if (this.plugin.activeGameView && this.plugin.activeGameView !== this) {
      // a second leaf must stay inert: no engine, no autosaves (see main.ts)
      this.contentEl.createEl('p', {
        text: 'ObsiSim is already open in another pane. Close this pane and use the existing one.',
        cls: 'obsisim-duplicate-view',
      });
      return;
    }
    this.plugin.activeGameView = this;
    const save = await this.plugin.loadSave();
    this.engine = await GameEngine.create(save);
    this.engine.onAutosave((save) => {
      this.plugin.saveSave(save).catch((error: unknown) => {
        console.error('ObsiSim: autosave failed', error);
        new Notice('ObsiSim: autosave failed — your colony may not persist.');
      });
    });
    this.engine.onUpdate((_snapshot, status) => {
      if (status.error && status.error !== this.lastError) {
        new Notice(`ObsiSim paused on error: ${status.error}`);
      }
      this.lastError = status.error;
    });
    this.vueApp = await createGameApp(this.engine, this.contentEl);
    this.engine.start();
  }

  async onClose(): Promise<void> {
    if (this.engine) {
      this.engine.pause();
      await this.engine.flush(); // drain any in-flight tick AND any queued-but-unprocessed commands
      try {
        await this.plugin.saveSave(this.engine.serialize());
      } catch (error) {
        console.error('ObsiSim: close-save failed', error);
        new Notice('ObsiSim: failed to save the colony — recent progress may be lost.');
      } finally {
        this.engine.destroy();
        this.engine = null;
      }
    }
    this.vueApp?.unmount();
    this.vueApp = null;
    this.contentEl.empty();
    if (this.plugin.activeGameView === this) {
      this.plugin.activeGameView = null;
    }
  }
}
