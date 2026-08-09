import { describe, expect, it } from 'vitest';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import type { TileRef } from '../../../src/shared/placement';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Colonist } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { HaulSystem, haulerCapacity } from '../../../src/engine/systems/haul-system';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { PopulationSystem } from '../../../src/engine/systems/population-system';
import { CAMP_TILE } from '../../../src/shared/haul';
import { campAdjacentFreeTile, enqueue } from '../fixtures';
import {
  applyRemovals, buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
  type TColonySystemFactory,
} from '../../../src/engine/world';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';

interface BuildingSpec { col: number; row: number; wood: number; id?: number }

/**
 * `systemsBefore` runs AHEAD of HaulSystem, which is where ALL_SYSTEMS puts
 * CommandSystem: a tick drains its commands first and only then moves haulers.
 * The order is load-bearing for the demolition cases below — it is what makes
 * "the tick the player pressed demolish" the tick the trip has to end on.
 *
 * Haulers are HOUSED beside the camp store by default. Task 7 scales a
 * hauler's carry capacity by their commute, so an unhoused hauler carries half
 * a load — and every case in this file counts loads. Housing them on a
 * commute-neutral tile (see campAdjacentFreeTile) holds that at exactly
 * `BALANCE.haulCarryCapacity`, the same way the balance harness's berry stock
 * holds hunger neutral, so these cases keep measuring haulage. `houseHaulers:
 * false` opts out where the reduced capacity IS the subject.
 */
