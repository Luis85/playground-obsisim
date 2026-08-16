import { describe, expect, it } from 'vitest';
import { CAMP_SITE_ID, CAMP_TILE } from '../../../src/shared/haul';
import type { HaulKind } from '../../../src/engine/components';
import { HaulTrip } from '../../../src/engine/components';
import { destinationFor, storeSitesOf, type StoreSiteRow } from '../../../src/engine/systems/haul-sites';
import { PendingChanges } from '../../../src/engine/resources';

// Fixture discipline (increment 7, point 5): every row below uses its own id,
// col, row and capacity, none coinciding with the camp's id (0) or tile
// (CAMP_TILE), and none coinciding with each other — so a test that asserts
// "site X is present/absent" cannot pass by accident of a shared value.
function row(overrides: Partial<StoreSiteRow> = {}): StoreSiteRow {
  return { id: 7, col: 11, row: 6, capacity: 60, relocating: false, underConstruction: false, ...overrides };
}

describe('storeSitesOf', () => {
  it('always leads with the camp, unbounded and at id 0', () => {
    const sites = storeSitesOf([], new PendingChanges());
    expect(sites).toEqual([{ id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null }]);
  });

  it('lists a live storehouse after the camp, ascending by id', () => {
    const near = row({ id: 3, col: 9, row: 4, capacity: 60 });
    const far = row({ id: 9, col: 20, row: 15, capacity: 30 });
    // Passed far-before-near on purpose: the result order must come from
    // ascending id, not from array/iteration order.
    const sites = storeSitesOf([far, near], new PendingChanges());
    expect(sites).toEqual([
      { id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null },
      { id: 3, col: 9, row: 4, capacity: 60 },
      { id: 9, col: 20, row: 15, capacity: 30 },
    ]);
  });

  it('excludes a relocating storehouse', () => {
    // A building mid-move provides none of its service — the same rule
    // beds.total already applies to a relocating house (increment 6).
    const settled = row({ id: 3, col: 9, row: 4, capacity: 60, relocating: false });
    const moving = row({ id: 5, col: 12, row: 8, capacity: 60, relocating: true });
    const sites = storeSitesOf([settled, moving], new PendingChanges());
    expect(sites.map((s) => s.id)).toEqual([CAMP_SITE_ID, 3]);
  });

  it('excludes a storehouse still under construction', () => {
    // A site is a hole in the ground, not a depot (spec §2.5) — the same rule
    // `relocating` applies above, on the other reason a building can be
    // standing on its tile while providing none of its service. A live row,
    // NOT a pending one: this is the site the post-step sync has already
    // published, so the exclusion has to come from the row's own flag.
    const built = row({ id: 3, col: 9, row: 4, capacity: 60, underConstruction: false });
    const site = row({ id: 5, col: 12, row: 8, capacity: 60, underConstruction: true });
    const sites = storeSitesOf([built, site], new PendingChanges());
    expect(sites.map((s) => s.id)).toEqual([CAMP_SITE_ID, 3]);
  });

  it('excludes a storehouse demolished earlier this tick', () => {
    // CommandSystem runs before HaulSystem and the entity survives until the
    // post-step sync, so without pending.demolished a hauler is dispatched to
    // a shed that is already gone.
    const alive = row({ id: 3, col: 9, row: 4, capacity: 60 });
    const gone = row({ id: 5, col: 12, row: 8, capacity: 60 });
    const pending = new PendingChanges();
    pending.demolished.add(gone.id);
    const sites = storeSitesOf([alive, gone], pending);
    expect(sites.map((s) => s.id)).toEqual([CAMP_SITE_ID, 3]);
  });

  it('does NOT include a storehouse constructed earlier this tick', () => {
    // Deliberate, and the opposite call from homing's pending.constructed
    // handling: a colonist left homeless beside a house built this tick is a
    // contradiction the player can SEE in one snapshot, while a hauler not
    // yet using a new shed is invisible and costs one tick. Simpler wins
    // here.
    //
    // A storehouse built this tick is absent from `rows` (the live query
    // does not see it until the post-step sync) — the real test is that
    // storeSitesOf does not reach into pending.constructed to fill that gap
    // even though the entry sits right there on the same object.
    const pending = new PendingChanges();
    pending.constructed.push({ id: 5, defId: 'storehouse', col: 12, row: 8 });
    const sites = storeSitesOf([], pending);
    expect(sites.map((s) => s.id)).toEqual([CAMP_SITE_ID]);
  });
});

