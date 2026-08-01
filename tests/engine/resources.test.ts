import { describe, expect, it } from 'vitest';
import { CommandQueue, IdCounter, MAX_PENDING_COMMANDS, NoticeBoard, ProductionLedger, StatsHistory, Stockpile } from '../../src/engine/resources';

describe('Stockpile', () => {
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

describe('ProductionLedger', () => {
  it('accumulates per-resource amounts across multiple adds', () => {
    const ledger = new ProductionLedger();
    ledger.add('wood', 2);
    ledger.add('wood', 3);
    expect(ledger.madeThisTick.get('wood')).toBe(5);
  });

  it('reset clears the accumulated amounts', () => {
    const ledger = new ProductionLedger();
    ledger.add('wood', 2);
    ledger.reset();
    expect(ledger.madeThisTick.size).toBe(0);
  });
});

describe('StatsHistory', () => {
  it('averages delivered, consumed, and made over recorded frames', () => {
    // Three distinct values per frame (not just delivered-vs-consumed) so a
    // rates() that mixed up which map feeds which key — e.g. reporting made
    // where delivered belongs — would fail this, not slip through matching
    // numbers.
    const stats = new StatsHistory();
    stats.record(new Map([['wood', 2]]), new Map(), new Map([['wood', 4]]));
    stats.record(new Map(), new Map([['wood', 1]]), new Map([['wood', 2]]));
    expect(stats.rates('wood')).toEqual({ delivered: 1, consumed: 0.5, made: 3 });
  });

  it('returns zero rates with no history', () => {
    expect(new StatsHistory().rates('wood')).toEqual({ delivered: 0, consumed: 0, made: 0 });
  });
});

describe('small resources', () => {
  it('IdCounter hands out sequential ids from 1', () => {
    const ids = new IdCounter();
    expect(ids.take()).toBe(1);
    expect(ids.take()).toBe(2);
  });

  it('IdCounter can be seeded to continue past previously issued ids', () => {
    const ids = new IdCounter(4);
    expect(ids.peek()).toBe(4);
    expect(ids.take()).toBe(4);
    expect(ids.peek()).toBe(5);
  });

  it('IdCounter saturates exactly at the save-format counter ceiling', () => {
    const ceiling = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER
    const oneBelow = new IdCounter(ceiling - 1);
    expect(oneBelow.exhausted()).toBe(false); // one id left: take() lands peek() ON the ceiling
    expect(oneBelow.take()).toBe(ceiling - 1);
    expect(oneBelow.peek()).toBe(ceiling); // still a loadable nextEntityId
    expect(oneBelow.exhausted()).toBe(true); // another take() would write ceiling+1
  });

  it('CommandQueue drain empties the queue', () => {
    const queue = new CommandQueue();
    queue.push({ type: 'recruitWorker' });
    expect(queue.drain()).toHaveLength(1);
    expect(queue.size).toBe(0);
  });

  it('CommandQueue caps pending at MAX_PENDING_COMMANDS, counting overflow via takeDropped', () => {
    const queue = new CommandQueue();
    for (let i = 0; i < MAX_PENDING_COMMANDS + 5; i++) queue.push({ type: 'recruitWorker' });
    expect(queue.size).toBe(MAX_PENDING_COMMANDS);
    expect(queue.takeDropped()).toBe(5);
    expect(queue.takeDropped()).toBe(0); // reset on read
  });

  it('NoticeBoard takeAll returns and clears, tagged by kind', () => {
    const board = new NoticeBoard();
    board.reject('nope');
    board.succeed('yep');
    expect(board.takeAll()).toEqual([
      { kind: 'rejection', message: 'nope' },
      { kind: 'success', message: 'yep' },
    ]);
    expect(board.takeAll()).toEqual([]);
  });
});