async function setup(
  specs: readonly BuildingSpec[],
  haulerCount: number,
  systemsBefore: readonly TColonySystemFactory[] = [],
  { houseHaulers = true }: { houseHaulers?: boolean } = {},
) {
  const save = initialSave();
  save.colonists = [];
  save.buildings = [];   // no starter house: this fixture builds its own world
  save.stockpile = {};
  const prep = buildColonyPrepWorld({ save, systems: [...systemsBefore, HaulSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const buildings: IEntity[] = specs.map((spec) => {
    const entity = spawnBuilding(prep, ids, {
      id: spec.id, defId: 'forester', progress: 0, batchActive: false, col: spec.col, row: spec.row, relocatingTicks: 0,
    });
    if (spec.wood > 0) entity.getComponent(OutputBuffer)!.add('wood', spec.wood);
    return entity;
  });
  // Spawned after the specs so it can dodge their tiles, and so its id never
  // shifts the ones the cases below assert on. An empty buffer keeps it out of
  // every dispatch decision: nextHaulTarget skips a candidate with nothing
  // claimable.
  const homeId = houseHaulers ? spawnHaulerHouse(prep, ids, specs) : null;
  const haulers: IEntity[] = Array.from({ length: haulerCount }, () => spawnColonist(prep, ids, { hauling: true, homeId }));
  const world = await prep.prepareRun();
  // The drain is not optional here, for the same reason it is not optional in
  // command-system.test.ts's `ticker`: three cases below hand this helper a
  // `CommandSystem` and demolish the building a hauler is walking to, and since
  // OBS-6-02 a demolition only goes onto `RemovalLedger` — `applyRemovals` is
  // the one thing that takes it off. Without it the "demolished" forester stood
  // in the world for the whole run with its buffer emptied, and all three cases
  // passed against that ghost.
  //
  // The drain ALONE, not `stepTick`: stepTick also refreshes the snapshot's
  // entity sections, and this file asserts on live components rather than on a
  // published snapshot, so the refresh would be work with nothing reading it.
  const step = async (times: number) => {
    for (let i = 0; i < times; i++) { await world.step(); applyRemovals(world); }
  };
  return { world, buildings, haulers, step, stockpile: world.getResource(Stockpile) };
}

/** One house on a commute-neutral tile, returning its building id. */
function spawnHaulerHouse(prep: IPreptimeWorld, ids: IdCounter, taken: readonly TileRef[]): number {
  const at = campAdjacentFreeTile(taken);
  const house = spawnBuilding(prep, ids, {
    defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0,
  });
  return house.getComponent(Building)!.id;
}

const tripOf = (hauler: IEntity) => hauler.getComponent(HaulTrip)!;
const bufferOf = (building: IEntity) => building.getComponent(OutputBuffer)!;

/**
 * Every hauler's trip, every building's remaining buffer, and the stockpile,
 * as one plain structure — what two independently-built worlds get compared
 * by (spec criterion 5). Sorted by id so the same hauler/building lands at
 * the same array index in both snapshots regardless of entity-iteration
 * order, which is what makes a position-wise toEqual meaningful.
 */
function haulStateOf(world: IRuntimeWorld) {
  const entities = [...world.getEntities()];
  const haulers = entities
    .filter((e) => e.getComponent(JobAssignment)?.hauling)
    .map((e) => {
      const trip = e.getComponent(HaulTrip)!;
      return {
        workerId: e.getComponent(Colonist)!.id,
        targetId: trip.targetId,
        phase: trip.phase,
        ticksLeft: trip.ticksLeft,
        amount: trip.amount,
      };
    })
    .sort((a, b) => a.workerId - b.workerId);
  const buildings = entities
    .filter((e) => e.getComponent(Building) !== undefined)
    .map((e) => ({ buildingId: e.getComponent(Building)!.id, remaining: e.getComponent(OutputBuffer)!.total() }))
    .sort((a, b) => a.buildingId - b.buildingId);
  return { haulers, buildings, stockpile: world.getResource(Stockpile).toJSON() };
}

describe('HaulSystem', () => {
  it('walks out, loads a full carry, walks back, and banks it in the store', async () => {
    // (5,4) is 5 tiles from the camp -> 3 ticks each way
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('outbound');
    expect(tripOf(haulers[0]).ticksLeft).toBe(3);

    await step(3); // arrival tick
    expect(bufferOf(buildings[0]).total()).toBe(3); // 6 carried away
    expect(tripOf(haulers[0]).phase).toBe('returning');
    expect(tripOf(haulers[0]).amount).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.get('wood')).toBe(0); // not banked until it arrives

    await step(3);
    expect(stockpile.get('wood')).toBe(BALANCE.haulCarryCapacity);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  // OBS-5-01: legTicks and BOTH leg endpoints are frozen at every site that
  // begins a leg (dispatch, and load/turn-for-home) and must survive exactly
  // as long as the leg they describe — cleared only once the trip ends.
  it('freezes the leg total and both leg endpoints when each leg begins, and clears them when the trip ends', async () => {
    // Same (5,4) trip as the test above: 3 ticks each way. Every number below
    // is distinct from every other — the camp is (2,0), the building (5,4),
    // the leg 3 ticks — so no field can read a neighbour's value and pass.
    const { haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1);
    await step(1); // dispatched: the outbound leg begins AT THE CAMP TILE
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'outbound', ticksLeft: 3, legTicks: 3,
      legFromCol: CAMP_TILE.col, legFromRow: CAMP_TILE.row, legToCol: 5, legToRow: 4,
    });

    await step(3); // arrives, loads, turns for home: the return leg begins here
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', ticksLeft: 3, legTicks: 3,
      legFromCol: 5, legFromRow: 4, legToCol: CAMP_TILE.col, legToRow: CAMP_TILE.row,
    });

    await step(3); // delivered
    expect(stockpile.get('wood')).toBe(BALANCE.haulCarryCapacity);
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'idle', legTicks: 0, legFromCol: 0, legFromRow: 0, legToCol: 0, legToRow: 0,
      // ...and the hauler is standing where the leg ended, not back at a default.
      atCol: CAMP_TILE.col, atRow: CAMP_TILE.row,
    });
  });

  it('charges a tick each way even beside the camp — no trip is free', async () => {
    const { step, stockpile } = await setup([{ col: 3, row: 0, wood: 6 }], 1);
    await step(2);
    expect(stockpile.get('wood')).toBe(0); // dispatched, arrived, not yet home
    await step(1);
    expect(stockpile.get('wood')).toBe(6);
  });

  it('lets several haulers share one backlog without claiming the same units', async () => {
    const { haulers, step, stockpile } = await setup([{ col: 3, row: 0, wood: 12 }], 2);
    await step(1);
    expect(haulers.every((h) => tripOf(h).phase === 'outbound')).toBe(true);
    await step(2);
    expect(stockpile.get('wood')).toBe(12); // 6 each, nothing double-counted
  });

  it('leaves a hauler idle when the backlog is already spoken for', async () => {
    const { haulers, step } = await setup([{ col: 3, row: 0, wood: 6 }], 3);
    await step(1);
    const phases = haulers.map((h) => tripOf(h).phase).sort();
    expect(phases).toEqual(['idle', 'idle', 'outbound']);
  });

  it('serves the worst backlog first, even when it is farther away', async () => {
    const { buildings, haulers, step } = await setup(
      [{ col: 4, row: 1, wood: 2 }, { col: 20, row: 10, wood: 9 }],
      1,
    );
    await step(1);
    expect(tripOf(haulers[0]).targetId).toBe(buildings[1].getComponent(Building)!.id);
  });

  it('the same hauler serves a near building far faster than a far one', async () => {
    // (3,0) is 1 tile from camp -> 1 tick each way; (23,15) is the default
    // map's far corner -> 13 ticks each way (see BALANCE.haulTilesPerTick doc).
    // Both start with a full buffer so neither stalls for a reason unrelated
    // to distance. At 10 ticks the near building has banked its whole 12-unit
    // buffer (two 6-unit trips, done by tick 6); the far one, 13 ticks each
    // way, hasn't completed its first trip yet (not due until tick 27).
    const near = await setup([{ col: 3, row: 0, wood: BALANCE.outputBufferCap }], 1);
    const far = await setup([{ col: 23, row: 15, wood: BALANCE.outputBufferCap }], 1);
    const TICKS = 10;
    await near.step(TICKS);
    await far.step(TICKS);
    expect(near.stockpile.get('wood')).toBe(12);
    expect(far.stockpile.get('wood')).toBe(0);
    expect(near.stockpile.get('wood')).toBeGreaterThan(far.stockpile.get('wood'));
  });

  it('dispatches identically regardless of entity order — same world, same claim', async () => {
    // both 3 tiles from camp, both holding 4: the lowest id must win either way
    const forward = await setup([{ id: 10, col: 5, row: 0, wood: 4 }, { id: 11, col: 2, row: 3, wood: 4 }], 1);
    const reversed = await setup([{ id: 11, col: 2, row: 3, wood: 4 }, { id: 10, col: 5, row: 0, wood: 4 }], 1);
    await forward.step(1);
    await reversed.step(1);
    expect(tripOf(forward.haulers[0]).targetId).toBe(10);
    expect(tripOf(reversed.haulers[0]).targetId).toBe(10);
  });

  it('a save decides the same way twice — same claims, same stockpile, same buffers', async () => {
    // Three distinct backlogs (2/9/6 wood) at three distances (1/4/11 ticks),
    // two haulers: every dispatch below is decided by backlog alone (2 < 6 <
    // 9, no ties), so the comparator's ordering does the work, not the id
    // fallback (already covered by the entity-order test above).
    const midRun = await setup(
      [{ col: 3, row: 0, wood: 2 }, { col: 8, row: 3, wood: 9 }, { col: 20, row: 10, wood: 6 }],
      2,
    );
    // Mid-run, not a fresh colony: by tick 5 one hauler has picked up the mid
    // building's backlog and is walking home carrying it (Task 6 will bank
    // that load straight into the save's stockpile), and the other is still
    // outbound to the far building. Neither buffer nor trip state is trivial.
    await midRun.step(5);
    const save = buildSaveFromWorld(midRun.world);

    // Two INDEPENDENT worlds from that one save — the save/load half criterion
    // 5 requires, as opposed to the entity-order test's single shared world.
    const worldA = await createColonyWorld(save);
    const worldB = await createColonyWorld(save);
    const RUN_TICKS = 20;
    for (let i = 0; i < RUN_TICKS; i++) {
      await worldA.step();
      await worldB.step();
    }

    const stateA = haulStateOf(worldA);
    const stateB = haulStateOf(worldB);

    // Prove this isn't trivially true: the run actually did something. (See
    // the task report for the concrete observed state at this point.)
    expect(stateA.haulers.some((h) => h.phase === 'returning' || h.amount > 0)).toBe(true);
    expect(stateA.stockpile.wood ?? 0).toBeGreaterThan(0);

    expect(stateA).toEqual(stateB);
  });

  it('leaves haulers idle when nothing is waiting', async () => {
    const { haulers, step } = await setup([{ col: 5, row: 4, wood: 0 }], 2);
    await step(4);
    expect(haulers.every((h) => tripOf(h).phase === 'idle')).toBe(true);
  });

  it('returns empty-handed when the buffer is drained before arrival', async () => {
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 6 }], 1);
    await step(1);
    bufferOf(buildings[0]).take('wood', 6); // someone else got there first
    await step(3);
    expect(tripOf(haulers[0]).amount).toBe(0);
    await step(3);
    expect(stockpile.get('wood')).toBe(0);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('breaks a two-resource tie by catalog order, not by insertion order', async () => {
    // Spec §2.3 names this a determinism rule: "the resource the building holds
    // most of (ties by catalog order)". `wood` goes in first (setup, before the
    // world is prepared) and `berries` second, so Map insertion order would
    // pick wood — but berries comes first in RESOURCE_IDS and must win.
    // (3,0) is 1 tile from camp: dispatch, load, deliver in three ticks.
    const { buildings, haulers, step, stockpile } = await setup([{ col: 3, row: 0, wood: BALANCE.haulCarryCapacity }], 1);
    bufferOf(buildings[0]).add('berries', BALANCE.haulCarryCapacity); // equal amounts, inserted second
    expect([...bufferOf(buildings[0]).amounts.keys()]).toEqual(['wood', 'berries']); // the order the tie must NOT follow
    await step(2);
    expect(tripOf(haulers[0]).resource).toBe('berries');
    await step(1);
    expect(stockpile.get('berries')).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.get('wood')).toBe(0); // still waiting at the building
  });

  it('reserves exactly what a reduced-capacity hauler will actually take', async () => {
    // A homeless hauler carries 3, not 6. BALANCE.haulCarryCapacity appears at
    // three sites in HaulSystem — the cross-tick claim map, the same-tick
    // dispatch claim, and the load — and all three must read this same number.
    // A claim of 6 for a hauler who will take 3 makes claimableAt under-report,
    // so a second hauler is sent elsewhere (or nowhere) while half the buffer
    // sits unclaimed: a scheduling penalty stacked on top of the commute,
    // which is not what the commute models.
    const reduced = haulerCapacity(null);
    expect(reduced).toBeLessThan(BALANCE.haulCarryCapacity);

    // One building beside the camp (1 tick each way) holding exactly one FLAT
    // carry — which is two REDUCED carries, so the buffer has room for both
    // haulers and only a mis-sized claim can keep the second at home.
    const { buildings, haulers, step, stockpile } = await setup(
      [{ col: 3, row: 0, wood: BALANCE.haulCarryCapacity }], 2, [], { houseHaulers: false },
    );

    await step(1);
    expect(haulers.map((h) => tripOf(h).phase)).toEqual(['outbound', 'outbound']);

    await step(1); // arrival: each takes what its own capacity allows, not the flat 6
    expect(haulers.map((h) => tripOf(h).amount)).toEqual([reduced, reduced]);
    expect(bufferOf(buildings[0]).total()).toBe(0); // between them they cleared it

    await step(1);
    expect(stockpile.get('wood')).toBe(2 * reduced);
  });

  // OBS-6-07 path 2. `homeTileOf` falls back to `PendingChanges.tileOf` for a
  // home the `buildings` query cannot see yet, and this is the only test that
  // reaches it. ProductionSystem's twin of the same lookup is pinned by
  // population-system.test.ts's 'charges a colonist housed by a same-tick
  // construction as housed, not homeless'; this is the haulage half, and it has
  // to assert on the LOAD, for the same reason that one asserts on the batch:
  // the published `carrying`/commute figures are built after the post-step sync
  // and could always see the new house, so they were never the broken reader.
  it('a hauler housed by a construction earlier in the same tick carries a full load, not a homeless one', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];
    // 15 wood + 5 planks is one house; the wood the hauler fetches is the
    // forester's buffer below, not this.
    save.stockpile = { wood: 100, planks: 100 };
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, PopulationSystem, HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // (3,0) is 1 tile from the camp: dispatched on tick 1, arrives on tick 2.
    // Exactly one FULL carry in the buffer, so the two capacities are
    // distinguishable in both directions — a reduced hauler leaves 3 behind.
    const forester = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 3, row: 0, relocatingTicks: 0 });
    forester.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity);
    // Homeless, and an ADULT: PopulationSystem is in this system list and
    // stands down any hauler who is not one, which would end the trip instead.
    const hauler = spawnColonist(prep, ids, {
      hauling: true, homeId: null, ageTicks: BALANCE.lifeBands.matureTicks,
    });
    const world = await prep.prepareRun();

    await world.step();                                       // dispatched, one tick out
    expect(tripOf(hauler)).toMatchObject({ phase: 'outbound', ticksLeft: 1 });

    // The construction lands on the ARRIVAL tick, so the same tick houses this
    // hauler (rehome reads pending.constructed) and loads them. The tile is
    // commute-neutral, so a correctly-resolved home scores capacity exactly
    // haulCarryCapacity against haulerCapacity(null)'s halved figure.
    const at = campAdjacentFreeTile([{ col: 3, row: 0 }]);
    enqueue(world, { type: 'constructBuilding', buildingDefId: 'house', at });
    await world.step();

    // Precondition, not the point: the house went up and homing seated them.
    expect(hauler.getComponent(Home)!.buildingId).not.toBeNull();
    // The point. Resolved through the pending ledger, this hauler carries a
    // full load; resolved to no tile, they would carry haulerCapacity(null).
    expect(tripOf(hauler).amount).toBe(BALANCE.haulCarryCapacity);
    expect(bufferOf(forester).total()).toBe(0); // and the buffer really is cleared
  });

  it('a hauler housed beside the camp carries a full load, one housed far away carries less', async () => {
    // The mechanic itself, at the level a player experiences it: where you put
    // a hauler's bed changes how much they move per trip. Both ends measured,
    // so neither "always full" nor "always reduced" passes.
    expect(haulerCapacity({ col: 3, row: 0 })).toBe(BALANCE.haulCarryCapacity);
    expect(haulerCapacity({ col: 23, row: 15 })).toBeLessThan(BALANCE.haulCarryCapacity);
    // Never zero: a hauler who shows up carries something, however far they walked.
    expect(haulerCapacity({ col: 23, row: 15 })).toBeGreaterThan(0);
  });

  it('ignores workers who are not haulers', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const idle = spawnColonist(prep, ids, {});
    const world = await prep.prepareRun();
    for (let i = 0; i < 6; i++) await world.step();
    expect(idle.getComponent(HaulTrip)!.phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(0);
  });
});

