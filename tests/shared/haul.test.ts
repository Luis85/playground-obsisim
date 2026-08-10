import { describe, expect, it } from 'vitest';
import type { ResourceId } from '../../src/shared/content-types';
import type { TileRef } from '../../src/shared/placement';
import {
  CAMP_SITE_ID, CAMP_TILE, claimableAt, compareHaulCandidates, compareSupplyCandidates,
  haulDistance, haulTicks, haulTicksBetween, nearestSite, nearestSiteWithRoom, nextHaulTarget,
  nextSupplyTarget, siteDemandOf, sitesHolding,
  type DemandSource, type HaulCandidate, type HaulKind, type HaulPhase, type StoreSite,
  type SupplyCandidate,
} from '../../src/shared/haul';

function candidate(overrides: Partial<HaulCandidate> = {}): HaulCandidate {
  return { buildingId: 1, col: 4, row: 1, buffered: 4, claimed: 0, ...overrides };
}

describe('haul geometry', () => {
  it('measures from the camp tile', () => {
    expect(CAMP_TILE).toEqual({ col: 2, row: 0 });
    expect(haulDistance(CAMP_TILE.col, CAMP_TILE.row)).toBe(0);
  });

  it('is straight-line distance in tiles — the line the renderer walks', () => {
    expect(haulDistance(2, 3)).toBe(3);
    expect(haulDistance(5, 4)).toBe(5); // 3-4-5
  });

  it('never makes a trip free: even the camp tile costs a tick', () => {
    expect(haulTicks(CAMP_TILE.col, CAMP_TILE.row, 2)).toBe(1);
    expect(haulTicks(3, 0, 2)).toBe(1);
  });

  it('rounds up partial tiles but not exact multiples', () => {
    expect(haulTicks(2, 4, 2)).toBe(2); // distance 4, exactly 2 ticks
    expect(haulTicks(5, 4, 2)).toBe(3); // distance 5 -> ceil(2.5)
  });

  it('charges the far corner of the default map about thirteen ticks each way', () => {
    expect(haulTicks(22, 15, 2)).toBe(13); // distance 25
  });
});

describe('haul job selection', () => {
  it('counts only what earlier haulers have not spoken for', () => {
    expect(claimableAt(candidate({ buffered: 9, claimed: 6 }))).toBe(3);
    expect(claimableAt(candidate({ buffered: 6, claimed: 6 }))).toBe(0);
  });

  it('serves the fullest building first, even when it is farther', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 1, buffered: 3 });
    const far = candidate({ buildingId: 2, col: 20, row: 10, buffered: 9 });
    expect(nextHaulTarget([near, far])?.buildingId).toBe(2);
  });

  it('breaks a tie on backlog by distance to the camp', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 0, buffered: 5 });
    const far = candidate({ buildingId: 2, col: 10, row: 0, buffered: 5 });
    expect(nextHaulTarget([far, near])?.buildingId).toBe(1);
  });

  it('breaks a full tie by lowest building id, so selection cannot depend on order', () => {
    const a = candidate({ buildingId: 7, col: 2, row: 3, buffered: 4 }); // distance 3
    const b = candidate({ buildingId: 3, col: 5, row: 0, buffered: 4 }); // distance 3
    expect(nextHaulTarget([a, b])?.buildingId).toBe(3);
    expect(nextHaulTarget([b, a])?.buildingId).toBe(3);
  });

  it('ignores buildings whose backlog is fully claimed, and returns null when nothing is open', () => {
    const claimed = candidate({ buildingId: 1, buffered: 6, claimed: 6 });
    const open = candidate({ buildingId: 2, col: 20, row: 10, buffered: 1 });
    expect(nextHaulTarget([claimed, open])?.buildingId).toBe(2);
    expect(nextHaulTarget([claimed])).toBeNull();
    expect(nextHaulTarget([])).toBeNull();
  });

  it('sorts a list the same way it picks a single target', () => {
    const list = [
      candidate({ buildingId: 1, col: 4, row: 1, buffered: 2 }),
      candidate({ buildingId: 2, col: 6, row: 1, buffered: 8 }),
      candidate({ buildingId: 3, col: 5, row: 0, buffered: 8 }),
    ];
    const sorted = [...list].sort(compareHaulCandidates);
    expect(sorted.map((c) => c.buildingId)).toEqual([3, 2, 1]);
  });
});

