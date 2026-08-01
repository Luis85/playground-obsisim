import { describe, expect, it } from 'vitest';
import { Building, OutputBuffer } from '../../../src/engine/components';
import { IdCounter, NoticeBoard, SnapshotStore } from '../../../src/engine/resources';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { BALANCE } from '../../../src/engine/content/balance';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

describe('SnapshotSystem', () => {
  it('projects a complete snapshot', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = { wood: 10, bread: 2 };
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 1.5, batchActive: true, col: 4, row: 1 });
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
    spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false, col: 4, row: 1 });
    const staffed = spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false, col: 6, row: 1 });
    spawnWorker(prep, ids, { buildingId: staffed.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.buildings.map((b) => b.state)).toEqual(['unstaffed', 'waitingForInput']);
  });

  it('pins staffing precedence: unstaffed wins over outputFull', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);

    // Unstaffed building with full buffer: should report 'unstaffed', not 'outputFull'
    const unstaffedFull = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    unstaffedFull.getComponent(OutputBuffer)!.add('wood', BALANCE.outputBufferCap);

    // Staffed building with full buffer: should report 'outputFull'
    const staffedFull = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1 });
    staffedFull.getComponent(OutputBuffer)!.add('wood', BALANCE.outputBufferCap);
    spawnWorker(prep, ids, { buildingId: staffedFull.getComponent(Building)!.id });

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.buildings[0].state).toBe('unstaffed');
    expect(snapshot.buildings[1].state).toBe('outputFull');
  });

  it('reports the trip target, phase and remaining ticks on BOTH legs', async () => {
    // Driven by a REAL trip, not a hand-written fixture: every other
    // haulTargetId in the suite is a literal handed to the layout, so nothing
    // else pins what the engine actually publishes.
    //
    // Increment 4 published the target outbound only, and the layout parked an
    // outbound dot at the doorstep and let a fixed-speed walk do the rest. The
    // layout now interpolates from `haulTicksLeft`, so a returning hauler needs
    // the building it is walking BACK from, and both legs need their remaining
    // ticks (OBS-4-09). `trip.targetId` survives the phase flip; only
    // trip.reset() clears it.
    const save = initialSave();
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // (5,4) is 5 tiles from the camp -> 3 ticks each way
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { hauling: true });
    const world = await prep.prepareRun();
    const hauler = () => world.getResource(SnapshotStore).latest!.workers[0];

    await world.step(); // dispatched: walking out to the building
    // The dispatch tick sets the full 3-tick leg without decrementing it, so
    // the hauler has not travelled yet — legProgress(3, 3) is 0 and the dot
    // correctly still stands at the camp on the tick it was assigned.
    expect(hauler()).toMatchObject({
      hauling: true, haulTargetId: buildingId, haulPhase: 'outbound', haulTicksLeft: 3, carrying: 0,
    });

    await world.step(); // one tick of walking: now genuinely partway out
    expect(hauler()).toMatchObject({ haulPhase: 'outbound', haulTicksLeft: 2 });

    for (let i = 0; i < 2; i++) await world.step(); // arrives, loads, turns for home
    expect(hauler()).toMatchObject({
      haulTargetId: buildingId, haulPhase: 'returning', carrying: BALANCE.haulCarryCapacity,
    });
    // The turn sets the full return leg, exactly as dispatch did: the dot is at
    // the building's door with the whole walk home still ahead of it.
    expect(hauler().haulTicksLeft).toBe(3);
    await world.step();
    expect(hauler()).toMatchObject({ haulPhase: 'returning', haulTicksLeft: 2 }); // genuinely walking home

    for (let i = 0; i < 2; i++) await world.step(); // banks the load, back to idle
    expect(hauler()).toMatchObject({ haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, carrying: 0 });
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
