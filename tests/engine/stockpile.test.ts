import { describe, expect, it } from 'vitest';
import { CAMP_SITE_ID, CAMP_TILE, type StoreSite } from '../../src/shared/haul';
import { Stockpile } from '../../src/engine/stockpile';

function depot(capacity: number, id = 7): StoreSite {
  return { id, col: 20, row: 14, capacity };
}

function camp(): StoreSite {
  return { id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null };
}

describe('Stockpile — the aggregate (unchanged since before increment 7)', () => {
  it('adds and reads amounts, tracking per-tick production', () => {
    const stock = new Stockpile({ wood: 5 });
    stock.add('wood', 3);
    expect(stock.get('wood')).toBe(8);
    expect(stock.producedThisTick.get('wood')).toBe(3);
  });

  it('add saturates at the save-format counter ceiling, recording only what was banked', () => {
    const ceiling = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER
    const stock = new Stockpile({ wood: ceiling - 2 });
    stock.add('wood', 5);
    expect(stock.get('wood')).toBe(ceiling); // never past the load guard's bound
    expect(stock.producedThisTick.get('wood')).toBe(2); // stats see the real delta
    stock.add('wood', 1);
    expect(stock.get('wood')).toBe(ceiling);
    expect(stock.producedThisTick.get('wood')).toBe(2);
  });

  it('refund banks an amount without recording a delivery', () => {
    const stock = new Stockpile({ wood: 5 });
    stock.refund('wood', 3);
    expect(stock.get('wood')).toBe(8);
    expect(stock.producedThisTick.size).toBe(0); // unlike add, never touches delivery stats
  });

  it('refund saturates at the save-format counter ceiling, same clamp as add', () => {
    const ceiling = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER
    const stock = new Stockpile({ wood: ceiling - 2 });
    stock.refund('wood', 5);
    expect(stock.get('wood')).toBe(ceiling); // never past the load guard's bound
    expect(stock.producedThisTick.size).toBe(0);
  });

  it('take is all-or-nothing per resource and tracks consumption', () => {
    const stock = new Stockpile({ bread: 1 });
    expect(stock.take('bread', 1)).toBe(true);
    expect(stock.take('bread', 1)).toBe(false);
    expect(stock.get('bread')).toBe(0);
    expect(stock.consumedThisTick.get('bread')).toBe(1);
  });

  it('pay is all-or-nothing across the whole cost map', () => {
    const stock = new Stockpile({ wood: 20, planks: 5 });
    expect(stock.pay({ wood: 15, planks: 10 })).toBe(false);
    expect(stock.get('wood')).toBe(20); // nothing taken
    expect(stock.pay({ wood: 15, planks: 5 })).toBe(true);
    expect(stock.get('wood')).toBe(5);
    expect(stock.get('planks')).toBe(0);
  });

  it('pay with an empty cost map always succeeds', () => {
    expect(new Stockpile().pay({})).toBe(true);
  });

  it('resetTickFlows clears the per-tick maps but not the amounts', () => {
    const stock = new Stockpile();
    stock.add('wood', 2);
    stock.resetTickFlows();
    expect(stock.producedThisTick.size).toBe(0);
    expect(stock.get('wood')).toBe(2);
  });

  it('toJSON round-trips into the constructor', () => {
    const stock = new Stockpile({ wood: 7, bread: 2 });
    expect(new Stockpile(stock.toJSON()).get('wood')).toBe(7);
  });
});

