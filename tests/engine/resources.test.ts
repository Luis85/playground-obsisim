import { describe, expect, it } from 'vitest';
import { CommandQueue, IdCounter, NoticeBoard, StatsHistory, Stockpile } from '../../src/engine/resources';

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

describe('StatsHistory', () => {
  it('averages production and consumption over recorded frames', () => {
    const stats = new StatsHistory();
    stats.record(new Map([['wood', 2]]), new Map());
    stats.record(new Map(), new Map([['wood', 1]]));
    expect(stats.rates('wood')).toEqual({ production: 1, consumption: 0.5 });
  });

  it('returns zero rates with no history', () => {
    expect(new StatsHistory().rates('wood')).toEqual({ production: 0, consumption: 0 });
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
    queue.pending.push({ type: 'recruitWorker' });
    expect(queue.drain()).toHaveLength(1);
    expect(queue.pending).toHaveLength(0);
  });

  it('NoticeBoard takeAll returns and clears', () => {
    const board = new NoticeBoard();
    board.push('nope');
    expect(board.takeAll()).toEqual(['nope']);
    expect(board.takeAll()).toEqual([]);
  });
});
