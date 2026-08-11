import { describe, expect, it } from 'vitest';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import { CAMP_SITE_ID, CAMP_TILE, type StoreSite } from '../../../src/shared/haul';
import type { TileRef } from '../../../src/shared/placement';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { RESOURCE_IDS } from '../../../src/engine/content/resources';
import {
  Building, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation,
} from '../../../src/engine/components';
import { Stockpile } from '../../../src/engine/resources';
import type { DispatchInputs, HaulBuildingRow, StaffedSet } from '../../../src/engine/systems/haul-dispatch';
import { claimsOf } from '../../../src/engine/systems/haul-claims';
import { chooseJob } from '../../../src/engine/systems/haul-dispatch';
import { bankLoad, destinationFor } from '../../../src/engine/systems/haul-sites';
import { haulerCapacity } from '../../../src/engine/systems/haul-system';
import {
  compareTransferCandidates, drainCandidates, nextTransferTarget, siteDemandFrom, stagingCandidates,
  type TransferCandidate,
} from '../../../src/engine/systems/haul-transfer';

/**
 * Transfer candidates, built and ranked. Nothing DISPATCHES a transfer yet —
 * `chooseJob` gains its third offer in the next task — so these fixtures do by
 * hand the one thing that task will do: freeze a winning candidate onto a
 * fetching trip, and ask for the next candidate with that trip's claims live.
 *
 * That hand-dispatch is not a convenience. Every quantity a `movable` formula
 * is built from has to be reservation-aware (spec §2.4), and the only fixture
 * that can tell a reservation-aware term from a physical one is a fixture with
 * MORE HAULERS THAN ONE: physical stock does not move until a hauler arrives,
 * several legs later, so a first dispatch reads identically either way. Every
 * case below that names a bound therefore dispatches at least twice, and the
 * assertion that carries it is the SECOND hauler's.
 */

const CAMP: StoreSite = { id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null };
const CAPACITY = BALANCE.haulCarryCapacity;

/** Two depots far enough apart, and from the camp, that "nearest site" is
 * never a close-run thing: every consumer tile below sits one tile from the
 * depot it belongs to and a map away from everything else. */
const A_TILE = { col: 20, row: 10 };
const B_TILE = { col: 4, row: 14 };
const NEAR_A = { col: 21, row: 10 };
const ALSO_NEAR_A = { col: 20, row: 11 };
/** Two more tiles around depot A, for the one fixture that needs FOUR staffed
 * consumers nearest a single site. */
const THIRD_NEAR_A = { col: 19, row: 10 };
const FOURTH_NEAR_A = { col: 20, row: 9 };
const NEAR_B = { col: 5, row: 14 };
const ALSO_NEAR_B = { col: 4, row: 15 };
/** A third depot, nearest to nothing and used only where a case needs a
 * second supplier that is not the camp. */
const C_TILE = { col: 10, row: 2 };
const A_ID = 71;
const B_ID = 72;
const C_ID = 73;
const A: StoreSite = { id: A_ID, ...A_TILE, capacity: BALANCE.storehouseCapacity };
const B: StoreSite = { id: B_ID, ...B_TILE, capacity: BALANCE.storehouseCapacity };
const C: StoreSite = { id: C_ID, ...C_TILE, capacity: BALANCE.storehouseCapacity };

let nextBuildingId = 100;

/** A staffed, non-relocating consumer — the only kind of building a site's
 * demand is derived from. `crew` is expressed by membership of the staffed
 * set, exactly as `supplyCandidates` reads it. */
function consumer(defId: BuildingDefId, at: TileRef): HaulBuildingRow {
  return {
    building: new Building(nextBuildingId++, defId),
    position: new Position(at.col, at.row),
    buffer: new OutputBuffer(),
    input: new InputBuffer(),
    relocation: new Relocation(0),
    production: new Production(),
  };
}

type Stocked = readonly (readonly [StoreSite, Partial<Record<ResourceId, number>>])[];

/** The trip Task 6 will begin: a transfer that has reserved its source stock,
 * its destination room and its share of the destination's deficit, and has not
 * walked a tile yet. */
function begunTransfer(candidate: TransferCandidate): HaulTrip {
  const trip = new HaulTrip();
  trip.kind = 'transfer';
  trip.phase = 'fetching';
  trip.targetId = null;
  trip.resource = candidate.resource;
  trip.plannedAmount = candidate.movable;
  trip.sourceSiteId = candidate.sourceSiteId;
  trip.destSiteId = candidate.destSiteId;
  trip.staging = candidate.staging;
  return trip;
}

/** A hauler on its last leg into depot A, holding a load the depot has already
 * reserved room for: the one kind of inbound claim occupancy counts, because
 * the goods are in a hand rather than in a plan. */
function carryingToA(resource: ResourceId, amount: number): HaulTrip {
  const trip = new HaulTrip();
  trip.kind = 'transfer';
  trip.destSiteId = A_ID;
  trip.resource = resource;
  trip.amount = amount;
  // The LEG, not the phase alone, and through `startLeg` for the reason
  // `handleMoveBuilding` uses it: `inHandAt` counts a load in hands only while
  // the site still stands where the leg is aimed (`arrivesAt`), so a returning
  // trip with no leg on it is aimed at tile (0, 0) and counts nowhere.
  trip.startLeg('returning', NEAR_A, A_TILE, BALANCE.haulTilesPerTick);
  return trip;
}

function colonyOf(sites: readonly StoreSite[], buildings: readonly HaulBuildingRow[], stock: Stocked = []) {
  const stockpile = new Stockpile();
  for (const [site, contents] of stock) {
    for (const [id, amount] of Object.entries(contents)) stockpile.refundAt(site, id as ResourceId, amount);
  }
  const trips: HaulTrip[] = [];
  const staffed: StaffedSet = new Set(buildings.map((row) => row.building.id));
  const claims = () => claimsOf(
    trips.map((trip) => ({ trip, job: new JobAssignment(null, true), home: new Home(null) })),
    stockpile,
    new Map(sites.map((site) => [site.id, site])),
    () => CAPACITY,
  );
  const demand = () => siteDemandFrom(sites, buildings, staffed);
  /** Both classes, staging first — the single list `chooseJob` used to rank in
   * one comparison, kept whole here because the RANKING is still one order
   * (§2.6) even though dispatch now offers the two classes on opposite sides
   * of collect. A test that asked only for the half it expected could not see
   * a candidate leaking into the wrong class. */
  const candidates = () => [
    ...stagingCandidates(sites, claims(), demand(), CAPACITY),
    ...drainCandidates(sites, claims(), demand(), CAPACITY),
  ];
  const inputs = (): DispatchInputs => ({ buildings, sites, staffed, claims: claims(), demand: demand() });
  /** One idle hauler, dispatched from wherever it stands: the winner is frozen
   * onto a trip, so the next call sees the claims it left behind. */
  const dispatch = (from: TileRef = CAMP_TILE): TransferCandidate | null => {
    const won = nextTransferTarget(candidates(), from);
    if (won !== null) trips.push(begunTransfer(won));
    return won;
  };
  return { sites, buildings, stockpile, trips, staffed, claims, demand, candidates, inputs, dispatch };
}

const movablesOf = (candidates: readonly TransferCandidate[]) => candidates.map((c) => c.movable);