describe('HaulSystem lifecycle', () => {
  it('ends the trip when the target is demolished mid-walk', async () => {
    // Demolition goes through the command path, the only way a building ever
    // leaves the world, so this exercises the real removal timing.
    const { world, buildings, haulers, step, stockpile } = await setup([{ col: 20, row: 10, wood: 9 }], 1, [CommandSystem]);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('outbound');
    enqueue(world, { type: 'demolishBuilding', buildingId: buildings[0].getComponent(Building)!.id });
    await step(1);
    // The premise the comment above claims, now checked rather than assumed:
    // the target really did leave the world, on the tick the command landed.
    // Until this file drained the RemovalLedger the building stood there for
    // the whole run with only its buffer emptied, and every assertion below
    // held against that ghost just as well — see the report for OBS-6-08.
    expect(world.hasEntity(buildings[0])).toBe(false);
    await step(11); // long past the arrival tick
    expect(tripOf(haulers[0]).phase).toBe('idle');
    // Demolition refunds the forester's own cost (wood: 10) same as any
    // demolition — orthogonal to the trip. None of the 9 buffered units the
    // hauler never picked up made it out through the haul path.
    expect(stockpile.get('wood')).toBe(10);
  });

  it('cancels an outbound trip on the tick its target is demolished, not on arrival', async () => {
    // (20,10) is 11 ticks each way. Spec §2.8 wants the trip to cancel when the
    // source goes, riding the same-tick demolishedIds machinery — not lazily on
    // arrival ten ticks later. The difference is visible: a snapshot taken on
    // the demolish tick still reports haulTargetId, the layout cannot find that
    // tile and walks the dot home, and the simulation keeps the hauler booked
    // for a building that no longer exists.
    const { world, buildings, haulers, step } = await setup([{ col: 20, row: 10, wood: 9 }], 1, [CommandSystem]);
    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', ticksLeft: 11 });

    enqueue(world, { type: 'demolishBuilding', buildingId: buildings[0].getComponent(Building)!.id });
    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', targetId: null, ticksLeft: 0 });
    // ...and it is not re-dispatched at the ghost in that same tick: sim-ecs
    // defers the entity removal past every system, so HaulSystem still sees the
    // demolished building (and its 9 units) when it runs after CommandSystem —
    // which is precisely why `targetId: null` above is a real assertion.
    //
    // The other half of that sentence, which nothing used to check: the
    // deferral ends WITH THE TICK. `applyRemovals` takes the building out once
    // the step resolves, so the ghost is a within-tick phenomenon rather than a
    // permanent resident, and the idle below is measured against a target that
    // genuinely no longer exists.
    expect(world.hasEntity(buildings[0])).toBe(false);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('a hauler already carrying delivers even if its source is gone', async () => {
    const { world, buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1, [CommandSystem]);
    await step(4); // loaded, now returning
    expect(tripOf(haulers[0]).amount).toBe(BALANCE.haulCarryCapacity);
    const before = stockpile.get('wood');
    enqueue(world, { type: 'demolishBuilding', buildingId: buildings[0].getComponent(Building)!.id });
    await step(1);
    // "its source is gone" is this case's whole premise, and it was fiction:
    // without the drain the forester stayed in the world for the rest of the
    // run, so what the assertion below really measured was a return leg whose
    // source was still standing with an emptied buffer. Checked first, so a
    // regression that stops removing the building fails HERE rather than
    // leaving the delivery assertion quietly testing something easier.
    expect(world.hasEntity(buildings[0])).toBe(false);
    // The return leg is deliberately NOT cancelled: those units already left
    // the building, and resetting the trip would delete them.
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', amount: BALANCE.haulCarryCapacity });

    await step(2); // walks the rest of the way home
    // Exact sum, never >=: the forester's own refund is wood: 10, which alone
    // clears haulCarryCapacity (6) — a >= assertion would hold with the deposit
    // deleted from HaulSystem entirely.
    expect(stockpile.get('wood')).toBe(before + BUILDINGS.forester.cost.wood! + BALANCE.haulCarryCapacity);
  });

  it('a hauler promoted a tick later respects the claim already walking', async () => {
    // Spec §2.3: "unclaimed" subtracts what haulers already outbound will take.
    // Same-tick claims are pinned elsewhere; this is the CROSS-tick half — the
    // claim map is rebuilt from live components every tick rather than being
    // remembered, so a hauler promoted mid-walk must see the first one's claim.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity); // exactly one load, no more
    // Both housed beside the camp, so "exactly one load" stays literally true:
    // an unhoused hauler carries half of it (Task 7) and would leave a
    // remainder for the promoted one to claim, which is the opposite of what
    // this case is about.
    const homeId = spawnHaulerHouse(prep, ids, [{ col: 5, row: 4 }]);
    const first = spawnColonist(prep, ids, { hauling: true, homeId });
    const second = spawnColonist(prep, ids, { homeId }); // idle for now; promoted next tick
    const world = await prep.prepareRun();

    await world.step(); // tick 1: the first hauler claims the whole buffer
    expect(tripOf(first).phase).toBe('outbound');

    enqueue(world, { type: 'assignHauler' });
    await world.step(); // tick 2: promoted while the first is still walking
    expect(tripOf(second)).toMatchObject({ phase: 'idle', targetId: null });
    expect(tripOf(first).phase).toBe('outbound'); // still en route, claim intact
  });

  it('a hauler promoted mid-walk sees the REDUCED claim the walker will really take', async () => {
    // The CROSS-tick half of "all three capacity sites move together". The
    // same-tick dispatch claim is pinned above; this one is buildClaimMap,
    // which is rebuilt from live components every tick and must reserve what
    // the outbound hauler will actually carry. A buffer of 4 is one reduced
    // carry (3) plus a remainder worth fetching — but a claim map still
    // reserving the flat 6 reports the whole buffer spoken for, and the
    // promoted hauler stays at the camp while a unit sits at the building.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', haulerCapacity(null) + 1);
    // Homeless on purpose: the reduced capacity IS the subject here.
    const first = spawnColonist(prep, ids, { hauling: true });
    const second = spawnColonist(prep, ids, {}); // promoted next tick, while the first is still walking
    const world = await prep.prepareRun();

    await world.step(); // (5,4) is 3 ticks out, so the first is nowhere near arrival
    expect(tripOf(first).phase).toBe('outbound');

    enqueue(world, { type: 'assignHauler' });
    await world.step(); // CommandSystem promotes, HaulSystem dispatches in the same tick
    expect(tripOf(first).phase).toBe('outbound'); // still en route, its claim intact
    expect(tripOf(second).targetId).toBe(building.getComponent(Building)!.id);
  });

  it('a colony restored from a save starts with no trips in flight', async () => {
    // HaulTrip is runtime-only and never enters the save (spec §2.5): a hauler
    // caught mid-trip banks its load at save time, and on load every worker
    // respawns with a default-constructed trip and claims afresh. Driven through
    // the real load path — a save whose workers ARE haulers, and a building with
    // a backlog worth claiming — so an attempt to persist trip state, or a
    // restore that carried one across timelines, fails here.
    const save = initialSave();
    save.colonists = save.colonists.map((worker) => ({ ...worker, hauling: true }));
    save.buildings = [{ id: 10, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, buffer: { wood: 9 }, relocatingTicks: 0 }];
    save.nextEntityId = 11;
    const world = await createColonyWorld(save);

    const trips = [...world.getEntities()]
      .filter((entity) => entity.getComponent(Colonist) !== undefined)
      .map((entity) => entity.getComponent(HaulTrip)!);
    expect(trips).toHaveLength(save.colonists.length);
    expect(trips.every((t) => t.phase === 'idle' && t.targetId === null && t.ticksLeft === 0 && t.amount === 0)).toBe(true);
  });
});
