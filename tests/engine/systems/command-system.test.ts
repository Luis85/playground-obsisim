import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, IdCounter, MAX_PENDING_COMMANDS, SimClock, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { enqueue } from '../fixtures';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnWorker } from '../../../src/engine/world';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV2 } from '../../../src/shared/save';

async function setup(save: SaveGameV2 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
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

  it('rejects construction once no buildable tile remains', async () => {
    const save = initialSave();
    let id = 10;
    for (let row = 0; row < 16; row++) {
      for (let col = 3; col < 24; col++) {
        save.buildings.push({ id: id++, defId: 'forester', progress: 0, batchActive: false, col, row });
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
});