describe('haulTicksBetween', () => {
  it('is never free, even between adjacent tiles', () => {
    expect(haulTicksBetween({ col: 5, row: 5 }, { col: 5, row: 6 }, 2)).toBe(1);
  });

  it('agrees with haulTicks when measured from the camp', () => {
    // haulTicks is now DEFINED as this, and the test pins the two together so
    // a future edit to one cannot silently re-price every existing trip.
    for (const tile of [{ col: 0, row: 0 }, { col: 23, row: 15 }, { col: 2, row: 0 }]) {
      expect(haulTicksBetween(CAMP_TILE, tile, 2)).toBe(haulTicks(tile.col, tile.row, 2));
    }
  });
});

describe('HaulPhase', () => {
  it('admits "fetching", for a hauler walking empty to its supply pickup', () => {
    const phase: HaulPhase = 'fetching';
    expect(phase).toBe('fetching');
  });
});

describe('HaulKind', () => {
  it('names the two jobs a hauler can be doing', () => {
    const kinds: HaulKind[] = ['collect', 'supply'];
    expect(kinds).toEqual(['collect', 'supply']);
  });
});

describe('nearestSite', () => {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: 2, row: 0, capacity: null };
  const depot: StoreSite = { id: 7, col: 20, row: 14, capacity: 60 };

  it('picks whichever site is actually closest, full or not', () => {
    expect(nearestSite(21, 14, [camp, depot])?.id).toBe(7);
    expect(nearestSite(2, 1, [camp, depot])?.id).toBe(CAMP_SITE_ID);
  });

  it('returns null when there are no sites at all', () => {
    expect(nearestSite(5, 5, [])).toBeNull();
  });

  it('breaks a distance tie by site id, not by argument order', () => {
    const a: StoreSite = { id: 9, col: 4, row: 0, capacity: 60 };
    const b: StoreSite = { id: 3, col: 0, row: 0, capacity: 60 };
    expect(nearestSite(2, 0, [a, b])?.id).toBe(3);
    expect(nearestSite(2, 0, [b, a])?.id).toBe(3);
  });
});

describe('nearestSiteWithRoom', () => {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: 2, row: 0, capacity: null };
  const depot: StoreSite = { id: 7, col: 20, row: 14, capacity: 60 };

  it('prefers the depot for a building beside it', () => {
    expect(nearestSiteWithRoom(21, 14, [camp, depot], () => 0, 6)?.id).toBe(7);
  });
  it('falls through to the camp when the depot is full', () => {
    // Discriminating: the depot is still NEARER. Only the room check can move
    // this answer, so a mutation that ignores capacity fails here and nowhere else.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 60 : 0), 6)?.id).toBe(CAMP_SITE_ID);
  });
  it('accepts a load that fills a depot EXACTLY', () => {
    // heldAt + amount === capacity must still be a valid destination. Without
    // this case the prescribed `>` -> `>=` mutation reddens no test at all,
    // which makes that mutation check vacuous.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 54 : 0), 6)?.id).toBe(7);
  });
  it('rejects a depot with SOME room but not enough for the load', () => {
    // The case the `amount` parameter exists for. 55 of 60 held, 12 to bank:
    // a predicate that only skips FULL sites picks the depot and splits the
    // load on arrival.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 55 : 0), 12)?.id).toBe(CAMP_SITE_ID);
  });

  it('never runs out of destinations while the camp exists', () => {
    // capacity: null is unbounded, so the camp is the guaranteed fallback.
    expect(nearestSiteWithRoom(21, 14, [camp], () => 1e9, 6)).not.toBeNull();
  });
  it('breaks a distance tie by site id, not by argument order', () => {
    const a: StoreSite = { id: 9, col: 4, row: 0, capacity: 60 };
    const b: StoreSite = { id: 3, col: 0, row: 0, capacity: 60 };
    expect(nearestSiteWithRoom(2, 0, [a, b], () => 0, 6)?.id).toBe(3);
    expect(nearestSiteWithRoom(2, 0, [b, a], () => 0, 6)?.id).toBe(3);
  });
});

