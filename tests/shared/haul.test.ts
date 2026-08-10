import { describe, expect, it } from 'vitest';
import type { TileRef } from '../../src/shared/placement';
import {
  CAMP_SITE_ID, CAMP_TILE, claimableAt, compareHaulCandidates, compareSupplyCandidates,
  haulDistance, haulTicks, haulTicksBetween, nearestSite, nearestSiteWithRoom, nextHaulTarget,
  nextSupplyTarget, sitesHolding,
  type HaulCandidate, type HaulKind, type HaulPhase, type StoreSite, type SupplyCandidate,
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
    resource: 'wheat', movable: 4,
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
