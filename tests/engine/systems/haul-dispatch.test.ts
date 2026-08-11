import { describe, expect, it } from 'vitest';
import { SystemError, type IEntity, type IPreptimeWorld, type IRuntimeWorld } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import { CAMP_SITE_ID, CAMP_TILE, haulTicksBetween, legPositionOf, type StoreSite } from '../../../src/shared/haul';
import type { TileRef } from '../../../src/shared/placement';
import { lifespanFor } from '../../../src/shared/population';
import { BALANCE } from '../../../src/engine/content/balance';
import { Age, Building, Colonist, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Relocation } from '../../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { PopulationSystem } from '../../../src/engine/systems/population-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { StatsSystem } from '../../../src/engine/systems/stats-system';
import { HaulSystem, haulerCapacity } from '../../../src/engine/systems/haul-system';
import { claimsOf, heldAtOf } from '../../../src/engine/systems/haul-claims';
import { holdsNoneOf } from '../../../src/engine/systems/haul-dispatch';
import { campAdjacentFreeTile, colonyTotal, enqueue } from '../fixtures';
import {
  applyRemovals, buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
  type TColonySystemFactory,
} from '../../../src/engine/world';
import type { SaveGameV6 } from '../../../src/shared/save';

/**
 * A supply trip is a state machine, so these fixtures are read tick by tick
 * rather than only at the end — a test that reads the end state passes for the
 * wrong reasons on a trip that skipped a leg.
 *
 * Every fixture below picks numbers that are pairwise distinct: tiles, leg
 * lengths, planned amounts, site capacities and stock levels never coincide,
 * so a field that reads a neighbour's value cannot pass by accident. Where two
 * numbers must be equal for the case to exist at all (a depot with room for
 * exactly one load), that equality is the subject and is stated as such.
 */

interface Spec {
  id?: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  /** Finished goods waiting for a collect trip. */
  buffer?: Partial<Record<ResourceId, number>>;
  /** This building's own in-tray, as a hauler would have filled it. */
  inputBuffer?: Partial<Record<ResourceId, number>>;
  /** A batch already in progress. Its inputs are ALREADY out of the in-tray —
   * `payFrom` draws them at batch start — which is why an empty tray on its own
   * says nothing about whether a building is working. */
  batchActive?: boolean;
  /** Colonists assigned to it — supply dispatch requires at least one. */
  crew?: number;
  /** Ledger stock standing IN this building, for a storehouse. */
  stored?: Partial<Record<ResourceId, number>>;
}

interface Options {
  systems?: readonly TColonySystemFactory[];
  camp?: Partial<Record<ResourceId, number>>;
  /** Extra idle adults, e.g. someone for `assignHauler` to promote. */
  idlers?: number;
}

/** The site record a storehouse spawned by `setup` presents to the ledger. */
function siteOf(entity: IEntity): StoreSite {
  const position = entity.getComponent(Position)!;
  return { id: entity.getComponent(Building)!.id, col: position.col, row: position.row, capacity: BALANCE.storehouseCapacity };
}

/** One house on a commute-neutral tile, so every hauler here carries the flat
 * `BALANCE.haulCarryCapacity` and these cases keep measuring haulage. */
function spawnHaulerHouse(prep: IPreptimeWorld, ids: IdCounter, taken: readonly TileRef[]): number {
  const at = campAdjacentFreeTile(taken);
  const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
  return house.getComponent(Building)!.id;
}

async function setup(specs: readonly Spec[], haulerCount: number, options: Options = {}) {
  const { systems = [HaulSystem], camp = {}, idlers = 0 } = options;
  const save = initialSave();
  save.colonists = [];
  save.buildings = [];
  save.stockpile = { ...camp };
  const prep = buildColonyPrepWorld({ save, systems });
  const ids = getPrepResource(prep, IdCounter);
  const buildings = specs.map((spec) => spawnBuilding(prep, ids, {
    id: spec.id, defId: spec.defId, progress: 0, batchActive: spec.batchActive ?? false, col: spec.col, row: spec.row,
    relocatingTicks: 0, buffer: spec.buffer, inputBuffer: spec.inputBuffer,
  }));
  const adult = BALANCE.lifeBands.matureTicks;
  const homeId = spawnHaulerHouse(prep, ids, specs);
  specs.forEach((spec, i) => {
    for (let c = 0; c < (spec.crew ?? 0); c++) {
      spawnColonist(prep, ids, { buildingId: buildings[i].getComponent(Building)!.id, ageTicks: adult, homeId });
    }
  });
  const haulers = Array.from({ length: haulerCount }, () => spawnColonist(prep, ids, { hauling: true, homeId, ageTicks: adult }));
  for (let i = 0; i < idlers; i++) spawnColonist(prep, ids, { ageTicks: adult, homeId });
  const world = await prep.prepareRun();
  const stockpile = world.getResource(Stockpile);
  specs.forEach((spec, i) => {
    // refundAt, not addAt: seeding a depot must not register as a delivery, or
    // the flow-accounting cases below would start from a dirtied ledger.
    for (const [id, amount] of Object.entries(spec.stored ?? {})) stockpile.refundAt(siteOf(buildings[i]), id as ResourceId, amount);
  });
  const step = async (times: number) => {
    for (let i = 0; i < times; i++) { await world.step(); applyRemovals(world); }
  };
  return { world, buildings, haulers, step, stockpile };
}

const tripOf = (colonist: IEntity) => colonist.getComponent(HaulTrip)!;
const inputOf = (building: IEntity) => building.getComponent(InputBuffer)!;
const bufferOf = (building: IEntity) => building.getComponent(OutputBuffer)!;
const idOf = (building: IEntity) => building.getComponent(Building)!.id;

/** The leg a fixture expects, computed the way the engine computes it, so a
 * retune of `haulTilesPerTick` moves the fixture and the engine together. */
const legTicks = (from: TileRef, to: TileRef) => haulTicksBetween(from, to, BALANCE.haulTilesPerTick);

const MILL = { col: 12, row: 8 };
const DEPOT = { col: 20, row: 10 };
const BESIDE_DEPOT = { col: 21, row: 10 };
/** A depot two tiles from the mill and eleven from the camp — the tile that
 * makes "back to the source" and "to the nearest site" different answers. */
const BESIDE_MILL = { col: 14, row: 9 };
/** A collect-only producer on nobody else's tile, nearer the camp than the
 * mill, so a hauler sent here rather than to MILL is unmistakable. */
const FORESTER = { col: 6, row: 2 };

describe('where a hauler starts', () => {
  // Every other number on HaulTrip defaults to zero, so this one field is the
  // exception and has to be stated at the ONE shared spawn list rather than at
  // each path — a hauler beginning at (0, 0) would price and draw its first leg
  // from the map's corner, a tile it has never stood on. Both paths into the
  // world are checked, because they were once allowed to drift apart (OBS-4-02).
  it('a restored hauler stands at the camp tile, not at the map corner', async () => {
    const save: SaveGameV6 = { ...initialSave() };
    save.colonists = save.colonists.map((worker) => ({ ...worker, hauling: true }));
    const world = await createColonyWorld(save);
    const trips = [...world.getEntities()].map((e) => e.getComponent(HaulTrip)).filter((t) => t !== undefined);
    expect(trips).toHaveLength(save.colonists.length);
    expect(trips.every((t) => t.atCol === CAMP_TILE.col && t.atRow === CAMP_TILE.row)).toBe(true);
    // Non-vacuous: the camp is not at the origin, so (0, 0) would fail this.
    expect([CAMP_TILE.col, CAMP_TILE.row]).not.toEqual([0, 0]);
  });

  it('a hauler recruited during play stands at the camp tile too', async () => {
    const save: SaveGameV6 = { ...initialSave(), stockpile: { bread: 5000 } };
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem] });
    const world = await prep.prepareRun();
    const before = new Set([...world.getEntities()].filter((e) => e.getComponent(JobAssignment) !== undefined));
    enqueue(world, { type: 'recruitWorker' });
    await world.step();
    const arrival = [...world.getEntities()].find((e) => e.getComponent(JobAssignment) !== undefined && !before.has(e));
    expect(arrival).toBeDefined();
    expect(arrival!.getComponent(HaulTrip)!).toMatchObject({ atCol: CAMP_TILE.col, atRow: CAMP_TILE.row });
  });
});

