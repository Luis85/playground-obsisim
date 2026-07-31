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
    // isLoadableSave rejects a worker whose buildingId names no building -- but
    // reachable through spawnWorker, and reachable in-game once entity REMOVAL
    // lands (increment 2), when a JobAssignment can outlive its building. Pinned
    // now so the change that makes it live doesn't also get to pick the wording.
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
});
