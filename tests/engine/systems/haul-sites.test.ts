import { describe, expect, it } from 'vitest';
import { CAMP_SITE_ID, CAMP_TILE } from '../../../src/shared/haul';
import { storeSitesOf, type StoreSiteRow } from '../../../src/engine/systems/haul-sites';
import { PendingChanges } from '../../../src/engine/resources';

// Fixture discipline (increment 7, point 5): every row below uses its own id,
// col, row and capacity, none coinciding with the camp's id (0) or tile
// (CAMP_TILE), and none coinciding with each other — so a test that asserts
// "site X is present/absent" cannot pass by accident of a shared value.
function row(overrides: Partial<StoreSiteRow> = {}): StoreSiteRow {
  return { id: 7, col: 11, row: 6, capacity: 60, relocating: false, ...overrides };
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