describe('sitesHolding', () => {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: 2, row: 0, capacity: null };
  const depot: StoreSite = { id: 7, col: 20, row: 14, capacity: 60 };

  it('keeps only sites carrying unclaimed stock of the resource in question', () => {
    expect(sitesHolding([camp, depot], (id) => (id === 7 ? 5 : 0)).map((s) => s.id)).toEqual([7]);
  });

  it('drops a site whose stock is fully claimed already', () => {
    expect(sitesHolding([depot], () => 0)).toEqual([]);
  });
});

// A candidate is a building-SOURCE pair, not just a building: the same
// building reachable from two different sites is two candidates. Every
// fixture below that is meant to discriminate the route from the plain
// hauler-to-building distance therefore varies the site fields, not just the
// building fields — a comparator that ignores the source leg entirely would
// still pass a fixture that only varied buildingCol/buildingRow.
function supplyCandidate(overrides: Partial<SupplyCandidate> = {}): SupplyCandidate {
  return {
    buildingId: 1, buildingCol: 4, buildingRow: 1,
    siteId: CAMP_SITE_ID, siteCol: CAMP_TILE.col, siteRow: CAMP_TILE.row,
    resource: 'wheat', movable: 4, starving: false,
    ...overrides,
  };
}

describe('supply job selection', () => {
  it('serves the most movable stock first, even when it is farther via its whole route', () => {
    const from: TileRef = { col: 2, row: 0 };
    const near = supplyCandidate({ buildingId: 1, buildingCol: 4, buildingRow: 1, movable: 3 });
    const far = supplyCandidate({ buildingId: 2, buildingCol: 20, buildingRow: 10, movable: 9 });
    expect(nextSupplyTarget([near, far], from)?.buildingId).toBe(2);
  });

  it('breaks a tie on movable by the route from the HAULER, not the camp', () => {
    // Discriminating from compareHaulCandidates: the camp sits at (2, 0). Each
    // candidate's source here coincides with its own building (leg two is
    // zero), so the route reduces to hauler-to-building — building 1 is
    // nearer the camp; building 2 is nearer this hauler's current tile. A
    // comparator that measured from CAMP_TILE instead of `from` (like the
    // collect law) would pick building 1 and fail this assertion.
    const from: TileRef = { col: 18, row: 10 };
    const nearCamp = supplyCandidate({
      buildingId: 1, buildingCol: 4, buildingRow: 0, siteId: 1, siteCol: 4, siteRow: 0, movable: 5,
    });
    const nearHauler = supplyCandidate({
      buildingId: 2, buildingCol: 20, buildingRow: 10, siteId: 2, siteCol: 20, siteRow: 10, movable: 5,
    });
    expect(nextSupplyTarget([nearCamp, nearHauler], from)?.buildingId).toBe(2);
  });

  it('ranks by the WHOLE route — hauler to source to building — not by the building alone', () => {
    // Both candidates serve the SAME building (5), so buildingCol/buildingRow
    // and buildingId cannot break the tie: only the source leg can. A
    // comparator that ignores the source sees two identical-distance
    // candidates, falls through the building-id tie (also equal), and lands
    // on the siteId tie-break — picking the FAR site (id 1, route 190) over
    // the near one (id 2, route 10). The whole-route comparator must pick
    // the near site instead.
    const from: TileRef = { col: 0, row: 0 };
    const viaFarSite = supplyCandidate({
      buildingId: 5, buildingCol: 10, buildingRow: 0, siteId: 1, siteCol: 100, siteRow: 0, movable: 4,
    });
    const viaNearSite = supplyCandidate({
      buildingId: 5, buildingCol: 10, buildingRow: 0, siteId: 2, siteCol: 0, siteRow: 0, movable: 4,
    });
    expect(nextSupplyTarget([viaFarSite, viaNearSite], from)?.siteId).toBe(2);
    expect(nextSupplyTarget([viaNearSite, viaFarSite], from)?.siteId).toBe(2);
  });

  it('breaks a route tie by lowest building id, so selection cannot depend on order', () => {
    const from: TileRef = { col: 2, row: 0 };
    const a = supplyCandidate({ buildingId: 7, buildingCol: 2, buildingRow: 3, movable: 4 });
    const b = supplyCandidate({ buildingId: 3, buildingCol: 2, buildingRow: 3, movable: 4 });
    expect(nextSupplyTarget([a, b], from)?.buildingId).toBe(3);
    expect(nextSupplyTarget([b, a], from)?.buildingId).toBe(3);
  });

  it('breaks a full tie (same building, same route length) by lowest site id', () => {
    const from: TileRef = { col: 0, row: 0 };
    const viaA = supplyCandidate({
      buildingId: 1, buildingCol: 0, buildingRow: 0, siteId: 9, siteCol: 5, siteRow: 0, movable: 4,
    });
    const viaB = supplyCandidate({
      buildingId: 1, buildingCol: 0, buildingRow: 0, siteId: 3, siteCol: -5, siteRow: 0, movable: 4,
    });
    expect(nextSupplyTarget([viaA, viaB], from)?.siteId).toBe(3);
    expect(nextSupplyTarget([viaB, viaA], from)?.siteId).toBe(3);
  });

  it('ignores candidates with nothing movable, and returns null when nothing is available', () => {
    const from: TileRef = { col: 2, row: 0 };
    const empty = supplyCandidate({ buildingId: 1, movable: 0 });
    const open = supplyCandidate({ buildingId: 2, buildingCol: 20, buildingRow: 10, movable: 1 });
    expect(nextSupplyTarget([empty, open], from)?.buildingId).toBe(2);
    expect(nextSupplyTarget([empty], from)).toBeNull();
    expect(nextSupplyTarget([], from)).toBeNull();
  });

  it('sorts a list the same way it picks a single target', () => {
    const from: TileRef = { col: 2, row: 0 };
    const list = [
      supplyCandidate({ buildingId: 1, buildingCol: 4, buildingRow: 1, movable: 2 }),
      supplyCandidate({ buildingId: 2, buildingCol: 6, buildingRow: 1, movable: 8 }),
      supplyCandidate({ buildingId: 3, buildingCol: 5, buildingRow: 0, movable: 8 }),
    ];
    const sorted = [...list].sort((a, b) => compareSupplyCandidates(a, b, from));
    expect(sorted.map((c) => c.buildingId)).toEqual([3, 2, 1]);
  });
});

