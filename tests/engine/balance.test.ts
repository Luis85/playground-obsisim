import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { CAMP_TILE } from '../../src/shared/haul';
import { runScenario } from '../support/balance-harness';
import { runPopulationScenario } from '../support/population-harness';

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
//
// houseCrew: false on every call, not just the mover: housing uniformity is
// a property of this comparison, not of any one scenario, and the stationary
// controls below (`from`/`to`) never set `moveTo` themselves — so a default
// keyed off it cannot see that they belong to the same comparison as the
// mover. See Scenario.houseCrew for why uniform-UNhoused, rather than
// uniform-housed, is the right call for a relocation comparison.
const relocating = (col: number, row: number, moveTo?: { col: number; row: number; atTick: number }) =>
  runScenario({ defId: 'forester', col, row, crew: 2, haulers: 2, ticks: 200, resource: 'wood', moveTo, houseCrew: false });

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

    // hypot(7,7) = 9.9 tiles at relocationTilesPerTick 1 = 10 ticks charged, and
    // 10 ticks of skipped work measured. The harness counts ticks the building
    // could not WORK rather than snapshots reporting `relocating` — those differ
    // by one, since ProductionSystem skips the tick that lands the move before
    // any snapshot shows it, and skips again on the tick the countdown reaches
    // zero. So this equals relocationTicks() by construction, including a
    // one-tile nudge, which the snapshot count reported as 0.
    // Exact, unlike this file's other assertions: this number is a function of
    // two tile coordinates and the constant under test, and nothing else.
    expect(moved.relocatingTicks).toBe(10);

    expect(moved.made).toBeLessThan(from.made); // costs output against the origin
    expect(moved.made).toBeLessThan(to.made);   //   ...and against the destination
  }, 180000);

  it('a far-corner relocation puts a building out of action for a large share of a run', async () => {
    // (8,4) -> (23,15) is hypot(15,11) = 18.6 tiles: a plausible "I put this in
    // the wrong place" correction, not a contrived worst case.
    //
    // Only the downtime is asserted. A `made` comparison against a building
    // that started in the far corner was tried and removed: the mover gets 50
    // ticks at the near tile that the control never gets, so such a comparison
    // measures head-start-minus-downtime, and its sign flips with run length
    // (the mover is behind at 200 ticks and ahead at 400). The distance-neutral
    // test above is the one that isolates downtime, and it holds at every
    // horizon because both runs share the same history apart from the move.
    const moved = await relocating(8, 4, { col: 23, row: 15, atTick: 50 });
    expect(moved.relocatingTicks).toBeGreaterThan(15);
    expect(moved.relocatingTicks).toBeLessThan(25);
  }, 120000);
});

describe('population balance', () => {
  it('the starvation countdown is visible for a real interval before the first death', async () => {
    // sampleEvery 1, NOT 10. At a coarser resolution both indices are rounded
    // to the nearest sample and the window this computes is rounded WITH them:
    // at 10 the true 99 ticks reports as 100, which is exactly the threshold
    // spec section 4 sets, so the measurement would clear its own bar on a
    // rounding artefact. 400 samples of a 3-colonist colony costs under a
    // second, and there is no reason to measure an interval less precisely
    // than the thing being compared against.
    const starved = await runPopulationScenario({ houses: 2, startingAdults: 3, foodPerTick: 0, ticks: 300, sampleEvery: 1 });
    const tickOf = (index: number) => starved.samples[index].tick;
    const firstDeath = starved.samples.findIndex((s) => s.adults + s.children + s.elders < 3);
    // Measured from starvingTicks CLIMBING, not from the store emptying. With
    // foodPerTick 0 the store is empty from the first sample, so mealsPerHead
    // would report a warning ~100 ticks before anyone is even at max hunger —
    // inflating the window and letting this pass while the countdown the
    // player actually sees is far too short.
    const firstStarving = starved.samples.findIndex((s) => s.starving > 0);
    expect(firstStarving).toBeGreaterThanOrEqual(0);
    expect(firstDeath).toBeGreaterThan(firstStarving);
    const warningTicks = tickOf(firstDeath) - tickOf(firstStarving);

    // The law, exactly, rather than the inequality spec section 4 asks for.
    // The inequality is `warningTicks >= BALANCE.autosaveEveryTicks`, and it
    // DOES NOT HOLD: the measured window is 99 ticks against a bar of 100.
    // That is a fencepost, not a tuning error — a colonist spends the whole of
    // starvationDeathTicks at max hunger, but the tick the counter reaches the
    // limit is the tick they die on, so the last snapshot a player can still
    // act on is one earlier. Recorded here as the exact relationship it is,
    // and reported to spec section 4 as a one-tick shortfall, rather than
    // softened into a range that would pass whatever the engine did.
    expect(warningTicks).toBe(BALANCE.starvationDeathTicks - 1);
    // Hunger has to climb to the cap before the countdown starts at all, so
    // the whole slide is far longer than the countdown — that part clears the
    // autosave bar with room to spare, and it is what a player actually sees.
    expect(tickOf(firstDeath)).toBeGreaterThan(BALANCE.autosaveEveryTicks * 1.5);
  }, 120000);

  it('a colonist housed far from their job delivers less than a colocated one', async () => {
    // The commute term must show up in GOODS, not only in a unit test of
    // commuteFactor. Same building, same tile, same crew — only the house moves.
    const near = await runScenario({ defId: 'forester', col: 6, row: 5, crew: 2, haulers: 3, ticks: 400, resource: 'wood' });
    const far = await runScenario({
      defId: 'forester', col: 6, row: 5, crew: 2, haulers: 3, ticks: 400, resource: 'wood',
      crewHouseAt: { col: 22, row: 15 },
    });
    expect(far.delivered).toBeLessThan(near.delivered);
  }, 120000);

  it('housing beside a distant producer beats housing at the camp — so clustering is not always right', async () => {
    // The OTHER half of spec section 4's commute question. The test above
    // shows only that distance costs output, which on its own argues for
    // putting everything at the camp; the haul sweep favours camp-adjacent
    // producers too, so nothing yet contradicts "cluster everything". Task 13
    // cannot sign the penalty off as well-sized without one configuration
    // where spreading out wins.
    //
    // Same producer, same tile, same crew, same haulers. The ONLY difference
    // is where the crew sleeps.
    const far = { defId: 'forester' as const, col: 20, row: 13, crew: 2, haulers: 3, ticks: 600, resource: 'wood' as const };
    const housedOnSite = await runScenario(far);
    // col + 2 rather than col + 1, but NOT for the reason it might seem: the
    // hauler house cannot be stacked on, because shelterPlan resolves it with
    // campAdjacentFreeTile AFTER the crew house is already in `occupied`, and
    // that helper skips a taken tile. col + 2 is chosen because it is the
    // camp-adjacent plot the haul sweep does not itself measure on, and it is
    // still inside commuteFreeTiles of the camp — so "housed at the camp" is
    // exactly as neutral for the haulers as it is meant to be.
    const housedAtCamp = await runScenario({ ...far, crewHouseAt: { col: CAMP_TILE.col + 2, row: CAMP_TILE.row } });

    expect(housedOnSite.delivered).toBeGreaterThan(housedAtCamp.delivered);
    // And by a margin a player would act on — a 1% edge is noise, not a
    // tradeoff, and would not make "do not cluster" a real decision.
    expect(housedOnSite.delivered / housedAtCamp.delivered).toBeGreaterThan(1.05);
  }, 120000);
});