describe('staging: a site pulls what the buildings around it eat', () => {
  it('a depot short of what its nearby mill eats pulls stock from the camp', () => {
    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 30 }]]);
    expect(colony.candidates()).toEqual([{
      sourceSiteId: CAMP_SITE_ID, sourceCol: CAMP_TILE.col, sourceRow: CAMP_TILE.row,
      destSiteId: A_ID, destCol: A_TILE.col, destRow: A_TILE.row,
      resource: 'wheat', movable: CAPACITY, staging: true,
    }]);
  });

  it('a site is never both source and sink for one resource', () => {
    // The termination property of §2.2, asserted directly rather than
    // inferred: deficit and surplus come from ONE comparison of a site's
    // claimed-net holding against its demand, so at most one of them is
    // positive. A depot holding above its own target and a depot holding
    // nothing, both with a mill beside them, and a camp with stock to spare.
    const colony = colonyOf(
      [CAMP, A, B],
      [consumer('mill', NEAR_A), consumer('mill', NEAR_B)],
      [[CAMP, { wheat: 30 }], [A, { wheat: 20 }]],
    );
    const candidates = colony.candidates();
    expect(candidates.length).toBeGreaterThan(1); // non-vacuous: there is something to be wrong about
    for (const resource of RESOURCE_IDS) {
      const forResource = candidates.filter((c) => c.resource === resource);
      const sources = new Set(forResource.map((c) => c.sourceSiteId));
      const sinks = forResource.map((c) => c.destSiteId);
      expect(sinks.filter((id) => sources.has(id))).toEqual([]);
    }
    // ...and specifically: the depot above its target is a source and never a
    // destination, which is the case the property exists for.
    expect(candidates.map((c) => c.destSiteId)).toEqual([B_ID, B_ID]);
    expect(new Set(candidates.map((c) => c.sourceSiteId))).toEqual(new Set([CAMP_SITE_ID, A_ID]));
  });

  it('a deficit already being walked toward is not offered twice', () => {
    // `inboundAt`. The depot holds 3 of its 12-unit target, so the deficit is
    // 9 and the first hauler takes 6 of it; the remaining 3 is below
    // `minTransferUnits` and the second hauler must be refused. Without the
    // claim the second reads the same deficit of 9 and goes for another 6.
    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 30 }], [A, { wheat: 3 }]]);
    expect(colony.dispatch()).toMatchObject({ destSiteId: A_ID, resource: 'wheat', movable: CAPACITY });
    expect(colony.dispatch()).toBeNull();
  });

  it('a deficit larger than the depot has room for is sized to the room', () => {
    // Three different numbers, and the smallest of them must win: a deficit of
    // 12, a hauler that carries 6, and 4 units of staging room. A fixture
    // whose deficit already sits below both of the others passes with the room
    // term deleted outright.
    //
    // CORRECTED FROM the brief's 56 wood. Staging room is
    // `capacity - storehouseFreeFloor - heldAt` (§2.2/§2.4), so 56 of 60 with a
    // floor of 12 is a room of ZERO and the fixture could not have asserted the
    // 4 it names. 44 is the holding that makes room exactly 4 under the floor
    // the spec actually specifies, and every discriminating property the brief
    // asked for survives the correction.
    const room = BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor - 44;
    const deficit = BALANCE.siteStagingTarget;
    expect(new Set([room, deficit, CAPACITY]).size).toBe(3);
    expect(deficit).toBeGreaterThan(CAPACITY);
    expect(CAPACITY).toBeGreaterThan(room);

    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 30 }], [A, { wood: 44 }]]);
    expect(colony.candidates()).toMatchObject([{ destSiteId: A_ID, resource: 'wheat', movable: room }]);
  });

  it('staging stops at the free floor rather than at the capacity', () => {
    // The second of §2.2's two bounds, alone: a depot holding exactly
    // `capacity - storehouseFreeFloor` has room for nothing more, even though
    // 12 units of raw capacity are standing empty. Its demand is real and
    // unmet; the answer is still no, because that room belongs to the
    // short-hop collect deposits the depot exists for.
    const atTheFloor = BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor;
    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 30 }], [A, { planks: atTheFloor }]]);
    expect(colony.stockpile.totalAt(A_ID)).toBeLessThan(BALANCE.storehouseCapacity); // raw room really is left
    expect(colony.candidates()).toEqual([]);

    // ...and one unit further down, staging resumes: the bound is the floor,
    // not "a depot with any stock in it".
    const roomier = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 30 }], [A, { planks: atTheFloor - CAPACITY }]]);
    expect(movablesOf(roomier.candidates())).toEqual([CAPACITY]);
  });

  it('two transfers of DIFFERENT resources cannot overbook one depot', () => {
    // The case `inboundAt` structurally CANNOT see, because it is per-resource
    // and capacity is not. A depot with six units of staging room, a mill and
    // a bakery beside it, and both wheat and flour standing at the camp: the
    // first hauler takes the six units of room with wheat, and the second must
    // find none for flour. Reddens if `heldAt` does not count a FETCHING
    // transfer's reservation — and does not redden with `inboundAt` alone,
    // which is the whole point of the fixture.
    const held = BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor - CAPACITY;
    const colony = colonyOf(
      [CAMP, A],
      [consumer('mill', NEAR_A), consumer('bakery', ALSO_NEAR_A)],
      [[CAMP, { wheat: 30, flour: 30 }], [A, { planks: held }]],
    );
    // Both deficits are real, and both would fit on their own.
    expect(movablesOf(colony.candidates())).toEqual([CAPACITY, CAPACITY]);
    expect(colony.dispatch()).toMatchObject({ destSiteId: A_ID, resource: 'wheat', movable: CAPACITY });
    expect(colony.dispatch()).toBeNull();
  });

  it('a transfer below minTransferUnits is not a candidate', () => {
    const below = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: BALANCE.minTransferUnits - 1 }]]);
    expect(below.candidates()).toEqual([]);
    const atThreshold = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: BALANCE.minTransferUnits }]]);
    expect(movablesOf(atThreshold.candidates())).toEqual([BALANCE.minTransferUnits]);
  });

  it('there is no "everything the site holds" escape hatch', () => {
    // DISTINCT from `worthMoving`, deliberately (§2.4). A one-unit tail at a
    // far depot produces no transfer candidate at all — and it is NOT
    // stranded, which is the half that makes this a decision rather than a
    // bug: the ordinary supply job still fetches it, because THAT threshold
    // does have the escape hatch.
    const mill = consumer('mill', NEAR_A);
    const colony = colonyOf([CAMP, A, B], [mill], [[B, { wheat: 1 }]]);
    expect(colony.candidates()).toEqual([]);

    const inputs: DispatchInputs = colony.inputs();
    const trip = new HaulTrip();
    chooseJob(trip, CAMP_TILE, inputs, CAPACITY);
    expect(trip).toMatchObject({
      kind: 'supply', phase: 'fetching', sourceSiteId: B_ID, resource: 'wheat', plannedAmount: 1,
    });
  });
});

/** Units of each of four resources in the split-surplus depot below. */
const SPLIT_HOLDING = 15;
/** ...and what each of them is worth as surplus, once the depot's demand is
 * taken off. Three, against a `minTransferUnits` of four. */
const SPLIT_SURPLUS = SPLIT_HOLDING - BALANCE.siteStagingTarget;

/**
 * The depot the drain's `minTransferUnits` exemption is argued over, holding
 * whatever a case needs it to hold.
 *
 * FOUR staffed consumers of four DIFFERENT inputs, all nearest depot A, so A's
 * demand is `4 x siteStagingTarget` = 48 — exactly
 * `storehouseCapacity - storehouseFreeFloor`, so `capTotalDemand` leaves it
 * alone and each of the four resources really is wanted 12.
 */
function fourInputDepot(holding: Partial<Record<ResourceId, number>>) {
  return colonyOf(
    [CAMP, A],
    [
      consumer('mill', NEAR_A), consumer('bakery', ALSO_NEAR_A),
      consumer('sawmill', THIRD_NEAR_A), consumer('workshop', FOURTH_NEAR_A),
    ],
    [[A, holding]],
  );
}

/**
 * The depot the exemption exists FOR, built once because two cases need it and
 * every number in it is load-bearing: 15 of each of the four inputs, so 60 of
 * 60, saturated, `drainNeed` at the full floor, and a surplus of 3 on every
 * resource with not one of them reaching the threshold.
 */
