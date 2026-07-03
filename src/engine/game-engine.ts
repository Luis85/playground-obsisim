import type { IRuntimeWorld } from 'sim-ecs';
import type { Command } from '../shared/commands';
import type { EngineStatus, Snapshot } from '../shared/snapshot';
import type { SaveGameV1, SavedBuilding } from '../shared/save';
import { BALANCE } from './content/balance';
import { Building, Hunger, JobAssignment, Production, ToolCoverage, Worker } from './components';
import { CommandQueue, SimClock, SnapshotStore, Stockpile } from './resources';
import { createColonyWorld, initialSave, refreshEntitySections } from './world';

export type UpdateListener = (snapshot: Snapshot | null, status: EngineStatus) => void;

export function buildSaveFromWorld(world: IRuntimeWorld): SaveGameV1 {
  const clock = world.getResource(SimClock);
  const buildings: { id: number; saved: SavedBuilding }[] = [];
  const workers: { id: number; hunger: number; buildingId: number | null; toolTicks: number }[] = [];
  for (const entity of world.getEntities()) {
    const building = entity.getComponent(Building);
    if (building) {
      const production = entity.getComponent(Production)!;
      buildings.push({
        id: building.id,
        saved: {
          defId: building.defId,
          progress: production.progress,
          batchActive: production.batchActive,
        },
      });
      continue;
    }
    const worker = entity.getComponent(Worker);
    if (worker) {
      workers.push({
        id: worker.id,
        hunger: entity.getComponent(Hunger)!.value,
        buildingId: entity.getComponent(JobAssignment)!.buildingId,
        toolTicks: entity.getComponent(ToolCoverage)!.remainingTicks,
      });
    }
  }
  buildings.sort((a, b) => a.id - b.id);
  workers.sort((a, b) => a.id - b.id);
  const buildingIndexById = new Map(buildings.map((b, index) => [b.id, index]));
  return {
    version: 1,
    tick: clock.tick,
    lastRecruitTick: clock.lastRecruitTick,
    stockpile: world.getResource(Stockpile).toJSON(),
    buildings: buildings.map((b) => b.saved),
    workers: workers.map((w) => ({
      hunger: w.hunger,
      toolTicks: w.toolTicks,
      buildingIndex: w.buildingId === null ? null : (buildingIndexById.get(w.buildingId) ?? null),
    })),
  };
}

export class GameEngine {
  private paused = true;
  private speed: 1 | 2 | 4 = 1;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepping = false;
  private inFlight: Promise<void> | null = null;
  private readonly updateListeners: UpdateListener[] = [];
  private autosaveListener: ((save: SaveGameV1) => void) | null = null;

  private constructor(private world: IRuntimeWorld) {}

  static async create(save?: SaveGameV1 | null): Promise<GameEngine> {
    return new GameEngine(await createColonyWorld(save ?? initialSave()));
  }

  get snapshot(): Snapshot | null {
    return this.world.getResource(SnapshotStore).latest;
  }

  get status(): EngineStatus {
    return { paused: this.paused, speed: this.speed, error: this.error };
  }

  onUpdate(listener: UpdateListener): void {
    this.updateListeners.push(listener);
    listener(this.snapshot, this.status);
  }

  onAutosave(listener: (save: SaveGameV1) => void): void {
    this.autosaveListener = listener;
  }

  dispatch(command: Command): void {
    this.world.getResource(CommandQueue).pending.push(command);
  }

  async stepOnce(): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    const step = this.runStep();
    this.inFlight = step;
    try {
      await step;
    } finally {
      this.stepping = false;
      this.inFlight = null;
    }
    this.publish();
  }

  /**
   * Resolves once any in-flight tick has fully finished (including its
   * command sync). Close-saves must pause + settle before serialize(), or
   * they can capture a half-stepped world mid-tick.
   */
  async settle(): Promise<void> {
    if (this.inFlight) await this.inFlight;
  }

  /**
   * Drain any in-flight tick, then — if the UI queued commands that no tick
   * has processed yet (dispatch while paused, or a click racing the close) —
   * run one final tick so a close-save cannot silently drop an accepted
   * command. No-op when the queue is empty.
   */
  async flush(): Promise<void> {
    await this.settle();
    if (this.world.getResource(CommandQueue).pending.length > 0) {
      await this.stepOnce();
    }
  }

  private async runStep(): Promise<void> {
    try {
      const clock = this.world.getResource(SimClock);
      clock.tick++;
      await this.world.step();
      // sim-ecs syncs this tick's newly-created entities only after step() resolves,
      // so SnapshotSystem's snapshot (written mid-tick) can miss them. Patch the
      // entity-derived sections now, before publishing, so a paused manual step
      // shows its own commands' effects without waiting on a follow-up tick.
      refreshEntitySections(this.world);
      if (clock.tick % BALANCE.autosaveEveryTicks === 0) {
        this.autosaveListener?.(this.serialize());
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.pauseInternal();
    }
  }

  start(): void {
    this.error = null; // resuming clears a prior error; a recurring one re-pauses
    this.paused = false;
    this.schedule();
    this.publish();
  }

  pause(): void {
    this.pauseInternal();
    this.publish();
  }

  setSpeed(speed: 1 | 2 | 4): void {
    this.speed = speed;
    if (!this.paused) this.schedule();
    this.publish();
  }

  serialize(): SaveGameV1 {
    // live ECS state, never the snapshot — see buildSaveFromWorld
    return buildSaveFromWorld(this.world);
  }

  async reset(): Promise<void> {
    this.pauseInternal();
    await this.settle();
    this.error = null;
    this.world = await createColonyWorld(initialSave());
    this.autosaveListener?.(this.serialize());
    this.publish();
  }

  destroy(): void {
    this.clearTimer();
    this.updateListeners.length = 0;
    this.autosaveListener = null;
  }

  private pauseInternal(): void {
    this.paused = true;
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    const intervalMs = 1000 / (BALANCE.baseTicksPerSecond * this.speed);
    this.timer = setInterval(() => {
      void this.stepOnce();
    }, intervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private publish(): void {
    for (const listener of this.updateListeners) {
      listener(this.snapshot, this.status);
    }
  }
}