describe('Stockpile — multi-site (increment 7)', () => {
  it('a colony with goods split across sites spends as one', () => {
    const s = new Stockpile({ wood: 10 });          // camp
    s.addAt(depot(60), 'wood', 15);                 // a depot
    expect(s.get('wood')).toBe(25);
    expect(s.pay({ wood: 20 })).toBe(true);         // neither site alone could
    expect(s.get('wood')).toBe(5);
  });

  it('spends the camp first, then sites by ascending id', () => {
    // Discriminating: no PREFIX of the draw order sums to the payment. A
    // fixture where some prefix happens to equal the payment (e.g. camp +
    // site 3 == 12 here previously) leaves the same residue regardless of
    // whether the camp or that site is drawn first, so it cannot tell the
    // two orders apart.
    const s = new Stockpile({ wood: 5 });
    s.addAt(depot(60, 9), 'wood', 2);
    s.addAt(depot(60, 3), 'wood', 8);
    expect(s.pay({ wood: 10 })).toBe(true);
    expect(s.getAt(CAMP_SITE_ID, 'wood')).toBe(0);
    expect(s.getAt(3, 'wood')).toBe(3);
    expect(s.getAt(9, 'wood')).toBe(2);
  });

  it('a bank beyond a site capacity spills to the camp rather than being lost', () => {
    // §2.4 invariant 1. DISCRIMINATING: assert BOTH sides — 60 at the depot and
    // 40 at the camp. An implementation that simply drops the excess passes any
    // assertion that only checks the depot.
    const s = new Stockpile();
    s.addAt(depot(60), 'wood', 100);
    expect(s.getAt(7, 'wood')).toBe(60);
    expect(s.getAt(CAMP_SITE_ID, 'wood')).toBe(40);
    expect(s.get('wood')).toBe(100);
  });

  it('the camp is unbounded', () => {
    const s = new Stockpile();
    s.addAt(camp(), 'wood', 10_000);
    expect(s.get('wood')).toBe(10_000);
  });

  it('toJSON is the camp alone, so a v5 stockpile round-trips unchanged', () => {
    const s = new Stockpile({ wood: 10 });
    s.addAt(depot(60), 'wood', 15);
    expect(s.toJSON()).toEqual({ wood: 10 });
    expect(s.siteJSON(7)).toEqual({ wood: 15 });
  });

  it('refundAt does not count as a delivery', () => {
    const s = new Stockpile();
    s.refundAt(depot(60), 'wood', 5);
    expect(s.producedThisTick.get('wood') ?? 0).toBe(0);   // and addAt makes this 5
  });

  it('totalAt sums every resource held at one site, not just one', () => {
    const s = new Stockpile();
    s.addAt(depot(60), 'wood', 10);
    s.addAt(depot(60), 'bread', 5);
    expect(s.totalAt(7)).toBe(15);
    expect(s.totalAt(CAMP_SITE_ID)).toBe(0); // a site nothing was banked at
  });

  it('siteIds lists camp first, then sites by ascending id', () => {
    const s = new Stockpile();
    s.addAt(depot(60, 9), 'wood', 1);
    s.addAt(depot(60, 3), 'wood', 1);
    expect(s.siteIds()).toEqual([CAMP_SITE_ID, 3, 9]);
  });

  it('takeAt takes up to what one site holds and returns the amount, without recording consumption', () => {
    // §2.4: leaving a site is not yet the colony spending it — takeAt must
    // never touch consumedThisTick, unlike take/pay/remove.
    const s = new Stockpile();
    s.addAt(depot(60), 'wood', 10);
    expect(s.takeAt(7, 'wood', 15)).toBe(10); // partial: only 10 was there
    expect(s.getAt(7, 'wood')).toBe(0);
    expect(s.consumedThisTick.size).toBe(0);
  });

  it('recordConsumed counts a spend without removing anything', () => {
    const s = new Stockpile({ wood: 10 });
    s.recordConsumed('wood', 4);
    expect(s.get('wood')).toBe(10); // nothing removed — takeAt already did that
    expect(s.consumedThisTick.get('wood')).toBe(4);
  });

  it('spillTo moves everything one site holds into another and empties the source', () => {
    const s = new Stockpile({ wood: 5 });
    s.addAt(depot(60), 'wood', 10);
    s.addAt(depot(60), 'bread', 3);
    s.spillTo(CAMP_SITE_ID, 7);
    expect(s.getAt(7, 'wood')).toBe(0);
    expect(s.getAt(7, 'bread')).toBe(0);
    expect(s.get('wood')).toBe(15);
    expect(s.get('bread')).toBe(3);
  });

  it('seedSite reconstructs a site\'s contents without recording a delivery', () => {
    // Restore-only (see the class doc on seedSite): a save taken mid-relocation
    // holds contents for a site the live list excludes, so this is the only way
    // to put stock at a site id with no corresponding StoreSite to bank against.
    const s = new Stockpile();
    s.seedSite(7, { wood: 12 });
    expect(s.getAt(7, 'wood')).toBe(12);
    expect(s.get('wood')).toBe(12);
    expect(s.producedThisTick.size).toBe(0);
  });
});