describe('the supply leg', () => {
  it('a supply hauler fetches, unloads, and comes back with what was waiting', async () => {
    // 20 wheat at the camp, a mill at (12,8) with an empty in-tray and 4 flour
    // already made — so the return leg has something to carry and the whole
    // round trip is exercised. 20, 4, 6 and 12/8 are all distinct.
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'mill', ...MILL, buffer: { flour: 4 }, crew: 1 }], 1, { camp: { wheat: 20 } },
    );
    const [mill] = buildings;
    const total = () => colonyTotal(world, 'wheat') + colonyTotal(world, 'flour');
    expect(total()).toBe(24);

    // THREE legs, and this first assertion is the one a two-leg habit gets
    // wrong: even a camp-sourced job pays the never-free one-tick minimum, so a
    // hauler cannot be outbound-and-loaded on the dispatch tick.
    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', kind: 'supply', amount: 0, plannedAmount: 6 });

    await step(legTicks(CAMP_TILE, CAMP_TILE)); // source arrival: loaded, and now walking to the mill
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', resource: 'wheat', amount: 6, plannedAmount: 0 });
    expect(stockpile.get('wheat')).toBe(14); // out of the store, not yet consumed
    expect(total()).toBe(24);

    await step(legTicks(CAMP_TILE, MILL)); // building arrival: unload, then load
    expect(inputOf(mill).amounts.get('wheat')).toBe(6);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', resource: 'flour', amount: 4, pickedUp: true });
    expect(bufferOf(mill).total()).toBe(0);
    expect(total()).toBe(24);

    await step(legTicks(MILL, CAMP_TILE)); // deposit
    expect(stockpile.getAt(CAMP_SITE_ID, 'flour')).toBe(4);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0 });
    expect(total()).toBe(24);
  });

  it('a supply trip that finds nothing waiting returns empty', async () => {
    // The honest cost of a one-directional errand: the wheat still lands, and
    // the hauler walks home with nothing.
    const { buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'mill', ...MILL, crew: 1 }], 1, { camp: { wheat: 20 } },
    );
    await step(1 + legTicks(CAMP_TILE, CAMP_TILE) + legTicks(CAMP_TILE, MILL));
    expect(inputOf(buildings[0]).amounts.get('wheat')).toBe(6);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', resource: null, amount: 0, pickedUp: false });

    await step(legTicks(MILL, CAMP_TILE));
    expect(tripOf(haulers[0]).phase).toBe('idle');
    expect(stockpile.get('wheat')).toBe(14);
  });

  it('the remainder rides home when the input buffer filled meanwhile', async () => {
    // 20 at the camp, 8 already in the mill's in-tray: room for 4, so the trip
    // plans 4 rather than a full 6 — three distinct numbers.
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'mill', ...MILL, inputBuffer: { wheat: 8 }, crew: 1 }], 1, { camp: { wheat: 20 } },
    );
    const [mill] = buildings;
    expect(colonyTotal(world, 'wheat')).toBe(28);

    await step(1);
    expect(tripOf(haulers[0]).plannedAmount).toBe(4);
    await step(legTicks(CAMP_TILE, CAMP_TILE));
    expect(tripOf(haulers[0]).amount).toBe(4);

    // Another hauler got there first, moved conservingly: 4 out of the camp and
    // into the mill's in-tray, which fills it.
    stockpile.takeAt(CAMP_SITE_ID, 'wheat', 4);
    inputOf(mill).add('wheat', 4);
    expect(colonyTotal(world, 'wheat')).toBe(28);

    await step(legTicks(CAMP_TILE, MILL));
    // Not silently dropped: still in hand, still marked as never picked up.
    expect(inputOf(mill).total()).toBe(12);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', resource: 'wheat', amount: 4, pickedUp: false });
    expect(colonyTotal(world, 'wheat')).toBe(28);

    await step(legTicks(MILL, CAMP_TILE));
    expect(stockpile.get('wheat')).toBe(16);
    expect(colonyTotal(world, 'wheat')).toBe(28);
  });

  it('a remainder walks back to the site it came from, past a nearer depot standing open', async () => {
    // §2.5 step 4's rule, and the ONLY fixture that can see it: every other
    // remainder case gives the colony a single site, where "back to your
    // source" and "to the nearest site" are the same answer. Here the camp is
    // the source and eleven ticks away, while an empty depot stands two ticks
    // from the mill — so routing onward would turn camp wheat into depot stock
    // without it ever being consumed: a store-to-store transfer nobody asked
    // for, which is `remainderHome`'s own wording in haul-sites.ts. Task 6's
    // transfer mechanic does not repeal this. A real transfer is dispatched
    // against a DESTINATION'S demand and reserves room there; this load was
    // sized against a building's in-tray that has since filled, and no site
    // asked for it.
    const { world, buildings, haulers, step, stockpile } = await setup([
      { defId: 'mill', ...MILL, inputBuffer: { wheat: 8 }, crew: 1 },
      { defId: 'storehouse', ...BESIDE_MILL },
    ], 1, { camp: { wheat: 20 } });
    const [mill, depot] = buildings;
    // The two answers really are tellable apart, and by a wide margin.
    expect(legTicks(MILL, BESIDE_MILL)).toBeLessThan(legTicks(MILL, CAMP_TILE));
    expect(colonyTotal(world, 'wheat')).toBe(28);

    await step(1);
    // Sourced at the CAMP, not at the empty depot beside it: that is what makes
    // the walk home the long one.
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', sourceSiteId: CAMP_SITE_ID, plannedAmount: 4 });
    await step(legTicks(CAMP_TILE, CAMP_TILE));
    expect(tripOf(haulers[0]).amount).toBe(4);

    // Another hauler fills the in-tray behind this one's back, so the whole
    // load comes back undelivered.
    stockpile.takeAt(CAMP_SITE_ID, 'wheat', 4);
    inputOf(mill).add('wheat', 4);

    await step(legTicks(CAMP_TILE, MILL));
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', resource: 'wheat', amount: 4, pickedUp: false,
      destSiteId: CAMP_SITE_ID, legTicks: legTicks(MILL, CAMP_TILE),
      legToCol: CAMP_TILE.col, legToRow: CAMP_TILE.row,
    });

    await step(legTicks(MILL, CAMP_TILE));
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(16);
    expect(stockpile.totalAt(idOf(depot))).toBe(0); // the depot never sees it
    expect(colonyTotal(world, 'wheat')).toBe(28);
  });

  it('a remainder whose own source has filled up falls back to the nearest site with room', async () => {
    // The other half of the rule above: the source is preferred, not forced.
    // The depot the load came out of is packed to its last unit by the time the
    // hauler turns round, so the remainder has to walk the eleven ticks to the
    // camp rather than be shoved into a store with no room for it.
    const { world, buildings, haulers, step, stockpile } = await setup([
      { defId: 'storehouse', ...DEPOT, stored: { wheat: 12 } },
      { defId: 'mill', ...BESIDE_DEPOT, inputBuffer: { wheat: 8 }, crew: 1 },
    ], 1);
    const [depot, mill] = buildings;
    const depotId = idOf(depot);
    expect(colonyTotal(world, 'wheat')).toBe(20);

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', sourceSiteId: depotId, plannedAmount: 4 });
    await step(legTicks(CAMP_TILE, DEPOT));
    expect(tripOf(haulers[0]).amount).toBe(4);

    // Behind the hauler's back: the in-tray fills, and the depot is packed to
    // exactly its capacity with something else.
    stockpile.takeAt(depotId, 'wheat', 4);
    inputOf(mill).add('wheat', 4);
    stockpile.refundAt(siteOf(depot), 'planks', 56);
    expect(stockpile.totalAt(depotId)).toBe(BALANCE.storehouseCapacity);

    await step(legTicks(DEPOT, BESIDE_DEPOT));
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', resource: 'wheat', amount: 4, pickedUp: false,
      destSiteId: CAMP_SITE_ID, legTicks: legTicks(BESIDE_DEPOT, CAMP_TILE),
    });
    // The full source and the camp are a whole map apart, so this leg cannot be
    // mistaken for the one-tick hop back to the depot underfoot.
    expect(legTicks(BESIDE_DEPOT, DEPOT)).toBeLessThan(legTicks(BESIDE_DEPOT, CAMP_TILE));

    await step(legTicks(BESIDE_DEPOT, CAMP_TILE));
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(4);
    expect(stockpile.totalAt(depotId)).toBe(BALANCE.storehouseCapacity); // still exactly full
    expect(colonyTotal(world, 'wheat')).toBe(20);
  });

  it('demolishing the target under a LOADED outbound hauler destroys none of the load', async () => {
    // The demolition branch for a hauler with something in its hands. Before
    // the supply leg an outbound hauler was always empty, so cancelling it on
    // the demolish tick cost nothing; now it can be carrying inputs it drew out
    // of a store, and cancelling deletes them. §2.7: the hauler survives and is
    // perfectly able to carry them, so it turns for home ON THE DEMOLISH TICK
    // from where it stands — it does not walk the rest of the way to a tile
    // with nothing on it, and its load is not teleported off it either.
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'mill', ...MILL, crew: 1 }], 1, { systems: [CommandSystem, HaulSystem], camp: { wheat: 20 } },
    );
    expect(colonyTotal(world, 'wheat')).toBe(20);
    await step(1 + legTicks(CAMP_TILE, CAMP_TILE));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', amount: 6, pickedUp: false });
    expect(stockpile.get('wheat')).toBe(14); // out of the ledger, in a pair of hands

    // Three of the seven ticks out, so the hauler is a third of the way along a
    // leg no endpoint of the fixture stands on — the tile a turn-for-home has
    // to be priced from, and one no other number here can be confused with.
    const WALKED = 3;
    await step(WALKED);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', ticksLeft: legTicks(CAMP_TILE, MILL) - WALKED });
    const partWay = legPositionOf(tripOf(haulers[0]));

    enqueue(world, { type: 'demolishBuilding', buildingId: idOf(buildings[0]) });
    await step(1);
    expect(world.hasEntity(buildings[0])).toBe(false); // the target really did go
    // The TICKS, not merely the destination: the walk home is priced from where
    // this hauler actually got to (3 ticks), which is neither the walk it had
    // left to the mill (4) nor the walk home from the mill it never reached (7).
    // Asserting only "it ends up at the camp" passes for a teleport.
    expect(legTicks(partWay, CAMP_TILE)).toBe(3);
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', amount: 6, destSiteId: CAMP_SITE_ID, legTicks: 3, ticksLeft: 2,
    });
    // THE assertion, and it is colony-wide rather than on the trip: a cancel
    // here reads amount 0 on a field the handler just cleared, and 14 here.
    expect(colonyTotal(world, 'wheat')).toBe(20);

    await step(2); // and carries it home rather than teleporting it
    expect(stockpile.get('wheat')).toBe(20);
    expect(colonyTotal(world, 'wheat')).toBe(20);
  });

  it('a returning supply remainder is not counted as a delivery', async () => {
    // The same fixture reached twice: 4 units of wheat banked at the camp by a
    // hauler that could not deliver them, against 4 units of wheat banked at
    // the camp by a hauler that picked them out of an output buffer. Same
    // amount, same resource, same destination — only `pickedUp` differs, and
    // Delivered/t must move for the second and not for the first.
    const rebuffed = await setup([{ defId: 'mill', ...MILL, inputBuffer: { wheat: 8 }, crew: 1 }], 1, { camp: { wheat: 20 } });
    await step4(rebuffed, () => {
      rebuffed.stockpile.takeAt(CAMP_SITE_ID, 'wheat', 4);
      inputOf(rebuffed.buildings[0]).add('wheat', 4);
    });
    expect(rebuffed.stockpile.get('wheat')).toBe(16);
    expect(rebuffed.stockpile.producedThisTick.get('wheat') ?? 0).toBe(0);

    const collected = await setup([{ defId: 'farm', ...MILL, buffer: { wheat: 4 } }], 1);
    await collected.step(1 + legTicks(CAMP_TILE, MILL) + legTicks(MILL, CAMP_TILE));
    expect(collected.stockpile.get('wheat')).toBe(4);
    expect(collected.stockpile.producedThisTick.get('wheat') ?? 0).toBe(4);
  });

  it('a hauler idle where a storehouse stood keeps its tile and dispatches from there', async () => {
    // NOT "dispatches from the camp": atCol/atRow is a physical position, so
    // there is no membership to repair when the depot goes. Teleporting the
    // hauler home would mis-price its next leg by ten ticks.
    const { buildings, haulers, step, world } = await setup(
      [{ defId: 'storehouse', ...DEPOT }, { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 12 } }],
      1, { systems: [CommandSystem, HaulSystem] },
    );
    const out = legTicks(CAMP_TILE, BESIDE_DEPOT);
    await step(1 + out + legTicks(BESIDE_DEPOT, DEPOT));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', atCol: DEPOT.col, atRow: DEPOT.row });

    enqueue(world, { type: 'demolishBuilding', buildingId: idOf(buildings[0]) });
    await step(1); // the depot goes, and the hauler is dispatched from where it stands
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'outbound', legFromCol: DEPOT.col, legFromRow: DEPOT.row, ticksLeft: legTicks(DEPOT, BESIDE_DEPOT),
    });
    expect(legTicks(DEPOT, BESIDE_DEPOT)).toBeLessThan(out); // the two figures really are tellable apart
  });

  it('a storehouse sent into relocation leaves its hauler standing exactly where it is', async () => {
    const { buildings, haulers, step } = await setup(
      [{ defId: 'storehouse', ...DEPOT }, { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 12 } }], 1,
    );
    await step(1 + legTicks(CAMP_TILE, BESIDE_DEPOT) + legTicks(BESIDE_DEPOT, DEPOT));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', atCol: DEPOT.col, atRow: DEPOT.row });

    buildings[0].getComponent(Relocation)!.ticksLeft = 5; // in transit: no longer a site
    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'outbound', legFromCol: DEPOT.col, legFromRow: DEPOT.row, ticksLeft: legTicks(DEPOT, BESIDE_DEPOT),
    });
  });
});

/** The rebuffed-remainder run, shared by the remainder and delivery cases:
 * dispatch, fetch, fill the in-tray behind the hauler's back, walk both
 * remaining legs. */
async function step4(fixture: Awaited<ReturnType<typeof setup>>, fillMeanwhile: () => void): Promise<void> {
  await fixture.step(1 + legTicks(CAMP_TILE, CAMP_TILE));
  fillMeanwhile();
  await fixture.step(legTicks(CAMP_TILE, MILL) + legTicks(MILL, CAMP_TILE));
}

/**
 * Five ways to reach the same fact: stock in a remote depot is reachable by
 * any hauler, from wherever it happens to be standing. Under the discarded
 * base model each of these deadlocked — a supply job could only load at the
 * hauler's own site, and a hauler only changed site by depositing at one — so
 * each is kept as a regression sentinel against a base creeping back in.
 */
describe('a remote depot is reachable by anyone', () => {
  const chain: Spec[] = [
    { defId: 'storehouse', ...DEPOT, stored: { wheat: 30 } },
    { defId: 'mill', ...BESIDE_DEPOT, crew: 1 },
  ];
  /** Long enough for the 11-tick fetch, the 1-tick hop and three ticks of
   * milling, with room to spare — this asks WHETHER the cluster starts. */
  const RUN = 40;
  const produced = (world: IRuntimeWorld) => colonyTotal(world, 'flour');

  it('a hauler at the camp fetches from a remote depot to feed a mill beside it', async () => {
    const { world, step } = await setup(chain, 1, { systems: [ProductionSystem, HaulSystem] });
    await step(RUN);
    expect(produced(world)).toBeGreaterThan(0);
  });

  it('...after a reload, when every hauler wakes at the camp with no memory', async () => {
    const save: SaveGameV6 = { ...initialSave(), colonists: [], buildings: [], stockpile: {} };
    save.buildings = [
      { inputBuffer: {}, stored: {}, id: 40, defId: 'house', col: 3, row: 0, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      { inputBuffer: {}, stored: { wheat: 30 }, id: 41, defId: 'storehouse', ...DEPOT, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      { inputBuffer: {}, stored: {}, id: 42, defId: 'mill', ...BESIDE_DEPOT, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
    ];
    save.colonists = [
      { id: 43, hunger: 0, buildingId: 42, toolTicks: 0, hauling: false, ageTicks: BALANCE.startingAgeTicks, homeId: 40, starvingTicks: 0 },
      { id: 44, hunger: 0, buildingId: null, toolTicks: 0, hauling: true, ageTicks: BALANCE.startingAgeTicks, homeId: 40, starvingTicks: 0 },
    ];
    save.nextEntityId = 45;
    // The depot's stock comes out of the save itself since v6, rather than
    // being seeded after the restore; what this case exercises is the RESTORED
    // hauler, which wakes idle at the camp tile with no site membership to
    // inherit and must still reach that stock.
    const world = await createColonyWorld(save);
    expect(world.getResource(Stockpile).getAt(41, 'wheat')).toBe(30);
    for (let i = 0; i < RUN; i++) await world.step();
    expect(produced(world)).toBeGreaterThan(0);
  });

  it('...after the haulers that used to stand at that depot are gone', async () => {
    // Deliberately no forester out here to collect from: a collect trip
    // ending at the depot would re-base a hauler there for free, which is
    // exactly the escape hatch the base model needed and the reason this
    // fixture would otherwise pass with sources restricted to the hauler's
    // own tile.
    const { world, step } = await setup(chain, 1, { systems: [CommandSystem, ProductionSystem, HaulSystem], idlers: 1 });
    // The first hauler works its way out to the depot's corner and ends up
    // standing there; then it stops being a hauler, and a colonist who has
    // never left the camp is promoted in its place.
    await step(RUN);
    const before = produced(world);
    expect(before).toBeGreaterThan(0);
    enqueue(world, { type: 'unassignHauler' }, { type: 'assignHauler' });
    await step(RUN);
    expect(produced(world)).toBeGreaterThan(before);
  });

  it('...for a depot that was built during play rather than restored with the colony', async () => {
    const { world, step, stockpile } = await setup(
      [{ defId: 'mill', ...BESIDE_DEPOT, crew: 1 }], 1,
      { systems: [CommandSystem, ProductionSystem, HaulSystem], camp: { wood: 200, planks: 200 } },
    );
    enqueue(world, { type: 'constructBuilding', buildingDefId: 'storehouse', at: DEPOT });
    await step(2); // built, and the entity is in the world
    const depot = [...world.getEntities()].find((e) => e.getComponent(Building)?.defId === 'storehouse')!;
    stockpile.refundAt(siteOf(depot), 'wheat', 30);
    await step(RUN);
    expect(produced(world)).toBeGreaterThan(0);
  });

  it('...even with a busy forester beside the camp offering easy collect work', async () => {
    const { world, step } = await setup(
      [...chain, { defId: 'forester', col: 3, row: 0, buffer: { wood: 12 }, crew: 2 }], 1,
      { systems: [ProductionSystem, HaulSystem] },
    );
    await step(RUN);
    expect(produced(world)).toBeGreaterThan(0);
  });
});

describe('what a leg cannot assume', () => {
  it('a construction ordered mid-fetch cannot make the hauler create goods', async () => {
    // WOOD, because the resource has to be both a recipe input and a
    // construction cost or the fixture cannot discriminate at all: no building
    // costs wheat, so a wheat-fetching hauler's source can never be drained by
    // a build order.
    const { world, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { wood: 12 } }, { defId: 'sawmill', ...BESIDE_DEPOT, crew: 1 }], 1,
      { systems: [CommandSystem, ProductionSystem, HaulSystem] },
    );
    expect(colonyTotal(world, 'wood')).toBe(12);
    const out = legTicks(CAMP_TILE, DEPOT);
    await step(1);
    // It set out to fetch 6 — the figure the assertion at the bottom must NOT
    // be satisfied by.
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', plannedAmount: 6, amount: 0 });

    // A gatherer's hut costs 10 wood and the camp holds none, so `pay` draws it
    // straight out of the depot this hauler is walking toward — a legitimate
    // spend the source claim does not bind.
    await step(out - 1);
    enqueue(world, { type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await step(1); // the build lands, then this same tick brings the hauler in
    expect(stockpile.get('wood')).toBe(0);
    expect(colonyTotal(world, 'wood')).toBe(2); // NOT 6: what was there, not what was claimed
  });

  it('an unstaffed target is not unloaded into — the load comes home instead', async () => {
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'mill', ...MILL, crew: 1 }], 1, { systems: [CommandSystem, HaulSystem], camp: { wheat: 20 } },
    );
    await step(1 + legTicks(CAMP_TILE, CAMP_TILE));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', amount: 6 });

    enqueue(world, { type: 'unassignWorker', buildingId: idOf(buildings[0]) });
    await step(legTicks(CAMP_TILE, MILL));
    expect(inputOf(buildings[0]).total()).toBe(0);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', resource: 'wheat', amount: 6, pickedUp: false });

    await step(legTicks(MILL, CAMP_TILE));
    expect(stockpile.get('wheat')).toBe(20);
    expect(colonyTotal(world, 'wheat')).toBe(20);
  });

  // Supply's own half of `loadOutput`'s recheck: staffing and a target's
  // existence are re-verified on arrival because a leg takes ticks and the
  // world moves during them (spec §2.5) — and a hauler's OWN capacity is no
  // different. `plannedAmount` is sized at DISPATCH against the capacity the
  // hauler had then; if its home is demolished, relocated or reassigned while
  // it walks, arrival must draw against what it can carry NOW.
  it('a fetch caps its take at CURRENT capacity, not the capacity it was dispatched at', async () => {
    // Four numbers, pairwise distinct, so no field here can read a
    // neighbour's value and still pass: the housed capacity the plan is
    // sized against (6), the homeless capacity the recheck must fall back to
    // (3), what the depot actually holds (5, more than homeless can carry but
    // less than housed), and the fetching leg's length (4 ticks — SOURCE is 7
    // tiles from camp at BALANCE.haulTilesPerTick == 2).
    const SOURCE = { col: 9, row: 0 };
    const housedCapacity = BALANCE.haulCarryCapacity;
    const homelessCapacity = haulerCapacity(null);
    const sourceStock = 5;
    const fetchLeg = legTicks(CAMP_TILE, SOURCE);
    expect(new Set([housedCapacity, homelessCapacity, sourceStock, fetchLeg]).size).toBe(4);
    expect(sourceStock).toBeGreaterThan(homelessCapacity);
    expect(sourceStock).toBeLessThan(housedCapacity);

    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...SOURCE, stored: { wheat: sourceStock } }, { defId: 'mill', ...MILL, crew: 1 }], 1,
    );
    const source = idOf(buildings[0]);
    expect(colonyTotal(world, 'wheat')).toBe(sourceStock);

    await step(1); // dispatched: the plan is sized against the HOUSED capacity
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', plannedAmount: sourceStock, amount: 0 });

    await step(fetchLeg - 1); // one tick short of arrival: still walking
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', ticksLeft: 1 });
    haulers[0].getComponent(Home)!.buildingId = null; // home gone mid-fetch

    await step(1); // arrival: the recheck must see the CURRENT (homeless) capacity
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', resource: 'wheat', amount: homelessCapacity });
    // Not drained to zero: the depot still holds what the hauler could not
    // carry, available for the next one to claim.
    expect(stockpile.getAt(source, 'wheat')).toBe(sourceStock - homelessCapacity);
    // Conservation alone cannot tell the fix from the bug — both leave this
    // sum at sourceStock — but a cap implemented by DISCARDING the remainder
    // instead of leaving it at the source would fail it, so it stays as a net.
    expect(colonyTotal(world, 'wheat')).toBe(sourceStock);

    await step(legTicks(SOURCE, MILL)); // walks the reduced load in and unloads it
    expect(inputOf(buildings[1]).amounts.get('wheat')).toBe(homelessCapacity);
    expect(colonyTotal(world, 'wheat')).toBe(sourceStock); // still conserved, now split source/input
  });
});

