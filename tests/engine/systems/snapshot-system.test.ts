import { describe, expect, it } from 'vitest';
import { Building } from '../../../src/engine/components';
import { IdCounter, NoticeBoard, SnapshotStore } from '../../../src/engine/resources';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

describe('SnapshotSystem', () => {
  it('projects a complete snapshot', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = { wood: 10, bread: 2 };
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 1.5, batchActive: true });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, hunger: 20, toolTicks: 10 });
    spawnWorker(prep, ids); // idle
    getPrepResource(prep, NoticeBoard).reject('test notice');

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.population).toBe(2);
    expect(snapshot.idleWorkers).toBe(1);
    expect(snapshot.stockpile.wood.stock).toBe(10);
    expect(snapshot.colonyWealth).toBe(10 * 1 + 2 * 8); // wood@1 + bread@8
    expect(snapshot.notices).toEqual([{ kind: 'rejection', message: 'test notice' }]);

    const b = snapshot.buildings[0];
    expect(b.defId).toBe('forester');
    expect(b.workers).toBe(1);
    expect(b.state).toBe('producing');
    expect(b.progressPct).toBe(50); // 1.5 / 3
    expect(b.tooledWorkers).toBe(1);
    expect(b.workPower).toBeCloseTo(1.5); // 1 covered worker: eff 1.0 x tool 1.5

    expect(snapshot.workers.map((w) => w.buildingId)).toEqual([buildingId, null]);
    expect(snapshot.workers[0].toolTicks).toBe(10);
  });

  it('marks unstaffed and waiting states', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false });
    const staffed = spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false });
    spawnWorker(prep, ids, { buildingId: staffed.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.buildings.map((b) => b.state)).toEqual(['unstaffed', 'waitingForInput']);
  });

  it('clears notices after snapshotting them', async () => {
    const prep = buildColonyPrepWorld({ save: initialSave(), systems: [SnapshotSystem] });
    getPrepResource(prep, NoticeBoard).reject('once');
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([{ kind: 'rejection', message: 'once' }]);
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([]);
  });
});
