import { describe, expect, it } from 'vitest';
import { IdCounter, SnapshotStore, StatsHistory, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { StatsSystem } from '../../../src/engine/systems/stats-system';
import { Building } from '../../../src/engine/components';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

describe('StatsSystem', () => {
  it('records per-tick flows and resets them', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem, StatsSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // 3 workers on a forester = 1 wood per tick
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    const buildingId = building.getComponent(Building)!.id;
    for (let i = 0; i < 3; i++) spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();

    for (let i = 0; i < 10; i++) await world.step();

    expect(world.getResource(StatsHistory).rates('wood').production).toBeCloseTo(1);
    expect(world.getResource(Stockpile).producedThisTick.size).toBe(0); // reset after recording
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.productionRate).toBeCloseTo(1);
    expect(snapshot.stockpile.wood.netFlow).toBeCloseTo(1);
  });
});
