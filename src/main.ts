import { Notice, Plugin } from 'obsidian';
import type { SaveGameV1 } from './shared/save';
import { isLoadableSave } from './engine/world';
import { GameView, VIEW_TYPE_OBSISIM } from './view/game-view';

interface PluginData {
  save?: unknown;
  corruptBackup?: unknown;
}

function isMissingSave(data: PluginData): boolean {
  return data.save === undefined || data.save === null;
}

export default class ObsiSimPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_OBSISIM, (leaf) => new GameView(leaf, this));
    this.addRibbonIcon('factory', 'Open ObsiSim', () => void this.activateView());
    this.addCommand({
      id: 'open',
      name: 'Open game',
      callback: () => void this.activateView(),
    });
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSISIM)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_OBSISIM, active: true });
  }

  /**
   * All data.json writes flow through one FIFO promise chain: autosaves are
   * fire-and-forget, so without ordering a slow autosave could resolve AFTER
   * the awaited close-save and clobber data.json with an older tick.
   */
  private saveQueue: Promise<void> = Promise.resolve();

  /**
   * Every data.json write — including the corrupt-save backup — goes through
   * this queue, so no two read-modify-write cycles can interleave.
   */
  private enqueueDataWrite(mutate: (data: PluginData) => PluginData): Promise<void> {
    const write = this.saveQueue.then(async () => {
      const data = ((await this.loadData()) as PluginData | null) ?? {};
      await this.saveData(mutate(data));
    });
    this.saveQueue = write.catch(() => undefined); // keep the chain alive on failure
    return write;
  }

  saveSave(save: SaveGameV1): Promise<void> {
    return this.enqueueDataWrite((data) => ({ ...data, save }));
  }

  async loadSave(): Promise<SaveGameV1 | null> {
    // wait out any in-flight write (e.g. a closing view's save) before reading
    await this.saveQueue;
    const data = ((await this.loadData()) as PluginData | null) ?? {};
    if (isMissingSave(data)) return null;
    if (isLoadableSave(data.save)) return data.save; // catalog-aware guard, not bare isSaveGameV1
    await this.backupCorruptSave();
    return null;
  }

  // spec 7.2: corrupt/incompatible save -> back it up, start fresh, tell the user
  private async backupCorruptSave(): Promise<void> {
    new Notice('ObsiSim: save was corrupt or incompatible — starting a fresh colony (old save backed up).');
    await this.enqueueDataWrite((current) => ({ ...current, save: undefined, corruptBackup: current.save }));
  }
}
