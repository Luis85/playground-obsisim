import { describe, expect, it, vi } from 'vitest';

// Spy on refreshEntitySections so the post-step gate is directly observable:
// "zero calls on a plain tick" is the only assertion that covers the skip, since
// a gated and an ungated refresh are indistinguishable from world state alone.
vi.mock('../../src/engine/world', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/world')>();
  return { ...actual, refreshEntitySections: vi.fn(actual.refreshEntitySections) };
});

import { buildSaveFromWorld, GameEngine } from '../../src/engine/game-engine';
import * as worldModule from '../../src/engine/world';
import { createColonyWorld, initialSave, isLoadableSave } from '../../src/engine/world';
import { HaulTrip } from '../../src/engine/components';
import { Stockpile } from '../../src/engine/resources';

const refreshMock = vi.mocked(worldModule.refreshEntitySections);
import type { SaveGameV3 } from '../../src/shared/save';
import { MAX_SAVED_COUNTER } from '../../src/shared/save';

async function steps(engine: GameEngine, n: number) {
  for (let i = 0; i < n; i++) await engine.stepOnce();
}

/** Deterministic scripted session used by both determinism tests. */
async function scriptedRun(ticks: number, save?: SaveGameV3): Promise<GameEngine> {
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
    const save: SaveGameV3 = autosave.mock.calls[0][0];
    expect(save.buildings).toEqual([{ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {} }]);
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
    // not fall back to a loading screen
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
    expect(save.buildings).toEqual([{ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {} }]);
    expect(save.stockpile.wood).toBe(20); // cost paid AND building present
    await engine.flush(); // empty queue: no extra tick
    expect(engine.serialize().tick).toBe(1);
  });

  // Killer test for buildSaveFromWorld's sorts (increment-1 review: survived).
  // Entity iteration order equals id order in every other test, so the sorts are
  // otherwise unobservable. Listing save records out of id order makes spawn
  // order — and therefore iteration order — differ from id order.
  it('serializes entities in ascending id order regardless of spawn order', async () => {
    const save = initialSave();
    save.buildings = [
      { id: 5, defId: 'sawmill', progress: 0, batchActive: false, col: 6, row: 1, buffer: {} },
      { id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {} },
    ];
    save.workers = [3, 1, 2].map((id) => ({ id, hunger: 0, buildingId: null, toolTicks: 0, hauling: false }));
    save.nextEntityId = 6;
    const engine = await GameEngine.create(save);
    const out = engine.serialize();
    expect(out.buildings.map((b) => b.id)).toEqual([4, 5]);
    expect(out.workers.map((w) => w.id)).toEqual([1, 2, 3]);
  });

  // Killer test for flush()'s `await this.settle()` (increment-1 review:
  // survived). The mutation is only observable when a tick is in flight AND the
  // queue is non-empty, which needs a command that MISSED that tick's drain.
  // Dispatching right after stepOnce() does not achieve that — measured: the
  // command still lands in the in-flight tick, flush() no-ops, and the mutation
  // survives. So the window is entered by state, not by counting microtasks.
  it('flush() waits out an in-flight tick before running a command that missed it', async () => {
    const save = initialSave();
    save.stockpile = { wood: 60 };
    const engine = await GameEngine.create(save);

    // A is queued BEFORE the tick, so tick 1's CommandSystem pays for it.
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    const inFlight = engine.stepOnce(); // deliberately not awaited

    // Spin until A's cost is paid: that proves tick 1 has drained its queue,
    // while the tick itself is still in flight (inFlight is not awaited yet).
    let spins = 0;
    while (engine.serialize().stockpile.wood === 60) {
      await Promise.resolve();
      if (++spins > 1000) throw new Error('in-flight tick never drained its queue');
    }
    expect(engine.snapshot!.tick).toBe(0); // still in flight: nothing published

    // B therefore cannot be seen by tick 1 — only flush()'s extra tick runs it.
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await engine.flush();
    await inFlight;

    const out = engine.serialize();
    expect(out.buildings.map((b) => b.defId)).toEqual(['forester', 'gatherersHut']);
    expect(out.tick).toBe(2); // the in-flight tick plus flush's own
  });

  it('a manual step publishes a snapshot including entities its commands created', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce(); // paused manual step: no follow-up tick will come
    expect(engine.snapshot!.buildings).toHaveLength(1);
    expect(engine.snapshot!.buildings[0].defId).toBe('forester');
    expect(engine.snapshot!.stockpile.wood.stock).toBe(20);
  });

  it('save/restore preserves entity ids and the id counter keeps incrementing past them', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // workers 1-3 exist -> gets id 4
    await steps(engine, 3);
    const save = engine.serialize();

    const restored = await GameEngine.create(save);
    expect(restored.snapshot!.workers.map((w) => w.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(restored.snapshot!.buildings.map((b) => b.id)).toEqual([4]);

    restored.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await restored.stepOnce();
    expect(restored.snapshot!.buildings.map((b) => b.id).sort((a, b) => a - b)).toEqual([4, 5]);
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

    // Resuming after an error must clear the stale banner, not leave it
    // showing forever even once play works fine again.
    engine.start();
    expect(engine.status.error).toBeNull();
    engine.pause(); // clean up the interval timer started by start()
  });

  it('refreshes entity sections only on ticks that create entities', async () => {
    const save = initialSave();
    save.stockpile = { wood: 30 };
    const engine = await GameEngine.create(save);
    refreshMock.mockClear();

    await engine.stepOnce(); // plain tick: nothing created
    expect(refreshMock).not.toHaveBeenCalled();

    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    expect(refreshMock).toHaveBeenCalledTimes(1); // creating tick: refreshed
    // and the building must be visible on ITS OWN tick, not one later
    expect(engine.snapshot!.buildings).toHaveLength(1);
  });

  it('a demolishing tick refreshes the published snapshot immediately', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    await engine.stepOnce();
    const buildingId = engine.snapshot!.buildings[0].id;
    engine.dispatch({ type: 'demolishBuilding', buildingId });
    // Removal consumes no id, so without the RemovalLedger flag the
    // id-delta-gated refresh would skip and the demolished building would
    // linger in the published snapshot until the next id-consuming tick.
    await engine.stepOnce();
    expect(engine.snapshot!.buildings).toHaveLength(0);
  });

  it('banks a hauler mid-trip load into the saved stockpile without touching the live world', async () => {
    const world = await createColonyWorld();
    let carried: HaulTrip | null = null;
    for (const entity of world.getEntities()) {
      const trip = entity.getComponent(HaulTrip);
      if (trip !== undefined) {
        trip.phase = 'returning';
        trip.resource = 'wood';
        trip.amount = 4;
        carried = trip;
        break;
      }
    }
    const before = world.getResource(Stockpile).get('wood');
    const save = buildSaveFromWorld(world);

    expect(save.stockpile.wood).toBe(before + 4);
    // A save is a snapshot, not an event: the running colony still delivers
    // that load normally, so the live world must be untouched.
    expect(world.getResource(Stockpile).get('wood')).toBe(before);
    expect(carried!.amount).toBe(4);
  });

  it('saturates deposit-on-save at the counter ceiling so an accepted save stays accepted', async () => {
    const world = await createColonyWorld();
    // Stockpile.add itself saturates, so this reaches the ceiling exactly
    // regardless of the starting amount.
    world.getResource(Stockpile).add('wood', MAX_SAVED_COUNTER);
    for (const entity of world.getEntities()) {
      const trip = entity.getComponent(HaulTrip);
      if (trip !== undefined) {
        trip.phase = 'returning';
        trip.resource = 'wood';
        trip.amount = 4;
        break;
      }
    }

    const save = buildSaveFromWorld(world);

    // Raw addition would write MAX_SAVED_COUNTER + 4, one past isStockpileValid's
    // bound — exactly the ping-pong (accepted save -> deposit-on-save -> rejected
    // save) the load guard's comment says cannot happen.
    expect(save.stockpile.wood).toBe(MAX_SAVED_COUNTER);
    expect(isLoadableSave(save)).toBe(true);
  });
});
