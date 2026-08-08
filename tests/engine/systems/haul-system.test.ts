import { describe, expect, it } from 'vitest';
import type { IEntity, IRuntimeWorld } from 'sim-ecs';
import { Building, HaulTrip, JobAssignment, OutputBuffer, Worker } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { enqueue } from '../fixtures';
import {
  buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker, type TColonySystemFactory,
} from '../../../src/engine/world';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';

interface BuildingSpec { col: number; row: number; wood: number; id?: number }

/**
 * `systemsBefore` runs AHEAD of HaulSystem, which is where ALL_SYSTEMS puts
 * CommandSystem: a tick drains its commands first and only then moves haulers.
 * The order is load-bearing for the demolition cases below — it is what makes
 * "the tick the player pressed demolish" the tick the trip has to end on.
 */
async function setup(specs: readonly BuildingSpec[], haulerCount: number, systemsBefore: readonly TColonySystemFactory[] = []) {
  const save = initialSave();
  save.workers = [];
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
  const haulers: IEntity[] = Array.from({ length: haulerCount }, () => spawnWorker(prep, ids, { hauling: true }));
  const world = await prep.prepareRun();
  const step = async (times: number) => { for (let i = 0; i < times; i++) await world.step(); };
  return { world, buildings, haulers, step, stockpile: world.getResource(Stockpile) };
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
        workerId: e.getComponent(Worker)!.id,
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

  // OBS-5-01: legTicks and the pickup tile are frozen at the two sites that
  // begin a leg (dispatch, and load/turn-for-home) and must survive exactly
  // as long as the leg they describe — cleared only once the trip resets.
  it('freezes the leg total and the return-leg pickup tile when each leg begins, and clears both on reset', async () => {
    // Same (5,4) trip as the test above: 3 ticks each way.
    const { haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1);
    await step(1); // dispatched: outbound leg begins
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', ticksLeft: 3, legTicks: 3 });

    await step(3); // arrives, loads, turns for home: the return leg begins here
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', ticksLeft: 3, legTicks: 3, pickupCol: 5, pickupRow: 4,
    });

    await step(3); // delivered
    expect(stockpile.get('wood')).toBe(BALANCE.haulCarryCapacity);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', legTicks: 0, pickupCol: 0, pickupRow: 0 });
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

  it('ignores workers who are not haulers', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const idle = spawnWorker(prep, ids, {});
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
    await step(12); // long past the arrival tick
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
    // defers the entity removal to the post-step sync, so HaulSystem still sees
    // the demolished building (and its 9 units) when it runs after CommandSystem.
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
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 0 });
    building.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity); // exactly one load, no more
    const first = spawnWorker(prep, ids, { hauling: true });
    const second = spawnWorker(prep, ids, {}); // idle for now; promoted next tick
    const world = await prep.prepareRun();

    await world.step(); // tick 1: the first hauler claims the whole buffer
    expect(tripOf(first).phase).toBe('outbound');

    enqueue(world, { type: 'assignHauler' });
    await world.step(); // tick 2: promoted while the first is still walking
    expect(tripOf(second)).toMatchObject({ phase: 'idle', targetId: null });
    expect(tripOf(first).phase).toBe('outbound'); // still en route, claim intact
  });

  it('a colony restored from a save starts with no trips in flight', async () => {
    // HaulTrip is runtime-only and never enters the save (spec §2.5): a hauler
    // caught mid-trip banks its load at save time, and on load every worker
    // respawns with a default-constructed trip and claims afresh. Driven through
    // the real load path — a save whose workers ARE haulers, and a building with
    // a backlog worth claiming — so an attempt to persist trip state, or a
    // restore that carried one across timelines, fails here.
    const save = initialSave();
    save.workers = save.workers.map((worker) => ({ ...worker, hauling: true }));
    save.buildings = [{ id: 10, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, buffer: { wood: 9 }, relocatingTicks: 0 }];
    save.nextEntityId = 11;
    const world = await createColonyWorld(save);

    const trips = [...world.getEntities()]
      .filter((entity) => entity.getComponent(Worker) !== undefined)
      .map((entity) => entity.getComponent(HaulTrip)!);
    expect(trips).toHaveLength(save.workers.length);
    expect(trips.every((t) => t.phase === 'idle' && t.targetId === null && t.ticksLeft === 0 && t.amount === 0)).toBe(true);
  });
});
