import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, IdCounter, MAX_PENDING_COMMANDS, SimClock, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { Building, HaulTrip, OutputBuffer, Relocation, Worker } from '../../../src/engine/components';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { HungerSystem } from '../../../src/engine/systems/hunger-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { enqueue } from '../fixtures';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';
import { buildColonyPrepWorld, COMPONENT_TYPES, getPrepResource, initialSave, spawnWorker } from '../../../src/engine/world';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV4 } from '../../../src/shared/save';

async function setup(save: SaveGameV4 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  // mirror GameEngine.stepOnce: the engine owns time, bumping the clock before each step.
  // Without this the recruit cooldown (which compares SimClock.tick) can never elapse.
  const tick = async () => {
    world.getResource(SimClock).tick++;
    await world.step();
  };
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = (w: IRuntimeWorld = world) => w.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

// Relocation downtime is enforced by ProductionSystem, which the shared setup()
// deliberately omits. Order matches ALL_SYSTEMS (buildColonyPrepWorld throws
// otherwise).
async function setupWithProduction(save: SaveGameV4 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, ProductionSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  const tick = async () => {
    world.getResource(SimClock).tick++;
    await world.step();
  };
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = () => world.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

describe('CommandSystem', () => {
  it('constructs a building, paying its cost; entity appears next tick', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // 30 - 10
    expect(snapshot().buildings).toHaveLength(0); // command applied at end of step
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Built a Forester.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0].defId).toBe('forester');
  });

  it('rejects unaffordable construction with a notice', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'workshop' }); // needs 20 planks
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot afford Workshop.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('recruits a worker and enforces the 30-tick cooldown', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Recruited worker #4.' }]);
    await tick();
    expect(snapshot().population).toBe(4);
    await dispatch({ type: 'recruitWorker' }); // still on cooldown
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Recruiting is still on cooldown.' }]);
    for (let i = 0; i < 30; i++) await tick();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(5);
  });

  it('assigns and unassigns workers within slot limits', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a worker to Forester.' }]);
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(2);
    await dispatch({ type: 'assignWorker', buildingId }); // forester has 2 slots
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free worker slots at this building.' }]);
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from Forester.' }]);
    expect(snapshot().buildings[0].workers).toBe(1);
    expect(snapshot().idleWorkers).toBe(2);
  });

  it('falls back to a generic name when the building an assignment points at is gone', async () => {
    // buildingName's 'building' fallback. Unreachable through the save path --
    // isLoadableSave rejects a worker whose buildingId names no building -- and
    // demolition kept it fixture-only: it nulls every assignment it evicts and
    // the same-tick demolishedIds guard rejects later commands against the id.
    // Pinned as defense in depth for any future remover that misses eviction.
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
    spawnWorker(prep, getPrepResource(prep, IdCounter), { buildingId: 404 }); // no building 404
    const world = await prep.prepareRun();
    enqueue(world, { type: 'unassignWorker', buildingId: 404 });
    world.getResource(SimClock).tick++;
    await world.step();

    const notices = world.getResource(SnapshotStore).latest!.notices;
    expect(notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from building.' }]);
  });

  it('refuses entity creation once the id space is exhausted, without side effects', async () => {
    const save = initialSave();
    save.nextEntityId = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER: nothing left to hand out
    const { world, tick, dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // cost not paid
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().population).toBe(3);
  });

  it('notices when assigning to a missing building or with no idle workers, or unassigning from an unstaffed one', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignWorker', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;

    // a real building nobody has been assigned to yet
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No worker assigned to this building.' }]);

    // a second forester so a slot stays open even once every worker is busy
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const secondBuildingId = snapshot().buildings.find((b) => b.id !== buildingId)!.id;

    // 3 starting workers, 2 slots per forester: fill building 1 (2 workers),
    // send the last idle worker to building 2 (1/2 slots) -- one open slot
    // remains there, but every worker is now busy.
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('emits exactly one notice naming the drop count after a queue overflow', async () => {
    const { world, tick, snapshot } = await setup();
    const queue = world.getResource(CommandQueue);
    for (let i = 0; i < MAX_PENDING_COMMANDS + 5; i++) queue.push({ type: 'recruitWorker' });
    await tick();
    const dropNotices = snapshot().notices.filter((n) => n.message.includes('dropped'));
    expect(dropNotices).toEqual([{ kind: 'rejection', message: '5 command(s) were dropped: the queue was full.' }]);
  });

  it('constructs at a chosen buildable tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 7, row: 4 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Built a Forester.' }]);
    await tick();
    expect(snapshot().buildings[0]).toMatchObject({ defId: 'forester', col: 7, row: 4 });
  });

  it('auto-places table constructions on the legacy plot pattern', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await tick();
    expect(snapshot().buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });

  it('rejects out-of-bounds, camp-band, and occupied tiles without paying', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 0, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 24, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // nothing paid
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // only the forester paid
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick constructions cannot claim one tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester', at: { col: 6, row: 2 } },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 2 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick auto-placed constructions land on distinct plots', async () => {
    // the claimedTiles bridge must feed autoPlacePosition too, not only the
    // explicit-at validator — otherwise both table builds pick one plot
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester' },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut' },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'success']);
    await tick();
    const tiles = snapshot().buildings.map((b) => `${b.col},${b.row}`);
    expect(new Set(tiles).size).toBe(2);
  });

  it('rejects construction once no buildable tile remains', async () => {
    const save = initialSave();
    let id = 10;
    for (let row = 0; row < 16; row++) {
      for (let col = 3; col < 24; col++) {
        save.buildings.push({ id: id++, defId: 'forester', progress: 0, batchActive: false, col, row, buffer: {}, relocatingTicks: 0 });
      }
    }
    save.nextEntityId = id;
    save.stockpile = { wood: 100 };
    const { dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free tile left to build on.' }]);
  });

  it('demolishes: refunds the cost, idles the workers, removes the entity', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // wood 30 -> 20
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // full refund
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().idleWorkers).toBe(3);
  });

  it('demolishing a building with buffered goods names the loss; the refund stays exactly the construction cost', async () => {
    // OBS-4-07, resolved: the buffer is destroyed either way (unchanged from
    // the test above) — only the notice's wording is new. The stockpile
    // assertion is the guard that this stayed a messaging fix: it must land on
    // the exact same 30 as the empty-building case above, proving the 9
    // buffered wood never reached the stockpile despite being named in the notice.
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // wood 30 -> 20
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded, 9 Wood lost.' },
    ]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // construction refund only, same as the empty case
  });

  it('demolishing an empty building leaves the notice byte-identical to today\'s wording', async () => {
    // OBS-4-07: a zero-units clause would be noise on the common case, so an
    // empty buffer must not grow a trailing ", lost." clause of any kind.
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
  });

  it('rejects demolishing a building that does not exist', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'demolishBuilding', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
  });

  it('a demolished id is dead within its own tick: later commands against it reject', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'assignWorker', buildingId },
      { type: 'unassignWorker', buildingId },
      { type: 'demolishBuilding', buildingId },
    );
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
    ]);
  });

  it('a tile freed by demolition is buildable again on the NEXT tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } },
    );
    expect(snapshot().notices[1]).toEqual({ kind: 'rejection', message: 'Cannot build there.' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: "Built a Gatherer's Hut." }]);
  });

  it('moves a building in place — same id, workers and batch intact, visible same tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Position is a component mutation, not a deferred entity command — the
    // same tick's snapshot already shows it.
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 9, row: 6, workers: 1 });
  });

  it('rejects moving to an occupied tile, its own tile, off-map, or a missing building', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 6, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 1, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId: 999, to: { col: 9, row: 9 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
    expect(snapshot().buildings[0]).toMatchObject({ col: 5, row: 5 }); // never moved
  });

  it('same-tick: a construction claims its tile before a later move can take it', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 7, row: 7 } },
      { type: 'moveBuilding', buildingId, to: { col: 7, row: 7 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
  });

  it('assigns and unassigns haulers, with one notice each', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a hauler.' }]);
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(1);
    expect(snapshot().idleWorkers).toBe(2); // 3 starting workers, one now hauling

    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(0);
    expect(snapshot().idleWorkers).toBe(3);
  });

  it('rejects hauler assignment with no idle worker, and unassignment with no hauler', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No hauler to unassign.' }]);

    await dispatch({ type: 'assignHauler' }, { type: 'assignHauler' }, { type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('haulers are workers in every other respect — they still eat', async () => {
    // Built directly against HungerSystem: the shared `setup` runs only the
    // command and snapshot systems, so it could never show a hauler eating.
    const save = initialSave();
    save.workers = [];
    save.stockpile = { berries: 5 };
    const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
    spawnWorker(prep, getPrepResource(prep, IdCounter), { hauling: true });
    const world = await prep.prepareRun();
    for (let i = 0; i <= BALANCE.mealThreshold; i++) await world.step();
    expect(world.getResource(Stockpile).get('berries')).toBeLessThan(5);
  });

  it('never takes a building worker for hauling', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignHauler' }); // one idle worker left
    await dispatch({ type: 'assignHauler' }); // none left
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    expect(snapshot().buildings[0].workers).toBe(2); // the staffed pair was never poached
  });

  it('assigning a building worker never poaches a hauler', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // Turn every starting worker into a hauler (3 workers total)
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    // Verify all are hauling and none are idle
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(3);
    expect(snapshot().idleWorkers).toBe(0);
    // Try to assign a worker to the building — should reject, not poach a hauler
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    // Verify every hauler is still hauling with no buildingId
    expect(snapshot().workers.every((w) => w.hauling && w.buildingId === null)).toBe(true);
    expect(snapshot().buildings[0].workers).toBe(0);
  });

  it('a hauler unassigned mid-trip drops its load in the store, never into nothing', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'assignHauler' });
    await tick(); await tick(); await tick(); await tick(); // out and loaded
    const carrier = [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0)!;
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity);
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The trip must be reset, not merely handed off: buildSaveFromWorld banks a
    // carried load into the save filtered on `carrying`, NOT on `hauling`, so a
    // load left in hand here would be banked a second time on the next save —
    // the same units twice. legTicks and the pickup tile were genuinely
    // non-zero the moment before this (the carrier was mid-return-leg from
    // (5,4)) — reset() must clear them along with everything else, the same
    // way it clears phase/targetId/resource/amount.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({
      phase: 'idle', targetId: null, resource: null, amount: 0, legTicks: 0, pickupCol: 0, pickupRow: 0,
    });
    expect(buildSaveFromWorld(world).stockpile.wood).toBe(before + BALANCE.haulCarryCapacity);
  });

  // OBS-4-08: the old rule took the first hauler in entity-iteration order, so
  // pressing `−` could interrupt a loaded worker most of the way home while an
  // idle one stood at the camp. No goods were lost — the load is banked — but
  // the walk already done was thrown away for nothing.
  it('unassigning releases an idle hauler rather than one carrying a load home', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner: 13 ticks each way, so the return leg is long enough that
    // the two dispatches below cannot finish it out from under the assertion.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      // Exactly one load: the first hauler empties the buffer, so the second has
      // nothing to fetch and stays idle at the camp instead of going outbound.
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity);
      }
    }
    await dispatch({ type: 'assignHauler' });
    const loaded = () => [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0);
    for (let i = 0; i < 20 && loaded() === undefined; i++) await tick();
    const carrier = loaded()!;
    expect(carrier.getComponent(HaulTrip)!.phase).toBe('returning'); // precondition, not the assertion
    await dispatch({ type: 'assignHauler' });

    const carriedBefore = carrier.getComponent(HaulTrip)!.amount;
    const stockBefore = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The idle one went. The loaded trip is untouched: still returning, still
    // holding its load, and nothing banked early.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({ phase: 'returning', amount: carriedBefore });
    expect(world.getResource(Stockpile).get('wood')).toBe(stockBefore);
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(1);
  });

  it('a move retargets the haulers already walking to that building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner of the default map: BALANCE.haulTilesPerTick's own comment
    // pins it at 13 ticks each way -- genuinely distant, not a token trip.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    // CommandSystem runs before HaulSystem (the real ALL_SYSTEMS order), so the
    // very tick that flags the worker as hauling also dispatches it -- no extra
    // tick is needed to see it start walking.
    await dispatch({ type: 'assignHauler' });
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    expect(trip()).toMatchObject({ targetId: buildingId, ticksLeft: 13, legTicks: 13 }); // the far-corner distance

    await tick(); await tick(); // well into the walk, nowhere near arrival
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 11, legTicks: 13 }); // legTicks never decrements

    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 1 } }); // just past camp: 2 ticks away
    // Recomputed against the new tile (2), then HaulSystem's same-tick decrement
    // (CommandSystem runs first) takes it to 1 -- not the stale 11 the old,
    // far-away tile would have left behind. Exact value, still true under the
    // real order because 2 ticks leaves room for CommandSystem's write to be
    // decremented once without hitting zero in this same tick. legTicks is
    // refreshed to the SAME new total (2) but, unlike ticksLeft, is never
    // touched by that same-tick decrement — it is OBS-5-01's frozen figure.
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 1, legTicks: 2 });

    // Behavioral proof, not another frame of the counter: within a handful of
    // ticks (not the dozen the original far-corner distance demanded) the
    // hauler must actually arrive, load, walk home and deposit.
    await tick(); await tick(); await tick();
    expect(trip().phase).toBe('idle'); // arrived, loaded, walked home, delivered
    expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity); // the goods actually reached the stockpile
  });

  it('a move does not disturb a hauler already on its return leg', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } }); // 5 tiles out -> 3 ticks each way
    await tick();
    const buildingId = snapshot().buildings[0].id;
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity);
    }
    await dispatch({ type: 'assignHauler' }); // dispatched this same tick: outbound, ticksLeft 3
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    await tick(); await tick(); await tick(); // walks the 3 ticks out and loads
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 3, legTicks: 3, pickupCol: 5, pickupRow: 4,
      resource: 'wood', amount: BALANCE.haulCarryCapacity,
    });

    // The building it loaded from moves elsewhere. A returning hauler walks to
    // the camp, which never moves, so this must leave the trip alone.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Only HaulSystem's ordinary per-tick decrement (3 -> 2), nothing extra
    // from the move: ticksLeft and the load it is carrying are untouched — and
    // neither are legTicks or the pickup tile. OBS-5-01: a returning trip's
    // origin does not follow the building; pickupCol/pickupRow must still read
    // the OLD (5,4), never the new (9,6) the building moved to.
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 2, legTicks: 3, pickupCol: 5, pickupRow: 4,
      resource: 'wood', amount: BALANCE.haulCarryCapacity,
    });

    await tick(); await tick(); // the same 2 ticks it would have taken without the move
    expect(trip().phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity); // still delivers in full
  });

  // The buildings-side companion to the worker parity test below. OBS-4-02
  // recorded its absence as an open gap: OutputBuffer was added to the restore
  // path only, so buildings constructed during play had no buffer at all, and
  // nothing in the suite would have noticed.
  it('a constructed building carries the same components as a restored one', async () => {
    const save: SaveGameV4 = {
      ...initialSave(),
      buildings: [{ id: 10, defId: 'forester', col: 6, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 }],
      nextEntityId: 11, // strictly past every id above, or the load guard refuses the save
    };
    const { world, tick, dispatch } = await setup(save);
    const restored = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === 10)!;
    const expected = COMPONENT_TYPES.filter((type) => restored.getComponent(type) !== undefined);
    expect(expected.length).toBeGreaterThan(0); // guards against an empty comparison passing vacuously

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    // id > 10 identifies the live-constructed one: the restored building holds
    // exactly 10, and ids only ever increase.
    const constructed = [...world.getEntities()]
      .filter((e) => e.getComponent(Building) !== undefined)
      .find((e) => e.getComponent(Building)!.id > 10)!;
    expect(constructed, 'no building was constructed').toBeDefined();
    for (const type of expected) {
      expect(constructed.getComponent(type), `constructed building is missing ${type.name}`).toBeDefined();
    }
  });

  it('a recruited worker carries the same components as a restored one', async () => {
    const { world, tick, dispatch } = await setup();
    // The highest existing id, not just "the first worker found": entity
    // iteration order is not id-ordered, and comparing against an arbitrary
    // starting worker would let the id > before.id check below match another
    // pre-existing (and therefore trivially complete) worker instead of the
    // actual recruit, silently defeating the whole test.
    const workers = [...world.getEntities()].filter((e) => e.getComponent(Worker) !== undefined);
    const before = workers.reduce((max, e) => (e.getComponent(Worker)!.id > max.getComponent(Worker)!.id ? e : max));
    const expected = COMPONENT_TYPES.filter((type) => before.getComponent(type) !== undefined);
    await dispatch({ type: 'recruitWorker' });
    await tick();
    const recruited = [...world.getEntities()]
      .filter((e) => e.getComponent(Worker) !== undefined)
      .find((e) => e.getComponent(Worker)!.id > before.getComponent(Worker)!.id)!;
    for (const type of expected) {
      expect(recruited.getComponent(type), `recruited worker is missing ${type.name}`).toBeDefined();
    }
  });

  it('a moved building stops producing for a distance-scaled downtime', async () => {
    const { tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    for (let i = 0; i < 10; i++) await tick(); // it is genuinely producing
    const madeBefore = snapshot().buildings[0].buffered;
    expect(madeBefore).toBeGreaterThan(0);

    // (5,4) -> (15,4) is exactly 10 tiles; at 1 tile/tick that is 10 ticks.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 15, row: 4 } });
    const paused = snapshot().buildings[0].buffered;
    for (let i = 0; i < 9; i++) await tick();
    expect(snapshot().buildings[0].buffered).toBe(paused); // nothing made while relocating

    for (let i = 0; i < 6; i++) await tick(); // downtime over, work resumes
    expect(snapshot().buildings[0].buffered).toBeGreaterThan(paused);
  });

  it('moving again replaces the remaining downtime rather than adding to it', async () => {
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } }); // long move
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 21, row: 14 } }); // 1 tile: 1 tick
    const relocation = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocation.ticksLeft).toBeLessThanOrEqual(1);
  });

  it('haulers still collect from a relocating building', async () => {
    // Acceptance criterion 3. Goods already in the buffer exist whether or not
    // the crew is working, so only production pauses — a relocating building
    // with a full buffer must still drain.
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity);
      }
    }
    await dispatch({ type: 'assignHauler' });
    // Move it far enough that the downtime outlasts the whole haul round trip.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } });
    const relocating = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocating.ticksLeft).toBeGreaterThan(10); // genuinely out of action for the whole trip

    const before = world.getResource(Stockpile).get('wood');
    for (let i = 0; i < 40; i++) await tick();
    expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity);
    expect(snapshot().buildings[0].buffered).toBe(0); // the buffer genuinely drained
  });

  it('demolition still refunds 100% of construction cost', async () => {
    // A decision, not an accident: increment 5 considered cutting the refund as
    // a balance knob and rejected it, because free relocation dominated it —
    // a player could dodge any refund penalty by moving instead of rebuilding.
    // Now that moving costs downtime the two acts are cleanly separated: moving
    // costs time, removing is fully refunded.
    //
    // The NUMBER is already guarded by the two demolition tests above — both
    // fail if the refund is halved. What this test adds is the REASON it is
    // 100%, recorded at an assertion rather than only in a spec, so a future
    // balance pass reaching for this knob finds the argument against it here.
    const { world, tick, dispatch, snapshot } = await setup();
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before - 10); // forester costs 10 wood
    await tick(); // the entity appears the tick after the command is handled
    await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
    expect(world.getResource(Stockpile).get('wood')).toBe(before);
  });

  it('demolition refund does not count as a hauler delivery', async () => {
    // Stockpile.add unconditionally records into producedThisTick, which
    // StatsSystem publishes as deliveredRate. Routing the refund through
    // add() would inflate Delivered/t for a resource no hauler touched, and
    // could push it above Made/t — undermining the gap-is-haul-backlog
    // reading the Made/t + Delivered/t pairing (OBS-4-06) depends on.
    // refund() must bank the same amount without ever touching
    // producedThisTick. Both halves matter: the refund amount is existing
    // behaviour that must not regress, and the zeroed producedThisTick is
    // the fix.
    const { world, tick, dispatch, snapshot } = await setup();
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
    expect(world.getResource(Stockpile).get('wood')).toBe(before); // full refund, unchanged
    expect(world.getResource(Stockpile).producedThisTick.get('wood') ?? 0).toBe(0); // not a delivery
  });
});