function splitSurplusDepot() {
  return fourInputDepot({
    wheat: SPLIT_HOLDING, flour: SPLIT_HOLDING, wood: SPLIT_HOLDING, planks: SPLIT_HOLDING,
  });
}

describe('draining: a site above its floor pushes to the camp', () => {
  it('a full-enough depot drains its no-demand stock to the camp', () => {
    // Nobody is nearest to this depot, so it demands nothing and everything in
    // it is surplus — the corner depot §4.3 measured silting up.
    const colony = colonyOf([CAMP, A], [], [[A, { planks: 55 }]]);
    expect(colony.candidates()).toEqual([{
      sourceSiteId: A_ID, sourceCol: A_TILE.col, sourceRow: A_TILE.row,
      destSiteId: CAMP_SITE_ID, destCol: CAMP_TILE.col, destRow: CAMP_TILE.row,
      resource: 'planks', movable: CAPACITY, staging: false,
    }]);
  });

  it('a depot saturated with a resource it DOES demand still drains the excess', () => {
    // 60 wheat in a 60-cap depot against a wheat demand of 12. The drain picks
    // the largest SURPLUS, not the largest holding among resources with zero
    // demand — under the latter this depot has no drainable resource at all
    // and stays saturated for the rest of the game, which is increment 7's
    // §4.3 defect surviving the increment written to remove it. Reachable in
    // ordinary play: collect banks a producer's output at the nearest site
    // with room and never consults demand.
    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[A, { wheat: BALANCE.storehouseCapacity }]]);
    const demand = BALANCE.siteStagingTarget;
    expect(colony.dispatch()).toMatchObject({
      sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID, resource: 'wheat', movable: CAPACITY, staging: false,
    });

    // BOTH halves, or this proves nothing: a drain goes out, and it stops
    // long before the demand that would stage the load straight back.
    while (colony.dispatch() !== null) { /* to exhaustion */ }
    expect(colony.claims().unclaimedAt(A_ID, 'wheat')).toBeGreaterThan(demand);
    expect(colony.candidates()).toEqual([]); // and nothing is pulling it back in
  });

  it('two equal surpluses are drained in catalog order', () => {
    // The tie-break `fullestResource` and `shortestOf` already use, and the
    // only thing standing between this rule and an answer that depends on
    // which resource happened to be inserted first. Equal holdings, no demand
    // for either, and the depot below its floor: wheat comes before planks in
    // the catalog, so wheat goes.
    const equal = 28;
    const colony = colonyOf([CAMP, A], [], [[A, { wheat: equal, planks: equal }]]);
    expect(RESOURCE_IDS.indexOf('wheat')).toBeLessThan(RESOURCE_IDS.indexOf('planks'));
    expect(colony.candidates()).toMatchObject([{ sourceSiteId: A_ID, resource: 'wheat', staging: false }]);
  });

  it('a depot with headroom above the floor does not drain', () => {
    // The clause that makes a drain purposeful rather than tidying: stock
    // present, demand zero, and headroom ABOVE the floor. Buying room is worth
    // a walk only when room is scarce.
    const roomy = colonyOf([CAMP, A], [], [[A, { planks: 40 }]]);
    expect(BALANCE.storehouseCapacity - 40).toBeGreaterThan(BALANCE.storehouseFreeFloor);
    expect(roomy.candidates()).toEqual([]);

    // Non-vacuous: the same depot, the same absent demand, one step below the
    // floor — and now it drains.
    const tight = colonyOf([CAMP, A], [], [[A, { planks: 52 }]]);
    expect(BALANCE.storehouseCapacity - 52).toBeLessThan(BALANCE.storehouseFreeFloor);
    expect(movablesOf(tight.candidates())).toEqual([BALANCE.minTransferUnits]);
  });

  it('a depot whose surplus is split across four resources still drains', () => {
    // A saturated depot with its surplus SPREAD is the third door to increment
    // 7's §4.3 defect. `drainResource` picks one resource — the single largest
    // surplus — so with 15 of each of four inputs against a demand of 12 each,
    // every candidate is worth 3 and a flat `minTransferUnits` of 4 refuses all
    // of them, even though the aggregate surplus of 12 is exactly the floor
    // being restored. The depot then accepts no collect deposit and stages
    // nothing for the rest of the game.
    //
    // A drain buys ROOM, and `candidateOf`'s "supply can still fetch it"
    // escape is no escape for it: this stock is above every nearby building's
    // demand, so no supply candidate exists for it either.
    const colony = splitSurplusDepot();
    // The fixture IS the finding, so its premises are asserted rather than
    // assumed — a demand quietly capped to 11, or a fifth resource in the
    // depot, and this passes for a reason that has nothing to do with the rule.
    expect(colony.stockpile.totalAt(A_ID)).toBe(BALANCE.storehouseCapacity);
    expect(colony.demand().get(A_ID)?.get('wheat')).toBe(BALANCE.siteStagingTarget);
    expect(SPLIT_SURPLUS).toBeLessThan(BALANCE.minTransferUnits);

    expect(colony.candidates()).toMatchObject([{
      sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID, resource: 'wheat',
      movable: SPLIT_SURPLUS, staging: false,
    }]);
  });

  it('a drain that would restore the floor outright is still refused', () => {
    // The other side of the exemption, and what keeps it narrow. Here the
    // surplus is nowhere near binding — the depot holds 51 of 60, so its 51
    // planks could give a full-sized load many times over — and `drainNeed` is
    // what holds `movable` down to 3. The trip would FINISH the job, and a job
    // that small means nine units of headroom, more than a hauler carries, so
    // every short-hop deposit still lands and nothing is stranded by waiting.
    // (Here that headroom is nine PHYSICALLY free units; `drainNeed` is netted
    // against `plannedOutAt`, so in general some of it may be room already
    // booked out — see the fourth hauler in the multi-hauler case below.)
    // Walking three units to the camp is precisely the trivial trip the
    // threshold exists to refuse.
    const held = 51;
    const free = BALANCE.storehouseCapacity - held;
    const need = BALANCE.storehouseFreeFloor - free;
    expect(need).toBeLessThan(BALANCE.minTransferUnits); // the threshold is what refuses it
    expect(free).toBeGreaterThan(BALANCE.haulCarryCapacity); // and the depot is not silting up
    expect(held - need).toBeGreaterThan(BALANCE.minTransferUnits); // surplus is NOT the binding term
    const colony = colonyOf([CAMP, A], [], [[A, { planks: held }]]);
    expect(colony.candidates()).toEqual([]);

    // Non-vacuous: one unit further down, `drainNeed` reaches the threshold on
    // its own and the same depot drains without needing any exemption.
    const lower = colonyOf([CAMP, A], [], [[A, { planks: held + 1 }]]);
    expect(movablesOf(lower.candidates())).toEqual([BALANCE.minTransferUnits]);
  });

  it('a hauler too small to carry the threshold does not get the exemption', () => {
    // The term the exemption is easiest to lose to, because it is invisible at
    // the call site: the `capacity` a drain is sized against is the HAULER's
    // own — `haulerCapacity`, not the flat `BALANCE.haulCarryCapacity` — and a
    // hauler with no bed carries `round(6 x homelessFactor)` = 3, BELOW the
    // threshold of 4. So `movable` can sit under the gate with the site
    // perfectly able to offer a full load, and a rule that asked only whether
    // this trip finishes the job would exempt it.
    //
    // 52 of 60: eight units free, `drainNeed` 4, and 52 planks of surplus. The
    // site can hand over a full-sized load AND that load restores the floor;
    // nothing about the site is stuck. A small hauler is not a stuck site, so
    // there is no candidate for it.
    const held = 52;
    const free = BALANCE.storehouseCapacity - held;
    const need = BALANCE.storehouseFreeFloor - free;
    const small = haulerCapacity(null);
    expect(small).toBeLessThan(BALANCE.minTransferUnits); // the hauler alone puts `movable` under the gate
    expect(need).toBeGreaterThanOrEqual(BALANCE.minTransferUnits); // ...and neither other term does
    expect(held - need).toBeGreaterThanOrEqual(BALANCE.minTransferUnits);
    const colony = colonyOf([CAMP, A], [], [[A, { planks: held }]]);
    expect(drainCandidates(colony.sites, colony.claims(), colony.demand(), small)).toEqual([]);

    // Non-vacuous twice over, and the two halves say different things: the same
    // depot drains for a hauler with a bed, so the depot is genuinely drainable
    // and it is the hauler being refused; and the same small hauler DOES drain
    // a site that is doing the best it can, so what it is refused is the
    // exemption and not the job.
    expect(movablesOf(drainCandidates(colony.sites, colony.claims(), colony.demand(), CAPACITY)))
      .toEqual([BALANCE.minTransferUnits]);
    const split = splitSurplusDepot();
    expect(movablesOf(drainCandidates(split.sites, split.claims(), split.demand(), small)))
      .toEqual([SPLIT_SURPLUS]);
  });

  it('a site that can still offer a full-sized load is not doing the best it can', () => {
    // The `surplus < minTransferUnits` clause's own fixture, and the one state
    // that separates the two halves of the exemption: here the site's surplus
    // IS short of what the floor needs — the trip would not finish the job — so
    // `surplus < drainNeed` holds and that clause ALONE would exempt this. The
    // other one refuses it, and rightly: a surplus of 5 against a threshold of
    // 4 is a site that can hand over a full-sized load, so nothing about the
    // site is stuck. It is the hauler that is small.
    //
    // 60 of 60 with the fullest resource at 17 against its demand of 12: a
    // saturated depot, `drainNeed` at the full floor of 12, and a surplus of 5.
    const colony = fourInputDepot({ wheat: 17, flour: 15, wood: 14, planks: 14 });
    const surplus = 17 - BALANCE.siteStagingTarget;
    const small = haulerCapacity(null);
    expect(colony.stockpile.totalAt(A_ID)).toBe(BALANCE.storehouseCapacity); // saturated: drainNeed is the floor
    expect(surplus).toBeGreaterThanOrEqual(BALANCE.minTransferUnits); // ...but a full-sized load is on offer
    expect(surplus).toBeLessThan(BALANCE.storehouseFreeFloor); // and it would NOT restore the floor
    expect(drainCandidates(colony.sites, colony.claims(), colony.demand(), small)).toEqual([]);

    // Non-vacuous: the load the site is holding out really is there, and a
    // hauler with a bed walks all five units of it.
    expect(movablesOf(drainCandidates(colony.sites, colony.claims(), colony.demand(), CAPACITY)))
      .toMatchObject([surplus]);
  });

  it('a drain never targets another depot', () => {
    // Two depots, one full and one empty, and the empty one is NEARER: a rule
    // that drained to the nearest site with room would pick it every time.
    const colony = colonyOf([CAMP, A, B], [], [[A, { planks: 55 }]]);
    const toB = Math.hypot(A_TILE.col - B_TILE.col, A_TILE.row - B_TILE.row);
    const toCamp = Math.hypot(A_TILE.col - CAMP_TILE.col, A_TILE.row - CAMP_TILE.row);
    expect(toB).toBeLessThan(toCamp); // the wrong answer really is the cheaper one
    expect(colony.candidates()).toMatchObject([{ sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID }]);
  });

  it('the camp never drains', () => {
    // Unbounded: no free-space floor to breach, so no push rule can ever fire
    // from it. This is the termination proof — the only way a drained good
    // returns to a depot is staging, which requires a real consumer's demand.
    const colony = colonyOf([CAMP, A], [consumer('mill', NEAR_A)], [[CAMP, { wheat: 100, planks: 100 }]]);
    expect(colony.stockpile.totalAt(CAMP_SITE_ID)).toBeGreaterThan(BALANCE.storehouseCapacity);
    // Non-vacuous: the camp is a perfectly ordinary staging SOURCE at the same
    // moment it is refusing to be a drain source.
    expect(colony.candidates()).toMatchObject([{ sourceSiteId: CAMP_SITE_ID, staging: true }]);
  });
});

