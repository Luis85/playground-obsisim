import { describe, expect, it } from 'vitest';
import { runScenario } from './balance-harness';

describe('balance harness', () => {
  it('is deterministic — the same scenario twice gives identical numbers', async () => {
    const scenario = { defId: 'forester' as const, col: 8, row: 4, crew: 2, haulers: 1, ticks: 60, resource: 'wood' as const };
    const a = await runScenario(scenario);
    const b = await runScenario(scenario);
    expect(a).toEqual(b);
  });

  it('separates what was made from what was delivered', async () => {
    // No haulers: the forester fills its buffer and stalls. Everything it makes
    // is real production; none of it reaches the store.
    const r = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 0, ticks: 120, resource: 'wood' });
    expect(r.made).toBeGreaterThan(0);
    expect(r.delivered).toBe(0);
    expect(r.finalBuffer).toBeGreaterThan(0);
    expect(r.stalledTicks).toBeGreaterThan(0);
  });

  it('reports the leg length and the unhauled production ceiling', async () => {
    // (8,4) is hypot(6,4) = 7.21 tiles from camp; at 2 tiles/tick that is 4.
    const r = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 1, ticks: 60, resource: 'wood' });
    expect(r.legTicks).toBe(4);
    // 2 workers = 2 work/tick, 3 ticks/batch, 1 wood per batch.
    expect(r.ceiling).toBeCloseTo(40, 5);
  });

  it('counts hauler idle ticks so over-provisioning is visible', async () => {
    // A building beside the camp cannot keep one hauler busy.
    const r = await runScenario({ defId: 'forester', col: 3, row: 0, crew: 2, haulers: 1, ticks: 120, resource: 'wood' });
    expect(r.haulerIdleTicks).toBeGreaterThan(0);
    expect(r.stalledTicks).toBe(0);
  });
});