/**
 * A NEARLY-FULL DEPOT IS NO LONGER A STATE A FIXTURE MAY SEED, and every case
 * below fills one while the hauler walks instead.
 *
 * `chooseJob` offers a drain ahead of collect, and a drain candidate exists for
 * exactly a bounded site with less than `storehouseFreeFloor` free — which is
 * every depot these cases need. Seeded at 59 of 60 the hauler no longer takes
 * the collect at all: it drains the depot, and by the time anything is walking
 * a load home there is room for it. The state is not merely inconvenient to
 * reach now; it is one dispatch actively dissolves.
 *
 * So the depot is seeded below its floor's reach and topped up on the tick
 * before the hauler arrives at the producer, which is the tick before
 * `turnForHome` reads the room. The hauler is mid-trip throughout, so no
 * dispatch runs and no drain can undo the setup. Direct construction of a state
 * the engine defends against is the same technique §2.7 prescribes for the
 * room recheck, and it is stated rather than dressed up as a scenario.
 *
 * WITHOUT THIS the second case still passes and no longer tests its own name:
 * one hauler drains the depot, the other collects and finds the room the drain
 * just made, and "the second goes to the camp" is satisfied by a run in which
 * nothing was ever bound for a full depot.
 */
describe('reservations', () => {
  /** Below the free floor's reach at setup (free 50 against a floor of 12), so
   * the fixture opens with no drain candidate anywhere. */
  const UNDRAINABLE = 10;

  it('a load whose whole size does not fit is not split across a depot and the camp', async () => {
    // 59 of 60 in the depot: room for one unit of a six-unit load. Skipping
    // only FULL sites would bank 1 here and forward 5 to the camp with nobody
    // walking them.
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { wheat: UNDRAINABLE } }, { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 6 } }], 1,
    );
    await step(legTicks(CAMP_TILE, BESIDE_DEPOT)); // dispatched, and one tick short of the producer
    stockpile.refundAt(siteOf(buildings[0]), 'wheat', 59 - UNDRAINABLE);

    await step(1); // arrival: `turnForHome` reads a depot with room for one
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', amount: 6, destSiteId: CAMP_SITE_ID });

    await step(legTicks(BESIDE_DEPOT, CAMP_TILE));
    expect(stockpile.totalAt(idOf(buildings[0]))).toBe(59); // untouched, not topped to 60
    expect(stockpile.getAt(CAMP_SITE_ID, 'wood')).toBe(6);
    expect(colonyTotal(world, 'wood')).toBe(6);
  });

  it('two haulers bound for a depot with room for one send the second to the camp', async () => {
    // 54 of 60: room for exactly one six-unit load, and the two foresters are
    // equidistant enough that both haulers turn for home on the same tick —
    // which is the only tick a reservation can be the deciding fact.
    const near = { col: 20, row: 11 };
    const { buildings, haulers, step, stockpile } = await setup([
      { defId: 'storehouse', ...DEPOT, stored: { wheat: UNDRAINABLE } },
      { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 6 } },
      { defId: 'forester', ...near, buffer: { wood: 6 } },
    ], 2);
    await step(legTicks(CAMP_TILE, BESIDE_DEPOT));
    stockpile.refundAt(siteOf(buildings[0]), 'wheat', 54 - UNDRAINABLE);

    await step(1);
    const trips = haulers.map(tripOf);
    expect(trips.every((t) => t.phase === 'returning' && t.amount === 6)).toBe(true);

    const depotId = idOf(buildings[0]);
    const destinations = trips.map((t) => t.destSiteId).sort();
    expect(destinations).toEqual([CAMP_SITE_ID, depotId].sort());
    // And the loser really does walk the long way, rather than merely being
    // labelled differently: one leg is a single tile, the other is the map.
    expect(trips.map((t) => t.legTicks).sort((a, b) => a - b))
      .toEqual([legTicks(BESIDE_DEPOT, DEPOT), legTicks(near, CAMP_TILE)].sort((a, b) => a - b));
  });

  it('a returning hauler re-resolving a moved depot does not count its own reservation', async () => {
    // 54 of 60 again: the depot fits this load only if the trip's own
    // reservation is excluded from the lookup.
    //
    // The depot moves EIGHT tiles, not two: the first leg
    // (BESIDE_DEPOT -> DEPOT) is one tick, so a two-tile move makes the second
    // leg one tick as well and the assertion below cannot tell a leg that was
    // freshly resolved from one that was simply left alone.
    const moved = { col: 20, row: 2 };
    const { buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { wheat: UNDRAINABLE } }, { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 6 } }], 1,
    );
    await step(legTicks(CAMP_TILE, BESIDE_DEPOT));
    stockpile.refundAt(siteOf(buildings[0]), 'wheat', 54 - UNDRAINABLE);

    await step(1);
    const depotId = idOf(buildings[0]);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', destSiteId: depotId, amount: 6 });

    buildings[0].getComponent(Position)!.row = moved.row; // the depot is somewhere else now
    await step(legTicks(BESIDE_DEPOT, DEPOT));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', destSiteId: depotId, legTicks: legTicks(DEPOT, moved) });
    // ...and that really is a NEW leg, not the old one left running.
    expect(legTicks(DEPOT, moved)).not.toBe(legTicks(BESIDE_DEPOT, DEPOT));
  });

  it('a depot that moves mid-return is walked to, not banked into from where the hauler stands', async () => {
    // Roomy on purpose (10 of 60), so the only thing under test is whether the
    // arrival is decided by the frozen TILE or by the site id: a storehouse
    // that relocates keeps its id and changes its tile. Six tiles, so the
    // second leg (3 ticks) is a different number from the first (1) — a
    // one-tick move would leave `ticksLeft` unable to tell them apart.
    const moved = { col: 20, row: 4 };
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { wheat: 10 } }, { defId: 'forester', ...BESIDE_DEPOT, buffer: { wood: 6 } }], 1,
    );
    await step(1 + legTicks(CAMP_TILE, BESIDE_DEPOT));
    const depotId = idOf(buildings[0]);
    buildings[0].getComponent(Position)!.row = moved.row;

    await step(legTicks(BESIDE_DEPOT, DEPOT));
    // Still carrying, still walking — the ticks, not merely the eventual total,
    // because an arrival-count assertion passes for a teleport.
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', amount: 6, ticksLeft: legTicks(DEPOT, moved), legToCol: moved.col, legToRow: moved.row,
    });
    expect(legTicks(DEPOT, moved)).not.toBe(legTicks(BESIDE_DEPOT, DEPOT)); // a fresh leg, not the old one
    expect(stockpile.getAt(depotId, 'wood')).toBe(0);

    await step(legTicks(DEPOT, moved));
    expect(stockpile.getAt(depotId, 'wood')).toBe(6);
    expect(colonyTotal(world, 'wood')).toBe(6);
  });

  it('a depot holding less than the threshold still produces a candidate, because the whole site is movable', async () => {
    // worthMoving's own comment: a depot holding a single unit could feed a
    // staffed consumer forever if the threshold alone gated it, because one
    // unit never reaches minSupplyUnits and a candidate would never be
    // produced for it. Four numbers here are pairwise distinct so none of
    // them can read a neighbour's value and still pass: what the depot holds
    // (1), BALANCE.minSupplyUnits (2), the mill's room once capped by a
    // hauler's carry (6), and the fetching leg's length below.
    const SOURCE = { col: 6, row: 3 };
    const held = 1;
    const fetchLeg = legTicks(CAMP_TILE, SOURCE);
    expect(new Set([held, BALANCE.minSupplyUnits, BALANCE.haulCarryCapacity, fetchLeg]).size).toBe(4);
    expect(held).toBeLessThan(BALANCE.minSupplyUnits); // the threshold clause alone would refuse this

    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...SOURCE, stored: { wheat: held } }, { defId: 'mill', ...MILL, crew: 1 }], 1,
    );
    const source = idOf(buildings[0]);
    expect(colonyTotal(world, 'wheat')).toBe(held);

    await step(1); // dispatched: a candidate WAS produced for a stock below the threshold
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', kind: 'supply', sourceSiteId: source, plannedAmount: held, amount: 0 });

    await step(fetchLeg);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', resource: 'wheat', amount: held });
    expect(stockpile.getAt(source, 'wheat')).toBe(0); // the single unit did not strand at the depot

    await step(legTicks(SOURCE, MILL));
    expect(inputOf(buildings[1]).amounts.get('wheat')).toBe(held);
    expect(colonyTotal(world, 'wheat')).toBe(held);
  });

  it('three haulers and one depot holding a single load: exactly one goes for it', async () => {
    // The depot holds exactly one carry of wheat, and the mill has room for
    // two — so nothing but the SOURCE claim can keep the other two at home.
    const { haulers, step } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { wheat: 6 } }, { defId: 'mill', ...BESIDE_DEPOT, crew: 1 }], 3,
    );
    await step(1);
    const phases = haulers.map((h) => tripOf(h).phase).sort();
    expect(phases).toEqual(['fetching', 'idle', 'idle']);
  });

  it('three haulers and three starved mills spread out rather than converging on one', async () => {
    // Each mill has 6 of a 12-unit in-tray, so one delivery fills it: without
    // an input claim all three haulers leave for the same mill on the same tick.
    const { haulers, step } = await setup([
      { defId: 'mill', col: 8, row: 4, inputBuffer: { wheat: 6 }, crew: 1 },
      { defId: 'mill', col: 12, row: 8, inputBuffer: { wheat: 6 }, crew: 1 },
      { defId: 'mill', col: 16, row: 2, inputBuffer: { wheat: 6 }, crew: 1 },
    ], 3, { camp: { wheat: 100 } });
    await step(1);
    const targets = haulers.map((h) => tripOf(h).targetId);
    expect(new Set(targets).size).toBe(3);
  });

  it('an input claim is SUBTRACTED from room, not treated as an all-or-nothing exclusion', async () => {
    // One mill, an EMPTY 12-unit in-tray, one crew, and three haulers: room for
    // exactly two 6-unit loads. This is the case the three-starved-mills test
    // above cannot be, because there `room` (6) and `haulCarryCapacity` (6) are
    // equal — a fixture where any claim at all excludes the whole building
    // passes it exactly as well as one where the claim is subtracted. Here
    // room (12) is not haulCarryCapacity (6), so "subtract 6, then 6 again"
    // and "exclude on any nonzero claim" diverge on the SECOND hauler: the
    // first must find room, the second must find a smaller room, and the
    // third must find none.
    const { world, haulers, step } = await setup(
      [{ defId: 'mill', ...MILL, crew: 1 }], 3, { camp: { wheat: 100 } },
    );
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    const jobs = haulers
      .map((h) => tripOf(h))
      .map((t) => ({ kind: t.kind, phase: t.phase, planned: t.plannedAmount }))
      .sort((a, b) => b.planned - a.planned);
    expect(jobs).toEqual([
      { kind: 'supply', phase: 'fetching', planned: 6 },
      { kind: 'supply', phase: 'fetching', planned: 6 },
      { kind: 'collect', phase: 'idle', planned: 0 },
    ]);
    expect(systemErrors).toBe(0);
  });

  it('an outbound leg still claims the room it will fill, so a second hauler is not sent for it too', async () => {
    // The mill's in-tray already holds 6 of 12: room for exactly one more
    // load, stated as such, because that equality (not haulCarryCapacity
    // against itself, but held-stock against room) is what makes "claim it
    // fully while outbound" and "claim nothing once outbound" tell apart —
    // the first hauler's `plannedAmount` resets to 0 the moment it picks up
    // and turns outbound, so only the `amount` term can still be holding the
    // room claimed. A second hauler, still idle, is re-evaluated on the very
    // tick the first goes outbound and must still find none.
    const { world, haulers, step } = await setup(
      [{ defId: 'mill', ...MILL, inputBuffer: { wheat: 6 }, crew: 1 }], 2, { camp: { wheat: 100 } },
    );
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'supply', phase: 'fetching', plannedAmount: 6 });
    expect(tripOf(haulers[1])).toMatchObject({ phase: 'idle' });

    await step(legTicks(CAMP_TILE, CAMP_TILE)); // source arrival: loaded, and now outbound
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', amount: 6, plannedAmount: 0 });
    // Still nothing for the second hauler — the claim moved from plannedAmount
    // to amount, it did not vanish.
    expect(tripOf(haulers[1])).toMatchObject({ kind: 'collect', phase: 'idle', plannedAmount: 0 });
    expect(systemErrors).toBe(0);
  });

  it('a supply hauler claims the output it will load on arrival, so no second hauler is sent at it', async () => {
    // The output claim counts haulers of BOTH kinds, because a supply hauler
    // loads the target's out-tray on arrival too (§2.5 step 3).
    //
    // The camp holds fewer than one hauler's carry of wheat (5, against a
    // haulCarryCapacity of 6), so the SOURCE claim (already covered above) is
    // what leaves the second hauler with no supply job and pushes it onto the
    // collect list — deliberately, so this case turns on the output claim
    // alone rather than sharing the input claim's fixture. There the mill's 4
    // flour is the biggest backlog going and the forester's 3 wood the only
    // other, so counting the supply hauler's carry against that 4 is the one
    // thing that can send it to the forester instead.
    //
    // 5 rather than a flat 6: camp stock, haulCarryCapacity and the room a
    // bare-in-tray mill offers would otherwise all read 6, and so would the
    // asserted plannedAmount — a fixture that cannot tell `movable = min(room,
    // unclaimed)` apart from a flat capacity. 5 forces the SOURCE, not the
    // capacity, to be the binding number.
    const { world, buildings, haulers, step, stockpile } = await setup([
      { defId: 'mill', ...MILL, buffer: { flour: 4 }, crew: 1 },
      { defId: 'forester', ...FORESTER, buffer: { wood: 3 } },
    ], 2, { camp: { wheat: 5 } });
    const [mill, forester] = buildings;
    // The two backlogs are tellable apart, and the mill's is the LARGER: an
    // unclaimed mill wins the collect ordering outright.
    expect(bufferOf(mill).total()).toBeGreaterThan(bufferOf(forester).total());

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'supply', phase: 'fetching', targetId: idOf(mill), plannedAmount: 5 });
    expect(tripOf(haulers[1])).toMatchObject({ kind: 'collect', phase: 'outbound', targetId: idOf(forester) });

    // And it really was a whole job, not merely a differently-labelled one:
    // both loads come home, and nothing was created or destroyed on the way.
    await step(1 + legTicks(CAMP_TILE, CAMP_TILE) + legTicks(CAMP_TILE, MILL) + legTicks(MILL, CAMP_TILE));
    expect(stockpile.getAt(CAMP_SITE_ID, 'flour')).toBe(4);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wood')).toBe(3);
    expect(colonyTotal(world, 'wood')).toBe(3); // a colony-wide total, not just the field just written
    expect(inputOf(mill).amounts.get('wheat')).toBe(5);
    expect(colonyTotal(world, 'wheat')).toBe(5);
    expect(colonyTotal(world, 'flour')).toBe(4);
  });
});