describe('a bound that only a second hauler can see', () => {
  it('two haulers staging from one source cannot exceed its surplus', () => {
    // 22 wheat against a demand of 12 is a surplus of 10, and a hauler carries
    // 6. The first takes 6; the second must take 4, NOT 6, and the source
    // lands exactly ON its demand. Then the thing that actually matters: the
    // source has not become a SINK. A test that checks only the second load's
    // size passes an implementation off by one in the other direction.
    const colony = colonyOf(
      [CAMP, A, B],
      [consumer('mill', NEAR_A), consumer('mill', NEAR_B)],
      [[A, { wheat: 22 }]],
    );
    expect(colony.dispatch(A_TILE)).toMatchObject({ sourceSiteId: A_ID, destSiteId: B_ID, movable: CAPACITY });
    expect(colony.dispatch(A_TILE)).toMatchObject({ sourceSiteId: A_ID, destSiteId: B_ID, movable: 4 });
    expect(colony.claims().unclaimedAt(A_ID, 'wheat')).toBe(BALANCE.siteStagingTarget);
    expect(colony.candidates().map((c) => c.destSiteId)).not.toContain(A_ID);
  });

  it('a source over-committed into deficit would reverse-transfer', () => {
    // The consequence of the case above, as its own test: run it to
    // completion and assert no transfer is ever offered BACK to the source.
    //
    // Two mills beside the destination (a 24-unit deficit) so the deficit
    // cannot be what stops the third hauler, and two OTHER sources holding a
    // 4-unit tail each — small enough that `movable` never promotes them over
    // the source under test while it still has surplus, and large enough that
    // a reverse transfer into that source would have a legal supplier if it
    // ever fell into deficit.
    const colony = colonyOf(
      [CAMP, A, B, C],
      [consumer('mill', NEAR_A), consumer('mill', NEAR_B), consumer('mill', ALSO_NEAR_B)],
      [[A, { wheat: 22 }], [C, { wheat: 4 }], [CAMP, { wheat: 4 }]],
    );
    const dispatched = [colony.dispatch(A_TILE), colony.dispatch(A_TILE), colony.dispatch(A_TILE)];
    expect(dispatched.map((c) => c?.sourceSiteId)).toEqual([A_ID, A_ID, C_ID]);
    expect(movablesOf(dispatched.flatMap((c) => c ?? []))).toEqual([CAPACITY, 4, 4]);

    const remaining = colony.candidates();
    expect(remaining.length).toBeGreaterThan(0); // non-vacuous: the camp can still stage
    expect(remaining.map((c) => c.destSiteId)).not.toContain(A_ID);
  });

  it('concurrent drains stop once the floor is scheduled to be restored', () => {
    // 60 of 60, a floor of 12, a carry of 6, and THREE idle haulers. Exactly
    // two drains go out and the third hauler gets nothing. A two-hauler
    // fixture cannot see this: the bug is that `drainNeed` never falls, so it
    // takes a hauler that must be REFUSED.
    const colony = colonyOf([CAMP, A], [], [[A, { planks: BALANCE.storehouseCapacity }]]);
    expect([colony.dispatch(), colony.dispatch(), colony.dispatch()].map((c) => c?.movable ?? null))
      .toEqual([CAPACITY, CAPACITY, null]);
    expect(colony.claims().plannedOutAt(A_ID)).toBe(BALANCE.storehouseFreeFloor);
  });

  it('a reduced drain spends the headroom it books, exactly as a full one does', () => {
    // The exemption lowers the THRESHOLD, not the bound — and only more than
    // one hauler can tell the difference, because `drainNeed` does not fall
    // until a dispatch nets against `plannedOutAt`.
    //
    // 60 of 60, a floor of 12, four surpluses of 3. Three drains of 3 go out,
    // each taking a DIFFERENT resource because the surplus it spent is
    // claimed-net, and the fourth hauler is refused — by the exemption's own
    // boundary rather than by anything running out: after three, `plannedOutAt`
    // is 9 so `drainNeed` is 3, the untouched resource can still offer exactly
    // 3, and a surplus that is no longer BELOW the need fails the exemption's
    // second clause and puts that last trip back under `minTransferUnits`.
    //
    // The nine units that buys are booked room, not free space: the depot is
    // still physically at 60 of 60 and will not accept a deposit until those
    // three trips arrive. That is the point — the job is already being finished
    // by trips in flight, so a fourth is the trivial trip and not the rescue.
    const colony = splitSurplusDepot();
    const dispatched = [colony.dispatch(), colony.dispatch(), colony.dispatch(), colony.dispatch()];
    expect(dispatched.map((c) => c?.movable ?? null))
      .toEqual([SPLIT_SURPLUS, SPLIT_SURPLUS, SPLIT_SURPLUS, null]);
    expect(new Set(dispatched.flatMap((c) => c?.resource ?? [])).size).toBe(3);
    expect(colony.claims().plannedOutAt(A_ID)).toBe(3 * SPLIT_SURPLUS);
    expect(colony.claims().plannedOutAt(A_ID)).toBeLessThanOrEqual(BALANCE.storehouseFreeFloor);
    expect(colony.claims().plannedOutAt(A_ID)).toBeGreaterThan(BALANCE.haulCarryCapacity);
  });

  it('a supply fetch from a depot counts toward its drain headroom', () => {
    // `plannedOutAt` counts every fetching trip, not only transfers: a supply
    // hauler removes exactly as much occupancy as a transfer does. A depot at
    // 54 of 60 has 6 units free against a floor of 12, so `drainNeed` is 6 and
    // a drain of 6 goes out — unless a supply hauler is already fetching 6 out
    // of it, in which case the room is on its way and no drain is needed.
    //
    // These numbers discriminate. At one unit below the floor `drainNeed`
    // would be 1, which `minTransferUnits` refuses on its own, and the fixture
    // would pass with `plannedOutAt` dropped entirely.
    const alone = colonyOf([CAMP, A], [], [[A, { planks: 54 }]]);
    expect(movablesOf(alone.candidates())).toEqual([CAPACITY]);

    const withFetch = colonyOf([CAMP, A], [], [[A, { planks: 54 }]]);
    const fetching = new HaulTrip();
    fetching.kind = 'supply';
    fetching.phase = 'fetching';
    fetching.sourceSiteId = A_ID;
    fetching.resource = 'planks';
    fetching.plannedAmount = CAPACITY;
    withFetch.trips.push(fetching);
    expect(withFetch.candidates()).toEqual([]);
  });
});

