import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, SimClock, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { buildColonyPrepWorld, initialSave } from '../../../src/engine/world';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV1 } from '../../../src/shared/save';

async function setup(save: SaveGameV1 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  // mirror GameEngine.stepOnce: the engine owns time, bumping the clock before each step.
  // Without this the recruit cooldown (which compares SimClock.tick) can never elapse.
  const tick = async () => {
    world.getResource(SimClock).tick++;
    await world.step();
  };
  const dispatch = async (...commands: Command[]) => {
    world.getResource(CommandQueue).pending.push(...commands);
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
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0].defId).toBe('forester');
  });

  it('rejects unaffordable construction with a notice', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'workshop' }); // needs 20 planks
    expect(snapshot().notices).toEqual(['Cannot afford Workshop.']);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('recruits a worker and enforces the 30-tick cooldown', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(4);
    await dispatch({ type: 'recruitWorker' }); // still on cooldown
    expect(snapshot().notices).toEqual(['Recruiting is still on cooldown.']);
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
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(2);
    await dispatch({ type: 'assignWorker', buildingId }); // forester has 2 slots
    expect(snapshot().notices).toEqual(['No free worker slots at this building.']);
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(1);
    expect(snapshot().idleWorkers).toBe(2);
  });

  it('notices when assigning to a missing building or with no idle workers', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignWorker', buildingId: 999 });
    expect(snapshot().notices).toEqual(['Building not found.']);
  });
});