/**
 * OBS-7-01's floor, unit-tested here rather than through dispatch because no
 * integration fixture can separate the new term from the route term: a
 * candidate's `starving` flag and its distance are both consequences of where
 * the building stands and what it holds, and only a hand-built pair can hold
 * one fixed while moving the other.
 */
describe('the starvation floor', () => {
  it('a starving building outranks a topping-up one that is nearer', () => {
    // DISCRIMINATING: the starving candidate loses on every pre-existing term
    // — less movable stock (3 against 9), a route twenty tiles long against
    // two, and the HIGHER building id — so the only thing that can lift it is
    // the new one. Delete the starving term and the topping-up candidate wins.
    const from: TileRef = { col: 2, row: 0 };
    const toppingUp = supplyCandidate({ buildingId: 3, buildingCol: 4, buildingRow: 0, movable: 9 });
    const starving = supplyCandidate({ buildingId: 8, buildingCol: 20, buildingRow: 10, movable: 3, starving: true });
    expect(nextSupplyTarget([toppingUp, starving], from)?.buildingId).toBe(8);
    expect(nextSupplyTarget([starving, toppingUp], from)?.buildingId).toBe(8);
  });

  it('among starving buildings the nearer is still served first', () => {
    // The counter-direction the floor must not break: a term that swallowed
    // the rest of the order would send a hauler across the map past a starving
    // building it could have served on the way. Both are starving and both have
    // the same movable stock, so route is the only live term — and the nearer
    // one carries the HIGHER id, so the id tie-break cannot produce this answer.
    const from: TileRef = { col: 2, row: 0 };
    const far = supplyCandidate({ buildingId: 2, buildingCol: 20, buildingRow: 10, movable: 5, starving: true });
    const near = supplyCandidate({ buildingId: 6, buildingCol: 4, buildingRow: 0, movable: 5, starving: true });
    expect(nextSupplyTarget([far, near], from)?.buildingId).toBe(6);
    expect(nextSupplyTarget([near, far], from)?.buildingId).toBe(6);
  });

  it('among topping-up buildings nothing has changed', () => {
    // The regression guard: with nobody starving the order is exactly what it
    // was — movable descending, then the whole route, then the building id.
    // Building 9 and building 6 tie on both movable (8) and route (3), so only
    // the id separates them; building 7 wins on movable alone despite the
    // longest route of the four, and building 1 loses on movable alone despite
    // the shortest.
    const from: TileRef = { col: 2, row: 0 };
    const list = [
      supplyCandidate({ buildingId: 1, buildingCol: 4, buildingRow: 0, siteId: 2, movable: 2 }),
      supplyCandidate({ buildingId: 9, buildingCol: 2, buildingRow: 3, siteId: 4, movable: 8 }),
      supplyCandidate({ buildingId: 6, buildingCol: 5, buildingRow: 0, siteId: 5, movable: 8 }),
      supplyCandidate({ buildingId: 7, buildingCol: 20, buildingRow: 10, siteId: 3, movable: 11 }),
    ];
    const sorted = [...list].sort((a, b) => compareSupplyCandidates(a, b, from));
    expect(sorted.map((c) => c.buildingId)).toEqual([7, 6, 9, 1]);
  });

  it('the starving term does not disturb the id tie-breaks', () => {
    // Two candidates for the SAME starving building, equally far, differing
    // only in site id: the floor is a band, so it must leave a full tie a full
    // tie rather than making selection depend on candidate order.
    const from: TileRef = { col: 0, row: 0 };
    const viaA = supplyCandidate({
      buildingId: 1, buildingCol: 0, buildingRow: 0, siteId: 9, siteCol: 5, siteRow: 0, movable: 4, starving: true,
    });
    const viaB = supplyCandidate({
      buildingId: 1, buildingCol: 0, buildingRow: 0, siteId: 3, siteCol: -5, siteRow: 0, movable: 4, starving: true,
    });
    expect(nextSupplyTarget([viaA, viaB], from)?.siteId).toBe(3);
    expect(nextSupplyTarget([viaB, viaA], from)?.siteId).toBe(3);
  });
});