describe('stock spent out from under a fetching hauler', () => {
  it('does not stage the missing stock and its stale claim as two separate shortages', () => {
    // `unclaimedAt` CAN GO NEGATIVE, and the deficit has to survive it.
    // `Stockpile.pay` spends camp-first across EVERY site, so a construction
    // cost can draw a depot's stock down below what a supply hauler already
    // claimed out of it — the hauler keeps its `plannedAmount` until it
    // arrives, and `takeAt` returns what is actually there. Unclamped,
    // `demand - unclaimedAt` ADDS that stale claim to the deficit and the one
    // missing pile is counted twice.
    //
    // Every number here is produced by the engine's own paths: the claim by a
    // real `chooseJob` dispatch, the shortfall by a real `pay`. A fixture that
    // set the claim or the stock by hand would prove nothing about the state
    // this arises from.
    const demand = BALANCE.siteStagingTarget; // 12: one sawmill beside depot A
    const colony = colonyOf(
      [CAMP, A, B],
      [consumer('sawmill', NEAR_A)],
      [[CAMP, { wood: 14 }], [A, { wood: CAPACITY }], [B, { wood: 30 }]],
    );

    // A supply hauler leaves for the depot beside the sawmill and claims every
    // unit of wood standing there.
    const supply = new HaulTrip();
    chooseJob(supply, A_TILE, colony.inputs(), CAPACITY);
    expect(supply).toMatchObject({
      kind: 'supply', phase: 'fetching', sourceSiteId: A_ID, resource: 'wood', plannedAmount: CAPACITY,
    });
    colony.trips.push(supply);

    // ...and then the colony builds a farm. 20 wood: the camp's 14 and, camp
    // exhausted, the six the hauler is already walking toward.
    expect(colony.stockpile.pay(BUILDINGS.farm.cost)).toBe(true);
    expect(colony.stockpile.getAt(A_ID, 'wood')).toBe(0);
    expect(colony.stockpile.getAt(B_ID, 'wood')).toBe(30); // the draw stopped at A, as `drawOrder` says
    expect(colony.claims().unclaimedAt(A_ID, 'wood')).toBe(-CAPACITY); // negative, from a real spend

    // The consequence, which is what the clamp is for: A wants 12 and gets 12.
    const staged: TransferCandidate[] = [];
    for (let won = colony.dispatch(A_TILE); won !== null; won = colony.dispatch(A_TILE)) staged.push(won);
    expect(staged).toMatchObject([
      { sourceSiteId: B_ID, destSiteId: A_ID, resource: 'wood', movable: CAPACITY, staging: true },
      { sourceSiteId: B_ID, destSiteId: A_ID, resource: 'wood', movable: CAPACITY, staging: true },
    ]);
    expect(staged.reduce((sum, c) => sum + c.movable, 0)).toBe(demand);

    // Non-vacuous: nothing ELSE could have refused a third hauler. B still has
    // surplus to send, A still has room to take it, and the deficit is the only
    // term left standing — unclamped it reads 18 and a third load goes out.
    expect(colony.claims().unclaimedAt(B_ID, 'wood')).toBeGreaterThanOrEqual(CAPACITY);
    expect(BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor - colony.claims().heldAt(A_ID))
      .toBeGreaterThanOrEqual(CAPACITY);
  });

  it('does not drain a depot on the strength of a fetching transfer that may bring nothing', () => {
    // §2.4: the drain answers for removals it has scheduled and for loads
    // already in a hauler's HANDS, not for intentions aimed at it. A fetching
    // transfer is an intention and it may take ZERO — `takeAt` returns what is
    // actually at the source, which `Stockpile.pay` can spend out from under
    // the claim — while a drain it triggers removes REAL goods. Occupancy built
    // from `heldAt` counts exactly that intention, so the two disagree.
    //
    // 42 planks in the depot, a 6-unit staging transfer fetching wood toward
    // it, and a 6-unit collect returning planks to it: `heldAt` reads 54, free
    // space 6 against a floor of 12, and a 6-unit drain goes out. Occupancy
    // counted from what is in hand reads 48 — exactly the ceiling the collect
    // is about to land the depot on — and nothing needs to leave.
    const HELD = 42;
    const CEILING = BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor;
    const sawmill = consumer('sawmill', NEAR_A);
    sawmill.buffer.add('planks', CAPACITY); // a batch waiting for its short hop
    const colony = colonyOf([CAMP, A], [sawmill], [[CAMP, BUILDINGS.farm.cost], [A, { planks: HELD }]]);

    // The staging transfer, through the ordinary candidate path: the depot
    // wants 12 wood for its sawmill and has room for exactly one load.
    expect(colony.dispatch()).toMatchObject({
      sourceSiteId: CAMP_SITE_ID, destSiteId: A_ID, resource: 'wood', movable: CAPACITY, staging: true,
    });
    const [staged] = colony.trips;

    // ...and then the colony builds a farm. `pay` draws camp-first, so it
    // spends the very wood that hauler is walking toward.
    expect(colony.stockpile.pay(BUILDINGS.farm.cost)).toBe(true);
    expect(colony.claims().unclaimedAt(CAMP_SITE_ID, 'wood')).toBe(-CAPACITY); // negative, from a real spend

    // Meanwhile a collect walks the sawmill's planks home. Both halves are the
    // engine's own: `chooseJob` picks the job — no site holds wood now, so no
    // supply candidate can outrank it — and `destinationFor` picks the depot,
    // whose staging room is gone but whose FREE FLOOR is exactly the room it
    // keeps for short-hop deposits like this one.
    const collect = new HaulTrip();
    chooseJob(collect, A_TILE, colony.inputs(), CAPACITY);
    expect(collect).toMatchObject({ kind: 'collect', phase: 'outbound', targetId: sawmill.building.id });
    collect.resource = 'planks';
    collect.amount = sawmill.buffer.take('planks', CAPACITY);
    collect.pickedUp = true;
    const home = destinationFor(collect, NEAR_A, colony.sites, colony.claims().heldAt);
    collect.startLeg('returning', NEAR_A, home, BALANCE.haulTilesPerTick); // `turnForHome`, minus the walking
    expect(collect).toMatchObject({ phase: 'returning', destSiteId: A_ID, amount: CAPACITY, pickedUp: true });
    colony.trips.push(collect);

    // The consequence, and the whole point: no drain goes out.
    expect(colony.dispatch()).toBeNull();

    // The other consequence, once every trip still standing is played out: the
    // fetch finds the camp spent and takes nothing, the collect banks in the
    // room reserved for it, and the depot lands ON its ceiling instead of six
    // units below it with a hauler walking those six to the camp for nothing.
    for (const trip of colony.trips) {
      if (trip.phase !== 'fetching' || trip.resource === null) continue;
      trip.amount = colony.stockpile.takeAt(trip.sourceSiteId, trip.resource, trip.plannedAmount);
    }
    expect(staged.amount).toBe(0);
    bankLoad(colony.stockpile, home, collect);
    expect(colony.stockpile.totalAt(A_ID)).toBe(CEILING);

    // Non-vacuous, and the other half of the rule: the SAME six units already
    // in a hauler's hands do count, and the same depot does drain. The
    // correction is "never on an intention", not "drain less". These two trips
    // are built by hand rather than dispatched — the fixture is the minimal
    // pair of the one above, differing only in which leg the wood is on.
    const inHand = colonyOf([CAMP, A], [consumer('sawmill', NEAR_A)], [[A, { planks: HELD }]]);
    inHand.trips.push(carryingToA('wood', CAPACITY), carryingToA('planks', CAPACITY));
    expect(inHand.claims().inHandAt(A_ID)).toBe(HELD + 2 * CAPACITY);
    expect(movablesOf(inHand.candidates())).toEqual([CAPACITY]);
  });
});

