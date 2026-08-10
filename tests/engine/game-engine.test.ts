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
import type { IEntity, IRuntimeWorld } from 'sim-ecs';
import { Building, HaulTrip, InputBuffer, OutputBuffer } from '../../src/engine/components';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import { CAMP_SITE_ID, CAMP_TILE } from '../../src/shared/haul';
import type { ResourceId } from '../../src/shared/content-types';
import { colonyTotal } from './fixtures';
import { BALANCE } from '../../src/engine/content/balance';
import { Stockpile } from '../../src/engine/resources';

const refreshMock = vi.mocked(worldModule.refreshEntitySections);
import type { SaveGameV6 } from '../../src/shared/save';
import { MAX_SAVED_COUNTER } from '../../src/shared/save';

/** The forester scriptedRun builds: the starter house holds id 1 and the
 * founders 2-4, so the first thing constructed gets id 5. */
const FORESTER_ID = 5;

async function steps(engine: GameEngine, n: number) {
  for (let i = 0; i < n; i++) await engine.stepOnce();
}

const DETACH_FAILURE = 'detach failed with the entity still present';

/**
 * Stage the ONE shape `applyRemovals` can throw on, on a live engine's own
 * world: `removeEntity` throws for a building AND leaves it in the world, so
 * `detach`'s postcondition check re-throws instead of swallowing. Returns the
 * switch that clears the failure, standing in for whatever transient condition
 * caused it — a permanent one never leaves the paused state at all.
 *
 * Staged rather than provoked because the arm is UNREACHABLE against sim-ecs
 * 0.6.4: its runtime `removeEntity` skips its whole body for an entity it does
 * not hold, and otherwise deletes from `data.entities` as the first statement
 * of that body — so everything that can throw runs after the delete, leaving
 * `hasEntity` false and the throw swallowed. These two cases are therefore
 * ordering proofs for the day a sim-ecs upgrade changes that, not live bugs.
 *
 * Reaches the private world the same way 'a thrown step captures the error and
 * pauses' does, further down this file; there is no other seam, because
 * sim-ecs assigns `removeEntity` as an OWN property per world instance
 * (`__publicField`), so patching the prototype does nothing — verified, the
 * prototype patch never fires.
 */
function stageDetachFailure(engine: GameEngine): () => void {
  const world = (engine as unknown as { world: IRuntimeWorld & { removeEntity(entity: Readonly<IEntity>): void } }).world;
  const real = world.removeEntity.bind(world);
  let failing = true;
  world.removeEntity = (entity: Readonly<IEntity>): void => {
    if (failing && entity.hasComponent(Building)) throw new Error(DETACH_FAILURE);
    real(entity);
  };
  return () => { failing = false; };
}

