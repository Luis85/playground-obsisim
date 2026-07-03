import { describe, expect, it, vi } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine';
import type { SaveGameV1 } from '../../src/shared/save';

async function steps(engine: GameEngine, n: number) {
  for (let i = 0; i < n; i++) await engine.stepOnce();
}

/** Deterministic scripted session used by both determinism tests. */
async function scriptedRun(ticks: number, save?: SaveGameV1): Promise<GameEngine> {
  const engine = await GameEngine.create(save ?? null);
  if (!save) {
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    // ids: workers 1-3 spawned first, the constructed forester gets id 4
    engine.dispatch({ type: 'assignWorker', buildingId: 4 });
    engine.dispatch({ type: 'assignWorker', buildingId: 4 });
  }
  await steps(engine, ticks);
  return engine;
}

describe('GameEngine', () => {
  it('publishes snapshots and status to listeners on every step', async () => {
    const engine = await GameEngine.create();
    const listener = vi.fn();
    engine.onUpdate(listener); // fires immediately with the seeded tick-0 snapshot
    expect(listener.mock.calls[0][0].tick).toBe(0);
    await engine.stepOnce();
    const [snapshot, status] = listener.mock.calls.at(-1)!;
    expect(snapshot.tick).toBe(1);
    expect(status).toEqual({ paused: true, speed: 1, error: null });
  });

  it('is deterministic: same script twice yields identical saves', async () => {
    const a = await scriptedRun(100);
    const b = await scriptedRun(100);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('save/restore round-trip: 500 ticks + save + 100 == 600 straight ticks', async () => {
    const straight = await scriptedRun(600);
    const first = await scriptedRun(500);
    const resumed = await GameEngine.create(first.serialize());
    await steps(resumed, 100);
    expect(resumed.serialize()).toEqual(straight.serialize());
  }, 30000);

  it('speed only changes wall-clock pacing, never the per-tick result', async () => {
    const a = await scriptedRun(50);
    const b = await scriptedRun(50);
    b.setSpeed(4); // no effect on manual stepping determinism
    await steps(a, 10);
    await steps(b, 10);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('fires autosave every 100 ticks', async () => {
    const engine = await GameEngine.create();
    const autosave = vi.fn();
    engine.onAutosave(autosave);
    await steps(engine, 100);
    expect(autosave).toHaveBeenCalledTimes(1);
    expect(autosave.mock.calls[0][0].tick).toBe(100);
  });

  it('autosave on a command tick includes entities created that tick', async () => {
    // P1 regression: the tick-100 snapshot misses entities from tick-100 commands,
    // but the autosaved file must not (serialize reads live state after the sync point)
    const engine = await GameEngine.create();
    const autosave = vi.fn();
    engine.onAutosave(autosave);
    await steps(engine, 99);
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce(); // tick 100 -> autosave fires
    const save: SaveGameV1 = autosave.mock.calls[0][0];
    expect(save.buildings).toEqual([{ defId: 'forester', progress: 0, batchActive: false }]);
    expect(save.stockpile.wood).toBe(20); // cost paid AND building present
  });

  it('serialize before any step reflects the initial colony', async () => {
    const engine = await GameEngine.create();
    expect(engine.serialize().stockpile).toEqual({ wood: 30, berries: 20 });
  });

  it('reset returns to the initial colony and publishes a fresh, non-null snapshot', async () => {
    const engine = await scriptedRun(50);
    await engine.reset();
    expect(engine.serialize()).toEqual((await GameEngine.create()).serialize());
    // seeded snapshot: the UI must show the fresh colony while still paused,
    // not fall back to a loading screen (Codex P2)
    expect(engine.snapshot).not.toBeNull();
    expect(engine.snapshot!.tick).toBe(0);
    expect(engine.snapshot!.stockpile.wood.stock).toBe(30);
  });

  it('start/pause drive the interval loop', async () => {
    vi.useFakeTimers();
    try {
      const engine = await GameEngine.create();
      engine.start();
      expect(engine.status.paused).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); // 2 ticks/s at 1x
      engine.pause();
      expect(engine.snapshot!.tick).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.snapshot!.tick).toBe(2); // paused: no more ticks
    } finally {
      vi.useRealTimers();
    }
  });

  it('settle() waits out an in-flight tick before a close-save serializes', async () => {
    const engine = await GameEngine.create();
    const pending = engine.stepOnce(); // do not await: tick is in flight
    await engine.settle();
    expect(engine.snapshot!.tick).toBe(1); // fully stepped, not half-applied
    await pending;
  });

  it('flush() processes commands queued while paused so a close-save keeps them', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // paused: no tick runs
    await engine.flush(); // runs one final tick to process the queue
    const save = engine.serialize();
    expect(save.buildings).toEqual([{ defId: 'forester', progress: 0, batchActive: false }]);
    expect(save.stockpile.wood).toBe(20); // cost paid AND building present
    await engine.flush(); // empty queue: no extra tick
    expect(engine.serialize().tick).toBe(1);
  });

  it('a thrown step captures the error and pauses, without crashing the caller', async () => {
    const engine = await GameEngine.create();
    engine.start();
    // Force the next world.step() to reject; runStep's catch must record the
    // error and pause rather than let it propagate out of stepOnce().
    const world = (engine as unknown as { world: { step(): Promise<void> } }).world;
    world.step = () => Promise.reject(new Error('sim-ecs blew up'));
    await engine.stepOnce();
    expect(engine.status.error).toBe('sim-ecs blew up');
    expect(engine.status.paused).toBe(true);
  });
});
