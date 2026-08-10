import { Notice, Plugin } from 'obsidian';
import type { SaveGameV6 } from './shared/save';
import { decideLoad } from './engine/world';
import { GameView, VIEW_TYPE_OBSISIM } from './view/game-view';

interface PluginData {
  save?: unknown;
  corruptBackup?: unknown;
}

export default class ObsiSimPlugin extends Plugin {
  /**
   * The one view that owns a running engine. A second obsisim-game leaf
   * (workspace restore after a pane split, "open in new window") must NOT
   * create another engine: two engines would race each other's autosaves
   * into the single save slot and the idle one could overwrite real progress.
   */
  activeGameView: GameView | null = null;

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
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSISIM);
    const activeLeaf = leaves.find((leaf) => leaf.view === this.activeGameView);
    if (this.activeGameView && activeLeaf) {
      await this.app.workspace.revealLeaf(activeLeaf);
      return;
    }
    // no engine-owning view exists: any remaining leaves are inert duplicates
    // from a workspace restore — clear them so a fresh view can own the engine
    for (const leaf of leaves) {
      leaf.detach();
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

  saveSave(save: SaveGameV6): Promise<void> {
    return this.enqueueDataWrite((data) => ({ ...data, save }));
  }

  async loadSave(): Promise<SaveGameV6 | null> {
    // wait out any in-flight write (e.g. a closing view's save) before reading
    await this.saveQueue;
    const data = ((await this.loadData()) as PluginData | null) ?? {};
    // decideLoad does the actual work (migrate-then-validate, not a bare guard:
    // a save from an older schema is upgraded before the catalog checks run, so
    // bumping the save version never routes live saves to the backup path);
    // this method just performs the I/O each decision implies.
    const decision = decideLoad(data.save);
    if (decision.kind === 'restore') return decision.save;
    if (decision.kind === 'backup') await this.backupCorruptSave();
    return null;
  }

  // spec 7.2: corrupt/incompatible save -> back it up, start fresh, tell the user
  private async backupCorruptSave(): Promise<void> {
    new Notice('ObsiSim: save was corrupt or incompatible — starting a fresh colony (old save backed up).');
    await this.enqueueDataWrite((current) => ({ ...current, save: undefined, corruptBackup: current.save }));
  }
}