/**
 * Every case below is the same shape: a FAR bakery under test (id 111) against
 * a NEAR rival (id 222) that is never starving, both staffed, both suppliable
 * from the camp's flour, and both with more room than one hauler can carry — so
 * `movable` is 6 for each and the whole route is the only pre-existing term
 * that can separate them. The far one therefore wins if and only if it is
 * starving, and it also carries the LOWER building id, so the id tie-break
 * cannot produce that answer either.
 */
const FAR_BAKERY = MILL; // (12, 8) — no other building in these cases stands there
const NEAR_BAKERY = { col: 6, row: 0 };
const FAR_ID = 111;
const NEAR_ID = 222;

/** The rival: five of the twelve it can hold, no batch running, near the camp. */
const nearRival: Spec = { id: NEAR_ID, defId: 'bakery', ...NEAR_BAKERY, inputBuffer: { flour: 5 }, crew: 1 };

describe('the starvation floor', () => {
  it('a building holding some of what it needs is not starving', async () => {
    // Neither in-tray is EMPTY, so neither is starving and the near bakery
    // takes the trip. Discriminating in both directions, which is the point of
    // the case: widening the band from `=== 0` to `<= 1` makes the far bakery
    // starving and hands it the trip, while deleting the starving term
    // altogether leaves this answer exactly as it stands.
    const holdsOne = 1;
    // Four pairwise-distinct numbers, so no assertion here can be satisfied by
    // a field that read a neighbour's value.
    expect(new Set([holdsOne, 5, BALANCE.haulCarryCapacity, BALANCE.inputBufferCap]).size).toBe(4);
    // Both in-trays leave MORE room than one hauler can carry, so the two
    // candidates really do tie on `movable` and the case turns on nothing else.
    expect(BALANCE.inputBufferCap - holdsOne).toBeGreaterThan(BALANCE.haulCarryCapacity);
    expect(BALANCE.inputBufferCap - 5).toBeGreaterThan(BALANCE.haulCarryCapacity);

    const { haulers, step, world } = await setup([
      { id: FAR_ID, defId: 'bakery', ...FAR_BAKERY, inputBuffer: { flour: holdsOne }, crew: 1 },
      nearRival,
    ], 1, { camp: { flour: 20 } });
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: NEAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    expect(systemErrors).toBe(0);
  });

  /**
   * The `batchActive` pair. One fixture, one knob, and the knob is the whole
   * case: `payFrom` (src/engine/systems/production-system.ts) draws a batch's
   * inputs out of the in-tray at batch START, so an EMPTY in-tray is the
   * ordinary state of a building producing perfectly well — a mill on a
   * three-tick batch holds no wheat for three ticks out of three. Nothing but
   * `batchActive` tells that building apart from one that has actually run dry,
   * which is why the two cases below differ in nothing else at all.
   *
   * They are a pair for the reason `docs/process/agent-workflow.md` gives:
   * the empty-tray clause is TRUE in both, so this clause alone has to carry
   * each assertion, and dropping `&& !row.production.batchActive` on its own
   * reddens the first and leaves the second green.
   */
  const emptyTrayBakery = (batchActive: boolean) => setup([
    { id: FAR_ID, defId: 'bakery', ...FAR_BAKERY, crew: 1, batchActive },
    nearRival,
  ], 1, { camp: { flour: 20 } });

  it('a building mid-batch is not starving, however empty its tray', async () => {
    // The far bakery's tray is empty because its crew is baking what used to be
    // in it. It is not blocked, so it does not jump the queue: the near rival,
    // which is nearer and nothing else, takes the trip.
    const { haulers, step, world } = await emptyTrayBakery(true);
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    // The route really is against the far bakery — the only pre-existing term
    // in play, and by a wide margin.
    expect(legTicks(CAMP_TILE, FAR_BAKERY)).toBeGreaterThan(legTicks(CAMP_TILE, NEAR_BAKERY));

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: NEAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    expect(systemErrors).toBe(0);
  });

  it('a building with an empty tray and no batch running IS starving', async () => {
    // The same fixture with the batch stopped: now the empty tray means the
    // crew has nothing to work with, and the floor sends the hauler the long
    // way round rather than topping up the rival that is already stocked.
    const { haulers, step, world } = await emptyTrayBakery(false);
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: FAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    expect(systemErrors).toBe(0);
  });

  it('a processor blocked on a full output buffer is not starving', async () => {
    // The other three clauses all read true here — the far bakery's tray is
    // empty of flour, no batch is running, and nothing is claimed inbound —
    // but its out-tray already holds `BALANCE.outputBufferCap` bread, so a
    // delivery could not start a batch even if one landed immediately:
    // `startBatch` (production-system.ts) returns before it ever reaches
    // `payFrom`. That building is blocked on COLLECTION, not on input, so the
    // near rival — blocked on nothing — takes the trip instead.
    const { haulers, step, world } = await setup([
      { id: FAR_ID, defId: 'bakery', ...FAR_BAKERY, crew: 1, buffer: { bread: BALANCE.outputBufferCap } },
      nearRival,
    ], 1, { camp: { flour: 20 } });
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: NEAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    expect(systemErrors).toBe(0);
  });

  it('a second hauler is not promoted to a building already being served', async () => {
    // The multi-hauler check this increment applies to everything else, turned
    // on the floor itself: if ten idle haulers were dispatched on the same
    // tick, would this have stopped the tenth?
    //
    // An in-tray and a batch flag are both PHYSICAL state, and neither moves
    // when a hauler is DISPATCHED — only when one ARRIVES, several legs later.
    // Dispatch runs every idle hauler inside one tick, so on those two clauses
    // alone the second hauler reads the same empty tray as the first and is
    // promoted to the same building behind it.
    //
    // TWO haulers by construction: the first dispatch is correct with or
    // without the claim clause, so the assertion that carries this case is the
    // SECOND hauler's target and a one-hauler fixture would prove nothing.
    const { haulers, step, world } = await setup([
      { id: FAR_ID, defId: 'bakery', ...FAR_BAKERY, crew: 1 },
      nearRival,
    ], 2, { camp: { flour: 20 } });
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    // The first hauler is promoted across the map, exactly as the case above.
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: FAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    // THE assertion: the far bakery has a load on the way, so it is no longer
    // starving and the second hauler falls back to the ordinary order — which
    // sends it to the nearer building. It is not left idle either: the camp
    // still holds 14 flour and the rival still has room, so "no supply job at
    // all" would be a different bug passing as this fix.
    expect(tripOf(haulers[1])).toMatchObject({
      kind: 'supply', phase: 'fetching', targetId: NEAR_ID, plannedAmount: BALANCE.haulCarryCapacity,
    });
    expect(systemErrors).toBe(0);
  });

  it('starving is about the resource being delivered, not any input', () => {
    // The empty-tray HALF of the rule, on its own — the `batchActive` half sits
    // at the call site in `supplyCandidates` and has the pair above.
    //
    // Unit-tested rather than dispatched, and it cannot be otherwise. No
    // shipped recipe has two inputs (every def in
    // `src/engine/content/buildings.ts` has 0 or 1) and `needOf` reads the
    // module-level catalog by defId; but even given a two-input def it would
    // still be unreachable, because `needOf` calls `shortestOf` ONCE and
    // `supplyCandidates` emits a candidate only for the resource it returns —
    // with A at zero, A always has the lowest ratio, so the B candidate this
    // case has to compare against never exists. So the rule is exported and
    // tested directly, the way `cheapestHaulerToRelease` is: an `InputBuffer`
    // is content-free, so a two-resource in-tray needs no def at all.
    //
    // What this pins is that the band is per-RESOURCE and not per-buffer.
    // Today "holds none of the resource being delivered" and "in-tray empty"
    // coincide exactly, so the per-buffer rule would ship silently and only
    // become wrong the first time a recipe gains a second input.
    const inTray = new InputBuffer();
    inTray.add('flour', 9);
    expect(holdsNoneOf(inTray, 'wheat')).toBe(true);
    expect(holdsNoneOf(inTray, 'flour')).toBe(false);
  });
});

/**
 * Where the supply leg and `moveBuilding` meet. The tiles are named here rather
 * than reusing MILL/DEPOT above because every distance in the case has to be a
 * different number, which the shared pair cannot give.
 */
const MOVER_DEPOT = { col: 14, row: 0 };
const MOVER_MILL = { col: 11, row: 15 };
const MOVER_MILL_MOVED = { col: 3, row: 5 };