/**
 * §2.5's remainder clause, from both sides. `remainderHome` is module-private
 * and reached only through `destinationFor`, so these two cases drive it from
 * there — and they are built by hand rather than run through a world because
 * the clause is a fact about ONE trip, and the pair must differ in exactly one
 * field: `kind`.
 *
 * The fixture is deliberately one where "back to your source" and "the nearest
 * site with room" are DIFFERENT answers, and where neither of them is the camp
 * — `destinationFor` falls back to the camp when everything else fails, so a
 * fixture whose right answer was the camp could not tell a resolution from a
 * collapse.
 */
const SOURCE_ID = 3;
const NEAR_ID = 5;
/** The far source the load was drawn from, and a near depot standing open. */
const SOURCE_TILE = { col: 20, row: 10 };
const NEAR_TILE = { col: 5, row: 1 };
/** Where the hauler is standing when it asks: one tile from the near depot,
 * most of the map from its own source. */
const STANDING = { col: 6, row: 1 };
const CAPACITY = 60;
const SOURCE_HELD = 10;
const CARRIED = 4;

const remainderSites = () => storeSitesOf([
  row({ id: SOURCE_ID, ...SOURCE_TILE, capacity: CAPACITY }),
  row({ id: NEAR_ID, ...NEAR_TILE, capacity: CAPACITY }),
], new PendingChanges());

const heldAt = (siteId: number) => (siteId === SOURCE_ID ? SOURCE_HELD : 0);

/** A hauler standing still with an UNDELIVERED load in its hands — every
 * condition `remainderHome` reads, set to the value that makes it fire. */
function carrying(kind: HaulKind): HaulTrip {
  const trip = new HaulTrip();
  trip.kind = kind;
  trip.phase = 'returning';
  trip.resource = 'wheat';
  trip.amount = CARRIED;
  trip.pickedUp = false;
  trip.sourceSiteId = SOURCE_ID;
  return trip;
}

/** Everything except `kind` that has to be true for a supply remainder to walk
 * home, asserted rather than assumed: without this the transfer case below
 * could pass because the fixture quietly failed some OTHER clause. */
function expectEveryRemainderConditionHolds(trip: HaulTrip, sites: readonly { id: number }[]): void {
  expect(trip.pickedUp).toBe(false);
  expect(trip.amount).toBeGreaterThan(0);
  expect(sites.map((s) => s.id)).toContain(SOURCE_ID);
  expect(heldAt(SOURCE_ID) + trip.amount).toBeLessThanOrEqual(CAPACITY); // the source has room for the WHOLE load
}

describe('where an undelivered load goes', () => {
  it('a supply remainder still goes home to its source', () => {
    // One half of the clause §2.5 gains in this increment, and the half that
    // was already law: routing a supply remainder onward would turn camp wheat
    // into depot stock without it ever being consumed.
    const sites = remainderSites();
    const trip = carrying('supply');
    expectEveryRemainderConditionHolds(trip, sites);

    const dest = destinationFor(trip, STANDING, sites, heldAt);
    expect(dest.id).toBe(SOURCE_ID);
    expect(trip.destSiteId).toBe(SOURCE_ID); // and the reservation moves with it
  });

  it('a transfer does not go home to its source', () => {
    // THE clause. Same fixture, same standing tile, same load — only `kind`
    // differs, and every condition that sent the supply remainder home above is
    // still true. A transfer that walked back to its source would undo itself:
    // it would spend a whole round trip to put the goods back where it found
    // them.
    const sites = remainderSites();
    const trip = carrying('transfer');
    expectEveryRemainderConditionHolds(trip, sites);

    const dest = destinationFor(trip, STANDING, sites, heldAt);
    expect(dest.id).toBe(NEAR_ID);
    expect(dest.id).not.toBe(SOURCE_ID);
    // Not the camp either, so this is a resolution rather than
    // `destinationFor`'s everything-failed fallback.
    expect(dest.id).not.toBe(CAMP_SITE_ID);
    expect(trip.destSiteId).toBe(NEAR_ID);
  });
});