/** Deterministic scripted session used by both determinism tests. */
async function scriptedRun(ticks: number, save?: SaveGameV6): Promise<GameEngine> {
  const engine = await GameEngine.create(save ?? null);
  if (!save) {
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    // ids: the starter house is 1 and the founders 2-4, so the constructed
    // forester gets id 5
    engine.dispatch({ type: 'assignWorker', buildingId: FORESTER_ID });
    engine.dispatch({ type: 'assignWorker', buildingId: FORESTER_ID });
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
    const save: SaveGameV6 = autosave.mock.calls[0][0];
    expect(save.buildings.find((b) => b.id === FORESTER_ID))
      .toEqual({
        id: FORESTER_ID, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
        // Both empty, and both asserted rather than omitted: `toEqual` on the
        // whole record is what makes a producer that stopped writing either
        // field fail here as well as in the round-trip cases.
        buffer: {}, inputBuffer: {}, stored: {}, relocatingTicks: 0,
      });
    expect(save.stockpile.wood).toBe(20); // cost paid AND building present
  });

  it('a save written on the tick after a die-off holds nobody the colony has already killed', async () => {
    // OBS-6-02's third consequence, and the one a player loses data to. The
    // autosave fires on `clock.tick % autosaveEveryTicks` INSIDE runStep, and
    // the clock advanced across the frozen steps a multi-entity removal used
    // to cost — so a save could land mid-freeze while colonists the snapshot
    // had already announced dead were still live entities. serialize() walks
    // live entities, so they went into the file: structurally valid, accepted
    // by isLoadableSave, and killed again by the first tick after the reload
    // (a starvation victim reloads at the threshold and dies on tick 1; an
    // old-age victim is dropped by restore's past-own-lifespan guard and never
    // appears at all). Nothing rejects such a save — that IS the problem, so
    // asserting it loads would pass either way. The roster is the assertion.
    //
    // tick 98 so the die-off lands on 99 and the autosave boundary on 100:
    // the first step of the freeze, back when there was one.
    const dying = [2, 3, 4].map((id) => ({
      id, hunger: BALANCE.hungerMax, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: BALANCE.lifeBands.matureTicks, homeId: 1, starvingTicks: BALANCE.starvationDeathTicks - 1,
    }));
    const survivor = {
      id: 5, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: 1000, homeId: 1, starvingTicks: 0,
    };
    const engine = await GameEngine.create({
      ...initialSave(), tick: 98, stockpile: {}, colonists: [...dying, survivor], nextEntityId: 6,
    });
    const autosave = vi.fn();
    engine.onAutosave(autosave);

    await engine.stepOnce(); // tick 99
    // Precondition, not the finding: the colony really did announce all three
    // deaths on one tick. Without this the roster check below could pass on a
    // tick that only ever killed one.
    expect(engine.snapshot!.notices.map((n) => n.message))
      .toEqual(['Colonist #2 starved.', 'Colonist #3 starved.', 'Colonist #4 starved.']);

    await engine.stepOnce(); // tick 100 -> autosave fires
    expect(autosave).toHaveBeenCalledTimes(1);
    const written: SaveGameV6 = autosave.mock.calls[0][0];
    expect(written.tick).toBe(100);
    expect(written.colonists.map((c) => c.id)).toEqual([survivor.id]);
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
    expect(save.buildings.find((b) => b.id === FORESTER_ID))
      .toEqual({
        id: FORESTER_ID, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
        // Same reasoning as the autosave case above: both empty, both asserted.
        buffer: {}, inputBuffer: {}, stored: {}, relocatingTicks: 0,
      });
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
      { inputBuffer: {}, stored: {}, id: 6, defId: 'sawmill', progress: 0, batchActive: false, col: 8, row: 1, buffer: {}, relocatingTicks: 0 },
      { inputBuffer: {}, stored: {}, id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 },
      ...initialSave().buildings, // the starter house, id 1, listed LAST on purpose
    ];
    save.colonists = [4, 2, 3].map((id) => ({
      id, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: 2500, homeId: 1, starvingTicks: 0,
    }));
    save.nextEntityId = 7;
    const engine = await GameEngine.create(save);
    const out = engine.serialize();
    expect(out.buildings.map((b) => b.id)).toEqual([1, 5, 6]);
    expect(out.colonists.map((c) => c.id)).toEqual([2, 3, 4]);
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
    expect(out.buildings.map((b) => b.defId)).toEqual(['house', 'forester', 'gatherersHut']);
    expect(out.tick).toBe(2); // the in-flight tick plus flush's own
  });

  it('a manual step publishes a snapshot including entities its commands created', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce(); // paused manual step: no follow-up tick will come
    expect(engine.snapshot!.buildings).toHaveLength(2); // the starter house and the new forester
    expect(engine.snapshot!.buildings[1].defId).toBe('forester');
    expect(engine.snapshot!.stockpile.wood.stock).toBe(20);
  });

  it('save/restore preserves entity ids and the id counter keeps incrementing past them', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // workers 1-3 exist -> gets id 4
    await steps(engine, 3);
    const save = engine.serialize();

    const restored = await GameEngine.create(save);
    expect(restored.snapshot!.colonists.map((c) => c.id).sort((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(restored.snapshot!.buildings.map((b) => b.id)).toEqual([1, FORESTER_ID]);

    restored.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await restored.stepOnce();
    expect(restored.snapshot!.buildings.map((b) => b.id).sort((a, b) => a - b)).toEqual([1, 5, 6]);
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
    expect(engine.snapshot!.buildings).toHaveLength(2);
  });

  it('a demolishing tick refreshes the published snapshot immediately', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    await engine.stepOnce();
    const buildingId = engine.snapshot!.buildings.find((b) => b.defId === 'forester')!.id;
    engine.dispatch({ type: 'demolishBuilding', buildingId });
    // Removal consumes no id, so without the RemovalLedger flag the
    // id-delta-gated refresh would skip and the demolished building would
    // linger in the published snapshot until the next id-consuming tick.
    await engine.stepOnce();
    expect(engine.snapshot!.buildings.map((b) => b.defId)).toEqual(['house']);
  });

  it('a resumed tick retries a failed removal before any system can rehome into the doomed house', async () => {
    const engine = await GameEngine.create();
    const clearFailure = stageDetachFailure(engine);
    const houseId = engine.snapshot!.buildings[0].id;
    expect(engine.snapshot!.colonists.map((c) => c.homeId)).toEqual([houseId, houseId, houseId]); // fixture precondition

    engine.dispatch({ type: 'demolishBuilding', buildingId: houseId });
    await engine.stepOnce();
    // The demolition itself RAN — refunded, buffer emptied, residents evicted,
    // removal queued. Only the detach failed, so the house is still standing
    // and the entry is back on the ledger.
    expect(engine.status.error).toBe(DETACH_FAILURE);
    expect(engine.status.paused).toBe(true);
    expect(engine.serialize().buildings.map((b) => b.id)).toEqual([houseId]);

    clearFailure();
    engine.start(); // the player resumes, which clears the error banner
    engine.pause(); // ...and this kills the interval, so the step below is the only tick
    await engine.stepOnce();

    // WHAT THIS PROTECTS. Retrying only AFTER the resumed tick's systems had
    // run put the house back into service for exactly one tick on the way out:
    // CommandSystem clears PendingChanges.demolished at the top, so
    // PopulationSystem read a house that was still in every query as a usable
    // shelter and rehomed all three colonists into it — and the post-step
    // retry then removed it out from under them. Assert on both readers that
    // were wrong: the homeIds themselves, and the save guard that turns them
    // into a corrupt-save backup instead of a colony.
    const save = engine.serialize();
    expect(save.buildings).toHaveLength(0); // the retry landed either way — precondition, not the point
    expect(save.colonists.map((c) => c.homeId)).toEqual([null, null, null]);
    expect(isLoadableSave(save)).toBe(true);
  });

  it('a close-save flushes a failed removal instead of writing the demolished building back to disk', async () => {
    const engine = await GameEngine.create();
    const clearFailure = stageDetachFailure(engine);
    const houseId = engine.snapshot!.buildings[0].id;

    engine.dispatch({ type: 'demolishBuilding', buildingId: houseId });
    await engine.stepOnce();
    expect(engine.status.paused).toBe(true);

    // GameView.onClose, in order: pause, flush, serialize. The demolish
    // command was CONSUMED by the failed tick, so CommandQueue is empty and a
    // flush() that only asks about the queue finds nothing to do — the
    // refunded, emptied house goes back to disk as though the demolition never
    // happened, and the ledger dies with the process, so nothing ever retries.
    clearFailure();
    engine.pause();
    await engine.flush();
    const save = engine.serialize();

    expect(save.buildings).toHaveLength(0);
    expect(isLoadableSave(save)).toBe(true);
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


/**
 * The save format's producer side — the half of save v6 that no shape check can
 * reach. `SavedBuilding` gains two required fields, and writing `{}` for both
 * typechecks, migrates, round-trips and passes every guard while silently
 * deleting every storehouse's contents and every in-tray on save.
 */
describe('buildSaveFromWorld writes all four places goods can be', () => {
  const DEPOT_ID = 5;
  const MILL_ID = 6;
  /** Out on the map and one tile apart, so a supply trip has a real leg to be
   * caught part-way through, and neither sits on the starter house's tile. */
  const DEPOT_TILE = { col: 14, row: 5 };
  const MILL_TILE = { col: 15, row: 5 };

  /** The private world a GameEngine drives, reached the way `stageDetachFailure`
   * above reaches it — there is no other seam, and these cases must read the
   * LIVE ledger rather than a save's own account of itself. */
  const worldOf = (engine: GameEngine) => (engine as unknown as { world: IRuntimeWorld }).world;

  /** initialSave() plus a depot holding `stored` and a mill beside it, the
   * mill's own in-tray holding `millInput` — {} for every caller that does not
   * pass one, so this stays a no-op addition for the other two tests below. */
  function colonyWithADepot(
    stored: Partial<Record<ResourceId, number>>, camp: Partial<Record<ResourceId, number>>,
    millInput: Partial<Record<ResourceId, number>> = {},
  ): SaveGameV6 {
    const save = initialSave();
    save.stockpile = { ...camp };
    save.buildings.push(
      {
        id: DEPOT_ID, defId: 'storehouse', ...DEPOT_TILE,
        progress: 0, batchActive: false, buffer: {}, inputBuffer: {}, stored, relocatingTicks: 0,
      },
      {
        id: MILL_ID, defId: 'mill', ...MILL_TILE,
        progress: 0, batchActive: false, buffer: {}, inputBuffer: millInput, stored: {}, relocatingTicks: 0,
      },
    );
    save.nextEntityId = MILL_ID + 1;
    return save;
  }

  /**
   * Every resource the colony owns, wherever it stands — `colonyTotal` per
   * resource, walking sites, both trays of every building and every hauler's
   * hands. THE conservation quantity: a field the producer just wrote can be
   * made to agree with itself, a colony-wide total cannot.
   */
  function totals(world: IRuntimeWorld): Record<string, number> {
    return Object.fromEntries(RESOURCE_IDS.map((id) => [id, colonyTotal(world, id)]));
  }

  /** A colony working its depot: the mill staffed, one hauler on duty. Bread so
   * nobody starves out of the fixture mid-run; wheat ONLY in the depot, so every
   * unit the mill ever holds was physically fetched from a site. */
  async function workingColony() {
    const engine = await GameEngine.create(colonyWithADepot({ wheat: 41 }, { wood: 30, bread: 90 }));
    engine.dispatch({ type: 'assignWorker', buildingId: MILL_ID });
    engine.dispatch({ type: 'assignHauler' });
    return engine;
  }

  /** The hauler's hands, when they hold a SUPPLY load and are still walking.
   * `pickedUp === false` is what makes it supply rather than collect — the same
   * discriminator §2.4's flow table needs. */
  function supplyLoad(world: IRuntimeWorld): HaulTrip | undefined {
    return [...world.getEntities()]
      .map((e) => e.getComponent(HaulTrip))
      .find((t) => t !== undefined && t.amount > 0 && !t.pickedUp);
  }

  /**
   * How much is standing in each of the five places a unit of goods can be.
   * Read as a set rather than summed, because "conserved" is only worth
   * asserting once every place actually holds something: the first version of
   * this fixture stopped at the first loaded hauler, when the mill's in-tray was
   * still empty — so it would have conserved four places out of five and passed
   * with `inputBuffer` deleted from the save entirely.
   */
  function wherever(world: IRuntimeWorld) {
    const stockpile = world.getResource(Stockpile);
    const mill = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === MILL_ID)!;
    return {
      camp: stockpile.totalAt(CAMP_SITE_ID),
      depot: stockpile.totalAt(DEPOT_ID),
      inTray: mill.getComponent(InputBuffer)!.total(),
      outTray: mill.getComponent(OutputBuffer)!.total(),
      hands: supplyLoad(world)?.amount ?? 0,
    };
  }

  /** Steps until every one of those five places holds something, or throws — a
   * fixture that silently stopped short is exactly how a conservation test ends
   * up conserving only the places it happened to reach. */
  async function stepToGoodsEverywhere(engine: GameEngine): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await engine.stepOnce();
      if (Object.values(wherever(worldOf(engine))).every((held) => held > 0)) return;
    }
    throw new Error('the colony never had goods in all five places at once');
  }

  it('a colony with goods in the camp AND a storehouse round-trips both', async () => {
    // Distinct amounts AND distinct resources at each site — 30 wood at the
    // camp, 17 planks in the depot — so every wrong producer fails on a VALUE
    // rather than on a total that happens to differ: one that writes only the
    // camp reads 0 planks, one that writes only `stored` reads 0 wood, and one
    // that wrote `colonyStock()` into `stockpile` would double-count the depot
    // and read 34 planks. A fixture with an empty camp would pass with the site
    // half deleted.
    const engine = await GameEngine.create(colonyWithADepot({ planks: 17 }, { wood: 30 }, { wheat: 9 }));
    const save = engine.serialize();

    expect(save.stockpile).toEqual({ wood: 30 }); // the CAMP alone, never the aggregate
    expect(save.buildings.find((b) => b.id === DEPOT_ID)!.stored).toEqual({ planks: 17 });
    // The parallel case for the OTHER site-shaped record: a building's own
    // in-tray, localized the same way `stored` is above rather than folded
    // into a colony-wide total — 9 is distinct from both 17 and 30, so a
    // producer that swapped this field for `stored`, or for the camp, fails
    // on its VALUE rather than surviving because the two totals happened to
    // agree.
    expect(save.buildings.find((b) => b.id === MILL_ID)!.inputBuffer).toEqual({ wheat: 9 });

    const stockpile = worldOf(await GameEngine.create(save)).getResource(Stockpile);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wood')).toBe(30);
    expect(stockpile.getAt(DEPOT_ID, 'planks')).toBe(17);
    expect(stockpile.get('planks')).toBe(17); // banked once, not once per projection
    expect(stockpile.get('wood')).toBe(30);
  });

  it('every ledger site other than the camp names a building in the save', async () => {
    // The sentinel for §2.4's second invariant, asserted from the other end. A
    // site with no building behind it is unserializable BY CONSTRUCTION here —
    // savedBuildingOf walks buildings — so its goods would count in
    // colonyWealth, be unreachable by any hauler, and then vanish at the next
    // save with nothing reporting it. Run over a colony that has been through a
    // demolition, the one path in the game that removes a site.
    const engine = await GameEngine.create(colonyWithADepot({ planks: 17 }, { wood: 30, planks: 5 }));
    // Guard against a vacuous sentinel: there must BE a non-camp site to orphan.
    expect(worldOf(engine).getResource(Stockpile).siteIds()).toContain(DEPOT_ID);

    engine.dispatch({ type: 'demolishBuilding', buildingId: DEPOT_ID });
    await engine.stepOnce();

    const save = engine.serialize();
    expect(save.buildings.some((b) => b.id === DEPOT_ID)).toBe(false); // the building really is gone
    const named = new Set(save.buildings.map((b) => b.id));
    const orphans = worldOf(engine).getResource(Stockpile).siteIds().filter((id) => id !== CAMP_SITE_ID && !named.has(id));
    expect(orphans).toEqual([]);

    // And the goods came with it. 5 at the camp + 17 spilled out of the depot +
    // the storehouse's own 10-plank cost refunded = 32; no subset of those
    // coincides, so a spill that lost or double-counted a pile fails on 32.
    expect(save.stockpile.planks).toBe(32);
    expect(save.stockpile.wood).toBe(50); // 30 + the refunded 20
  });

  it('save and load conserves everything and the colony resumes work', async () => {
    const engine = await workingColony();
    await stepToGoodsEverywhere(engine);
    const live = worldOf(engine);
    const before = totals(live);
    // Guard, stated place by place rather than as one total: each of the five
    // is a separate way for the save format to lose goods, and a single summed
    // assertion cannot say which of them the fixture actually reached.
    for (const [place, held] of Object.entries(wherever(live))) {
      expect(held, `nothing standing at ${place}`).toBeGreaterThan(0);
    }

    // Resource by resource, across every site, both trays and the hauler's
    // hands — NOT the field the producer just wrote. Dropping `stored` loses the
    // depot's wheat; dropping `inputBuffer` loses the mill's.
    const restored = await GameEngine.create(engine.serialize());
    expect(totals(worldOf(restored))).toEqual(before);

    // NOT tick-identical resumption — that was an overclaim and is now false: a
    // colony saved with a hauler beside a depot comes back with everyone at the
    // camp, so claims, travel times and distribution all differ. What IS
    // guaranteed is that every site's stock is still reachable, so work resumes
    // within a bounded number of ticks.
    await steps(restored, 40);
    expect(totals(worldOf(restored)).flour).toBeGreaterThan(before.flour);
  });

  it('a hauler mid-supply-trip banks its load at the camp and stands there on load', async () => {
    // HaulTrip still never enters the save (increment 4's simplification,
    // kept): conservation exact, no guard, no migration.
    const engine = await workingColony();
    await stepToGoodsEverywhere(engine);
    const trip = supplyLoad(worldOf(engine))!;
    const carried = trip.amount;
    const live = worldOf(engine);
    const campWheat = live.getResource(Stockpile).getAt(CAMP_SITE_ID, 'wheat');

    const save = engine.serialize();
    expect(save.stockpile.wheat).toBe(campWheat + carried);
    // A save is a snapshot, not an event: the live colony still walks that load
    // to the mill.
    expect(trip.amount).toBe(carried);

    const restored = await GameEngine.create(save);
    expect(totals(worldOf(restored))).toEqual(totals(live));
    const trips = [...worldOf(restored).getEntities()]
      .map((e) => e.getComponent(HaulTrip))
      .filter((t) => t !== undefined);
    expect(trips.length).toBeGreaterThan(0);
    for (const t of trips) {
      expect(t).toMatchObject({ phase: 'idle', amount: 0, atCol: CAMP_TILE.col, atRow: CAMP_TILE.row });
    }
  });
});
