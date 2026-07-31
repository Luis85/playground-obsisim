import { createSystem, WriteResource } from 'sim-ecs';
import { describe, expect, it } from 'vitest';
import { SnapshotStore, StatsHistory, Stockpile } from '../../../src/engine/resources';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { StatsSystem } from '../../../src/engine/systems/stats-system';
import { buildColonyPrepWorld, initialSave } from '../../../src/engine/world';

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

    expect(world.getResource(StatsHistory).rates('wood').production).toBeCloseTo(1);
    expect(world.getResource(Stockpile).producedThisTick.size).toBe(0); // reset after recording
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.productionRate).toBeCloseTo(1);
    expect(snapshot.stockpile.wood.netFlow).toBeCloseTo(1);
  });
});