describe('a target that moves under an outbound hauler', () => {
  it('re-prices the leg from where the hauler has actually walked to, not from the camp', async () => {
    // The defect this case exists for lived in `handleMoveBuilding`
    // (src/engine/systems/command-handlers.ts): it recharged a retargeted leg
    // with `haulTicks(to, …)`, which measures from the CAMP, and left all four
    // frozen endpoints pointing at the building's old tile.
    //
    // Both halves need a hauler that (a) began its outbound leg somewhere other
    // than the camp and (b) is PART-WAY along it, so this is a supply trip: the
    // hauler fetches wheat at a depot in the top-right and sets off from there.
    // Every leg length in the fixture is a different number, checked below
    // rather than asserted by comment, so no two candidate implementations can
    // produce the same answer:
    //   fetch, camp -> depot                              6
    //   the outbound leg, depot -> mill                   8   (walked half)
    //   what remains of it when the move lands            4   ("do nothing")
    //   depot -> the new tile                             7   ("snap to the leg's origin")
    //   camp -> the new tile                              3   (the old, camp-relative charge)
    //   (12.5, 7.5) -> the new tile                       5   (the answer)
    const FETCH = legTicks(CAMP_TILE, MOVER_DEPOT);
    const OUTBOUND = legTicks(MOVER_DEPOT, MOVER_MILL);
    const WALKED = OUTBOUND / 2;
    // Half-way along, so the hauler stands at the leg's midpoint — a tile
    // boundary on neither axis, and equal to neither endpoint.
    const HALFWAY = { col: (MOVER_DEPOT.col + MOVER_MILL.col) / 2, row: (MOVER_DEPOT.row + MOVER_MILL.row) / 2 };
    const RETARGETED = legTicks(HALFWAY, MOVER_MILL_MOVED);
    const FROM_CAMP = legTicks(CAMP_TILE, MOVER_MILL_MOVED);
    const FROM_ORIGIN = legTicks(MOVER_DEPOT, MOVER_MILL_MOVED);
    expect(new Set([FETCH, OUTBOUND, WALKED, RETARGETED, FROM_CAMP, FROM_ORIGIN]).size).toBe(6);

    const { world, buildings, haulers, step } = await setup([
      { defId: 'storehouse', ...MOVER_DEPOT, stored: { wheat: 20 } },
      { defId: 'mill', ...MOVER_MILL, crew: 1 },
    ], 1, { systems: [CommandSystem, HaulSystem] });
    const [, mill] = buildings;
    // sim-ecs swallows a system's exception and republishes it as an event, so
    // a handler that threw would leave every assertion below reading pre-crash
    // state and passing.
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    expect(colonyTotal(world, 'wheat')).toBe(20);

    await step(1 + FETCH); // dispatched, fetched: outbound FROM THE DEPOT, not from the camp
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'outbound', amount: 6, ticksLeft: OUTBOUND, legTicks: OUTBOUND,
      legFromCol: MOVER_DEPOT.col, legFromRow: MOVER_DEPOT.row,
    });

    await step(WALKED); // half the walk done, half still to go
    expect(tripOf(haulers[0]).ticksLeft).toBe(WALKED);

    enqueue(world, { type: 'moveBuilding', buildingId: idOf(mill), to: MOVER_MILL_MOVED });
    await step(1); // CommandSystem retargets, then HaulSystem's decrement takes one tick off
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'outbound', legTicks: RETARGETED, ticksLeft: RETARGETED - 1,
      legToCol: MOVER_MILL_MOVED.col, legToRow: MOVER_MILL_MOVED.row,
    });
    // The new leg begins at the hauler's real position: strictly between the
    // depot it left and the tile the mill has vacated, on BOTH axes, so neither
    // "snap to the origin" nor "snap to the old target" can satisfy it.
    expect(tripOf(haulers[0]).legFromCol).toBeCloseTo(HALFWAY.col, 10);
    expect(tripOf(haulers[0]).legFromRow).toBeCloseTo(HALFWAY.row, 10);
    expect(tripOf(haulers[0]).legFromCol).toBeLessThan(MOVER_DEPOT.col);
    expect(tripOf(haulers[0]).legFromCol).toBeGreaterThan(MOVER_MILL.col);
    expect(tripOf(haulers[0]).legFromRow).toBeGreaterThan(MOVER_DEPOT.row);
    expect(tripOf(haulers[0]).legFromRow).toBeLessThan(MOVER_MILL.row);
    expect(colonyTotal(world, 'wheat')).toBe(20);

    // On schedule, both ways round: still walking one tick short of the charge,
    // and arrived on it. A leg priced from the camp arrives two ticks early, one
    // priced from the depot two ticks late.
    await step(RETARGETED - 2);
    expect(tripOf(haulers[0]).phase).toBe('outbound');

    await step(1); // arrival AT THE NEW TILE: the return leg starts there regardless
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', legFromCol: MOVER_MILL_MOVED.col, legFromRow: MOVER_MILL_MOVED.row,
    });
    // The 12.8-tile move this case needs to exercise the re-pricing puts the
    // mill 13 ticks from being back in service — far longer than the 5-tick
    // retargeted leg above lands the hauler in, so this fixture's own numbers
    // land the hauler on a mill still mid-relocation. `haul-system.ts`'s
    // `unload` rechecks that on arrival the same way it rechecks staffing:
    // the load stays in hand as an undelivered remainder rather than being
    // banked into a building providing no service — see the dedicated case
    // below for that recheck itself.
    expect(inputOf(mill).total()).toBe(0);
    expect(colonyTotal(world, 'wheat')).toBe(20);
    expect(systemErrors).toBe(0);
  });

  it('a target that starts relocating mid-leg is not unloaded into on arrival', async () => {
    // §2.5's rule applied to the same retarget as above, but this time the
    // move is what `needOf` refuses at DISPATCH — `unload` must therefore
    // recheck it on ARRIVAL, exactly as it already rechecks staffing.
    // `handleMoveBuilding` re-prices the retargeted leg from wherever the
    // hauler has actually walked to, which can be a short hop even when the
    // relocation countdown that same move starts is long: that gap is what
    // lets the hauler land before the building is back in service. Every
    // number below is checked, not asserted by comment, and the two the case
    // turns on — the retargeted leg and the relocation countdown — are 3 and
    // 12, a leg neither multiple of the other:
    //   fetch, camp -> depot                                7
    //   the outbound leg, depot -> mill                     8   (walked half)
    //   what remains of it when the move lands               4
    //   depot/mill midpoint -> the new tile (retarget)      3   (short hop)
    //   the old mill tile -> the new tile (relocation)     12   (long countdown)
    const RELOC_DEPOT = { col: 15, row: 0 };
    const RELOC_MILL = { col: 15, row: 15 };
    const RELOC_MILL_MOVED = { col: 15, row: 3 };
    const FETCH = legTicks(CAMP_TILE, RELOC_DEPOT);
    const OUTBOUND = legTicks(RELOC_DEPOT, RELOC_MILL);
    const WALKED = OUTBOUND / 2;
    const HALFWAY = { col: (RELOC_DEPOT.col + RELOC_MILL.col) / 2, row: (RELOC_DEPOT.row + RELOC_MILL.row) / 2 };
    const RETARGETED = legTicks(HALFWAY, RELOC_MILL_MOVED);
    expect(new Set([FETCH, OUTBOUND, WALKED, RETARGETED]).size).toBe(4);

    const { world, buildings, haulers, step, stockpile } = await setup([
      { defId: 'storehouse', ...RELOC_DEPOT, stored: { wheat: 20 } },
      { defId: 'mill', ...RELOC_MILL, crew: 1 },
    ], 1, { systems: [CommandSystem, ProductionSystem, HaulSystem] });
    const [depot, mill] = buildings;
    const depotId = idOf(depot);
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    expect(colonyTotal(world, 'wheat')).toBe(20);

    await step(1 + FETCH); // dispatched, fetched: outbound from the depot
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', amount: 6, ticksLeft: OUTBOUND, legTicks: OUTBOUND });
    expect(stockpile.totalAt(depotId)).toBe(14); // out of the depot, in a pair of hands

    await step(WALKED); // half the walk done, half still to go
    expect(tripOf(haulers[0]).ticksLeft).toBe(WALKED);

    // Dispatched onto a building that was NOT relocating — this is exactly
    // what makes the recheck necessary rather than redundant with `needOf`.
    expect(mill.getComponent(Relocation)!.ticksLeft).toBe(0);
    enqueue(world, { type: 'moveBuilding', buildingId: idOf(mill), to: RELOC_MILL_MOVED });
    await step(1); // retargeted onto the new, near tile; relocation starts its long countdown THE SAME TICK
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', legTicks: RETARGETED, ticksLeft: RETARGETED - 1 });
    expect(mill.getComponent(Relocation)!.ticksLeft).toBe(11); // 12, minus this tick's decrement

    await step(RETARGETED - 2); // one tick short of arrival
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'outbound', ticksLeft: 1 });
    expect(mill.getComponent(Relocation)!.ticksLeft).toBe(10); // still a long way from 0

    await step(1); // arrival at the new tile — the tick under test
    // The building is still mid-relocation, providing no service: this is the
    // fact `unload` must recheck, not merely one that was true at dispatch.
    expect(mill.getComponent(Relocation)!.ticksLeft).toBe(9);
    // The load is an undelivered remainder, not a delivery: still in the
    // hauler's hands, and the mill's in-tray never grew to receive it.
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', kind: 'supply', resource: 'wheat', amount: 6, pickedUp: false });
    expect(inputOf(mill).total()).toBe(0);
    // Colony-wide, not the field just written: nothing was destroyed and
    // nothing was teleported to a site the hauler never walked to.
    expect(colonyTotal(world, 'wheat')).toBe(20);
    expect(stockpile.totalAt(depotId)).toBe(14); // still out of the ledger, still in transit home

    await step(legTicks(RELOC_MILL_MOVED, RELOC_DEPOT)); // and the remainder really does walk all the way home
    expect(tripOf(haulers[0]).phase).toBe('idle');
    expect(stockpile.totalAt(depotId)).toBe(20); // back where it came from
    expect(colonyTotal(world, 'wheat')).toBe(20);
    expect(systemErrors).toBe(0);
  });
});

/**
 * Determinism, across BOTH kinds. haul-system.test.ts covers collect on its
 * own, which was the whole of it in increment 4; supply adds two ranking terms
 * collect does not have — the whole hauler->source->building route, and the
 * site id — and both chains end at the building id precisely so entity
 * iteration order cannot reach the decision.
 *
 * What is compared is the claim-bearing half of `HaulTrip` and nothing else:
 * every field `claimsOf` reads (`resource` at :96, `amount` at :89/:93, plus
 * `targetId`/`sourceSiteId`/`destSiteId`/`plannedAmount`), because §2.6's
 * invariant is that a hauler's intent IS those fields — two runs that agree
 * on them hold identical claims by construction. `phase` and `ticksLeft` ride
 * along too: not claim-bearing themselves, but the surest sign the two runs
 * really did reach the same tick in the same state.
 */
const jobsOf = (fixture: Awaited<ReturnType<typeof setup>>) => fixture.haulers.map((hauler) => {
  const { kind, phase, targetId, sourceSiteId, destSiteId, resource, amount, plannedAmount, ticksLeft } = tripOf(hauler);
  return { kind, phase, targetId, sourceSiteId, destSiteId, resource, amount, plannedAmount, ticksLeft };
});

/** Every building id in the order this world's queries actually walk them. */
const buildingOrderOf = (world: IRuntimeWorld): number[] =>
  [...world.getEntities()].flatMap((entity) => entity.getComponent(Building)?.id ?? []);

describe('the same world decides the same way whichever order it is walked in', () => {
  // Two mills five tiles from the camp, two foresters ten: inside each pair
  // every ranking term ABOVE the id is equal — movable 6 and 6 over a route of
  // 5 and 5, backlog 9 and 9 at a distance of 10 and 10 — so the id tie-break
  // is the only thing left that can decide, and array order is the only other
  // candidate answer. The two pairs are ten tiles apart from each other so
  // neither can be mistaken for the other's.
  const MILL_LOW: Spec = { id: 21, defId: 'mill', col: 6, row: 3, crew: 1 };
  const MILL_HIGH: Spec = { id: 22, defId: 'mill', col: 2, row: 5, crew: 1 };
  const WOOD_LOW: Spec = { id: 31, defId: 'forester', col: 8, row: 8, buffer: { wood: 9 } };
  const WOOD_HIGH: Spec = { id: 32, defId: 'forester', col: 10, row: 6, buffer: { wood: 9 } };
  const distance = (a: TileRef, b: TileRef) => Math.hypot(a.col - b.col, a.row - b.row);

  it('dispatches both kinds identically, down to the id the tie-break ends at', async () => {
    // The ties are real ties, and the two pairs are not each other's.
    expect(distance(CAMP_TILE, MILL_LOW)).toBe(distance(CAMP_TILE, MILL_HIGH));
    expect(distance(CAMP_TILE, WOOD_LOW)).toBe(distance(CAMP_TILE, WOOD_HIGH));
    expect(distance(CAMP_TILE, MILL_LOW)).not.toBe(distance(CAMP_TILE, WOOD_LOW));

    // Exactly one carry of wheat at the camp, so the second hauler is left
    // without a supply job by the SOURCE claim and both orderings get exercised
    // in one tick — the input claim stays out of this case entirely.
    const specs: Spec[] = [MILL_LOW, MILL_HIGH, WOOD_LOW, WOOD_HIGH];
    const forward = await setup(specs, 2, { camp: { wheat: 6 } });
    const reversed = await setup([...specs].reverse(), 2, { camp: { wheat: 6 } });
    // Not the same run twice: the two worlds really are walked in opposite orders.
    expect(buildingOrderOf(forward.world)).not.toEqual(buildingOrderOf(reversed.world));

    await forward.step(1);
    await reversed.step(1);
    const jobs = jobsOf(forward);
    // Non-vacuous three ways: neither hauler idled, both kinds were dispatched,
    // and each decision landed on the lower id of its own tied pair.
    expect(jobs.map((job) => job.phase)).toEqual(['fetching', 'outbound']);
    expect(jobs.map((job) => job.kind)).toEqual(['supply', 'collect']);
    expect(jobs.map((job) => job.targetId)).toEqual([MILL_LOW.id, WOOD_LOW.id]);

    expect(jobsOf(reversed)).toEqual(jobs);
  });
});

/**
 * The claims a transfer holds, asserted on the lookups themselves rather than
 * through a dispatch. `describe('the transfer trip')` below dispatches them for
 * real; these four quantities are the whole of what a transfer candidate is
 * sized against, so they are also worth pinning where a fixture can state each
 * one alone, without a layout that makes every other quantity incidental.
 *
 * `heldAtOf` is exported on its own for the two cancellation paths outside
 * `HaulSystem`, so it is callable with nothing but trips and a stockpile.
 */
const A_DEPOT: StoreSite = { id: 71, col: 20, row: 10, capacity: BALANCE.storehouseCapacity };
const tripWith = (fields: Partial<HaulTrip>): HaulTrip => Object.assign(new HaulTrip(), fields);
const rowsOf = (trips: readonly HaulTrip[]) => trips.map((trip) => ({
  trip, job: new JobAssignment(null, true), home: new Home(null),
}));
const claimsFrom = (trips: readonly HaulTrip[], stockpile: Stockpile) =>
  claimsOf(rowsOf(trips), stockpile, () => BALANCE.haulCarryCapacity);

describe('the room a walking transfer reserves', () => {
  // Pairwise distinct so no assertion below can be satisfied by a field that
  // read a neighbour's value: what the depot physically holds, what one trip
  // plans to bring, and what a second trip is already carrying.
  const HELD = 30;
  const PLANNED = 6;
  const CARRIED = 4;

  const stocked = () => {
    const stockpile = new Stockpile({ wheat: 20 });
    stockpile.refundAt(A_DEPOT, 'planks', HELD);
    return stockpile;
  };

  it('a fetching transfer reserves destination room before it has picked anything up', () => {
    // The leg during which the reservation is the ONLY thing between two
    // haulers and the same headroom: `phase === 'returning'` alone counts
    // nothing here, because a fetching hauler carries nothing yet.
    const stockpile = stocked();
    const fetching = tripWith({
      kind: 'transfer', phase: 'fetching', destSiteId: A_DEPOT.id, resource: 'wheat',
      plannedAmount: PLANNED, amount: 0,
    });
    expect(stockpile.totalAt(A_DEPOT.id)).toBe(HELD); // physically unchanged, which is the point
    expect(heldAtOf(rowsOf([fetching]), stockpile)(A_DEPOT.id)).toBe(HELD + PLANNED);
  });

  it('a fetching SUPPLY reserves nothing at the camp its return leg defaults to', () => {
    // The kind gate, on its own. `beginTrip` sets `destSiteId` to
    // CAMP_SITE_ID for every trip and `turnForHome` resolves it for real only
    // on the return, so an ungated clause has every supply fetch in the colony
    // reserving camp room. Harmless — the camp is unbounded — and therefore
    // exactly the kind of wrong that survives to become load-bearing.
    const stockpile = stocked();
    const fetching = tripWith({
      kind: 'supply', phase: 'fetching', destSiteId: CAMP_SITE_ID, targetId: 9,
      resource: 'wheat', plannedAmount: PLANNED, amount: 0,
    });
    expect(heldAtOf(rowsOf([fetching]), stockpile)(CAMP_SITE_ID)).toBe(20);
  });

  it('the returning term is unchanged, and the two never double-count', () => {
    // `plannedAmount` is zeroed the moment `takeAt` returns a real figure and
    // `amount` is zero until then, so a transfer contributes ONE of the two at
    // any moment — never both, and never neither.
    const stockpile = stocked();
    const returning = tripWith({
      kind: 'transfer', phase: 'returning', destSiteId: A_DEPOT.id, resource: 'wheat',
      plannedAmount: 0, amount: CARRIED,
    });
    expect(heldAtOf(rowsOf([returning]), stockpile)(A_DEPOT.id)).toBe(HELD + CARRIED);
  });
});

