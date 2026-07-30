import { describe, expect, it } from 'vitest';
import { CommandQueue, SimClock, SnapshotStore } from '../../src/engine/resources';
import { createColonyWorld, initialSave } from '../../src/engine/world';
import type { Command } from '../../src/shared/commands';
import type { SaveGameV1 } from '../../src/shared/save';

async function run(world: Awaited<ReturnType<typeof createColonyWorld>>, ticks: number) {
  const clock = world.getResource(SimClock);
  for (let i = 0; i < ticks; i++) {
    clock.tick++;
    await world.step();
  }
}

function dispatch(world: Awaited<ReturnType<typeof createColonyWorld>>, ...commands: Command[]) {
  const queue = world.getResource(CommandQueue);
  for (const command of commands) queue.push(command);
}

/** Rich fixture: enough stock + idle workers to build the full economy at once. */
function richSave(): SaveGameV1 {
  const save = initialSave();
  save.stockpile = { wood: 500, planks: 200, berries: 200 };
  save.workers = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, hunger: 0, buildingId: null, toolTicks: 0 }));
  save.nextEntityId = 15;
  return save;
}

describe('full colony integration', () => {
  it('bootstraps both chains to steady bread and tools production', async () => {
    const world = await createColonyWorld(richSave());
    dispatch(
      world,
      { type: 'constructBuilding', buildingDefId: 'gatherersHut' },
      { type: 'constructBuilding', buildingDefId: 'farm' },
      { type: 'constructBuilding', buildingDefId: 'mill' },
      { type: 'constructBuilding', buildingDefId: 'bakery' },
      { type: 'constructBuilding', buildingDefId: 'forester' },
      { type: 'constructBuilding', buildingDefId: 'sawmill' },
      { type: 'constructBuilding', buildingDefId: 'workshop' },
    );
    await run(world, 2); // construct, then entities appear
    const snapshot = () => world.getResource(SnapshotStore).latest!;
    const byDef = Object.fromEntries(snapshot().buildings.map((b) => [b.defId, b.id]));
    dispatch(
      world,
      { type: 'assignWorker', buildingId: byDef.gatherersHut },
      { type: 'assignWorker', buildingId: byDef.farm },
      { type: 'assignWorker', buildingId: byDef.farm },
      { type: 'assignWorker', buildingId: byDef.mill },
      { type: 'assignWorker', buildingId: byDef.mill },
      { type: 'assignWorker', buildingId: byDef.bakery },
      { type: 'assignWorker', buildingId: byDef.bakery },
      { type: 'assignWorker', buildingId: byDef.forester },
      { type: 'assignWorker', buildingId: byDef.forester },
      { type: 'assignWorker', buildingId: byDef.sawmill },
      { type: 'assignWorker', buildingId: byDef.sawmill },
      { type: 'assignWorker', buildingId: byDef.workshop },
      { type: 'assignWorker', buildingId: byDef.workshop },
    );
    await run(world, 400);

    const final = snapshot();
    expect(final.stockpile.bread.stock).toBeGreaterThan(0);
    expect(final.stockpile.tools.productionRate).toBeGreaterThan(0);
    expect(final.stockpile.bread.productionRate).toBeGreaterThan(0);
    // wheat must not accumulate unboundedly (2 farm workers vs 2 mill workers)
    expect(final.stockpile.wheat.stock).toBeLessThan(50);
    // everyone stays fed on the safety net + bread
    expect(final.workers.every((w) => w.efficiency > 0.5)).toBe(true);
    expect(final.colonyWealth).toBeGreaterThan(0);
  });

  it('starvation drops efficiency toward 0.2 and food restores it (nobody dies)', async () => {
    const save = initialSave(); // 20 berries, 3 workers, no production
    const world = await createColonyWorld(save);
    await run(world, 400); // berries run out, workers starve
    const snapshot = () => world.getResource(SnapshotStore).latest!;
    expect(snapshot().population).toBe(3); // nobody dies
    expect(snapshot().workers.every((w) => w.efficiency <= 0.21)).toBe(true);

    // hand the colony bread: everyone recovers within a meal cycle
    const { Stockpile } = await import('../../src/engine/resources');
    world.getResource(Stockpile).add('bread', 50);
    await run(world, 60);
    expect(snapshot().workers.every((w) => w.efficiency === 1)).toBe(true);
  });

  it('starting state matches the spec (30 wood, 20 berries, 3 idle workers)', async () => {
    const world = await createColonyWorld();
    await run(world, 1);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.stock).toBe(30);
    expect(snapshot.population).toBe(3);
    expect(snapshot.idleWorkers).toBe(3);
    expect(snapshot.buildings).toHaveLength(0);
  });
});
