import { describe, expect, it } from 'vitest';
import { Building, OutputBuffer, Production } from '../../../src/engine/components';
import { IdCounter, NoticeBoard, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { BALANCE } from '../../../src/engine/content/balance';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist } from '../../../src/engine/world';
import { CAMP_TILE, haulTicksBetween } from '../../../src/shared/haul';
import { campAdjacentFreeTile, stepTick } from '../fixtures';

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

  it('counts food standing in a storehouse toward meals per head', async () => {
    // The headline number on the Dashboard, and it has to describe the food the
    // colony can actually EAT: meals are paid through `pay`, which draws across
    // every site, so bread a hauler banked in a depot is bread these colonists
    // will be fed from. Split 3 at the camp and 24 in the storehouse, against
    // two colonists: 27 meals over three heads is 9, where the camp alone would
    // publish 1.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = { bread: 3 };
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const depotAt = { col: 6, row: 2 };
    const depot = spawnBuilding(prep, ids, { defId: 'storehouse', progress: 0, batchActive: false, ...depotAt, relocatingTicks: 0 });
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks });
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks });

    const world = await prep.prepareRun();
    world.getResource(Stockpile).refundAt(
      { id: depot.getComponent(Building)!.id, ...depotAt, capacity: BALANCE.storehouseCapacity }, 'bread', 24,
    );
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.population).toBe(2);
    expect(snapshot.mealsPerHead).toBeCloseTo(9);
    // Non-vacuous: the camp's own share is a different, smaller number.
    expect(snapshot.stockpile.bread.stock).toBe(27);
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
    // ticks (OBS-4-09). `trip.targetId` survives the phase flip; only ending
    // the trip through `cancel()` clears it. `haulLegTicks` and the leg's two
    // frozen endpoints (OBS-5-01) follow the same rule: published so the layout
    // never has to re-derive them from the building's live tile.
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
    // the building's door with the whole walk home still ahead of it. The leg's
    // origin freezes to the building's tile at THIS moment (5,4) — the point
    // haulSpot must keep using even if the building later moves — and its
    // destination to the camp store it is walking the load to.
    expect(hauler()).toMatchObject({
      haulTicksLeft: 3, haulLegTicks: 3,
      haulLegFromCol: 5, haulLegFromRow: 4, haulLegToCol: CAMP_TILE.col, haulLegToRow: CAMP_TILE.row,
    });
    await world.step();
    expect(hauler()).toMatchObject({ haulPhase: 'returning', haulTicksLeft: 2 }); // genuinely walking home

    for (let i = 0; i < 2; i++) await world.step(); // banks the load, back to idle
    expect(hauler()).toMatchObject({
      haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, haulLegTicks: 0,
      haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0, carrying: 0,
    });
  });

  /** Flour waiting at the mill for the return leg. Deliberately under
   * `haulCarryCapacity`, and distinct from it, so the load carried out and the
   * load carried in are two different numbers. */
  const MILL_FLOUR = 4;

  /**
   * A supply trip whose source is a DEPOT rather than the camp — the only
   * shape in which a leg's two ends and the hauler's own resting tile are
   * three different places, and therefore the only shape that can tell the
   * three published pairs apart.
   *
   * The camp holds nothing, so the depot is the one place the mill's wheat can
   * come from; the mill stands one tile from the depot and both stand a long
   * walk from the camp. The mill also has flour already made, so the trip is a
   * genuine round trip — out with inputs, home with output.
   */
  async function depotSupplyFixture() {
    const depotAt = { col: 20, row: 10 };
    const millAt = { col: 21, row: 10 };
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};   // nothing at the camp, so the depot is the only source
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const depot = spawnBuilding(prep, ids, { defId: 'storehouse', progress: 0, batchActive: false, ...depotAt, relocatingTicks: 0 });
    const mill = spawnBuilding(prep, ids, {
      defId: 'mill', progress: 0, batchActive: false, ...millAt, relocatingTicks: 0, buffer: { flour: MILL_FLOUR },
    });
    const millId = mill.getComponent(Building)!.id;
    // Supply dispatch only serves a STAFFED building; the crew is here for
    // that and nothing else.
    const at = campAdjacentFreeTile([depotAt, millAt]);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
    const homeId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { buildingId: millId, ageTicks: BALANCE.lifeBands.matureTicks, homeId });
    spawnColonist(prep, ids, { hauling: true, ageTicks: BALANCE.lifeBands.matureTicks, homeId });

    const world = await prep.prepareRun();
    const depotId = depot.getComponent(Building)!.id;
    world.getResource(Stockpile).refundAt({ id: depotId, ...depotAt, capacity: BALANCE.storehouseCapacity }, 'wheat', 12);
    const hauler = () => world.getResource(SnapshotStore).latest!.colonists.find((c) => c.hauling)!;
    const step = async (times: number) => { for (let i = 0; i < times; i++) await world.step(); };
    return { world, step, hauler, depotAt, millAt, depotId, millId };
  }

  it('publishes both ends of the leg being walked, and they are not the camp', async () => {
    // Task 12 draws a dot from one end of a leg to the other, and this
    // increment's legs run between arbitrary tiles: a depot-to-building leg
    // touches the camp at neither end, so a single published endpoint plus a
    // hardcoded camp anchor cannot describe it (§2.10).
    //
    // Why this fixture discriminates: on the leg asserted below the origin is
    // the depot (20,10), the destination is the mill (21,10) and the hauler's
    // own `at` is still the camp (2,0) — three distinct tiles, so a field
    // reading either of the other two pairs fails rather than coincides.
    const { step, hauler, depotAt, millAt, millId } = await depotSupplyFixture();

    await step(1); // dispatched: walking EMPTY out to the depot it will load at
    expect(hauler()).toMatchObject({
      haulKind: 'supply', haulPhase: 'fetching', haulPickedUp: false, carrying: 0,
      haulLegFromCol: CAMP_TILE.col, haulLegFromRow: CAMP_TILE.row,
      haulLegToCol: depotAt.col, haulLegToRow: depotAt.row,
    });

    await step(haulTicksBetween(CAMP_TILE, depotAt, BALANCE.haulTilesPerTick)); // loads at the depot, turns for the mill
    expect(hauler()).toMatchObject({
      haulKind: 'supply', haulPhase: 'outbound', haulTargetId: millId,
      // Carrying goods IN: the load came out of a store, not out of a
      // building's out-tray, which is exactly what `pickedUp` records.
      haulPickedUp: false, carrying: BALANCE.haulCarryCapacity,
      haulLegFromCol: depotAt.col, haulLegFromRow: depotAt.row,
      haulLegToCol: millAt.col, haulLegToRow: millAt.row,
    });
    // `haulAt*` is only meaningful when idle (only `cancel` writes it); mid-leg
    // it still holds wherever the trip began, which is stale but not asserted
    // exactly here so a later task that makes it live does not fail a test
    // that isn't about that. What's checked is the property this fixture
    // exists for: it is not the leg's own origin, i.e. a third distinct tile.
    expect(hauler().haulAtCol).not.toBe(depotAt.col);
    expect(hauler().haulAtRow).not.toBe(depotAt.row);
    // Non-vacuous: neither end of this leg is the camp, and the two ends are
    // not each other.
    expect([depotAt, millAt, CAMP_TILE].map((t) => `${t.col},${t.row}`)).toHaveLength(new Set(
      [depotAt, millAt, CAMP_TILE].map((t) => `${t.col},${t.row}`),
    ).size);

    await step(haulTicksBetween(depotAt, millAt, BALANCE.haulTilesPerTick)); // unloads the wheat, loads the flour
    // §2.10's headline case, and the one a `haulKind`-driven direction marker
    // draws backwards: still labelled `supply`, now carrying goods OUT of the
    // building. `pickedUp` is what says so, and it has flipped while the kind
    // has not. The leg it turned onto runs mill -> depot, so neither end is
    // the camp on this one either.
    expect(hauler()).toMatchObject({
      haulKind: 'supply', haulPhase: 'returning', haulPickedUp: true, carrying: MILL_FLOUR,
      haulLegFromCol: millAt.col, haulLegFromRow: millAt.row,
      haulLegToCol: depotAt.col, haulLegToRow: depotAt.row,
    });
  });

  it('stands an idle hauler where its last trip left it — a depot, not the camp', async () => {
    // The state a lone site-end pair could not express at all. An idle hauler
    // has no leg, so `legFrom`/`legTo` are cleared; without `haulAt*` the
    // layout has no coordinates for it and falls through to camp placement —
    // a dot standing a whole map away from the colonist it draws.
    const { step, hauler, depotAt, millAt } = await depotSupplyFixture();
    const tilesPerTick = BALANCE.haulTilesPerTick;
    // Fetch out, walk the load to the mill, then walk home. Home is the DEPOT:
    // it is one tile from the mill and has room, where the camp is a whole map
    // away — so the trip ends nowhere near the camp.
    await step(1
      + haulTicksBetween(CAMP_TILE, depotAt, tilesPerTick)
      + haulTicksBetween(depotAt, millAt, tilesPerTick)
      + haulTicksBetween(millAt, depotAt, tilesPerTick));

    expect(hauler()).toMatchObject({
      haulPhase: 'idle', haulKind: null, haulTargetId: null, haulPickedUp: false, carrying: 0,
      haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0,
      haulAtCol: depotAt.col, haulAtRow: depotAt.row,
    });
    // Non-vacuous three ways: the resting tile is not the camp the hauler
    // started from, not the mill it last visited, and not the (0, 0) every
    // cleared leg field above reads.
    expect([depotAt.col, depotAt.row]).not.toEqual([CAMP_TILE.col, CAMP_TILE.row]);
    expect([depotAt.col, depotAt.row]).not.toEqual([millAt.col, millAt.row]);
    expect([depotAt.col, depotAt.row]).not.toEqual([0, 0]);
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

    // deliveredWorkPower (OBS-6-06): colonist 1 is the only worker at workId,
    // fresh-spawned (efficiency 1, no tool), so their own published share IS
    // the building's whole workPower — not a second, independently-drifting
    // computation of the same 0.76.
    expect(byId(1).deliveredWorkPower).toBeCloseTo(0.76, 5);
    // Colonist 2 hauls — buildingId is null by construction — and colonist 3
    // is idle. Neither is assigned to a building, so neither has a work-power
    // share of one to report; a hauler's throughput is carried capacity
    // (haulerCapacity, HaulSystem), a wholly different number.
    expect(byId(2).deliveredWorkPower).toBeNull();
    expect(byId(3).deliveredWorkPower).toBeNull();
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

  it('publishes a building\'s in-tray, its ledger share and its capacity as three separate figures', async () => {
    // Three piles at two buildings, and each is read off its OWN source: the
    // in-tray only this building may spend, the out-tray a hauler collects
    // from, and a storehouse's share of the colony ledger (which lives in the
    // Stockpile, keyed by building id, not on a component).
    //
    // Why this fixture discriminates: the mill carries 4 in its in-tray and 7
    // in its out-tray, and the depot holds 9 against a 60-unit capacity — four
    // pairwise-distinct values, so `inputBuffered` reading `buffered` (or
    // either reading `stored`) lands on a number no assertion below expects.
    // The one pair the MILL row cannot tell apart is `stored` and `storage`,
    // which are both 0 there because a producer is not a store; the DEPOT row
    // separates exactly those two (9 against 60), which is why both rows are
    // asserted rather than one.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const mill = spawnBuilding(prep, ids, {
      defId: 'mill', progress: 0, batchActive: false, col: 12, row: 8, relocatingTicks: 0, inputBuffer: { wheat: 4 },
    });
    mill.getComponent(OutputBuffer)!.add('flour', 7);
    const depotAt = { col: 20, row: 10 };
    const depot = spawnBuilding(prep, ids, { defId: 'storehouse', progress: 0, batchActive: false, ...depotAt, relocatingTicks: 0 });
    const depotId = depot.getComponent(Building)!.id;

    const world = await prep.prepareRun();
    world.getResource(Stockpile).refundAt({ id: depotId, ...depotAt, capacity: BALANCE.storehouseCapacity }, 'wood', 9);
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    const byId = (id: number) => snapshot.buildings.find((b) => b.id === id)!;

    expect(byId(mill.getComponent(Building)!.id)).toMatchObject({
      inputBuffered: 4, buffered: 7, stored: 0, storage: 0,
    });
    expect(byId(depotId)).toMatchObject({
      inputBuffered: 0, buffered: 0, stored: 9, storage: BALANCE.storehouseCapacity,
    });
    // Non-vacuous: the depot's capacity is not what it happens to be holding,
    // so `storage` reading `stored` (or the reverse) fails rather than agrees.
    expect(BALANCE.storehouseCapacity).not.toBe(9);
  });

  it('pins storage precedence over housing too', async () => {
    // A storehouse's `recipe` is null exactly like a house's, so if the
    // housing check (recipe === null) ran before the storage check
    // (storage > 0), this would read 'housing' instead of 'storing'.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    spawnBuilding(prep, ids, { defId: 'storehouse', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });

    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.buildings[0].state).toBe('storing');
  });

  /**
   * A relocating workplace and an identical unmoved one, side by side, both
   * staffed and both housed on their own tile so the commute factor is 1.0 for
   * everybody. The unmoved twin is the control that makes these tests
   * discriminating rather than merely red: same def, same crew, same zero-tile
   * commute, so a gate that zeroed every colonist fails on its row.
   *
   * ProductionSystem runs alongside SnapshotSystem deliberately. The relocation
   * countdown lives in THAT system and is decremented in the same arm that
   * skips the work, so only a world running it publishes the real
   * post-decrement `relocatingTicks` the snapshot has to be read against.
   */
  async function relocationFixture(movingTicks: number) {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const moving = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: movingTicks });
    const still = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 8, row: 1, relocatingTicks: 0 });
    const movingId = moving.getComponent(Building)!.id;
    const stillId = still.getComponent(Building)!.id;
    // Housed AT their workplace: 0 tiles, factor 1.0 exactly, so every number
    // below is a whole worker-tick and a commute could not be mistaken for the
    // relocation gate.
    spawnColonist(prep, ids, { id: 1, buildingId: movingId, homeId: movingId });
    spawnColonist(prep, ids, { id: 2, buildingId: stillId, homeId: stillId });
    const world = await prep.prepareRun();
    return {
      world, movingId, stillId,
      progressOf: (entity: typeof moving) => entity.getComponent(Production)!.progress,
      moving, still,
      snap: () => world.getResource(SnapshotStore).latest!,
    };
  }

  it('publishes zero delivered work power for a crew whose building is mid-move', async () => {
    // The defect: ProductionSystem `continue`s past a relocating building
    // before it ever looks work power up, so its crew bank nothing — while the
    // snapshot gated only on `buildingId === null` and printed them a full
    // 1.00, and summed that same 1.00 into the building's own workPower. That
    // is the mechanism/display disagreement OBS-6-06 exists to expose, in the
    // column added to expose it, plus its pre-existing building-level twin.
    //
    // TWO ticks, not more, and that is load-bearing: after one tick the
    // published `relocatingTicks` is exactly 1, the single value that separates
    // the correct `> 0` from the `> 1` this project has already shipped and
    // reverted once (task 6). At 3 ticks the published 2 satisfies both, and
    // this test would wave the old mistake straight through.
    const { world, movingId, stillId, progressOf, moving, still, snap } = await relocationFixture(2);
    await stepTick(world);

    // The mechanism first: nothing was banked at the moving building, a whole
    // worker-tick was banked at its twin.
    expect(progressOf(moving)).toBe(0);
    expect(progressOf(still)).toBeCloseTo(1, 5);

    const byId = (id: number) => snap().colonists.find((c) => c.id === id)!;
    const building = (id: number) => snap().buildings.find((b) => b.id === id)!;
    expect(byId(1).deliveredWorkPower).toBe(0);
    expect(building(movingId).workPower).toBe(0);
    // The control: identical in every respect except the move.
    expect(byId(2).deliveredWorkPower).toBeCloseTo(1, 5);
    expect(building(stillId).workPower).toBeCloseTo(1, 5);

    // 0, NOT null: they are assigned and work power is their unit, so this is
    // a measured zero, not the hauler's "does not apply". Null would render as
    // the same em dash an idle colonist gets and re-hide the stall.
    expect(byId(1).deliveredWorkPower).not.toBeNull();
    // And the crew is still counted as staffing it — they are assigned, just
    // not working. Zeroing the head count would be a different, wrong claim.
    expect(building(movingId).workers).toBe(1);
    // The published value the gate above was read against: 1, not 2 — see the
    // note at the top of this test on why that separates `> 0` from `> 1`.
    expect(building(movingId).relocatingTicks).toBe(1);
  });

  it('overstates by exactly one tick on the landing tick, and is exact read forwards', async () => {
    // The known limit of gating on a POST-decrement `relocatingTicks`, pinned
    // rather than left to a comment. ProductionSystem skips and decrements in
    // the same arm and the snapshot is published after, so on the tick that
    // counts 1 down to 0 the work is genuinely skipped while nothing in the
    // snapshot says the building was ever in flight.
    const { world, movingId, progressOf, moving, snap } = await relocationFixture(1);
    await stepTick(world);

    expect(progressOf(moving)).toBe(0); // the work WAS skipped
    const landed = () => snap().buildings.find((b) => b.id === movingId)!;
    // ...but every relocation-derived field in the snapshot already reads as
    // settled, deliveredWorkPower included. It is not alone in this: `state`
    // and the Buildings view's Downtime column ('—' at 0 ticks) overstate the
    // same tick in the same direction, which is why moving this one field to
    // some other boundary would only make it disagree with its neighbours.
    expect(landed().relocatingTicks).toBe(0);
    expect(landed().state).not.toBe('relocating');
    expect(snap().colonists.find((c) => c.id === 1)!.deliveredWorkPower).toBeCloseTo(1, 5);
    expect(landed().workPower).toBeCloseTo(1, 5);

    // Read FORWARDS — the sense `BuildingSnapshot.relocatingTicks` is
    // documented in, "ticks until a moved building can work again" — the same
    // figure is exact: the next tick does work, and it spends exactly the 1.0
    // the snapshot above promised.
    await stepTick(world);
    expect(progressOf(moving)).toBeCloseTo(1, 5);
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