/**
 * §2.2's demand law. Absence is zero: a site nobody is nearest to gets no entry
 * at all, so every assertion below reads through this rather than through
 * `.get()?.get()`, and "no demand" and "zero demand" cannot drift apart.
 */
function demandFor(
  demand: Map<number, Map<ResourceId, number>>, siteId: number, resource: ResourceId,
): number {
  return demand.get(siteId)?.get(resource) ?? 0;
}

describe('siteDemandOf', () => {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: 2, row: 0, capacity: null };

  it('a building pulls on the site nearest to it, and on no other', () => {
    // DISCRIMINATING: the mill stands beside the DEPOT, twenty tiles from the
    // camp. A resolution hard-wired to the camp — the tempting shortcut, since
    // the camp is the one site guaranteed to exist — banks all twelve units at
    // site 0 and leaves site 3 empty, which is this assertion inverted.
    const depot: StoreSite = { id: 3, col: 20, row: 14, capacity: 60 };
    const mill: DemandSource = { col: 21, row: 14, inputs: ['wheat'] };
    const demand = siteDemandOf([camp, depot], [mill], 12, 12);
    expect(demandFor(demand, 3, 'wheat')).toBe(12);
    expect(demandFor(demand, CAMP_SITE_ID, 'wheat')).toBe(0);
  });

  it('two buildings nearest the same site add their demand', () => {
    // 2 x 7, not 7: an implementation that assigns instead of summing (or takes
    // a max) reports the target itself, so 14 and 7 must not coincide with any
    // other number in the fixture.
    const near: StoreSite = { id: 5, col: 2, row: 1, capacity: 60 };
    const far: StoreSite = { id: 3, col: 20, row: 14, capacity: 60 };
    const mills: DemandSource[] = [
      { col: 2, row: 2, inputs: ['wheat'] },
      { col: 3, row: 1, inputs: ['wheat'] },
    ];
    const demand = siteDemandOf([near, far], mills, 7, 12);
    expect(demandFor(demand, 5, 'wheat')).toBe(14);
    expect(demandFor(demand, 3, 'wheat')).toBe(0);
  });

  it('a building equidistant from two sites pulls on the lower id', () => {
    // The `closer` tie-break, inherited rather than reimplemented — so the
    // answer must not depend on the order the sites arrive in.
    const higher: StoreSite = { id: 9, col: 4, row: 0, capacity: 60 };
    const lower: StoreSite = { id: 3, col: 0, row: 0, capacity: 60 };
    const mill: DemandSource = { col: 2, row: 4, inputs: ['wheat'] }; // hypot(2, 4) from both
    for (const sites of [[higher, lower], [lower, higher]]) {
      const demand = siteDemandOf(sites, [mill], 5, 12);
      expect(demandFor(demand, 3, 'wheat')).toBe(5);
      expect(demandFor(demand, 9, 'wheat')).toBe(0);
    }
  });

  it('a site nearest to nothing has no demand for anything', () => {
    // The corner-chain depot in §4.3, and the case the push rule exists for.
    const near: StoreSite = { id: 5, col: 2, row: 1, capacity: 60 };
    const cornerDepot: StoreSite = { id: 8, col: 20, row: 14, capacity: 60 };
    const mill: DemandSource = { col: 3, row: 1, inputs: ['wheat'] };
    const demand = siteDemandOf([near, cornerDepot], [mill], 9, 12);
    expect(demandFor(demand, 5, 'wheat')).toBe(9);
    expect(demandFor(demand, 8, 'wheat')).toBe(0);
    expect(demand.get(8)).toBeUndefined();
  });

  it('the camp is an ordinary site here', () => {
    // A building beside the camp pulls on the camp, by the same nearest-site
    // rule as everything else. The camp is special in the push rule (§2.4) and
    // in being unbounded — never here.
    const depot: StoreSite = { id: 7, col: 20, row: 14, capacity: 60 };
    const mill: DemandSource = { col: 3, row: 0, inputs: ['wheat'] };
    const demand = siteDemandOf([camp, depot], [mill], 12, 12);
    expect(demandFor(demand, CAMP_SITE_ID, 'wheat')).toBe(12);
    expect(demandFor(demand, 7, 'wheat')).toBe(0);
  });

  it('demand is per-resource', () => {
    // Two inputs on ONE consumer, so a site's demand cannot be a single number
    // shared across resources, and the second input cannot be dropped in favour
    // of the first. `tools` is the workshop's OUTPUT: nobody demands it.
    const depot: StoreSite = { id: 4, col: 2, row: 1, capacity: 60 };
    const far: StoreSite = { id: 8, col: 20, row: 14, capacity: 60 };
    const workshop: DemandSource = { col: 2, row: 2, inputs: ['wheat', 'planks'] };
    const demand = siteDemandOf([depot, far], [workshop], 11, 12);
    expect(demandFor(demand, 4, 'wheat')).toBe(11);
    expect(demandFor(demand, 4, 'planks')).toBe(11);
    expect(demandFor(demand, 4, 'tools')).toBe(0);
  });

  it('a bounded site never demands more than it can hold above its floor', () => {
    // FIVE mills nearest one 60-unit depot at a target of 12 would demand 60.
    // Capped at capacity - reserveFreeSpace = 48. Without this the drain can
    // never fire — collect does not consult demand at all, so the depot still
    // reaches 60 of 60, and there `surplus = unclaimedAt - demand` is zero —
    // and the free floor is unreachable by any rule.
    //
    // DISCRIMINATING: five sources, not two. At two the uncapped total is 24
    // and the cap never binds, so the test would pass with the cap deleted.
    const depot: StoreSite = { id: 6, col: 2, row: 1, capacity: 60 };
    const far: StoreSite = { id: 9, col: 20, row: 14, capacity: 60 };
    const mills: DemandSource[] = [
      { col: 1, row: 1, inputs: ['wheat'] }, { col: 3, row: 1, inputs: ['wheat'] },
      { col: 2, row: 2, inputs: ['wheat'] }, { col: 1, row: 2, inputs: ['wheat'] },
      { col: 3, row: 2, inputs: ['wheat'] },
    ];
    const demand = siteDemandOf([depot, far], mills, 12, 12);
    expect(demandFor(demand, 6, 'wheat')).toBe(48);
  });

  it('an over-subscribed cap is split proportionally and floored', () => {
    // UNEQUAL shares on purpose: three wheat consumers to one flour consumer.
    // Raw wheat 36, flour 12, total 48; cap 50 - 20 = 30. Proportional gives
    // floor(36 * 30 / 48) = 22 and floor(12 * 30 / 48) = 7, total 29 — under
    // the cap, which is the safe direction. Every wrong rule lands elsewhere:
    // no cap 36/12, an equal split of the cap 15/15, first-takes-everything
    // 30/0, and unfloored 22.5/7.5. An all-equal fixture could not separate
    // "scale proportionally" from "divide the cap between the resources".
    const depot: StoreSite = { id: 6, col: 2, row: 1, capacity: 50 };
    const far: StoreSite = { id: 9, col: 20, row: 14, capacity: 60 };
    const consumers: DemandSource[] = [
      { col: 1, row: 1, inputs: ['wheat'] }, { col: 3, row: 1, inputs: ['wheat'] },
      { col: 2, row: 2, inputs: ['wheat'] },
      { col: 1, row: 2, inputs: ['flour'] },
    ];
    const demand = siteDemandOf([depot, far], consumers, 12, 20);
    expect(demandFor(demand, 6, 'wheat')).toBe(22);
    expect(demandFor(demand, 6, 'flour')).toBe(7);
  });

  it('the camp is never capped', () => {
    // Unbounded capacity, so no floor to reserve and no cap to apply. The pair
    // to the two tests above: with the null-capacity branch deleted the camp is
    // clamped against a capacity it does not have, which reads as zero and
    // silences the camp's demand entirely. ONE source with ONE input, so only
    // the missing branch can move this number.
    const mill: DemandSource = { col: 3, row: 0, inputs: ['wheat'] };
    const demand = siteDemandOf([camp], [mill], 30, 12);
    expect(demandFor(demand, CAMP_SITE_ID, 'wheat')).toBe(30);
  });

  it('demands nothing when there are no sites to demand it', () => {
    // `nearestSite` returns null only for an empty list. Real callers always
    // pass the camp, but the branch exists and would otherwise be unexercised.
    const mill: DemandSource = { col: 3, row: 0, inputs: ['wheat'] };
    expect(siteDemandOf([], [mill], 12, 12).size).toBe(0);
  });
});
