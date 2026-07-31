import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { SimClock, SnapshotStore } from '../../src/engine/resources';
import { createColonyWorld, initialSave } from '../../src/engine/world';
import { enqueue as dispatch } from './fixtures';
import type { SaveGameV2 } from '../../src/shared/save';

async function run(world: Awaited<ReturnType<typeof createColonyWorld>>, ticks: number) {
  const clock = world.getResource(SimClock);
  for (let i = 0; i < ticks; i++) {
    clock.tick++;
    await world.step();
  }
}

/** Rich fixture: enough stock + idle workers to build the full economy at once. */
function richSave(): SaveGameV2 {
  const save = initialSave();
  save.stockpile = { wood: 500, planks: 200, berries: 200 };
  save.workers = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, hunger: 0, buildingId: null, toolTicks: 0 }));
  save.nextEntityId = 15;
  return save;
}

describe('full colony integration', () => {
  // The full bread-and-tools chain assertions this test used to make were
  // removed here: with output buffers (Task 2 of the logistics increment)
  // and nobody hauling, a multi-stage chain cannot run end to end — a
  // downstream building's input is sitting in the upstream building's
  // OutputBuffer, not in the shared Stockpile, so it never arrives. Task 4 of
  // docs/superpowers/plans/2026-07-31-increment-4-logistics.md restores an
  // end-to-end chain test here with haulers staffed. Until then, this test
  // only covers what is actually true of this colony today.
  it('raw stages fill their buffers; downstream stages stall until hauling exists', async () => {
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
    const finalByDef = Object.fromEntries(final.buildings.map((b) => [b.defId, b]));

    // Stage 1 — recipes with no inputs (forester, gatherersHut, farm): nothing
    // can block them, so they run every tick until their own OutputBuffer is
    // full, then hold there (outputFull) instead of losing throughput.
    for (const defId of ['forester', 'gatherersHut', 'farm']) {
      expect(finalByDef[defId].buffered).toBe(BALANCE.outputBufferCap);
      expect(finalByDef[defId].state).toBe('outputFull');
    }

    // Stage 2 — mill and bakery need wheat and flour respectively, and
    // neither ever reaches the Stockpile (farm's wheat and mill's flour are
    // both stuck in their own OutputBuffers): batchActive never turns on, so
    // these two buildings bank zero, ever.
    for (const defId of ['mill', 'bakery']) {
      expect(finalByDef[defId].buffered).toBe(0);
      expect(finalByDef[defId].state).toBe('waitingForInput');
    }
    expect(final.stockpile.wheat.stock).toBe(0);
    expect(final.stockpile.flour.stock).toBe(0);
    expect(final.stockpile.bread.stock).toBe(0);
    expect(final.stockpile.bread.productionRate).toBe(0);

    // sawmill and workshop are staffed on recipes whose inputs (wood, planks)
    // richSave seeds directly into the Stockpile to afford construction — so
    // unlike mill/bakery they DO run, but only by spending that starting
    // stock. Neither forester's wood nor sawmill's own planks output ever
    // crosses back into the Stockpile (both stay trapped in their makers'
    // OutputBuffers), so both cap out at their own buffer exactly like the
    // input-free stages, and the thing the colony actually wants — tools in
    // the Stockpile — never leaves zero.
    for (const defId of ['sawmill', 'workshop']) {
      expect(finalByDef[defId].buffered).toBe(BALANCE.outputBufferCap);
      expect(finalByDef[defId].state).toBe('outputFull');
    }
    expect(final.stockpile.tools.stock).toBe(0);
    expect(final.stockpile.tools.productionRate).toBe(0);
    expect(final.stockpile.planks.stock).toBeLessThan(200); // consumed by workshop, never topped up by sawmill

    // the colony itself is not in danger: the berries richSave also seeds
    // directly into the Stockpile carry everyone through the full run even
    // though gatherersHut's own berries output never reaches the Stockpile.
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
