import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { runScenario } from '../support/balance-harness';

// The measured shape of increment 4's haul constants, pinned so a later change
// to outputBufferCap / haulCarryCapacity / haulTilesPerTick cannot quietly
// flatten it. Assertions are on the THRESHOLDS the gradient implies, never on
// exact unit counts: pinning `delivered === 394` would fail on any unrelated
// recipe change and would teach nobody anything.
//
// Increment 4 §4 claimed one hauler roughly sustains one FAR producer. It does
// not — a far producer needs three. The gradient is sound; the claim was wrong.

const TICKS = 600;
const forester = (col: number, row: number, haulers: number) =>
  runScenario({ defId: 'forester', col, row, crew: 2, haulers, ticks: TICKS, resource: 'wood' });

// 200 ticks, not TICKS: a relocation is a one-off event, and a 600-tick run
// dilutes it below the noise of the surrounding steady state.
const relocating = (col: number, row: number, moveTo?: { col: number; row: number; atTick: number }) =>
  runScenario({ defId: 'forester', col, row, crew: 2, haulers: 2, ticks: 200, resource: 'wood', moveTo });

const share = (r: { delivered: number; ceiling: number }) => r.delivered / r.ceiling;

describe('haul balance gradient', () => {
  it('a building beside the camp is fully served by one hauler', async () => {
    const r = await forester(3, 0, 1);
    expect(r.legTicks).toBe(1);
    expect(share(r)).toBeGreaterThan(0.95);
    expect(r.stalledTicks).toBe(0);
  }, 60000);

  it('one hauler still keeps up at the crossover distance', async () => {
    const r = await forester(8, 4, 1);
    expect(r.legTicks).toBe(4);
    expect(share(r)).toBeGreaterThan(0.95);
  }, 60000);

  it('mid-distance needs a second hauler — one is not enough', async () => {
    const one = await forester(15, 8, 1);
    const two = await forester(15, 8, 2);
    expect(one.legTicks).toBe(8);
    expect(share(one)).toBeLessThan(0.7);   // one hauler visibly fails
    expect(one.stalledTicks).toBeGreaterThan(0);
    expect(share(two)).toBeGreaterThan(0.95); // two recovers it
  }, 120000);

  it('the far corner needs a third hauler', async () => {
    const two = await forester(23, 15, 2);
    const three = await forester(23, 15, 3);
    expect(two.legTicks).toBe(13);
    expect(share(two)).toBeLessThan(0.8);     // two is still short
    expect(share(three)).toBeGreaterThan(0.95);
  }, 120000);

  it('a full buffer is cleared by exactly two hauler trips', async () => {
    // outputBufferCap 12, haulCarryCapacity 6 — the claim increment 4 made for
    // these two constants together, stated as a ratio rather than as magnitudes.
    expect(BALANCE.outputBufferCap / BALANCE.haulCarryCapacity).toBe(2);
  });

  it('prints the sweep when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    const lines = ['', 'tile        leg  haulers  delivered  %ceiling  stalled%  idle'];
    for (const [col, row] of [[3, 0], [8, 4], [15, 8], [23, 15]] as const) {
      for (const haulers of [1, 2, 3, 4]) {
        const r = await forester(col, row, haulers);
        lines.push(
          `(${String(col).padStart(2)},${String(row).padStart(2)})   ${String(r.legTicks).padStart(3)}  ` +
          `${String(haulers).padStart(7)}  ${String(r.delivered).padStart(9)}  ` +
          `${(share(r) * 100).toFixed(0).padStart(8)}  ${((r.stalledTicks / TICKS) * 100).toFixed(0).padStart(8)}  ${String(r.haulerIdleTicks).padStart(4)}`,
        );
      }
    }
    console.log(lines.join('\n'));
  }, 600000);

  it('relocation downtime costs output even when the move changes nothing else', async () => {
    // (10,0) and (3,7) are BOTH leg 4 from the camp, so relocating between them
    // changes nothing about haulage — the only difference is that the building
    // stops working. Distance-neutrality is asserted below, not trusted to this
    // comment. Without this control the `made` comparison would be satisfied by
    // the destination simply being further away, and would stay green with
    // relocation costing no production at all.
    const from = await relocating(10, 0);
    const to = await relocating(3, 7);
    const moved = await relocating(10, 0, { col: 3, row: 7, atTick: 50 });

    expect(from.legTicks).toBe(to.legTicks); // the move is distance-neutral, by measurement

    // hypot(7,7) = 9.9 tiles at relocationTilesPerTick 1 = 10 ticks charged.
    // ProductionSystem runs after CommandSystem, so the countdown ticks down in
    // the same step the command lands and 9 snapshots report `relocating`.
    // Exact, unlike this file's other assertions: this number is a function of
    // two tile coordinates and the constant under test, and nothing else.
    expect(moved.relocatingTicks).toBe(9);

    expect(moved.made).toBeLessThan(from.made); // costs output against the origin
    expect(moved.made).toBeLessThan(to.made);   //   ...and against the destination
  }, 180000);

  it('a far-corner relocation costs more than starting far ever does', async () => {
    // (8,4) -> (23,15) is hypot(15,11) = 18.6 tiles: a plausible "I put this in
    // the wrong place" correction, not a contrived worst case.
    const stayed = await relocating(8, 4);       // leg 4 all run
    const settledFar = await relocating(23, 15); // leg 13 all run, never moves
    const moved = await relocating(8, 4, { col: 23, row: 15, atTick: 50 });

    expect(moved.relocatingTicks).toBeGreaterThan(15);
    expect(moved.relocatingTicks).toBeLessThan(25);

    // Distance alone predicts the OPPOSITE of what happens. The mover spends
    // its first 50 ticks at the near tile, where `stayed` runs at full rate, so
    // it should finish ahead of a building that sat in the far corner all run.
    // It finishes behind: the downtime more than cancels a 50-tick head start.
    // This is the comparison §4 of the spec cites.
    expect(moved.made).toBeLessThan(settledFar.made);
    expect(settledFar.made).toBeLessThan(stayed.made);
  }, 180000);
});