describe('which transfer a hauler takes', () => {
  const base: TransferCandidate = {
    sourceSiteId: 1, sourceCol: 5, sourceRow: 5,
    destSiteId: 2, destCol: 9, destRow: 5,
    resource: 'wheat', movable: 4, staging: true,
  };
  const candidate = (fields: Partial<TransferCandidate>): TransferCandidate => ({ ...base, ...fields });
  const HERE: TileRef = { col: 5, row: 5 };

  it('staging outranks a drain, however much more the drain would move', () => {
    // A real consumer's demand outranks freeing room, and it is a class
    // ordering rather than a magnitude one: the drain here moves more and is
    // still second.
    const staging = candidate({ movable: BALANCE.minTransferUnits, staging: true });
    const drain = candidate({ movable: CAPACITY, staging: false, sourceSiteId: 3 });
    expect(nextTransferTarget([drain, staging], HERE)).toBe(staging);
    expect(nextTransferTarget([staging, drain], HERE)).toBe(staging);
  });

  it('a candidate that would move nothing is not a job', () => {
    // The same guard `nextSupplyTarget` and `nextHaulTarget` carry, and for
    // the same reason: a hauler dispatched to move zero units walks a whole
    // round trip for nothing. `transferCandidates` cannot emit one today —
    // `minTransferUnits` refuses it four units earlier — so this asks the
    // selector directly rather than through a builder that would have to be
    // broken first.
    const empty = candidate({ movable: 0 });
    expect(nextTransferTarget([empty], HERE)).toBeNull();
    const real = candidate({ movable: BALANCE.minTransferUnits, sourceSiteId: 4 });
    expect(nextTransferTarget([empty, real], HERE)).toBe(real);
  });

  it('candidate order does not depend on array order', () => {
    // The guarantee every other selection in this codebase commits to.
    const winner = candidate({ movable: CAPACITY, sourceSiteId: 1, destSiteId: 2 });
    const rivals = [
      candidate({ movable: 5, sourceSiteId: 4, destSiteId: 5 }),
      candidate({ movable: CAPACITY, sourceSiteId: 3, destSiteId: 2 }),
      candidate({ movable: CAPACITY, sourceSiteId: 1, destSiteId: 6, destCol: 9, destRow: 5 }),
      candidate({ movable: CAPACITY, staging: false, sourceSiteId: 0 }),
    ];
    const shuffles = [
      [winner, ...rivals],
      [...rivals, winner],
      [rivals[1], winner, rivals[3], rivals[0], rivals[2]],
    ];
    for (const order of shuffles) expect(nextTransferTarget(order, HERE)).toBe(winner);
  });

  it('two resources moving the same route are ordered by catalog, not by array', () => {
    // The case the id tie-breaks CANNOT reach, and the reason the chain does
    // not end at a destination id: same source, same destination, same
    // `movable`, same class — every term above resource ties, and
    // `transferCandidates` iterates resources, so this pair is ordinary
    // rather than contrived.
    //
    // DISCRIMINATING against the shuffle above, whose candidates differ on an
    // id and which therefore passes with the resource term absent.
    const wheat = candidate({ resource: 'wheat' });
    const flour = candidate({ resource: 'flour' });
    expect(RESOURCE_IDS.indexOf('wheat')).toBeLessThan(RESOURCE_IDS.indexOf('flour'));
    expect(nextTransferTarget([flour, wheat], HERE)).toBe(wheat);
    expect(nextTransferTarget([wheat, flour], HERE)).toBe(wheat);
    expect(compareTransferCandidates(wheat, flour, HERE)).toBeLessThan(0);
    expect(compareTransferCandidates(flour, wheat, HERE)).toBeGreaterThan(0);
  });

  it('the route is measured from where the hauler stands, source then destination', () => {
    // Two candidates a hauler could take, identical but for their source. The
    // answer has to change with the hauler's own tile, or the route term is
    // measuring something that is not a trip.
    // Each move is five tiles long, so the ONLY thing that can separate them
    // is the walk to the source — and the lower source id is the eastern one,
    // so the id tie-break cannot produce this answer either.
    const west = candidate({ sourceSiteId: 8, sourceCol: 0, sourceRow: 5, destSiteId: 9, destCol: 0, destRow: 0 });
    const east = candidate({ sourceSiteId: 7, sourceCol: 19, sourceRow: 5, destSiteId: 9, destCol: 19, destRow: 0 });
    expect(nextTransferTarget([west, east], { col: 0, row: 5 })).toBe(west);
    expect(nextTransferTarget([west, east], { col: 19, row: 5 })).toBe(east);
  });
});

