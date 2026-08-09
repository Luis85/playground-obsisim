import type { IRuntimeWorld } from 'sim-ecs';
import type { Command } from '../shared/commands';
import type { EngineStatus, Snapshot } from '../shared/snapshot';
import type { SaveGameV5 } from '../shared/save';
import { LATEST_SAVE_VERSION, MAX_SAVED_COUNTER } from '../shared/save';
import { BALANCE } from './content/balance';
import { CommandQueue, IdCounter, RemovalLedger, SimClock, SnapshotStore, Stockpile, WorldMap } from './resources';
import { gatherEntityFacts, savedBuildingOf, savedColonistOf } from './snapshot-builder';
import { applyRemovals, createColonyWorld, initialSave, refreshEntitySections } from './world';

export type UpdateListener = (snapshot: Snapshot | null, status: EngineStatus) => void;

export function buildSaveFromWorld(world: IRuntimeWorld): SaveGameV5 {
  const clock = world.getResource(SimClock);
  const facts = gatherEntityFacts(world);
  const stockpile = world.getResource(Stockpile).toJSON();
  // A hauler caught mid-trip banks its load here rather than persisting trip
  // state: conservation stays exact, and HaulTrip stays out of the save format
  // and its guards entirely. The live world is deliberately NOT mutated — this
  // is a snapshot, and the running colony still delivers that load normally.
  //
  // Saturates at MAX_SAVED_COUNTER exactly like Stockpile.add: a save written
  // from an accepted state must itself be accepted by isLoadableSave on the
  // next load, and raw addition onto an at-ceiling stockpile would write one
  // point past that bound — which sends a real colony down decideLoad's
  // corrupt-backup path instead of restoring it.
  for (const worker of facts.workers) {
    if (worker.carryingResource === null || worker.carrying <= 0) continue;
    const current = stockpile[worker.carryingResource] ?? 0;
    stockpile[worker.carryingResource] = current + Math.min(worker.carrying, MAX_SAVED_COUNTER - current);
  }
  return {
    version: LATEST_SAVE_VERSION,
    tick: clock.tick,
    lastRecruitTick: clock.lastRecruitTick,
    // Persisted for the reason lastRecruitTick is: a cooldown a reload could
    // cancel is not a cooldown. Dropping it would let a player save and reload
    // to skip the wait between births.
    lastBirthTick: clock.lastBirthTick,
    stockpile,
    map: { cols: world.getResource(WorldMap).cols, rows: world.getResource(WorldMap).rows },
    buildings: facts.buildings.map(savedBuildingOf).sort((a, b) => a.id - b.id),
    colonists: facts.workers.map(savedColonistOf).sort((a, b) => a.id - b.id),
    nextEntityId: world.getResource(IdCounter).peek(),
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
  private autosaveListener: ((save: SaveGameV5) => void) | null = null;

  private constructor(private world: IRuntimeWorld) {}

  static async create(save?: SaveGameV5 | null): Promise<GameEngine> {
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

  onAutosave(listener: (save: SaveGameV5) => void): void {
    this.autosaveListener = listener;
  }

  dispatch(command: Command): void {
    this.world.getResource(CommandQueue).push(command);
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
   * Drain any in-flight tick, then — if there is unfinished business a
   * close-save would otherwise drop — run one final tick. No-op when there is
   * none, which is every ordinary close.
   *
   * Two kinds of unfinished business, one answer. A command the UI queued that
   * no tick has processed (dispatch while paused, or a click racing the close)
   * is the original case. A removal left on `RemovalLedger` by a detach that
   * threw is the same case one step later: the command WAS processed — the
   * demolition already refunded its cost, emptied its buffer and evicted its
   * residents — and only its effect is still pending. Without the second
   * check, `serialize()` writes that refunded, emptied building back to disk
   * as though the demolition never happened, and the ledger dies with the
   * process, so nothing ever retries it. The queue is empty by then, which is
   * exactly why the original condition misses it.
   *
   * Routed through `stepOnce`, never a bare `applyRemovals` here, and that is
   * the load-bearing part: `runStep` retries the ledger before it steps and
   * owns the catch, so a retry that fails AGAIN pauses the engine instead of
   * rejecting out of `GameView.onClose` — which wraps `serialize()` in a
   * try/catch but does NOT wrap this call, and would be left with the Vue app
   * still mounted and the single-view claim still held.
   */
  async flush(): Promise<void> {
    await this.settle();
    if (this.world.getResource(CommandQueue).size > 0 || this.world.getResource(RemovalLedger).size > 0) {
      await this.stepOnce();
    }
  }

  private async runStep(): Promise<void> {
    try {
      // Retry anything a previous tick's detach threw on and re-queued, BEFORE
      // any system runs. Empty on every normal tick, because the only writers
      // are systems inside step() and the post-step call below drains them.
      //
      // Ordering, not belt-and-braces. The re-queue alone retried the entry
      // only after a whole further tick had run against a world that still
      // contained the entity — and that tick rehomes into it: CommandSystem
      // clears PendingChanges.demolished at the top, so PopulationSystem reads
      // the doomed house as a usable shelter, moves colonists in, and the
      // post-step retry then removes it out from under them. The save that
      // follows carries a homeId naming a building that is gone, which the v5
      // guard refuses — a corrupt-save backup instead of a colony. Retrying
      // here means the entity is gone before anything can read it, and a retry
      // that fails again throws before `step()`, so no tick ever runs against
      // the inconsistent world. Better in both branches, worse in neither.
      applyRemovals(this.world);
      const clock = this.world.getResource(SimClock);
      const idsBefore = this.world.getResource(IdCounter).peek();
      clock.tick++;
      await this.world.step();
      // Deaths and demolitions land HERE, not through sim-ecs's command queue:
      // batching more than one removal into one queue froze the whole
      // simulation for a tick per extra corpse (OBS-6-02). Before the refresh
      // below and before the autosave, so neither can publish or persist
      // somebody the tick has already killed.
      const removed = applyRemovals(this.world);
      // sim-ecs syncs this tick's newly-created entities only after step() resolves,
      // so SnapshotSystem's snapshot (written mid-tick) can miss them. Patch the
      // entity-derived sections now, before publishing, so a paused manual step
      // shows its own commands' effects without waiting on a follow-up tick.
      //
      // GATED: only a tick that created or removed something can be affected.
      // Creation is the only thing that consumes ids -> an id-counter delta is
      // an exact signal for it, so the common case skips a full entity walk.
      //
      // INVARIANT from increment 2: entity REMOVAL consumes no id, so the
      // id-counter delta alone cannot see it. `applyRemovals`' own count is
      // the other half of the gate, so a tick that only removes something
      // still refreshes on its own tick. Nothing for a remover to remember:
      // the count comes from the removal itself, which is what the
      // RemovalLedger `dirty` flag this replaced could not promise.
      //
      // The PRE-step retry's count is deliberately absent from this gate, and
      // adding it would only cost a redundant walk: SnapshotSystem rebuilds
      // the entity sections from live queries on every tick, so an entity
      // removed before step() is already missing from the snapshot this tick
      // wrote. Only a POST-step removal can be newer than that snapshot.
      if (this.world.getResource(IdCounter).peek() !== idsBefore || removed > 0) {
        refreshEntitySections(this.world);
      }
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

  serialize(): SaveGameV5 {
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