describe('what a transfer claims of a site', () => {
  const OTHER_DEPOT: StoreSite = { id: 72, col: 4, row: 12, capacity: BALANCE.storehouseCapacity };

  it('inboundAt counts a transfer walking toward a site, per resource and per site', () => {
    const stockpile = new Stockpile({ wheat: 20 });
    const claims = claimsFrom([
      tripWith({ kind: 'transfer', phase: 'fetching', destSiteId: A_DEPOT.id, resource: 'wheat', plannedAmount: 6 }),
      tripWith({ kind: 'transfer', phase: 'returning', destSiteId: A_DEPOT.id, resource: 'wheat', amount: 4 }),
      // Same destination, a different resource: invisible to a per-resource
      // lookup, which is exactly why `heldAt` and not `inboundAt` is what
      // bounds a site's ROOM.
      tripWith({ kind: 'transfer', phase: 'fetching', destSiteId: A_DEPOT.id, resource: 'planks', plannedAmount: 5 }),
      // Same resource, a different destination.
      tripWith({ kind: 'transfer', phase: 'fetching', destSiteId: OTHER_DEPOT.id, resource: 'wheat', plannedAmount: 3 }),
      // A supply trip is not a transfer, whatever its destination says.
      tripWith({ kind: 'supply', phase: 'fetching', destSiteId: A_DEPOT.id, resource: 'wheat', plannedAmount: 2 }),
    ], stockpile);
    expect(claims.inboundAt(A_DEPOT.id, 'wheat')).toBe(10);
    expect(claims.inboundAt(A_DEPOT.id, 'planks')).toBe(5);
    expect(claims.inboundAt(OTHER_DEPOT.id, 'wheat')).toBe(3);
    expect(claims.inboundAt(A_DEPOT.id, 'bread')).toBe(0);
  });

  it('plannedOutAt counts every fetching trip out of a site, of every kind and resource', () => {
    // The resource-agnostic twin of `unclaimedAt`, and the pair is the point:
    // headroom is measured across every resource, so a per-resource claim
    // cannot bound it. Both lookups are read off the same fixture so the
    // difference is visible in one place.
    const stockpile = new Stockpile();
    stockpile.refundAt(A_DEPOT, 'wheat', 30);
    stockpile.refundAt(A_DEPOT, 'planks', 20);
    const claims = claimsFrom([
      tripWith({ kind: 'supply', phase: 'fetching', sourceSiteId: A_DEPOT.id, resource: 'wheat', plannedAmount: 6 }),
      tripWith({ kind: 'transfer', phase: 'fetching', sourceSiteId: A_DEPOT.id, resource: 'planks', plannedAmount: 5 }),
      // Already loaded and walking: its take is out of the ledger, not planned.
      tripWith({ kind: 'supply', phase: 'outbound', sourceSiteId: A_DEPOT.id, resource: 'wheat', amount: 4 }),
      tripWith({ kind: 'transfer', phase: 'fetching', sourceSiteId: OTHER_DEPOT.id, resource: 'wheat', plannedAmount: 3 }),
    ], stockpile);
    expect(claims.plannedOutAt(A_DEPOT.id)).toBe(11);
    expect(claims.plannedOutAt(OTHER_DEPOT.id)).toBe(3);
    expect(claims.plannedOutAt(CAMP_SITE_ID)).toBe(0);
    // The per-resource half sees one of the two and the site-wide half sees
    // both — the same traversal, asked two different questions.
    expect(claims.unclaimedAt(A_DEPOT.id, 'wheat')).toBe(24);
    expect(claims.unclaimedAt(A_DEPOT.id, 'planks')).toBe(15);
  });
});

/**
 * The transfer trip, end to end (§2.5, §2.6, §2.7). A transfer is the supply
 * trip MINUS its middle leg: `fetching` to a source site, then `returning` to a
 * destination site, `targetId` null throughout — so every case below is read
 * tick by tick, because the leg a transfer must NOT walk (`outbound`) is
 * invisible to a test that only looks at where the goods ended up.
 *
 * ONE layout serves most of them, and it is built so that nothing but a
 * transfer is ever dispatchable in it:
 *
 * - `STAGE_SOURCE` holds the stock and has no consumer near it, so it is pure
 *   surplus and never a supply source-of-last-resort by accident.
 * - `STAGE_DEST` is the site the mill beside it is NEAREST to, so the demand
 *   (§2.2) lands there and nowhere else.
 * - that mill's in-tray is FULL, which is what removes the supply candidate the
 *   same mill would otherwise produce — `needOf` refuses a building with no
 *   room — while leaving it a demand source, since `demandSourcesOf` filters on
 *   staffing and relocation only.
 * - nothing anywhere holds a finished good, so there is no collect candidate.
 *
 * `STAGE_NEIGHBOUR` holds nothing and is nearest to nobody, so it contributes
 * no demand and no surplus. It exists to be the answer to "where does a load
 * turned away from STAGE_DEST actually go" — an answer that must be neither the
 * camp (`destinationFor`'s everything-failed fallback) nor STAGE_SOURCE (which
 * would be the trip undoing itself).
 */
const STAGE_SOURCE = { col: 6, row: 3 };
const STAGE_DEST = DEPOT;
const STAGE_NEIGHBOUR = { col: 20, row: 11 };
/** The consumer whose appetite makes STAGE_DEST want anything at all. Its
 * in-tray is full in every fixture below. */
const STAGE_MILL = BESIDE_DEPOT;
/** A wheat producer STAGE_DEST is the nearest site to, so a load collected here
 * walks INTO the depot's deficit rather than home to the camp. */
const STAGE_FARM = { col: 22, row: 11 };
const FULL_TRAY = { wheat: BALANCE.inputBufferCap };

const stagingSpecs = (sourceStock: number, extra: readonly Spec[] = []): Spec[] => [
  { defId: 'storehouse', ...STAGE_SOURCE, stored: { wheat: sourceStock } },
  { defId: 'storehouse', ...STAGE_DEST },
  { defId: 'storehouse', ...STAGE_NEIGHBOUR },
  { defId: 'mill', ...STAGE_MILL, inputBuffer: FULL_TRAY, crew: 1 },
  ...extra,
];

/** Indices into `stagingSpecs`, named so a fixture that gains a building does
 * not silently renumber the assertions. */
const SOURCE_AT = 0;
const DEST_AT = 1;
const NEIGHBOUR_AT = 2;

describe('the transfer trip', () => {
  it('a transfer fetches from one site and banks at another', async () => {
    // Camp-sourced on purpose, so the first leg is `haulTicksBetween`'s
    // never-free one-tick minimum: a hauler cannot be dispatched AND loaded on
    // the same tick, whatever it is standing on.
    const CAMP_WHEAT = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...STAGE_DEST }, { defId: 'mill', ...STAGE_MILL, inputBuffer: FULL_TRAY, crew: 1 }],
      1, { camp: { wheat: CAMP_WHEAT } },
    );
    const destId = idOf(buildings[0]);
    const total = CAMP_WHEAT + BALANCE.inputBufferCap; // the mill's full tray counts too
    expect(colonyTotal(world, 'wheat')).toBe(total);
    // A transfer is the first trip in this engine with a NULL `targetId` for
    // its whole life, and sim-ecs swallows a throwing system into a
    // `SystemError` event rather than failing the step — so a lookup that
    // assumed a target would look like a hauler quietly doing nothing.
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1); // dispatched, and carrying NOTHING yet
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'fetching', staging: true, targetId: null, resource: 'wheat',
      sourceSiteId: CAMP_SITE_ID, destSiteId: destId, plannedAmount: BALANCE.haulCarryCapacity, amount: 0,
      legTicks: legTicks(CAMP_TILE, CAMP_TILE),
    });
    expect(legTicks(CAMP_TILE, CAMP_TILE)).toBe(1); // never free, even standing on the source
    expect(stockpile.getAt(destId, 'wheat')).toBe(0);

    await step(legTicks(CAMP_TILE, CAMP_TILE)); // source arrival: loaded, and RETURNING — never outbound
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'returning', targetId: null, resource: 'wheat',
      amount: BALANCE.haulCarryCapacity, plannedAmount: 0, destSiteId: destId,
      legTicks: legTicks(CAMP_TILE, STAGE_DEST), legToCol: STAGE_DEST.col, legToRow: STAGE_DEST.row,
    });
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(CAMP_WHEAT - BALANCE.haulCarryCapacity);
    expect(stockpile.getAt(destId, 'wheat')).toBe(0); // still in hand, not banked
    expect(colonyTotal(world, 'wheat')).toBe(total);

    await step(legTicks(CAMP_TILE, STAGE_DEST)); // deposit
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0, resource: null, staging: false });
    expect(stockpile.getAt(destId, 'wheat')).toBe(BALANCE.haulCarryCapacity); // the destination gained
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(CAMP_WHEAT - BALANCE.haulCarryCapacity); // the source did not regain
    expect(colonyTotal(world, 'wheat')).toBe(total);
    expect(systemErrors).toBe(0);
  });

  it('a drain transfer to the camp carries the class it was dispatched as', async () => {
    // The other half of `staging`, which nothing in the engine reads and §4.2's
    // instrument does: a depot with no consumer near it, filled past its free
    // floor, pushes to the camp. `staging: false` here is the truth about the
    // trip, not a default — a `beginTransfer` that hardcoded `true` would pass
    // every OTHER case in this file.
    const HELD = 55;
    const { buildings, haulers, step, stockpile } = await setup(
      [{ defId: 'storehouse', ...DEPOT, stored: { planks: HELD } }], 1,
    );
    const sourceId = idOf(buildings[0]);
    expect(BALANCE.storehouseCapacity - HELD).toBeLessThan(BALANCE.storehouseFreeFloor); // below its floor

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'fetching', staging: false, targetId: null, resource: 'planks',
      sourceSiteId: sourceId, destSiteId: CAMP_SITE_ID,
    });

    await step(legTicks(CAMP_TILE, DEPOT));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', staging: false, amount: BALANCE.haulCarryCapacity });

    await step(legTicks(DEPOT, CAMP_TILE));
    expect(stockpile.getAt(CAMP_SITE_ID, 'planks')).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.getAt(sourceId, 'planks')).toBe(HELD - BALANCE.haulCarryCapacity);
  });

  it('a transfer whose source emptied mid-walk cancels empty-handed', async () => {
    // `takeAt` returns 0: the stock this trip reserved was spent while it
    // walked. There is no building to carry on to — the one case with no
    // counterpart in the supply path, where a zero fetch continues to its
    // target and finishes as an ordinary collect run.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(stagingSpecs(SOURCE_STOCK), 1);
    const sourceId = idOf(buildings[SOURCE_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    expect(colonyTotal(world, 'wheat')).toBe(total);

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', sourceSiteId: sourceId });

    // Somebody else moved the lot while this hauler walked — conservingly, so
    // the colony total below measures the TRIP rather than the fixture.
    stockpile.takeAt(sourceId, 'wheat', SOURCE_STOCK);
    stockpile.refund('wheat', SOURCE_STOCK);
    expect(colonyTotal(world, 'wheat')).toBe(total);

    await step(legTicks(CAMP_TILE, STAGE_SOURCE));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0, resource: null, targetId: null });
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });

  it('a transfer whose destination vanished carries its load onward', async () => {
    // Demolished mid-return. NOT banked remotely and NOT walked back to its
    // source: nearest-with-room from where the hauler is standing, which is a
    // whole map away from STAGE_SOURCE and is not the camp either.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [CommandSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const destId = idOf(buildings[DEST_AT]);
    const neighbourId = idOf(buildings[NEIGHBOUR_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;

    await step(1 + legTicks(CAMP_TILE, STAGE_SOURCE));
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', destSiteId: destId, amount: BALANCE.haulCarryCapacity,
    });

    enqueue(world, { type: 'demolishBuilding', buildingId: destId });
    await step(1);
    expect(world.hasEntity(buildings[DEST_AT])).toBe(false); // it really did leave the world
    // The return leg is deliberately left running: the load is already out of
    // the ledger and the demolition did not move the hauler.
    expect(tripOf(haulers[0]).phase).toBe('returning');

    await step(legTicks(STAGE_SOURCE, STAGE_DEST) - 1); // arrival at a tile with nothing on it
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', amount: BALANCE.haulCarryCapacity, destSiteId: neighbourId,
      legToCol: STAGE_NEIGHBOUR.col, legToRow: STAGE_NEIGHBOUR.row, ticksLeft: legTicks(STAGE_DEST, STAGE_NEIGHBOUR),
    });
    // Onward, not backward: the source is live and has room, and is not where
    // this load is going.
    expect(tripOf(haulers[0]).destSiteId).not.toBe(sourceId);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0); // and nothing was teleported home
    expect(stockpile.getAt(neighbourId, 'wheat')).toBe(0);  // nor banked remotely

    await step(legTicks(STAGE_DEST, STAGE_NEIGHBOUR));
    expect(stockpile.getAt(neighbourId, 'wheat')).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK - BALANCE.haulCarryCapacity);
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });

  it('a transfer whose load fits its destination EXACTLY is banked, not turned away', async () => {
    // THE exact-fit boundary, and the only fixture that can see the
    // double-count. `heldAt` already counts this trip's own load, so a recheck
    // written `heldAt(dest) + trip.amount > capacity` reads 60 + 4 against a
    // capacity of 60 and turns a perfectly reserved arrival for home. The roomy
    // case passes either way and the overfilled one fails either way — only an
    // exact fit tells them apart.
    const LOAD = BALANCE.minTransferUnits;
    const PACKED = BALANCE.storehouseCapacity - LOAD;
    const { buildings, haulers, step, stockpile } = await setup(stagingSpecs(LOAD), 1);
    const destId = idOf(buildings[DEST_AT]);
    expect(LOAD).toBeLessThan(BALANCE.haulCarryCapacity); // the load is the SOURCE's size, not the hauler's

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', plannedAmount: LOAD });

    await step(legTicks(CAMP_TILE, STAGE_SOURCE));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', amount: LOAD, destSiteId: destId });

    // The destination fills behind the hauler's back to EXACTLY the room it
    // reserved — not one unit more, which is what makes this the boundary.
    stockpile.refundAt(siteOf(buildings[DEST_AT]), 'planks', PACKED);
    expect(stockpile.totalAt(destId) + LOAD).toBe(BALANCE.storehouseCapacity);

    await step(legTicks(STAGE_SOURCE, STAGE_DEST));
    expect(stockpile.getAt(destId, 'wheat')).toBe(LOAD);            // banked, not turned away
    expect(stockpile.totalAt(destId)).toBe(BALANCE.storehouseCapacity);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0 }); // and the trip ENDED here
  });

  it('a transfer whose destination filled below its reservation carries on', async () => {
    // Reserved room consumed by a path with no trip behind it — expected to be
    // unreachable in ordinary play (§2.7), so the fixture constructs the state
    // directly rather than pretending a demolition could produce it
    // (`handleDemolishBuilding` spills to the CAMP, never into a bounded site).
    //
    // The assertion a conservation sentinel cannot make: the colony total holds
    // whether the load is carried on or teleported to the camp, so what is
    // asserted is that the camp did NOT gain on the arrival tick.
    const LOAD = BALANCE.minTransferUnits;
    const OVERPACKED = BALANCE.storehouseCapacity - LOAD + 1;
    const { world, buildings, haulers, step, stockpile } = await setup(stagingSpecs(LOAD), 1);
    const destId = idOf(buildings[DEST_AT]);
    const neighbourId = idOf(buildings[NEIGHBOUR_AT]);

    await step(1 + legTicks(CAMP_TILE, STAGE_SOURCE));
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', amount: LOAD, destSiteId: destId });

    stockpile.refundAt(siteOf(buildings[DEST_AT]), 'planks', OVERPACKED);
    expect(stockpile.totalAt(destId) + LOAD).toBeGreaterThan(BALANCE.storehouseCapacity); // one unit past the fit
    expect(stockpile.totalAt(CAMP_SITE_ID)).toBe(0);

    await step(legTicks(STAGE_SOURCE, STAGE_DEST));
    // Walking a FRESH leg, not banked and not forwarded: the camp is untouched
    // and the depot took nothing.
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', amount: LOAD, destSiteId: neighbourId,
      legToCol: STAGE_NEIGHBOUR.col, legToRow: STAGE_NEIGHBOUR.row, ticksLeft: legTicks(STAGE_DEST, STAGE_NEIGHBOUR),
    });
    expect(stockpile.totalAt(CAMP_SITE_ID)).toBe(0);
    expect(stockpile.getAt(destId, 'wheat')).toBe(0);
    expect(stockpile.totalAt(destId)).toBe(OVERPACKED);

    await step(legTicks(STAGE_DEST, STAGE_NEIGHBOUR));
    expect(stockpile.getAt(neighbourId, 'wheat')).toBe(LOAD);
    expect(colonyTotal(world, 'wheat')).toBe(LOAD + BALANCE.inputBufferCap);
  });

  it('a transfer does not claim any building output buffer', async () => {
    // `targetId` null, so `claims.output` — which counts by target id — can
    // never see a transfer. This holds today by accident of the null, and
    // nothing else says so.
    const SOURCE_STOCK = BALANCE.haulCarryCapacity; // exactly one carry: no second transfer is possible
    const { buildings, haulers, step } = await setup(
      stagingSpecs(SOURCE_STOCK, [{ defId: 'forester', ...FORESTER }]), 2,
    );
    const forester = buildings[4];

    await step(1);
    const [mover, spare] = haulers;
    expect(tripOf(mover)).toMatchObject({ kind: 'transfer', phase: 'fetching', targetId: null });
    expect(tripOf(spare).phase).toBe('idle'); // nothing else to do — yet

    // A backlog appears while the transfer walks. The whole buffer must be
    // claimable: a transfer in flight speaks for none of it.
    bufferOf(forester).add('wood', BALANCE.haulCarryCapacity);
    await step(1);
    expect(tripOf(spare)).toMatchObject({ kind: 'collect', phase: 'outbound', targetId: idOf(forester) });
    expect(tripOf(mover).targetId).toBeNull();

    await step(legTicks(CAMP_TILE, FORESTER));
    expect(tripOf(spare).amount).toBe(BALANCE.haulCarryCapacity); // the FULL buffer, not a claimed-down share
    expect(bufferOf(forester).total()).toBe(0);
  });

  it('a stalled producer and a starving consumer both beat a transfer', async () => {
    // Acceptance criterion 9, and the whole rationale for the order: a transfer
    // moves goods nothing is waiting for, so it may only spend hauler-ticks
    // that would otherwise be idle.
    const SOURCE_STOCK = 30;
    const HUNGRY_MILL = { col: 3, row: 1 };
    const withSupply = stagingSpecs(SOURCE_STOCK, [
      { defId: 'forester', ...FORESTER, buffer: { wood: BALANCE.haulCarryCapacity } },
      { defId: 'mill', ...HUNGRY_MILL, inputBuffer: { wheat: 6 }, crew: 1 },
    ]);
    const withCollect = withSupply.slice(0, -1); // the same world, minus the consumer with room

    // Three jobs available and one hauler: it takes SUPPLY.
    const one = await setup(withSupply, 1);
    await one.step(1);
    expect(tripOf(one.haulers[0]).kind).toBe('supply');

    // ...and all three really were available, which is what stops the
    // assertion above passing because a transfer candidate never existed.
    const three = await setup(withSupply, 3);
    await three.step(1);
    expect(three.haulers.map((h) => tripOf(h).kind)).toEqual(['supply', 'collect', 'transfer']);

    // Two jobs available and one hauler: it takes COLLECT.
    const collecting = await setup(withCollect, 1);
    await collecting.step(1);
    expect(tripOf(collecting.haulers[0]).kind).toBe('collect');
    const pair = await setup(withCollect, 2);
    await pair.step(1);
    expect(pair.haulers.map((h) => tripOf(h).kind)).toEqual(['collect', 'transfer']);

    // Only with neither does it transfer.
    const alone = await setup(stagingSpecs(SOURCE_STOCK), 1);
    await alone.step(1);
    expect(tripOf(alone.haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', staging: true });
  });

  it('a COLLECT already walking wheat into the depot leaves nothing for a second hauler to stage', async () => {
    // `inboundAt` is a claim, so its fixture needs TWO haulers by construction:
    // one hauler cannot be both the load already in the air and the hauler
    // deciding whether to send another. The depot wants 12, holds 6, and a
    // collect is carrying the other 6 home to it — so its deficit is 0 and
    // there is nothing left to stage. A lookup that counts only `kind ===
    // 'transfer'` cannot see that load, reads the deficit as 6, sends a second
    // six-unit staging trip after it, and lands the depot at 18 against a
    // target of 12: a wasted round trip and source surplus spent for nothing.
    //
    // The two 6s are equal ON PURPOSE, and that equality is the subject rather
    // than a coincidence — the load in flight covers the shortfall EXACTLY,
    // which is what takes the deficit to zero instead of merely shrinking it.
    const DEPOT_STOCK = BALANCE.siteStagingTarget - BALANCE.haulCarryCapacity;
    const SOURCE_STOCK = 20; // distinct from both, and far more than one carry
    const withCollect: Spec[] = [
      { defId: 'storehouse', ...STAGE_SOURCE },
      { defId: 'storehouse', ...STAGE_DEST, stored: { wheat: DEPOT_STOCK } },
      { defId: 'mill', ...STAGE_MILL, inputBuffer: FULL_TRAY, crew: 1 },
      { defId: 'farm', ...STAGE_FARM, buffer: { wheat: BALANCE.haulCarryCapacity } },
    ];
    const { buildings, haulers, step, stockpile } = await setup(withCollect, 2);
    const destId = idOf(buildings[DEST_AT]);
    // The collected load really does walk to the DEPOT rather than to the camp,
    // which is the whole reason it belongs in the depot's inbound figure.
    expect(legTicks(STAGE_FARM, STAGE_DEST)).toBeLessThan(legTicks(STAGE_FARM, CAMP_TILE));

    await step(1);
    const [collector, spare] = haulers;
    expect(tripOf(collector)).toMatchObject({ kind: 'collect', phase: 'outbound', targetId: idOf(buildings[3]) });
    expect(tripOf(spare).phase).toBe('idle'); // no site holds a surplus to stage yet

    await step(legTicks(CAMP_TILE, STAGE_FARM));
    expect(tripOf(collector)).toMatchObject({
      kind: 'collect', phase: 'returning', resource: 'wheat',
      amount: BALANCE.haulCarryCapacity, destSiteId: destId,
    });

    // The surplus appears while that load is still in the air, so the second
    // hauler decides with a live collect walking into the deficit — the whole
    // point of the sequencing, since a load already BANKED is visible to
    // `unclaimedAt` and proves nothing about `inboundAt`.
    stockpile.refundAt(siteOf(buildings[SOURCE_AT]), 'wheat', SOURCE_STOCK);
    await step(1);
    expect(tripOf(collector).phase).toBe('returning'); // still walking: not yet banked anywhere
    expect(tripOf(spare).phase).toBe('idle');

    // ...and the same depot, the same 6-unit shortfall and the same surplus DO
    // produce a staging transfer once nothing is walking in. Without this the
    // reading above would pass just as well for a fixture in which no transfer
    // was ever constructible.
    const control = await setup([
      { ...withCollect[SOURCE_AT], stored: { wheat: SOURCE_STOCK } }, withCollect[DEST_AT], withCollect[2],
    ], 1);
    await control.step(1);
    expect(tripOf(control.haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'fetching', staging: true, resource: 'wheat',
      sourceSiteId: idOf(control.buildings[SOURCE_AT]), destSiteId: idOf(control.buildings[DEST_AT]),
      plannedAmount: BALANCE.haulCarryCapacity,
    });
  });
});