describe('what a site demands', () => {
  it('is the staging target per consuming building, capped by the free floor', () => {
    // The wiring of `siteDemandOf`: `targetPerSource` and `reserveFreeSpace`
    // are a named-options argument (`SiteDemandOptions`), not two positional
    // numbers, so a transposed call site fails to typecheck rather than
    // needing a fixture to tell the two orders apart. This just asserts the
    // wiring's behaviour, against the real constants.
    const one = [consumer('mill', NEAR_A)];
    expect(siteDemandFrom([CAMP, A], one, new Set(one.map((row) => row.building.id))).get(A_ID)?.get('wheat'))
      .toBe(BALANCE.siteStagingTarget); // the TARGET per building, not the floor

    // Five mills ask for five times the target, and a bounded depot may only
    // be asked for `capacity - storehouseFreeFloor`.
    const five = [NEAR_A, ALSO_NEAR_A, { col: 19, row: 10 }, { col: 20, row: 9 }, { col: 21, row: 11 }]
      .map((at) => consumer('mill', at));
    expect(siteDemandFrom([CAMP, A], five, new Set(five.map((row) => row.building.id))).get(A_ID)?.get('wheat'))
      .toBe(BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor);
  });

  it('counts only staffed, non-relocating consumers', () => {
    // Both engine conditions, filtered before the law is called, exactly as
    // `supplyCandidates` filters on `staffed`. A site whose only neighbours
    // are an unstaffed mill, a relocating mill and a farm demands nothing —
    // and therefore has no deficit for anything to be staged into.
    const staffedMill = consumer('mill', NEAR_A);
    const idleMill = consumer('mill', ALSO_NEAR_A);
    const movingMill = consumer('mill', { col: 19, row: 10 });
    movingMill.relocation.ticksLeft = 5;
    // A farm has a recipe with no inputs; a house has no recipe at all. Both
    // arrive in the building rows every tick — `HaulSystem`'s query returns
    // every building there is — and neither may contribute demand.
    const farm = consumer('farm', { col: 20, row: 9 });
    const house = consumer('house', { col: 21, row: 9 });
    const buildings = [staffedMill, idleMill, movingMill, farm, house];
    const staffed: StaffedSet = new Set([
      staffedMill.building.id, movingMill.building.id, farm.building.id, house.building.id,
    ]);
    expect(siteDemandFrom([CAMP, A], buildings, staffed).get(A_ID)?.get('wheat')).toBe(BALANCE.siteStagingTarget);
  });
});

/**
 * Acceptance criterion 8: no sequence of legal transfers returns the ledger to
 * a per-site distribution it has already visited without a consumption event
 * in between. This is §2.2's termination argument stated as a property rather
 * than as three worked examples.
 *
 * Seeded rather than random: a failure names the seed that produced it, and
 * re-running the same seed reproduces it exactly.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One randomised colony: two depots and a camp, arbitrary stock in each, and
 * between zero and four consumers scattered beside them. */
function randomColony(seed: number) {
  const random = mulberry32(seed);
  const pick = <T,>(from: readonly T[]): T => from[Math.floor(random() * from.length)];
  const stock = (cap: number): Partial<Record<ResourceId, number>> => {
    const contents: Partial<Record<ResourceId, number>> = {};
    let left = cap;
    for (const resource of ['wheat', 'flour', 'planks', 'wood'] as const) {
      const amount = Math.floor(random() * (left + 1));
      contents[resource] = amount;
      left -= amount;
    }
    return contents;
  };
  const buildings = Array.from({ length: Math.floor(random() * 5) }, () => consumer(
    pick(['mill', 'bakery', 'sawmill'] as const),
    pick([NEAR_A, ALSO_NEAR_A, NEAR_B, ALSO_NEAR_B, { col: 3, row: 0 }] as const),
  ));
  const capacity = BALANCE.storehouseCapacity;
  return colonyOf([CAMP, A, B], buildings, [[CAMP, stock(200)], [A, stock(capacity)], [B, stock(capacity)]]);
}

describe('no sequence of legal transfers walks in circles', () => {
  /** Every site's holding of every resource, as one comparable string — the
   * "per-site distribution" the criterion is about. */
  const distributionOf = (colony: ReturnType<typeof colonyOf>) => colony.sites
    .map((site) => `${site.id}:${RESOURCE_IDS.map((r) => colony.stockpile.getAt(site.id, r)).join(',')}`)
    .join('|');

  /** Each legal transfer moves at least `minTransferUnits`, so a colony
   * holding a few hundred units cannot need anything like this many. Reaching
   * the cap IS a failure — it means the sequence had not stopped. */
  const CAP = 400;

  /** One seeded colony, transferred to a standstill. Returns how many moves it
   * took, so the caller can prove the whole sweep was not vacuous. */
  function runToStandstill(seed: number): number {
    const colony = randomColony(seed);
    const before = RESOURCE_IDS.map((r) => colony.stockpile.get(r));
    const seen = new Set([distributionOf(colony)]);
    let moves = 0;
    for (; moves < CAP; moves++) {
      const chosen = nextTransferTarget(colony.candidates(), CAMP_TILE);
      if (chosen === null) break;
      // Applied whole, with no hauler in flight: the load leaves its source
      // and lands at its destination before the next transfer is chosen, which
      // is the strongest form of the claim — nothing is held back by a claim
      // that has not resolved yet, and no consumption event intervenes.
      const site = colony.sites.find((s) => s.id === chosen.destSiteId)!;
      const taken = colony.stockpile.takeAt(chosen.sourceSiteId, chosen.resource, chosen.movable);
      expect(taken, `seed ${seed}: a candidate claimed stock its source did not have`).toBe(chosen.movable);
      colony.stockpile.refundAt(site, chosen.resource, taken);
      const distribution = distributionOf(colony);
      expect(seen.has(distribution), `seed ${seed} revisited a distribution after ${moves + 1} transfers`).toBe(false);
      seen.add(distribution);
    }
    expect(moves, `seed ${seed} was still transferring at the cap`).toBeLessThan(CAP);
    expect(RESOURCE_IDS.map((r) => colony.stockpile.get(r)), `seed ${seed} did not conserve goods`).toEqual(before);
    return moves;
  }

  it('sixty seeded colonies each reach a standstill without repeating a distribution', () => {
    // One test rather than one per seed on purpose: the vacuity guard below
    // has to be asserted over the same run as the property, or a filtered
    // invocation could satisfy the property while moving nothing at all.
    const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
    const moves = seeds.map(runToStandstill);
    const total = moves.reduce((sum, n) => sum + n, 0);
    // Non-vacuous twice over: transfers really happened, and they happened in
    // most of the colonies rather than all in one.
    expect(total).toBeGreaterThan(seeds.length);
    expect(moves.filter((n) => n > 0).length).toBeGreaterThan(seeds.length / 2);
  });
});

/**
 * §2.6's dispatch order: supply → drain → collect → staging. It is a CHAIN, so
 * every arm can be hidden by the one above it, and a case that only shows its
 * own arm winning proves nothing about the arm it beat. Each case below
 * therefore also shows that the candidate it outranked genuinely existed on the
 * same tick.
 *
 * THE FIVE CASES DO NOT ALL CARRY THE SAME DIRECTION, and it is worth saying
 * which is which rather than implying one clause each. The clause this
 * increment CHANGED is the drain's promotion above collect, so:
 *
 * - POSITIVE — the new ordering has to hold for these to pass, and a dispatcher
 *   without the promotion fails them: `a drain outranks a collect`, and
 *   `concurrent drains do not starve collect` (which additionally pins the
 *   promotion ENDING, and needs three haulers to see it).
 * - NEGATIVE — these assert `collect`, which the PRE-CHANGE dispatcher also
 *   produced, so they cannot show the promotion exists; they bound how far it
 *   reaches: `...and only while the depot is below its free floor` (a drain
 *   above the floor must not fire) and `staging does NOT outrank a collect`
 *   (only the drain half moved).
 * - UNCHANGED — `supply still outranks a drain` asserts the half of the order
 *   that did not move, and is a guard against widening the promotion upward.
 *
 * So the positive assertion of the new ordering rests on two cases, not five.
 * Both are gated by mutations the other three survive; a reader adding a sixth
 * case should say which of the three groups it joins.
 */
