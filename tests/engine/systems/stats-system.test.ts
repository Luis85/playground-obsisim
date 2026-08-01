import { createSystem, WriteResource } from 'sim-ecs';
import { describe, expect, it } from 'vitest';
import { IdCounter, ProductionLedger, SimClock, SnapshotStore, StatsHistory, Stockpile } from '../../../src/engine/resources';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { StatsSystem } from '../../../src/engine/systems/stats-system';
import { ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';
import { Building } from '../../../src/engine/components';

// StatsSystem's actual contract is "record whatever flows the Stockpile saw
// this tick, then reset" — it never needed ProductionSystem to exercise it.
// Production now banks batches into a building's OutputBuffer instead of the
// Stockpile (Task 2), so a real forester can no longer drive this test. This
// tiny system, built the same way the real systems are, deposits straight
// into the Stockpile instead — isolating StatsSystem from the production
// path on purpose.
const DepositWoodSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
})
  .withName('DepositWoodSystem')
  .withRunFunction(({ stockpile }) => {
    stockpile.add('wood', 1);
  })
  .build();

describe('StatsSystem', () => {
  it('records per-tick flows and resets them', async () => {
    const save = initialSave();
    save.workers = [];
    // 1 wood deposited per tick, same as "3 workers on a forester" used to yield.
    const prep = buildColonyPrepWorld({ save, systems: [DepositWoodSystem, StatsSystem, SnapshotSystem] });
    const world = await prep.prepareRun();

    for (let i = 0; i < 10; i++) await world.step();

    expect(world.getResource(StatsHistory).rates('wood').delivered).toBeCloseTo(1);
    expect(world.getResource(Stockpile).producedThisTick.size).toBe(0); // reset after recording
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.deliveredRate).toBeCloseTo(1);
    expect(snapshot.stockpile.wood.netFlow).toBeCloseTo(1);
  });

  it('reports made and delivered as separate rates', async () => {
    // A forester with no haulers: it banks wood into its own buffer every batch
    // and nothing ever reaches the store. Under one combined "production" rate
    // these were indistinguishable, which is the schema half of OBS-4-06.
    const save = initialSave();
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const b = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4 });
    const bid = b.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId: bid });
    spawnWorker(prep, ids, { buildingId: bid });
    const world = await prep.prepareRun();

    for (let i = 0; i < 12; i++) {
      world.getResource(SimClock).tick++;
      await world.step();
    }
    const wood = world.getResource(SnapshotStore).latest!.stockpile.wood;
    expect(wood.madeRate).toBeGreaterThan(0);   // the crew is working
    expect(wood.deliveredRate).toBe(0);         // nobody carried any of it home
    expect(world.getResource(ProductionLedger).madeThisTick.size).toBe(0); // reset after recording
  });
});