/**
 * A TRANSFER IS NOT A DELIVERY, AND IT CONSUMES NOTHING (§2.8).
 *
 * Both facts hold by construction rather than by a branch written for them: a
 * transfer's load never came out of a building's output buffer, so `pickedUp`
 * is false for its whole life and `bankLoad` routes it to `refundAt`; and
 * `recordConsumed` fires only from `unload`, a leg a transfer never walks.
 * Correctness that holds by construction is the kind that rots silently, which
 * is the whole reason these two cases exist.
 *
 * EACH CASE RUNS THE SAME FIXTURE TWICE, and the second run is what makes the
 * first one mean anything. "The transfer did not move Delivered/t" passes just
 * as well with `addAt` deleted outright — the exact failure increment 5 shipped
 * and increment 7 caught — so each case pairs it with a run in which the SAME
 * amount of the SAME resource reaches the SAME site by the path that IS a
 * delivery (or, for consumption, by the path that IS a consumption). Only the
 * pair can tell "transfers are excluded" from "nothing moves the column".
 *
 * ONE LAYOUT SERVES ALL FOUR RUNS, and the runs differ only in where the wheat
 * starts and whether the mill has room for any:
 *
 * - wheat standing in STAGE_SOURCE's ledger and a FULL mill tray -> the only
 *   wheat job in the world is a transfer (a full tray is what `needOf` refuses,
 *   while `demandSourcesOf` still counts the mill, so the demand survives).
 * - wheat standing in STAGE_FARM's output buffer -> a collect, which banks at
 *   STAGE_DEST because that is the nearest site to the farm.
 * - wheat in the ledger and an EMPTY mill tray -> a supply, which unloads into
 *   the tray and records the consumption.
 *
 * THE FORESTER IS IN EVERY RUN, and it is what stops the zero assertions being
 * vacuous from the inside: it puts `FLOW_WOOD` units through `addAt` in each of
 * the four runs, so a run reading `deliveredRate === 0` for wheat is reading it
 * in a world where the delivery column is demonstrably alive. Its 3 is
 * deliberately not the wheat load's 4, so the wheat column cannot pass by
 * reading the wood column either — and in a supply run the wheat row carries a
 * non-zero `consumptionRate` against a zero `deliveredRate`, which is the pair
 * that stops the two columns being swapped for each other.
 */
const FLOW_LOAD = BALANCE.minTransferUnits;
/** The forester's backlog: distinct from FLOW_LOAD on purpose, so no column
 * here can read a neighbouring resource's value and still pass. */
const FLOW_WOOD = 3;
/**
 * Ticks per run — the same number for every run, so `deliveredRate` and
 * `consumptionRate` (a `BALANCE.statsWindowTicks`-wide mean) share one divisor
 * across the pair and the two runs really are comparable. Comfortably past the
 * longest trip any run walks (the farm collect, at 1 + 12 + 2) and comfortably
 * inside the stats window, so no frame has yet been shifted off the back.
 */
const FLOW_RUN = 24;
const FLOW_SYSTEMS = [HaulSystem, StatsSystem, SnapshotSystem];
/** Indices into `flowSpecs`, named for the same reason `SOURCE_AT` is. */
const FLOW_SOURCE_AT = 0;
const FLOW_DEST_AT = 1;
const FLOW_MILL_AT = 2;

interface FlowFixture {
  /** Wheat standing in STAGE_SOURCE's ledger — the transfer and supply runs. */
  depotWheat?: number;
  /** Wheat waiting in STAGE_FARM's out-tray — the collect run. */
  farmWheat?: number;
  /** The mill's in-tray. Full removes the supply candidate and leaves the
   * transfer; empty is what lets a supply run at all. */
  millTray?: number;
}

function flowSpecs({ depotWheat = 0, farmWheat = 0, millTray = BALANCE.inputBufferCap }: FlowFixture): Spec[] {
  return [
    { defId: 'storehouse', ...STAGE_SOURCE, stored: { wheat: depotWheat } },
    { defId: 'storehouse', ...STAGE_DEST },
    { defId: 'mill', ...STAGE_MILL, inputBuffer: { wheat: millTray }, crew: 1 },
    { defId: 'farm', ...STAGE_FARM, buffer: { wheat: farmWheat } },
    { defId: 'forester', ...FORESTER, buffer: { wood: FLOW_WOOD } },
  ];
}

/** The three flow columns for one resource, exactly as the Economy view reads
 * them off the published snapshot — not off `Stockpile`'s per-tick maps, which
 * `StatsSystem` has already cleared by the time a test could look. */
function flowsOf(world: IRuntimeWorld, id: ResourceId) {
  const { deliveredRate, consumptionRate, madeRate } = world.getResource(SnapshotStore).latest!.stockpile[id];
  return { deliveredRate, consumptionRate, madeRate };
}

describe('what a transfer does to the flow ledger', () => {
  it('a transfer does not move Delivered/t, and a collect of the same size does', async () => {
    // Run one: FLOW_LOAD units of wheat reach STAGE_DEST carried by a TRANSFER.
    const moved = await setup(flowSpecs({ depotWheat: FLOW_LOAD }), 2, { systems: FLOW_SYSTEMS });
    const movedDest = idOf(moved.buildings[FLOW_DEST_AT]);
    await moved.step(1);
    // The fixture's premise, stated rather than assumed: the wheat job really
    // is a transfer, and the wood job beside it really is a delivery.
    expect(moved.haulers.map((h) => tripOf(h).kind).sort()).toEqual(['collect', 'transfer']);

    await moved.step(FLOW_RUN - 1);
    // The goods DID arrive — so the zero below is "banked without being
    // counted", not "nothing happened".
    expect(moved.stockpile.getAt(movedDest, 'wheat')).toBe(FLOW_LOAD);
    expect(flowsOf(moved.world, 'wheat')).toEqual({ deliveredRate: 0, consumptionRate: 0, madeRate: 0 });
    // ...and `addAt` is demonstrably alive IN THIS RUN, at a rate the wheat row
    // cannot have read: 3 units against wheat's 4.
    expect(flowsOf(moved.world, 'wood').deliveredRate).toBeCloseTo(FLOW_WOOD / FLOW_RUN);
    expect(FLOW_WOOD).not.toBe(FLOW_LOAD);

    // Run two: the same layout, the same FLOW_LOAD units of wheat, the same
    // destination site and the same number of ticks — but out of an output
    // buffer, which is what makes it a delivery.
    const collected = await setup(flowSpecs({ farmWheat: FLOW_LOAD }), 2, { systems: FLOW_SYSTEMS });
    const collectedDest = idOf(collected.buildings[FLOW_DEST_AT]);
    await collected.step(1);
    expect(collected.haulers.map((h) => tripOf(h).kind)).toEqual(['collect', 'collect']);

    await collected.step(FLOW_RUN - 1);
    expect(collected.stockpile.getAt(collectedDest, 'wheat')).toBe(FLOW_LOAD); // same site, same amount
    expect(flowsOf(collected.world, 'wheat').deliveredRate).toBeCloseTo(FLOW_LOAD / FLOW_RUN);
    // And the OTHER two columns did not move with it, so the assertion above
    // cannot be satisfied by a Delivered column wired to either neighbour.
    expect(flowsOf(collected.world, 'wheat')).toMatchObject({ consumptionRate: 0, madeRate: 0 });
    expect(flowsOf(collected.world, 'wood').deliveredRate).toBeCloseTo(FLOW_WOOD / FLOW_RUN);
  });

  it('a transfer records no consumption', async () => {
    // `recordConsumed` fires only from `unload`, and a transfer never reaches
    // it — there is no `outbound` leg and no building to unload into.
    const moved = await setup(flowSpecs({ depotWheat: FLOW_LOAD }), 2, { systems: FLOW_SYSTEMS });
    const movedDest = idOf(moved.buildings[FLOW_DEST_AT]);
    await moved.step(1);
    expect(moved.haulers.map((h) => tripOf(h).kind).sort()).toEqual(['collect', 'transfer']);

    await moved.step(FLOW_RUN - 1);
    expect(moved.stockpile.getAt(movedDest, 'wheat')).toBe(FLOW_LOAD); // the trip completed
    expect(flowsOf(moved.world, 'wheat').consumptionRate).toBe(0);

    // The same layout with the mill's tray EMPTY: the same FLOW_LOAD units come
    // out of the same depot on the same tick, and this time a consuming path
    // DOES fire — which is what makes the zero above a discrimination rather
    // than a fixture in which nothing could ever have been consumed.
    const supplied = await setup(flowSpecs({ depotWheat: FLOW_LOAD, millTray: 0 }), 2, { systems: FLOW_SYSTEMS });
    await supplied.step(1);
    expect(supplied.haulers.map((h) => tripOf(h).kind).sort()).toEqual(['collect', 'supply']);

    await supplied.step(FLOW_RUN - 1);
    expect(inputOf(supplied.buildings[FLOW_MILL_AT]).amounts.get('wheat')).toBe(FLOW_LOAD);
    expect(flowsOf(supplied.world, 'wheat').consumptionRate).toBeCloseTo(FLOW_LOAD / FLOW_RUN);
    // The mirror of the delivery case: here the wheat row carries consumption
    // and NO delivery, so neither column can be reading the other.
    expect(flowsOf(supplied.world, 'wheat')).toMatchObject({ deliveredRate: 0, madeRate: 0 });
    expect(flowsOf(supplied.world, 'wood').deliveredRate).toBeCloseTo(FLOW_WOOD / FLOW_RUN);
    // Nothing was banked at the destination either — the load went INTO the
    // building, which is exactly what a transfer's never does.
    expect(supplied.stockpile.getAt(idOf(supplied.buildings[FLOW_SOURCE_AT]), 'wheat')).toBe(0);
  });
});

