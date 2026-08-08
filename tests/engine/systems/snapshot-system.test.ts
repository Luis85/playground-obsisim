import { describe, expect, it } from 'vitest';
import { Building, OutputBuffer } from '../../../src/engine/components';
import { IdCounter, NoticeBoard, SnapshotStore } from '../../../src/engine/resources';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { BALANCE } from '../../../src/engine/content/balance';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist } from '../../../src/engine/world';
import { campAdjacentFreeTile } from '../fixtures';

describe('SnapshotSystem', () => {
  it('projects a complete snapshot', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = { wood: 10, bread: 2 };
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 1.5, batchActive: true, col: 4, row: 1, relocatingTicks: 0 });
    const buildingId = building.getComponent(Building)!.id;
    // Housed at the same building it works: this test is about staffing,
    // progress and tool coverage, not homelessness — an unhoused worker here
    // would halve workPower via Task 6's placementFactor and desync the
    // 1.5-power assertion below from what the comment says it means.
    spawnColonist(prep, ids, { buildingId, hunger: 20, toolTicks: 10, homeId: buildingId });
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks }); // idle adult
    getPrepResource(prep, NoticeBoard).reject('test notice');

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.population).toBe(2);
    expect(snapshot.idleAdults).toBe(1);
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

    expect(snapshot.colonists.map((w) => w.buildingId)).toEqual([buildingId, null]);
    expect(snapshot.colonists[0].toolTicks).toBe(10);
  });

  it('marks unstaffed and waiting states', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    const staffed = spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false, col: 6, row: 1, relocatingTicks: 0 });
    spawnColonist(prep, ids, { buildingId: staffed.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.buildings.map((b) => b.state)).toEqual(['unstaffed', 'waitingForInput']);
  });

  it('pins staffing precedence: unstaffed wins over outputFull', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);

    // Unstaffed building with full buffer: should report 'unstaffed', not 'outputFull'
    const unstaffedFull = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    unstaffedFull.getComponent(OutputBuffer)!.add('wood', BALANCE.outputBufferCap);

    // Staffed building with full buffer: should report 'outputFull'
    const staffedFull = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, relocatingTicks: 0 });
    staffedFull.getComponent(OutputBuffer)!.add('wood', BALANCE.outputBufferCap);
    spawnColonist(prep, ids, { buildingId: staffedFull.getComponent(Building)!.id });

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
    // trip.reset() clears it. `haulLegTicks`/`haulPickupCol`/`haulPickupRow`
    // (OBS-5-01) follow the same rule: published so the layout never has to
    // re-derive them from the building's live tile.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // (5,4) is 5 tiles from the camp -> 3 ticks each way
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const buildingId = building.getComponent(Building)!.id;
    // Housed beside the camp for the same reason the staffed worker above is
    // housed at its building: Task 7 scales a hauler's carry by their commute,
    // and this case is about what the snapshot PUBLISHES for a trip, not about
    // housing. A commute-neutral tile keeps `carrying` at the flat
    // BALANCE.haulCarryCapacity the assertion below names.
    const at = campAdjacentFreeTile([{ col: 5, row: 4 }]);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
    spawnColonist(prep, ids, { hauling: true, homeId: house.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    const hauler = () => world.getResource(SnapshotStore).latest!.colonists[0];

    await world.step(); // dispatched: walking out to the building
    // The dispatch tick sets the full 3-tick leg without decrementing it, so
    // the hauler has not travelled yet — legProgress(3, 3) is 0 and the dot
    // correctly still stands at the camp on the tick it was assigned.
    expect(hauler()).toMatchObject({
      hauling: true, haulTargetId: buildingId, haulPhase: 'outbound', haulTicksLeft: 3, haulLegTicks: 3, carrying: 0,
    });

    await world.step(); // one tick of walking: now genuinely partway out
    expect(hauler()).toMatchObject({ haulPhase: 'outbound', haulTicksLeft: 2, haulLegTicks: 3 }); // legTicks holds the leg total, not the remainder

    for (let i = 0; i < 2; i++) await world.step(); // arrives, loads, turns for home
    expect(hauler()).toMatchObject({
      haulTargetId: buildingId, haulPhase: 'returning', carrying: BALANCE.haulCarryCapacity,
    });
    // The turn sets the full return leg, exactly as dispatch did: the dot is at
    // the building's door with the whole walk home still ahead of it. The
    // pickup tile freezes to the building's tile at THIS moment (5,4) — the
    // origin haulSpot must keep using even if the building later moves.
    expect(hauler()).toMatchObject({ haulTicksLeft: 3, haulLegTicks: 3, haulPickupCol: 5, haulPickupRow: 4 });
    await world.step();
    expect(hauler()).toMatchObject({ haulPhase: 'returning', haulTicksLeft: 2 }); // genuinely walking home

    for (let i = 0; i < 2; i++) await world.step(); // banks the load, back to idle
    expect(hauler()).toMatchObject({
      haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, haulLegTicks: 0,
      haulPickupCol: 0, haulPickupRow: 0, carrying: 0,
    });
  });

  it('publishes each colonist\'s commute, and spends the same factor on the building\'s workPower', async () => {
    // The snapshot is where a player learns WHY a building is slow, so the
    // commute has to be visible and it has to be the number the simulation
    // actually spent — buildEntitySections computes it once and uses it for
    // both, and this pins that they cannot drift apart.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const work = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    const workId = work.getComponent(Building)!.id;
    // 10 tiles away: 8 charged tiles at 0.03 is 0.76, strictly between a free
    // commute and the 0.5 floor, so neither end could produce this by accident.
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 14, row: 1, relocatingTicks: 0 });
    spawnColonist(prep, ids, { id: 1, buildingId: workId, homeId: house.getComponent(Building)!.id });
    // A hauler measures to the CAMP store, not to any building — their round
    // trip begins and ends there. Housed at (3,0), one tile from it.
    const campHouse = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 3, row: 0, relocatingTicks: 0 });
    spawnColonist(prep, ids, { id: 2, hauling: true, homeId: campHouse.getComponent(Building)!.id });
    spawnColonist(prep, ids, { id: 3 }); // homeless, unassigned

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    const byId = (id: number) => snapshot.colonists.find((c) => c.id === id)!;

    expect(byId(1).commuteTiles).toBeCloseTo(10, 5);
    expect(byId(1).commuteFactor).toBeCloseTo(0.76, 5);
    expect(byId(2).commuteTiles).toBeCloseTo(1, 5); // (3,0) to CAMP_TILE (2,0)
    expect(byId(2).commuteFactor).toBe(1);
    // No bed, so no distance to report: the whole charge lands in the factor.
    expect(byId(3)).toMatchObject({ commuteTiles: 0, commuteFactor: BALANCE.homelessFactor });

    // ...and the published workPower is that same 0.76, not a full-power 1.
    expect(snapshot.buildings.find((b) => b.id === workId)!.workPower).toBeCloseTo(0.76, 5);
  });

  it('reports a relocating building as relocating, with its remaining ticks', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // Staffed AND relocating: proves relocating beats 'waitingForInput' (an
    // idle-but-staffed building — staffed !== 0 and outputBlocked === false
    // regardless of the relocating branch here). It does NOT exercise
    // priority over 'unstaffed'/'outputFull' — see the dedicated precedence
    // test below, whose fixtures genuinely satisfy those rival branches.
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 7 });
    const buildingId = building.getComponent(Building)!.id;
    spawnColonist(prep, ids, { buildingId });
    const world = await prep.prepareRun();
    await world.step();

    const snap = world.getResource(SnapshotStore).latest!.buildings[0];
    expect(snap.state).toBe('relocating');
    expect(snap.relocatingTicks).toBe(7);
  });

  it('pins relocating precedence over unstaffed AND over outputFull, not just waitingForInput', async () => {
    // The test above only proves relocating beats 'waitingForInput': its
    // fixture assigns a worker and leaves the buffer empty, so staffed !== 0
    // and outputBlocked === false no matter where the relocating check sits.
    // These two fixtures instead genuinely satisfy the rival branch's own
    // condition, so a reordered priority actually flips the result.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);

    // Relocating AND genuinely unstaffed (no worker ever assigned): if the
    // staffed === 0 check ran before relocatingTicks > 0, this would read
    // 'unstaffed' instead.
    spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 5 });

    // Relocating AND genuinely output-full (staffed, buffer sitting at the
    // real cap so outputBlocked is actually true): if the outputBlocked check
    // ran before relocatingTicks > 0, this would read 'outputFull' instead.
    const relocatingFull = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, relocatingTicks: 5 });
    relocatingFull.getComponent(OutputBuffer)!.add('wood', BALANCE.outputBufferCap);
    spawnColonist(prep, ids, { buildingId: relocatingFull.getComponent(Building)!.id });

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.buildings[0].state).toBe('relocating'); // rival condition: staffed === 0
    expect(snapshot.buildings[1].state).toBe('relocating'); // rival condition: outputBlocked === true
  });

  it('pins relocating precedence over housing too', async () => {
    // Same shape as the precedence test above: a relocating house's OWN rival
    // condition (recipe === null) is genuinely satisfied, so if that check
    // ran before relocatingTicks > 0, this would read 'housing' instead. A
    // house can never be 'unstaffed' or 'outputFull' (no slots, no batch), so
    // relocating-vs-housing is the one precedence a house can actually flip.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 5 });

    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.buildings[0].state).toBe('relocating');
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