describe('where the two transfer classes sit in the dispatch order', () => {
  /** One idle hauler through the real dispatcher, its trip KEPT so the next
   * hauler on the same tick sees the claims it left behind. That is the only
   * way a netted term like `drainNeed` can be told from an unnetted one —
   * physical stock does not move until a hauler arrives, several legs later. */
  function dispatchJob(colony: ReturnType<typeof colonyOf>, from: TileRef = CAMP_TILE): HaulTrip {
    const trip = new HaulTrip();
    chooseJob(trip, from, colony.inputs(), CAPACITY);
    colony.trips.push(trip);
    return trip;
  }

  /** A producer with a finished batch waiting in its tray: the collect
   * candidate these cases have to rank against. A forester rather than a
   * consumer on purpose — its recipe has no inputs, so it contributes no site
   * demand and can never produce a supply candidate that would outrank
   * everything under test. */
  function producerWithFullTray(at: TileRef): HaulBuildingRow {
    const row = consumer('forester', at);
    row.buffer.add('wood', CAPACITY);
    return row;
  }

  it('a drain outranks a collect', () => {
    // The one reversal this increment measured. A depot pinned at capacity
    // with nothing beside it that eats, and a producer beside it with a full
    // tray: both jobs are on offer, and the drain goes first. The goods in the
    // tray are safe where they stand; the depot's lost headroom is what turns
    // every short-hop collect near it back into the long walk to the camp,
    // which is the leg the depot was placed to remove.
    const colony = colonyOf([CAMP, A], [producerWithFullTray(NEAR_A)], [[A, { planks: BALANCE.storehouseCapacity }]]);
    expect(colony.candidates()).toMatchObject([
      { sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID, resource: 'planks', movable: CAPACITY, staging: false },
    ]);
    expect(dispatchJob(colony)).toMatchObject({
      kind: 'transfer', phase: 'fetching', sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID, staging: false,
    });

    // The half that makes this an ORDERING rather than a fixture with one
    // legal answer: the same producer and the same tray, with the depot's
    // stock removed so no drain is offered, and the collect the assertion
    // above outranked is taken.
    const producer = producerWithFullTray(NEAR_A);
    const undrained = colonyOf([CAMP, A], [producer]);
    expect(undrained.candidates()).toEqual([]);
    expect(dispatchJob(undrained)).toMatchObject({
      kind: 'collect', phase: 'outbound', targetId: producer.building.id,
    });
  });

  it('...and only while the depot is below its free floor', () => {
    // The discriminating half of the case above: without it, that one passes
    // for a dispatcher that prefers a transfer unconditionally. The same
    // colony with the depot at exactly `capacity - storehouseFreeFloor` — its
    // free space IS the floor, `drainNeed` is 0, nothing needs to leave — and
    // the collect goes.
    const producer = producerWithFullTray(NEAR_A);
    const atTheFloor = BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor;
    const colony = colonyOf([CAMP, A], [producer], [[A, { planks: atTheFloor }]]);
    // Surplus is emphatically NOT what is missing: 48 units stand there with
    // no demand for them anywhere, so a drain sized on surplus alone — or one
    // whose floor test was dropped — would move a full load.
    expect(colony.claims().unclaimedAt(A_ID, 'planks')).toBeGreaterThan(CAPACITY);
    expect(colony.candidates()).toEqual([]);
    expect(dispatchJob(colony)).toMatchObject({
      kind: 'collect', phase: 'outbound', targetId: producer.building.id,
    });
  });

  it('supply still outranks a drain', () => {
    // The half of the order that did NOT move. A mill with an empty tray and
    // wheat standing at the depot beside it, plus a saturated depot across the
    // map: a building waiting on inputs produces nothing, and that still
    // outranks buying a depot's headroom back.
    const colony = colonyOf(
      [CAMP, A, B],
      [consumer('mill', NEAR_B)],
      [[A, { planks: BALANCE.storehouseCapacity }], [B, { wheat: 30 }]],
    );
    // Non-vacuous: the drain really is on offer this tick, and would be taken
    // the moment nothing outranked it.
    expect(colony.candidates()).toMatchObject([
      { sourceSiteId: A_ID, destSiteId: CAMP_SITE_ID, resource: 'planks', staging: false },
    ]);
    expect(dispatchJob(colony, B_TILE)).toMatchObject({
      kind: 'supply', phase: 'fetching', sourceSiteId: B_ID, resource: 'wheat',
    });
  });

  it('staging does NOT outrank a collect', () => {
    // The clause that says only the DRAIN half of the transfer rule moved. A
    // depot with a real unmet demand, a camp with the stock to fill it, and a
    // producer beside the depot with a full tray: the collect goes, because
    // nobody is waiting for a staged load while that producer's next batch is
    // waiting for its tray.
    //
    // The mill's in-tray is FULL, and that is what makes the fixture
    // constructible at all: a site's demand counts every staffed consuming
    // building, while `needOf` returns null once the tray has no room. So this
    // mill contributes A's 12-unit wheat demand and NO supply candidate —
    // without which supply would answer first and the ordering under test
    // would never be reached.
    const mill = consumer('mill', NEAR_A);
    mill.input.add('wheat', BALANCE.inputBufferCap);
    expect(mill.input.room(BALANCE.inputBufferCap)).toBe(0);
    const producer = producerWithFullTray(ALSO_NEAR_A);
    const colony = colonyOf([CAMP, A], [mill, producer], [[CAMP, { wheat: 30 }]]);
    // Non-vacuous: the staging candidate really is on offer, and it is the
    // only transfer here — the depot is empty, so nothing drains either.
    expect(colony.candidates()).toMatchObject([
      { sourceSiteId: CAMP_SITE_ID, destSiteId: A_ID, resource: 'wheat', movable: CAPACITY, staging: true },
    ]);
    expect(dispatchJob(colony)).toMatchObject({
      kind: 'collect', phase: 'outbound', targetId: producer.building.id,
    });
  });

  it('concurrent drains do not starve collect', () => {
    // The structural bound behind "a drain cannot starve collect": the
    // promotion is extinguished by ACTING on it. 60 of 60, a floor of 12, a
    // carry of 6, and THREE haulers on one tick — the first two drain, and the
    // third reads a `drainNeed` netted to zero against the removals they have
    // already scheduled, so the collect it was outranked by twice now goes.
    //
    // A one- or two-hauler fixture cannot see this. With the netting removed
    // `drainNeed` never falls, and the hauler that must be REFUSED a drain is
    // the third.
    const producer = producerWithFullTray(NEAR_A);
    const colony = colonyOf([CAMP, A], [producer], [[A, { planks: BALANCE.storehouseCapacity }]]);
    const trips = [dispatchJob(colony), dispatchJob(colony), dispatchJob(colony)];
    expect(trips.map((trip) => trip.kind)).toEqual(['transfer', 'transfer', 'collect']);
    expect(trips[2]).toMatchObject({ phase: 'outbound', targetId: producer.building.id });
    // Exactly restored, not overshot: two loads of 6 against a 12-unit floor.
    expect(colony.claims().plannedOutAt(A_ID)).toBe(BALANCE.storehouseFreeFloor);
  });
});

describe('what a dispatched trip records about itself', () => {
  it('a hauler that ran a staging transfer does not still report staging on its next job', () => {
    // `staging` rides on the trip and NOTHING in the engine reads it — §4.2's
    // instrument is its only consumer — so a stale `true` breaks no rule, only
    // a measurement, which is the kind of wrong that survives a whole
    // increment. `cancel()` clears the field at the end of a trip; this is the
    // other end, where the trip is DECIDED, and the only fixture that can see
    // it is one that hands dispatch a trip already dirty.
    //
    // A forester through `consumer()`: the helper builds a live building row,
    // and this one is a producer rather than a consumer — no recipe inputs, so
    // it contributes no site demand and the only job in this colony is the
    // collect its output buffer offers.
    const producer = consumer('forester', NEAR_A);
    producer.buffer.add('wood', CAPACITY);
    const colony = colonyOf([CAMP, A], [producer]);
    const inputs: DispatchInputs = colony.inputs();
    const trip = new HaulTrip();
    trip.staging = true; // exactly as a finished staging transfer would have left it

    chooseJob(trip, CAMP_TILE, inputs, CAPACITY);
    expect(trip).toMatchObject({ kind: 'collect', phase: 'outbound', staging: false });
  });
});