/**
 * EVERY PATH THAT ENDS A TRANSFER MUST PUT ITS LOAD SOMEWHERE (§2.7, §2.9).
 *
 * The cancellation paths were all written against `HaulTrip`, before there was
 * a kind to write them against, so a transfer is expected to pass through them
 * unchanged. That is the claim these cases TEST rather than assume: this
 * increment has already fixed a dispatch/arrival rule three times, and each
 * time it was a path that obviously already worked.
 *
 * Every case asserts the COLONY TOTAL, which is what a player would notice
 * being violated and what no single handler can satisfy by agreeing with
 * itself. But conservation is necessary and not sufficient, and that is the
 * trap here — a load teleported to the camp preserves the total exactly. So
 * wherever the subject is that goods were CARRIED rather than moved by ledger
 * adjustment, the camp's own holding is asserted not to have grown on the
 * arrival tick and the hauler is asserted to be walking a fresh leg. A case
 * that read only the total would stay green against precisely the bug it
 * exists to prevent.
 *
 * They live here, beside `describe('the transfer trip')`, for the reason that
 * describe block does: a transfer needs a bounded site and a real consumer's
 * demand before it can be DISPATCHED at all, and only this file's layout has
 * both. A hand-assembled `HaulTrip` would test the handler against a trip
 * shape no dispatch can produce.
 */
describe('a transfer interrupted', () => {
  it('is left alone by a demolition it has nothing to do with', async () => {
    // `handleDemolishBuilding` walks trips by `targetId`, and a transfer's is
    // NULL for its whole life — so no building id can ever match it and the
    // fetching clause is a permanent near-miss. Correct, and untested until
    // now: the forester demolished here is neither this trip's source nor its
    // destination, holds nothing, and is not a store site at all.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK, [{ defId: 'forester', ...FORESTER }]), 1,
      { systems: [CommandSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const destId = idOf(buildings[DEST_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    const toSource = legTicks(CAMP_TILE, STAGE_SOURCE);

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', targetId: null, destSiteId: destId });

    enqueue(world, { type: 'demolishBuilding', buildingId: idOf(buildings[4]) });
    await step(1);
    expect(world.hasEntity(buildings[4])).toBe(false); // it really did leave the world
    // The WHOLE leg, not merely the phase: a trip cancelled here would be
    // re-dispatched by the same tick's HaulSystem run and land back on
    // `fetching` from wherever it had walked to, which the phase alone cannot
    // tell from never having been interrupted.
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'fetching', targetId: null, sourceSiteId: sourceId, destSiteId: destId,
      plannedAmount: BALANCE.haulCarryCapacity, amount: 0,
      ticksLeft: toSource - 1, legTicks: toSource, legFromCol: CAMP_TILE.col, legFromRow: CAMP_TILE.row,
    });

    // ...and it finishes the job it was dispatched on.
    await step(toSource - 1 + legTicks(STAGE_SOURCE, STAGE_DEST));
    expect(stockpile.getAt(destId, 'wheat')).toBe(BALANCE.haulCarryCapacity);
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });

  it('loses nothing when its SOURCE depot is demolished mid-fetch', async () => {
    // Two rules meeting on one tick: `spillTo` sends the depot's contents to
    // the camp, and the `fetching && sourceSiteId` clause ends the trip that
    // was reserving stock there. Nothing has been picked up, so the
    // cancellation disposes of nothing — and the hauler, now idle, is free to
    // be re-dispatched against the stock's new home the very same tick.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [CommandSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', sourceSiteId: sourceId });

    enqueue(world, { type: 'demolishBuilding', buildingId: sourceId });
    await step(1);
    expect(world.hasEntity(buildings[SOURCE_AT])).toBe(false);
    // Banked wealth moves rather than dying with the building, so the colony
    // total is untouched — the assertion the depot's own figure cannot make.
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(SOURCE_STOCK);
    expect(colonyTotal(world, 'wheat')).toBe(total);
    // The trip no longer reserves a thing at a building that is gone. Read as
    // the SOURCE it now names, not as `idle`: the cancellation and the
    // re-dispatch happen in one tick, so `idle` is never observable here.
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'fetching', sourceSiteId: CAMP_SITE_ID, amount: 0,
      plannedAmount: BALANCE.haulCarryCapacity,
    });
  });

  it('carries its load onward when its DESTINATION is demolished mid-fetch', async () => {
    // The one demolition case NO cancellation clause matches: the trip is
    // `fetching`, its `sourceSiteId` names a live depot, and its `targetId` is
    // null — so it walks on, takes its load, and only then finds nothing left
    // to reserve. `transferOnward`'s `dest === undefined` fallback, which is
    // reachable from exactly here.
    //
    // Where the load then goes is not a free choice: `destinationFor` measures
    // from where the hauler STANDS, which is the source it has just drawn from,
    // and a site always has room for what was taken out of it a moment ago. So
    // the honest answer is "put it back", and the point of the case is that the
    // hauler CARRIES it there — a fresh leg, the goods out of the ledger
    // meanwhile, and nothing appearing at the camp.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [CommandSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const destId = idOf(buildings[DEST_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    const toSource = legTicks(CAMP_TILE, STAGE_SOURCE);
    // A transfer's `targetId` is null, so a lookup that assumed a target
    // throws — and sim-ecs swallows a throwing system into a `SystemError`
    // rather than failing the step, which would read as a hauler quietly
    // doing nothing.
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ kind: 'transfer', phase: 'fetching', destSiteId: destId });

    enqueue(world, { type: 'demolishBuilding', buildingId: destId });
    await step(1);
    expect(world.hasEntity(buildings[DEST_AT])).toBe(false);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'fetching', destSiteId: destId, ticksLeft: toSource - 1 });

    await step(toSource - 1); // source arrival, with no destination left to honour
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'returning', amount: BALANCE.haulCarryCapacity, plannedAmount: 0,
      destSiteId: sourceId, legToCol: STAGE_SOURCE.col, legToRow: STAGE_SOURCE.row,
    });
    // Carried, not written back: the load really is out of the ledger and in a
    // pair of hands, and the camp — the destination a teleport would pick —
    // gained nothing.
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK - BALANCE.haulCarryCapacity);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);
    expect(colonyTotal(world, 'wheat')).toBe(total);

    await step(1);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0, resource: null });
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);
    expect(colonyTotal(world, 'wheat')).toBe(total);
    expect(systemErrors).toBe(0);
  });

  it('does not deposit into a destination that is in transit', async () => {
    // `storeSitesOf` already drops a relocating storehouse, so `depositArrival`
    // finds no destination and turns the load for a site that still exists.
    //
    // THE DEPOT IS MOVED AWAY AND STRAIGHT BACK, and the round trip is the
    // whole fixture. A one-way move changes the depot's TILE, and
    // `depositArrival` compares tiles as well — so the case would pass just as
    // well with the relocation rule deleted. Moved back, the tile matches the
    // one this leg was aimed at and `relocating` is the ONLY thing standing
    // between this load and a building being carried across the map.
    const SOURCE_STOCK = 30;
    const PARKED = { col: STAGE_DEST.col, row: STAGE_DEST.row + 4 };
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [CommandSystem, HaulSystem] },
    );
    const destId = idOf(buildings[DEST_AT]);
    const neighbourId = idOf(buildings[NEIGHBOUR_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    const home = legTicks(STAGE_SOURCE, STAGE_DEST);

    await step(1 + legTicks(CAMP_TILE, STAGE_SOURCE));
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', destSiteId: destId, amount: BALANCE.haulCarryCapacity,
      legToCol: STAGE_DEST.col, legToRow: STAGE_DEST.row,
    });

    await step(home - 2);
    enqueue(
      world,
      { type: 'moveBuilding', buildingId: destId, to: PARKED },
      { type: 'moveBuilding', buildingId: destId, to: STAGE_DEST },
    );
    await step(1);
    // The fixture's whole premise, stated rather than assumed: same tile, still
    // in transit. No ProductionSystem here, so the countdown never runs down.
    expect(buildings[DEST_AT].getComponent(Position)).toMatchObject(STAGE_DEST);
    expect(buildings[DEST_AT].getComponent(Relocation)!.ticksLeft).toBeGreaterThan(0);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'returning', ticksLeft: 1, destSiteId: destId });

    await step(1); // arrival at a tile whose depot is not a site
    expect(stockpile.getAt(destId, 'wheat')).toBe(0);          // nothing went into a building mid-move
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);    // and nothing was teleported home
    expect(tripOf(haulers[0])).toMatchObject({
      phase: 'returning', amount: BALANCE.haulCarryCapacity, destSiteId: neighbourId,
      legToCol: STAGE_NEIGHBOUR.col, legToRow: STAGE_NEIGHBOUR.row, ticksLeft: legTicks(STAGE_DEST, STAGE_NEIGHBOUR),
    });
    expect(colonyTotal(world, 'wheat')).toBe(total);

    await step(legTicks(STAGE_DEST, STAGE_NEIGHBOUR));
    expect(stockpile.getAt(neighbourId, 'wheat')).toBe(BALANCE.haulCarryCapacity);
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });

  it('banks its load at a resolved site when its hauler is unassigned', async () => {
    // `bankCarriedLoad`, the legitimate forward-without-a-walk: this colonist
    // has stopped being a hauler, so nobody is left to carry anything. The load
    // goes to the site nearest WHERE THE WALK ACTUALLY GOT TO, which two ticks
    // into the return leg is still the source it came from — and neither the
    // camp (the reflex answer) nor the destination it was reserved for.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [CommandSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const destId = idOf(buildings[DEST_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    const home = legTicks(STAGE_SOURCE, STAGE_DEST);

    await step(1 + legTicks(CAMP_TILE, STAGE_SOURCE) + 2); // two ticks of the return leg walked
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'returning', amount: BALANCE.haulCarryCapacity, destSiteId: destId,
      ticksLeft: home - 2,
    });
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK - BALANCE.haulCarryCapacity);

    enqueue(world, { type: 'unassignHauler' });
    await step(1);
    expect(haulers[0].getComponent(JobAssignment)!.hauling).toBe(false);
    expect(tripOf(haulers[0])).toMatchObject({ phase: 'idle', amount: 0, resource: null });
    // Where it stopped, interpolated — a quarter of the way along a leg from
    // (6,3) to (20,10), which is neither endpoint and not a whole tile.
    expect(tripOf(haulers[0])).toMatchObject({ atCol: 9.5, atRow: 4.75 });
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK); // banked at the nearest site with room
    expect(stockpile.getAt(destId, 'wheat')).toBe(0);              // not at the destination it had reserved
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);        // and not at the camp by reflex
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });

  it("banks its load at a resolved site when its hauler dies", async () => {
    // `standDown`, the fourth cancellation path §2.7 names and the one in
    // another system entirely. Killed LATE in the return leg, where the nearest
    // site with room is no longer the source — which is what pins
    // `remainderHome` staying shut for a transfer. A supply remainder walks
    // home because nothing asked for it where it stands; a transfer's load was
    // asked for, and sending it back would undo the trip.
    const SOURCE_STOCK = 30;
    const { world, buildings, haulers, step, stockpile } = await setup(
      stagingSpecs(SOURCE_STOCK), 1, { systems: [PopulationSystem, HaulSystem] },
    );
    const sourceId = idOf(buildings[SOURCE_AT]);
    const destId = idOf(buildings[DEST_AT]);
    const total = SOURCE_STOCK + BALANCE.inputBufferCap;
    const home = legTicks(STAGE_SOURCE, STAGE_DEST);

    await step(1 + legTicks(CAMP_TILE, STAGE_SOURCE) + (home - 2)); // two ticks short of the depot
    expect(tripOf(haulers[0])).toMatchObject({
      kind: 'transfer', phase: 'returning', amount: BALANCE.haulCarryCapacity, destSiteId: destId, ticksLeft: 2,
    });

    // One tick short of this colonist's own lifespan: the next `ageEveryone`
    // takes them over it and `resolveOldAge` fires on that same tick, ahead of
    // HaulSystem — so `standDown` is the ONLY route the load has to a site.
    const colonistId = haulers[0].getComponent(Colonist)!.id;
    haulers[0].getComponent(Age)!.ticks = lifespanFor(colonistId, BALANCE.lifeBands) - 1;
    await step(1);
    expect(world.hasEntity(haulers[0])).toBe(false); // dead, and off the world
    expect(stockpile.getAt(destId, 'wheat')).toBe(BALANCE.haulCarryCapacity); // nearest with room
    expect(stockpile.getAt(sourceId, 'wheat')).toBe(SOURCE_STOCK - BALANCE.haulCarryCapacity); // NOT sent home
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);
    expect(colonyTotal(world, 'wheat')).toBe(total);
  });
});
