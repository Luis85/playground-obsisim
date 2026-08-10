import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { CAMP_TILE } from '../../src/shared/haul';
import type { TileRef } from '../../src/shared/placement';
import { runScenario, type BalanceResult } from '../support/balance-harness';
import { runPopulationScenario, type PopulationResult } from '../support/population-harness';

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
    // OBS-6-02's regression sentinel, and this is the scenario that earns it:
    // three colonists with no food at all die within two ticks of each other,
    // so before the fix this run lost 2 steps to the removal freeze and every
    // long curve in the report reported 0. A tick label is only quotable while
    // this is zero — see PopulationResult.frozenSteps.
    expect(starved.frozenSteps).toBe(0);
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

// 'chain', not a drip: spec section 4's first question is about a working food
// chain, and a drip supplies food regardless of how many adults are alive —
// holding constant the exact feedback loop under test.
//
// TWO huts, not four. With four the chain out-produces 48 beds and the roomy
// run below becomes a housing plateau wearing a demographic disguise, which
// answers nothing. Two gatherers' huts is four slots, and the huts are placed
// BEFORE the houses so that both runs in a comparison get the same hut tiles
// whatever their house count (see placeColony).
const chain = { startingAdults: 4, foodPerTick: 'chain' as const, huts: 2, haulers: 2 };
const LONG = { ticks: 12000, sampleEvery: 200 };
const ROOMY_HOUSES = 12;
/**
 * The house count at which a depot the harness places actually becomes a store
 * site, so §4.1's fourth reading measures the depot rather than measuring the
 * same run twice.
 *
 * `autoPlaceSequence` yields 40 plots (5 per row, odd rows) before it falls
 * back to a row-major scan, and this harness lays huts, then houses, then
 * depots. With ROOMY_HOUSES the two depots land at plots 15 and 16, further out
 * than the two huts at plots 1 and 2 — the camp is nearer to both huts than
 * either depot is, so nothing is ever banked in one. At 40 houses the depots
 * fall past the plot pass onto row 0, beside the camp band, where they ARE the
 * nearest site to the huts. Measured over 1,500 ticks: `storedAtEnd` is 0 at
 * 12 and 30 houses and 120 (both depots full) at 40, 60 and 78, with births
 * and final population identical in every one of them.
 */
const DEPOT_HOUSES = 40;
const populationOf = (s: { children: number; adults: number; elders: number }) => s.children + s.adults + s.elders;
const peakOf = (r: { samples: { children: number; adults: number; elders: number }[] }) =>
  Math.max(...r.samples.map(populationOf));

describe('population balance — the long curve', () => {
  it('a colony feeding itself settles at its FOOD CHAIN and holds there for a whole generation', async () => {
    // 12,000 ticks and generous housing, so FOOD and demographics — not bed
    // count — decide the curve. This is the minimum that answers the question,
    // not a round number: founders start at matureTicks and the first
    // generation dies between 5,700 and 7,300, so this spans a whole life plus
    // enough of the next generation to tell an oscillation from a plateau.
    const roomy = await runPopulationScenario({ ...chain, ...LONG, houses: ROOMY_HOUSES });
    const capped = await runPopulationScenario({ ...chain, ...LONG, houses: 1 });
    const roomyPeak = peakOf(roomy);

    // It really grew, rather than merely surviving: a colony that never breeds
    // would sit at startingAdults and satisfy every relationship below by
    // being flat.
    expect(roomyPeak).toBeGreaterThan(chain.startingAdults * 4);
    // The roomy run is only a control if BEDS never bind. 12 houses is 48 beds
    // and one birth per 50 ticks fills the 44 openings in ~2,200 of 12,000 —
    // so if food turned out to sustain that many, this "roomy" curve would be a
    // housing plateau, and Task 13 could not tell stability from a cap.
    // Measured: the ceiling is 40 against 48 beds.
    expect(roomyPeak).toBeLessThan(ROOMY_HOUSES * BALANCE.houseBeds);

    // And the cap is BEDS in the control, not food: one house is four beds for
    // four founders, so spareBeds is 0 from the first tick and never recovers.
    expect(capped.births).toBe(0);
    expect(capped.births).toBeLessThan(roomy.births);
    expect(capped.deathsByStarvation).toBe(0);

    // THE FINDING, and what this test asserted the opposite of until the
    // birthFoodPerHead retune. At 6 the same fixture peaked at 41 and was
    // extinct by tick 7,800 with 24 starvation deaths; the conclusion drawn
    // from that — that no store threshold could help, because a stock test
    // cannot ask "is there work for this colonist" — was wrong. A stock test
    // sets the RESERVE a colony still holds when growth stops, and a reserve
    // is exactly what absorbs the overshoot matureTicks guarantees. At 12 the
    // curve is a plateau: peak 40 around tick 4,000, 39 at tick 12,000, and
    // nobody starves at any point in between. See spec section 4.1 for the
    // sweep, including the four values below 10 that still die.
    //
    // Nothing here is a range chosen to fit. `toBe(0)` on starvation is the
    // strongest form available and fails at 24 for the shipped value; the
    // 0.8 floor fails at 0. Both would fail again on any retune back down.
    expect(roomy.deathsByStarvation).toBe(0);
    expect(populationOf(roomy.samples.at(-1)!)).toBeGreaterThan(roomyPeak * 0.8);
    // The original acceptance criterion Task 12 proposed and could not meet.
    // Kept as its own line, well below the assertion above, because it is the
    // bar the increment set rather than the one the measurement reached.
    expect(populationOf(roomy.samples.at(-1)!)).toBeGreaterThan(chain.startingAdults);

    // And a plateau rather than a lucky endpoint: the deepest trough after the
    // founders' generation has died out still holds most of the peak. Without
    // this the two assertions above are satisfied by a colony that collapsed
    // to 3 at tick 6,000 and rebuilt by 12,000 — which is the overshoot
    // failure, merely caught on an upswing. Measured trough: 34.
    const trough = Math.min(...roomy.samples.filter((s) => s.tick >= 3000).map(populationOf));
    expect(trough).toBeGreaterThan(roomyPeak * 0.6);
  }, 300000);

  it('that ceiling is the chain PRODUCING, not the harness under-hauling it', async () => {
    // Without this the previous test cannot tell a balance property from a
    // fixture choice: `haulers: 2` is the harness's number, and a colony whose
    // berries pile up in a hut buffer would plateau for a reason that says
    // nothing about birthFoodPerHead. Same colony, one extra hauler, and the
    // ceiling has to be unchanged.
    //
    // 3,500 ticks, not 12,000: the colony is within a few colonists of its
    // ceiling by then (37 of an eventual 40) and this compares ceilings, not
    // endings. Two full-length runs would cost a minute to measure a number
    // both would have settled long before.
    const short = { ticks: 3500, sampleEvery: 100, houses: ROOMY_HOUSES };
    const twoHaulers = await runPopulationScenario({ ...chain, ...short });
    const threeHaulers = await runPopulationScenario({ ...chain, ...short, haulers: 3, startingAdults: 5 });
    // Not `toBe`: the third hauler is one more mouth and one fewer pair of
    // hands in a hut, so an exact tie would be a coincidence. Within a couple
    // of colonists is the claim — haulage is not what is holding the colony
    // down.
    expect(Math.abs(peakOf(threeHaulers) - peakOf(twoHaulers))).toBeLessThanOrEqual(3);
  }, 180000);

  it('a birth burst becomes a retirement bulge one generation later', async () => {
    const long = await runPopulationScenario({ houses: 6, startingAdults: 2, foodPerTick: 8, ticks: 9000, sampleEvery: 100 });
    const peakChildren = long.samples.reduce((best, s, i) => (s.children > long.samples[best].children ? i : best), 0);
    const peakElders = long.samples.reduce((best, s, i) => (s.elders > long.samples[best].elders ? i : best), 0);

    // Non-vacuity FIRST. With no births at all, every sample ties at
    // children === 0, peakChildren stays pinned at index 0, and the two
    // FOUNDERS becoming elders around tick 4,500 clears the gap threshold on
    // their own — so the test would pass without a single birth cohort ever
    // reaching old age, which is the entire behaviour its name claims.
    expect(long.births).toBeGreaterThan(0);
    expect(long.samples[peakChildren].children).toBeGreaterThan(0);
    // And the elder peak must belong to that cohort, not to the founders:
    // it has to arrive at least a maturity-to-retirement span after the
    // children peaked, and outnumber the founders who were alive at tick 0.
    expect(long.samples[peakElders].elders).toBeGreaterThan(2);
    const gapTicks = long.samples[peakElders].tick - long.samples[peakChildren].tick;
    expect(gapTicks).toBeGreaterThan(BALANCE.lifeBands.retireTicks * 0.6);
  }, 180000);
});

/** One curve, as a block of fixed-width rows. Deliberately NOT the sweep's
 * `(col,row)` shape: increment 5's regression procedure extracts its 16 rows
 * with `grep -E '^\(\s*[0-9]+,'`, and a population row that matched would be
 * diffed against a haul row. */
function curveLines(title: string, result: PopulationResult): string[] {
  const lines = ['', title, '   tick  child  adult  elder    pop  meals/head  starving'];
  for (const s of result.samples) {
    lines.push(
      `  ${String(s.tick).padStart(5)}  ${String(s.children).padStart(5)}  ${String(s.adults).padStart(5)}` +
      `  ${String(s.elders).padStart(5)}  ${String(s.children + s.adults + s.elders).padStart(5)}` +
      `  ${s.mealsPerHead.toFixed(1).padStart(10)}  ${String(s.starving).padStart(8)}`,
    );
  }
  const final = result.samples.at(-1)!;
  lines.push(
    `  births ${result.births}, died of old age ${result.deathsByOldAge}, starved ${result.deathsByStarvation},` +
    ` peak ${peakOf(result)}, final ${populationOf(final)}, dependency ${result.dependencyRatio.toFixed(2)},` +
    ` frozen steps ${result.frozenSteps}`,
  );
  return lines;
}

describe('population report', () => {
  it('prints the population curve when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // The three curves behind section 4 of the increment-6 spec, printed beside
    // the distance/hauler sweep. Re-run rather than shared with the assertions
    // above: a memo across `it` blocks would make one test's numbers depend on
    // whether another ran, and `-t` filtering makes that reachable by accident.
    const roomy = await runPopulationScenario({ ...chain, ...LONG, houses: ROOMY_HOUSES });
    const capped = await runPopulationScenario({ ...chain, ...LONG, houses: 1 });
    const drip = await runPopulationScenario({ houses: 6, startingAdults: 2, foodPerTick: 8, ticks: 9000, sampleEvery: 500 });
    const starved = await runPopulationScenario({ houses: 2, startingAdults: 3, foodPerTick: 0, ticks: 300, sampleEvery: 1 });
    const tickWhere = (predicate: (s: PopulationResult['samples'][number]) => boolean) =>
      starved.samples.find(predicate)?.tick ?? -1;
    const firstStarving = tickWhere((s) => s.starving > 0);
    const firstDeath = tickWhere((s) => s.adults + s.children + s.elders < 3);

    console.log([
      ...curveLines(`self-feeding chain, ${ROOMY_HOUSES} houses / ${chain.huts} huts / ${chain.haulers} haulers`, roomy),
      ...curveLines(`self-feeding chain, 1 house / ${chain.huts} huts / ${chain.haulers} haulers (bed-capped control)`, capped),
      ...curveLines('bread drip 8/tick, 6 houses, 2 founders', drip),
      '',
      'starvation warning, 3 colonists, no food at all',
      `  first starvingTicks at ${firstStarving}, first death at ${firstDeath},` +
      ` window ${firstDeath - firstStarving} ticks against an autosave interval of ${BALANCE.autosaveEveryTicks}`,
      // frozenSteps printed BY HAND, because this scenario is the only one in
      // the report that does not go through curveLines — and it is the one
      // that used to be non-zero, losing 2 steps to OBS-6-02 when all three
      // colonists starved within a couple of ticks of each other. Printing the
      // field only on the curves made it "published rather than hidden" in the
      // type and invisible in the output, which is the opposite of the point.
      // It reads 0 now and is asserted to; it stays in the report so that the
      // number a tick label depends on is visible beside the label.
      `  frozen steps ${starved.frozenSteps} — OBS-6-02's sentinel, and what makes the two ticks` +
      ' above quotable: a non-zero figure means the run simulated fewer ticks than it counted',
    ].join('\n'));
  }, 600000);

  it('prints the population depot reading when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Section 4.1's FOURTH reading — the 12,000-tick chain repeated with and
    // without a depot — plus the control pair that says whether the reading is
    // a reading at all.
    //
    // At ROOMY_HOUSES the depot is placed at a plot the huts already beat: the
    // first two huts take the two plots nearest the camp, so the camp stays
    // nearest to everything and nothing is ever banked (see
    // PopulationScenario.storehouses). DEPOT_HOUSES is the smallest house count
    // measured to push the depots past the 40-plot pass and into the row-major
    // one, where they land beside the camp band and DO take stock — which is
    // why every row prints `stored`: a with-depot row reading 0 there is a run
    // compared against itself, whatever its population figures say.
    const rows = [[ROOMY_HOUSES, 0], [ROOMY_HOUSES, 2], [DEPOT_HOUSES, 0], [DEPOT_HOUSES, 2]] as const;
    const lines = ['', 'the fourth reading: 12,000-tick chain, with and without a depot',
      '  houses  depots  stored  peak  final  trough  births  starved  frozen  min meals/head'];
    for (const [houses, storehouses] of rows) {
      const r = await runPopulationScenario({ ...chain, ...LONG, houses, storehouses });
      const trough = Math.min(...r.samples.filter((s) => s.tick >= 3000).map(populationOf));
      lines.push(
        `  ${String(houses).padStart(6)}  ${String(storehouses).padStart(6)}  ${String(r.storedAtEnd).padStart(6)}` +
        `  ${String(peakOf(r)).padStart(4)}  ${String(populationOf(r.samples.at(-1)!)).padStart(5)}  ${String(trough).padStart(6)}` +
        `  ${String(r.births).padStart(6)}  ${String(r.deathsByStarvation).padStart(7)}  ${String(r.frozenSteps).padStart(6)}` +
        `  ${Math.min(...r.samples.map((s) => s.mealsPerHead)).toFixed(1).padStart(14)}`,
      );
    }
    console.log(lines.join('\n'));
  }, 900000);
});

// The instruments spec section 4 needs, and the sentinels that keep their
// numbers quotable. Every fixture below is a CHAIN — a forester feeding a
// sawmill at a distance — because that is the shape both of section 4.1's
// first two questions are asked in, and because two buildings' goods in flight
// at once is exactly the condition under which a per-stage figure that read
// the wrong stage would still look plausible.

/**
 * A chain hauled well enough that the raw producer never backs up: four
 * haulers over a leg-4 forester and a leg-6 sawmill.
 *
 * The forester's crew is 2 and the sawmill's is 1, so no per-stage figure
 * coincides with any other — different def, different resource, different
 * tile, different ceiling. A harness that reported stage 0's numbers for both
 * stages would pass a fixture whose stages agreed.
 */
const suppliedChain = (storehouses?: TileRef[]) => runScenario({
  defId: 'forester', col: 8, row: 4, crew: 2, haulers: 4, ticks: TICKS, resource: 'wood',
  second: { defId: 'sawmill', col: 11, row: 6, crew: 1, resource: 'planks' },
  storehouses,
});

/** The same chain stretched out to leg 6 and leg 8 with one hauler fewer, so
 * the forester spends most of the run stalled on a full buffer and the sawmill
 * spends part of it waiting for input — the two diagnostics, one per stage. */
const stretchedChain = (storehouses?: TileRef[]) => runScenario({
  defId: 'forester', col: 12, row: 6, crew: 2, haulers: 3, ticks: TICKS, resource: 'wood',
  second: { defId: 'sawmill', col: 15, row: 9, crew: 1, resource: 'planks' },
  storehouses,
});

describe('the two-way haul instruments', () => {
  it('gross production is what the ledger recorded, not what every hauler happens to be holding', async () => {
    const r = await suppliedChain();

    // Non-vacuity, and it is the whole point: goods really were in haulers'
    // hands when the run ended. That total — every load, of every resource, in
    // every direction — is precisely what the old `made` added to each stage,
    // so a run ending with empty hands could not tell the two derivations
    // apart.
    expect(r.carriedAtEnd).toBeGreaterThan(0);

    // The raw producer never stalled, so its gross output is a function of its
    // crew and the clock alone: 600 ticks x 2 workers / 3 ticks per batch.
    // EXACT, unlike this file's throughput assertions, because nothing about
    // hauling enters it — which is what makes it able to catch a `made` that
    // has hauled goods mixed into it.
    expect(r.stages[0].stalledTicks).toBe(0);
    expect(r.stages[0].made).toBe(r.stages[0].ceiling);

    // And the processor's figure is its own production, strictly less than the
    // where-are-the-goods-standing reconstruction it replaced. Six wood walking
    // TOWARD this sawmill are not six planks it produced.
    expect(r.stages[1].made).toBeLessThan(r.stages[1].delivered + r.stages[1].finalBuffer + r.carriedAtEnd);

    // `delivered` can never exceed `made` — a hauler cannot deliver more of a
    // resource than the stage that owns it produced. This holds for `made`
    // (checked above) precisely because it is now read from the ledger rather
    // than reconstructed; it is NOT independently checked for `delivered`
    // anywhere else. A harness that read stage 0's delivered figure (the
    // forester's WOOD, hauled in to feed the sawmill) for stage 1 would push
    // this well past `made`, since wood delivered to feed a hungry sawmill
    // outruns the planks the sawmill itself is producing.
    expect(r.stages[1].delivered).toBeLessThanOrEqual(r.stages[1].made);
  }, 120000);

  it('a two-stage chain reports each building separately, and feeds itself', async () => {
    const r = await stretchedChain();

    expect(r.stages).toHaveLength(2);
    expect(r.stages.map((s) => s.defId)).toEqual(['forester', 'sawmill']);
    expect(r.stages.map((s) => s.resource)).toEqual(['wood', 'planks']);
    // Crew 2 against crew 1, and leg 6 against leg 8: no figure below is
    // shared between the stages, so reading either one for the other fails.
    expect(r.stages[0].ceiling).toBe(400);
    expect(r.stages[1].ceiling).toBe(200);
    expect(r.stages[0].legTicks).toBe(6);
    expect(r.stages[1].legTicks).toBe(8);

    // The chain fed ITSELF. `wood` is a seeded recipe input for a one-stage
    // scenario, and would be an inexhaustible camp pile the sawmill could draw
    // on without the forester existing; a scenario that PRODUCES a resource
    // does not seed it, so every plank here came out of the forester by hauler.
    expect(r.stages[1].made).toBeGreaterThan(0);

    // One diagnostic per stage, and they are opposites: the far forester backs
    // up on a full output buffer, while the sawmill — which never stalls,
    // because its own output is collected on the way back — goes hungry for
    // input. A raw producer can never wait for input, which is why section 4
    // expects its gradient to be the control.
    expect(r.stages[0].stalledTicks).toBeGreaterThan(0);
    expect(r.stages[1].stalledTicks).toBe(0);
    expect(r.stages[0].waitingForInputTicks).toBe(0);
    expect(r.stages[1].waitingForInputTicks).toBeGreaterThan(0);

    // The other half of the same opposite-diagnostics pair, on the IN-tray
    // rather than the tick tally: the forester has no recipe input at all, so
    // its buffer is 0 by construction, while the under-hauled sawmill backs up
    // a real one. Reading either stage's buffer for the other — a wrong index
    // into `buildingIds`, or the wrong element of `results` — would either
    // collapse both to 0 or swap which one is 0, and this is the only
    // assertion in the file that would notice either.
    expect(r.stages[0].finalInputBuffer).toBe(0);
    expect(r.stages[1].finalInputBuffer).toBeGreaterThan(0);

    // The result's own fields ARE the first stage's, so every measurement
    // written against the single-building form still reads what it always did.
    expect(r.made).toBe(r.stages[0].made);
    expect(r.delivered).toBe(r.stages[0].delivered);
    expect(r.stalledTicks).toBe(r.stages[0].stalledTicks);
  }, 120000);

  it('a storehouse the scenario places is a live store site, not scenery', async () => {
    // (13,8) sits between the two buildings and well away from the camp, so it
    // is the nearest site with room for both of them — which is the only
    // condition under which a depot is worth its 20 wood and 10 planks.
    const withDepot = await stretchedChain([{ col: 13, row: 8 }]);
    const without = await stretchedChain();

    // The control is what makes the reading mean "the depot holds goods"
    // rather than "some building somewhere reports stock": with no depot
    // placed, nothing in the colony can hold any.
    expect(without.storedAtEnd).toBe(0);
    expect(withDepot.storedAtEnd).toBeGreaterThan(0);
  }, 180000);

  it('every unit of goods is accounted for, opening stock and recipe inputs included', async () => {
    const r = await suppliedChain([{ col: 10, row: 5 }]);

    // THE sentinel. Goods now live in four places plus a pair of hands, and a
    // leak in any of them would surface in a section 4 figure as a balance
    // problem rather than as the bug it is.
    expect(r.goods.conservationError).toBe(0);

    // Each correction term is non-vacuous in this fixture, which is what stops
    // the equation above from being satisfied by terms that are all zero:
    // the harness seeds recipe inputs before the run (opening), the sawmill
    // spends wood to make planks (recipeInputs), and the crew eats (eaten).
    expect(r.goods.opening).toBeGreaterThan(0);
    expect(r.goods.recipeInputs).toBeGreaterThan(0);
    expect(r.goods.eaten).toBeGreaterThan(0);
    // Both stages are counted, not just the measured one.
    expect(r.goods.made).toBeGreaterThan(r.stages[0].made);
    // Nothing is built or demolished in a balance scenario, so no goods may
    // appear or vanish outside production, hauling and hunger. This is where a
    // demolished depot's lost stock would hide.
    expect(r.goods.commandFlow).toBe(0);
    expect(r.goods.removalFlow).toBe(0);

    // And the round trip the increment is named for actually happens: a supply
    // trip that comes home empty is half a job, and section 2.5's mechanic is
    // only worth its complexity if this number is not near zero.
    expect(r.supplyReturns).toBeGreaterThan(0);
    expect(r.supplyReturnsLoaded / r.supplyReturns).toBeGreaterThan(0.5);

    // Hauler-ticks split two ways — by job and by leg — over the same ticks,
    // which is what section 4's third question asks to be reported. Asserted
    // as an identity rather than as magnitudes: the two decompositions count
    // the same working ticks, so a leg the phase split forgot (the fetch leg
    // is the new one, and buys nothing but position) shows up here as a
    // mismatch rather than as a plausible number nobody re-derives.
    const { idle, fetching, outbound, returning, collect, supply } = r.haulerTicks;
    expect(fetching).toBeGreaterThan(0);
    expect(supply).toBeGreaterThan(0);
    expect(collect + supply).toBe(fetching + outbound + returning);
    expect(r.haulerIdleTicks).toBe(idle);
  }, 120000);
});

describe('population instruments', () => {
  it('a self-feeding colony keeps every unit it makes', async () => {
    // Short beside the 12,000-tick curves above: conservation is a per-tick
    // invariant summed over the run, so it either holds from the first tick or
    // it does not, and 1,503 ticks of a growing colony exercises births,
    // deaths, hauling and hunger alike.
    //
    // 1,503, not the round 1,500: `removalFlow` below is only exercised if a
    // hauler is genuinely mid-trip, cargo in hand, on the exact tick the run
    // ends — otherwise a lost load and an empty-handed ending are
    // indistinguishable. Measured directly: 1,500/1,501/1,502 all end with
    // every hauler's hands empty, so `removalFlow` would be 0 whether or not
    // the closing count were computed correctly. 1,503 does not.
    const r = await runPopulationScenario({ ...chain, ticks: 1503, sampleEvery: 100, houses: ROOMY_HOUSES });

    expect(r.goods.conservationError).toBe(0);
    // Non-vacuity: this colony really did make and eat goods. It starts from
    // an empty store, so `opening` is 0 here by construction and the term is
    // exercised by the balance harness's seeded runs instead.
    expect(r.goods.made).toBeGreaterThan(0);
    expect(r.goods.eaten).toBeGreaterThan(0);
    expect(r.goods.commandFlow).toBe(0);
    // `conservationError` is algebraically blind to `final`: `removalFlow` is
    // DEFINED as `final - endOfTick`, so it cancels out of the predicted total
    // exactly and `final` never appears in the check above. This is the only
    // assertion in the file that reads the closing count at all — without it,
    // goods that vanished from wherever `goodsStanding` sums (a colonist's
    // `carrying`, say) would leave every other term here satisfied.
    expect(r.goods.removalFlow).toBe(0);
  }, 180000);

  it('the frozen-step sentinel still reads zero at stress colony size', async () => {
    // Roughly the size section 4's third question asks about dispatch cost at:
    // 100 colonists and 100 buildings, eight of them depots. A sentinel only
    // ever run on a three-colonist colony is not one — OBS-6-02's freeze was a
    // function of how many entities left the world at once, and this is the
    // colony shape where that is worth checking.
    const stress = await runPopulationScenario({
      foodPerTick: 'chain', huts: 20, haulers: 12, startingAdults: 100, houses: 72, storehouses: 8,
      ticks: 500, sampleEvery: 100,
    });

    expect(stress.frozenSteps).toBe(0);
    // The colony really is that size, rather than a small one wearing large
    // numbers: a tick label is only quotable if the run it labels happened.
    expect(populationOf(stress.samples.at(-1)!)).toBeGreaterThan(90);
    // And the eight depots are live store sites. Unlike a small colony's — the
    // auto-placement sequence gives the first huts the plots nearest the camp,
    // so a two-hut colony's depot is never the nearest site to anything — these
    // sit among huts that are genuinely far out, and take their stock.
    expect(stress.storedAtEnd).toBeGreaterThan(0);
  }, 180000);
});

// ---------------------------------------------------------------------------
// Spec section 4.1's three questions, measured. Everything below this line
// exists to produce a number for section 4 rather than to guard a behaviour,
// so each `it` pins the ONE relationship its measurement establishes and the
// report blocks print the curve those relationships were read off.
// ---------------------------------------------------------------------------

/**
 * A processor whose input is seeded at the CAMP, not produced next door.
 *
 * This is increment 5's sweep with one thing changed: the building consumes an
 * input, so haulage now has to walk goods in as well as out. Crew 2 and
 * ticksPerBatch 3 are the forester's own, which makes `ceiling` the same 400
 * and `share` directly comparable row for row — that comparability is the whole
 * instrument, and it is why the processor half is measured this way rather than
 * as the second stage of a chain.
 *
 * `share` is legitimate here, and StageResult.ceiling's caveat does not apply:
 * that caveat covers a `workshop` (which tools its own crew) and a stage FED BY
 * ANOTHER STAGE (where the chain, not the crew, is the constraint). A sawmill
 * drawing on the harness's inexhaustible seeded wood is neither — its crew is
 * the only thing that bounds production, exactly as a forester's is.
 */
const campFedSawmill = (col: number, row: number, haulers: number, storehouses?: TileRef[]) =>
  runScenario({ defId: 'sawmill', col, row, crew: 2, haulers, ticks: TICKS, resource: 'planks', storehouses });

describe('haul balance gradient — the processor half', () => {
  it('the one hauler that serves a raw producer at leg 4 no longer serves a processor there', async () => {
    // The same tile, the same crew, the same one hauler, the same 400-unit
    // ceiling. The ONLY difference between these two runs is that one recipe
    // has an input to walk in, so a colony in which input delivery did nothing
    // would put both on the same side of the bar and fail here. Measured: 0.99
    // against 0.89, with the 0.95 bar strictly between them and coinciding with
    // no value either fixture carries.
    const raw = await forester(8, 4, 1);
    const processing = await campFedSawmill(8, 4, 1);

    expect(raw.legTicks).toBe(processing.legTicks);
    expect(raw.ceiling).toBe(processing.ceiling);
    expect(share(raw)).toBeGreaterThan(0.95);
    expect(share(processing)).toBeLessThan(0.95);
    // And the shortfall is the input side specifically, not a generally slower
    // building: a raw producer can never wait for input, so this is 0 in the
    // control by construction.
    expect(raw.waitingForInputTicks).toBe(0);
    expect(processing.waitingForInputTicks).toBeGreaterThan(0);
  }, 120000);

  it('at the far corner a processor waits on its in-tray, not on another hauler', async () => {
    // Section 4.1 expects the processor's reach to be "roughly halved" and it
    // is (leg 4 -> leg 2 at one hauler, 8 -> 6 at two, 13 -> 8 at three). The
    // far corner is where that stops being a hauler story: a supply hauler
    // claims its whole load against the target's in-tray room, so at most
    // inputBufferCap / haulCarryCapacity loads can be walking toward one
    // building at a time. That is 2, and 2 loads over a 27-tick round trip is
    // 0.44 units per tick against a 2-worker sawmill's 0.67 — so the building
    // starves however many haulers the colony hires.
    const three = await campFedSawmill(23, 15, 3);
    const four = await campFedSawmill(23, 15, 4);

    // The concurrency limit, as a ratio rather than a magnitude — the same form
    // the outputBufferCap / haulCarryCapacity claim above is stated in.
    expect(BALANCE.inputBufferCap / BALANCE.haulCarryCapacity).toBe(2);
    // Measured 0.71 and 0.72: the fourth hauler buys one point of ceiling.
    expect(share(four)).toBeLessThan(0.8);
    expect(share(four) - share(three)).toBeLessThan(0.05);
    // Non-vacuity in both directions, and this is what makes the reading a
    // statement about the in-tray rather than about arithmetic. The building
    // really is input-starved (measured 30% of ticks), and the haulers really
    // are NOT standing about (measured 5% of their ticks idle) — so "hire
    // another hauler" is refuted by the run rather than by the comment.
    expect(four.waitingForInputTicks / TICKS).toBeGreaterThan(0.25);
    expect(four.haulerIdleTicks / (TICKS * 4)).toBeLessThan(0.1);
    // This is a READING, and a retune of inputBufferCap is what falsifies it —
    // deliberately, because the reading is the evidence for that retune rather
    // than a guard against it. Measured on this exact fixture: at 24 the same
    // run reads 0.92 of ceiling with 3% of ticks waiting, and at 48 it reads
    // 0.89 with 30 units of colony stock parked in the in-tray. If the constant
    // moves, this block has to be re-measured and rewritten, not relaxed.
  }, 120000);

  it('prints the processor sweep when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Deliberately the same four tiles and four hauler counts the raw sweep
    // prints, so section 4 can set the two blocks side by side and read the
    // halving off them. Increment 5's regression procedure greps the raw sweep
    // out with `^\(\s*[0-9]+,`, so these rows lead with the def name instead.
    const lines = ['', 'processor sweep — a camp-fed sawmill, crew 2, the raw sweep\'s tiles and hauler counts',
      'sawmill  tile       leg  haulers  delivered  %ceiling  waiting%  idle  supplyReturns  loaded'];
    for (const [col, row] of [[3, 0], [8, 4], [15, 8], [23, 15]] as const) {
      for (const haulers of [1, 2, 3, 4]) {
        const r = await campFedSawmill(col, row, haulers);
        lines.push(
          `sawmill (${String(col).padStart(2)},${String(row).padStart(2)})  ${String(r.legTicks).padStart(4)}  ` +
          `${String(haulers).padStart(7)}  ${String(r.delivered).padStart(9)}  ${(share(r) * 100).toFixed(0).padStart(8)}  ` +
          `${((r.waitingForInputTicks / TICKS) * 100).toFixed(0).padStart(8)}  ${String(r.haulerIdleTicks).padStart(4)}  ` +
          `${String(r.supplyReturns).padStart(13)}  ${String(r.supplyReturnsLoaded).padStart(6)}`,
        );
      }
    }
    console.log(lines.join('\n'));
  }, 600000);
});

/**
 * Section 4.1's second question is asked in the far corner, where the answer
 * can differ at all: nearer than this every configuration measured reaches its
 * ceiling with three haulers, and a depot cannot buy throughput a chain is
 * already getting.
 *
 * Crew 3 on the forester against crew 2 on the sawmill, so the wood side
 * out-produces the plank side and the chain stays haul-bound at every distance
 * — a crew-1 sawmill saturates by leg 8 and the whole sweep flattens. The two
 * crews also keep every per-stage figure distinct (ceilings 600 and 400, legs
 * 11 and 13, different defs and resources), so a reading that took one stage's
 * number for the other's cannot look plausible.
 */
const crewChain = (a: TileRef, b: TileRef, haulers: number, storehouses?: TileRef[], ticks = TICKS) => runScenario({
  defId: 'forester', col: a.col, row: a.row, crew: 3, haulers, ticks, resource: 'wood',
  second: { defId: 'sawmill', col: b.col, row: b.row, crew: 2, resource: 'planks' },
  storehouses,
});

/** The far-corner instance of it: a leg-11 forester feeding a leg-13 sawmill. */
const CORNER: readonly [TileRef, TileRef] = [{ col: 20, row: 12 }, { col: 23, row: 15 }];
const cornerChain = (haulers: number, storehouses?: TileRef[], ticks = TICKS) =>
  crewChain(CORNER[0], CORNER[1], haulers, storehouses, ticks);

/** The DEPOT tile for the chain above: between the two buildings and 19 tiles
 * from the camp, so it is the nearest site to both of them — the only
 * arrangement in which 20 wood and 10 planks could pay for themselves. */
const CORNER_DEPOT: TileRef = { col: 21, row: 14 };

/** The five chains the crossover sweep walks, near to far: forester tile,
 * sawmill tile, and the depot tile between them. */
const CROSSOVER_CHAINS: readonly (readonly [TileRef, TileRef, TileRef])[] = [
  [{ col: 5, row: 2 }, { col: 8, row: 4 }, { col: 7, row: 3 }],
  [{ col: 8, row: 4 }, { col: 11, row: 6 }, { col: 10, row: 5 }],
  [{ col: 12, row: 6 }, { col: 15, row: 9 }, { col: 13, row: 8 }],
  [{ col: 16, row: 10 }, { col: 19, row: 13 }, { col: 18, row: 12 }],
  [CORNER[0], CORNER[1], CORNER_DEPOT],
];

/** One row of that sweep. Split out of the report block purely to keep its
 * cognitive complexity under the quality gate — same remedy the harness's own
 * `shelterPlan` and `populateColony` split applied. */
function crossoverRow(haulers: number, storehouses: TileRef[] | undefined, r: BalanceResult): string {
  return (
    `${String(r.stages[0].legTicks).padStart(4)} ${String(r.stages[1].legTicks).padStart(4)}  ` +
    `${String(haulers).padStart(7)}  ${(storehouses === undefined ? 'no' : 'yes').padStart(5)}  ` +
    `${String(r.stages[1].made).padStart(6)}  ${String(r.stages[0].made).padStart(4)}  ` +
    `${((r.stages[1].waitingForInputTicks / TICKS) * 100).toFixed(0).padStart(16)}  ` +
    `${String(r.storedAtEnd).padStart(6)}  ${String(r.supplyReturns).padStart(13)}  ` +
    `${String(r.supplyReturnsLoaded).padStart(6)}  ${String(r.haulerIdleTicks).padStart(4)}`
  );
}

describe('storehouse balance', () => {
  it('a depot pays beside a producer feeding a consumer, and not beside a camp-fed one', async () => {
    // ONE mechanic, TWO placements, and the pair is the measurement: the same
    // corner, the same three haulers, the same depot. The only thing that
    // differs is where the processor's input comes from — the forester next
    // door, or the camp.
    //
    // It matters because a store site can only ever be FILLED by a building's
    // output (haul-sites.ts's remainderHome comment names the store-to-store
    // transfer section 2.13 excludes). Nothing pushes camp stock outward, so a
    // depot beside a camp-fed processor can never shorten the leg the input
    // walks; all it does is move the deposit off the camp, which leaves the
    // hauler's next fetch starting further from the only site holding wood.
    //
    // Neither bound is reachable by a depot that does nothing: a no-op depot
    // ties both comparisons, which passes the second and fails the first.
    const [chainPlain, chainDepot] = [await cornerChain(3), await cornerChain(3, [CORNER_DEPOT])];
    const [soloPlain, soloDepot] = [await campFedSawmill(23, 15, 3), await campFedSawmill(23, 15, 3, [CORNER_DEPOT])];

    // The depots are live store sites in both with-depot runs, and there is
    // nothing to hold stock in either control. Without this the two bounds
    // below could both be satisfied by a depot nobody ever walked to.
    expect(chainPlain.storedAtEnd).toBe(0);
    expect(soloPlain.storedAtEnd).toBe(0);
    expect(chainDepot.storedAtEnd).toBeGreaterThan(0);
    expect(soloDepot.storedAtEnd).toBeGreaterThan(0);

    // Beside the chain it buys throughput a player would notice. Measured 230
    // against 204 planks, +13%.
    expect(chainDepot.stages[1].made).toBeGreaterThan(chainPlain.stages[1].made * 1.05);
    // Beside the camp-fed processor it buys nothing at all — measured 266
    // against 294, a LOSS of 10%. The bound is stated as "no material gain"
    // rather than as a loss because the sign flips with hauler count (at four
    // haulers it is +3%), and the claim section 4 can carry is that this
    // placement does not pay, not that it always costs.
    expect(soloDepot.made).toBeLessThan(soloPlain.made * 1.05);
  }, 300000);

  it('prints the depot crossover sweep when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Section 4.1 asks for a crossover DISTANCE: the leg beyond which a depot
    // buys more than another hauler does. Read it by comparing a with-depot row
    // at h haulers against the no-depot row at h+1.
    //
    // `stored` is printed on every row for the reason the population reading
    // prints it: a with-depot row reading 0 is a run compared against itself.
    const lines = ['', 'depot crossover — forester crew 3 feeding sawmill crew 2, planks MADE',
      'legA legB  haulers  depot  planks  wood  sawmill waiting%  stored  supplyReturns  loaded  idle'];
    for (const [a, b, depot] of CROSSOVER_CHAINS) {
      for (const storehouses of [undefined, [depot]]) {
        for (const haulers of [1, 2, 3, 4]) lines.push(crossoverRow(haulers, storehouses, await crewChain(a, b, haulers, storehouses)));
      }
      lines.push('');
    }
    // Whether the depot keeps paying or fills once and stops. Nothing ever
    // moves goods from a depot back to the camp, and the chain's planks have no
    // consumer, so a depot beside one silts up with finished goods — after
    // which it can neither take another deposit nor stage another input.
    lines.push('does the depot keep paying — corner chain, 3 haulers', '  ticks  depot  planks  per tick  stored');
    for (const ticks of [600, 1200, 2400]) {
      for (const storehouses of [undefined, [CORNER_DEPOT]]) {
        const r = await cornerChain(3, storehouses, ticks);
        lines.push(
          `  ${String(ticks).padStart(5)}  ${(storehouses === undefined ? 'no' : 'yes').padStart(5)}  ` +
          `${String(r.stages[1].made).padStart(6)}  ${(r.stages[1].made / ticks).toFixed(3).padStart(8)}  ${String(r.storedAtEnd).padStart(6)}`,
        );
      }
    }
    console.log(lines.join('\n'));
  }, 900000);
});

/**
 * Section 4.1's third question needs a colony where EVERY building wants
 * inputs, and this is the shortest one the catalog allows: a mill turning
 * seeded wheat into flour, feeding a bakery turning flour into bread.
 *
 * The drain is an OPENING one, not a mid-run one, and section 4 must say so.
 * `seededResourcesFor` withholds every resource a stage of the scenario
 * produces, so at t=0 there is no flour at any site in the colony and the
 * bakery's input has to be manufactured before it can ever be delivered — which
 * is section 2.6's deadlock shape exactly. Nothing here drains a ledger that
 * was full a moment ago; no instrument in this repository can stage that today.
 *
 * Crew 2 against crew 3 and ticksPerBatch 3 against 4, so the stages' ceilings
 * (400 and 450), defs, resources and tiles are all distinct.
 */
const millAndBakery = (mill: TileRef, bakery: TileRef, haulers: number) => runScenario({
  defId: 'mill', col: mill.col, row: mill.row, crew: 2, haulers, ticks: TICKS, resource: 'flour',
  second: { defId: 'bakery', col: bakery.col, row: bakery.row, crew: 3, resource: 'bread' },
});

const NEAR: TileRef = { col: 12, row: 6 };
const FAR: TileRef = { col: 15, row: 9 };

describe('dispatch order under a drained ledger', () => {
  it('collection resumes, and the farther consumer is served late rather than never', async () => {
    // The two runs are the SAME two buildings with their tiles exchanged, and
    // the measured quantity is the bakery's gross output.
    //
    // This case was the MEASUREMENT that found OBS-7-01: it asserted
    // `made === 0` for the far bakery, because with no fairness term in
    // `compareSupplyCandidates` the nearer consumer took every trip while it
    // could still take a load. Increment 8 Task 1 put a starvation floor at
    // the front of that ordering, and this is the same fixture read as the
    // regression guard the issue asked it to become.
    //
    // It still discriminates, in both directions and by construction: a
    // dispatcher that starved the second stage whatever its position puts both
    // runs at zero and fails the first two bounds, and one that merely moved
    // the starvation to the other layout fails the third — which is the bound
    // doing the work, because it is the one that says the answer no longer
    // depends on which of the two the player happened to put farther out.
    const bakeryFar = await millAndBakery(NEAR, FAR, 1);
    const bakeryNear = await millAndBakery(FAR, NEAR, 1);

    // No deadlock: the colony does not sit still, and it accounts for every
    // unit while not doing so. The mill's own input is seeded, so this is the
    // half of section 2.6's argument that holds — supply candidates exist, and
    // collection rides home on them.
    expect(bakeryFar.stages[0].made).toBeGreaterThan(0);
    expect(bakeryFar.goods.conservationError).toBe(0);

    // Measured after the floor landed: 108 loaves in BOTH layouts, against 0
    // and 108 before it.
    expect(bakeryFar.stages[1].made).toBeGreaterThan(50);
    expect(bakeryNear.stages[1].made).toBeGreaterThan(50);
    // THE bound: exchanging the two tiles no longer changes who gets served.
    expect(Math.abs(bakeryFar.stages[1].made - bakeryNear.stages[1].made)).toBeLessThan(10);
    // Nor does the floor pin the hauler to the far bakery instead — it is
    // extinguished by one delivery, so the mill keeps being fed: 115 flour in
    // the far layout and 114 in the near one, against the 254 it made while it
    // was taking every trip and piling up flour nobody could bake.
    expect(bakeryFar.stages[0].made).toBeGreaterThan(50);
    // And the far bakery is no longer pinned at 100% waiting. 474 of 600 ticks
    // is the honest cost of one hauler serving two buildings, rather than a
    // queue whose front it never reached.
    expect(bakeryFar.stages[1].waitingForInputTicks).toBeLessThan(TICKS * 0.85);
  }, 180000);

  it('prints the hauler-tick split when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Section 4.1 asks for three numbers here: the split of hauler-ticks
    // between the two kinds of job, the fetch leg's share of them, and how
    // often a supply trip comes home loaded. The depot rows are printed beside
    // the plain ones because the fetch leg is the term a depot moves — a hauler
    // that banked at a depot starts its next fetch there, and the camp is the
    // only site holding a seeded input.
    const lines = ['', 'hauler-tick split — percentages of WORKING (non-idle) hauler ticks',
      'fixture              haulers  made0  made1   idle  working  collect%  supply%  fetch%  out%  return%  supplyReturns  loaded%'];
    const emit = (label: string, haulers: number, r: BalanceResult) => {
      const t = r.haulerTicks;
      const working = t.fetching + t.outbound + t.returning;
      const pct = (n: number, width: number) => ((n / working) * 100).toFixed(0).padStart(width);
      lines.push(
        `${label.padEnd(20)} ${String(haulers).padStart(7)}  ${String(r.stages[0].made).padStart(5)}  ${String(r.stages[1].made).padStart(5)}  ` +
        `${String(t.idle).padStart(5)}  ${String(working).padStart(7)}  ${pct(t.collect, 8)}  ${pct(t.supply, 7)}  ` +
        `${pct(t.fetching, 6)}  ${pct(t.outbound, 4)}  ${pct(t.returning, 7)}  ${String(r.supplyReturns).padStart(13)}  ` +
        `${((r.supplyReturnsLoaded / Math.max(1, r.supplyReturns)) * 100).toFixed(0).padStart(7)}`,
      );
    };
    for (const haulers of [1, 2, 3, 4]) emit('mill->bakery', haulers, await millAndBakery(NEAR, FAR, haulers));
    for (const haulers of [2, 4]) {
      emit('mill->bakery + depot', haulers, await runScenario({
        defId: 'mill', col: NEAR.col, row: NEAR.row, crew: 2, haulers, ticks: TICKS, resource: 'flour',
        second: { defId: 'bakery', col: FAR.col, row: FAR.row, crew: 3, resource: 'bread' },
        storehouses: [{ col: 13, row: 8 }],
      }));
    }
    for (const haulers of [1, 2, 3, 4]) emit('forester->sawmill', haulers, await cornerChain(haulers));
    console.log(lines.join('\n'));
  }, 900000);
});

/** The stress colony section 4.1's fifth question is asked at: 100 buildings,
 * eight of them depots, and 100 colonists. Only the hauling pool varies, which
 * is the multiplier `chooseJob`'s cost is argued from. */
const stressColony = (haulers: number) => runPopulationScenario({
  foodPerTick: 'chain', huts: 20, haulers, startingAdults: 100, houses: 72, storehouses: 8,
  ticks: 500, sampleEvery: 100,
});

describe('dispatch cost at scale', () => {
  it('the frozen-step sentinel still reads zero with most of the colony hauling', async () => {
    // The stress fixture above runs 12 haulers, which is the realistic share.
    // 80 of 100 is the shape that makes `chooseJob` expensive — it rebuilds
    // both candidate lists per IDLE hauler, so a colony with more haulers than
    // work is its worst case, and it is the one configuration where a stalled
    // tick would be cheapest to miss.
    const crowded = await stressColony(80);

    expect(crowded.frozenSteps).toBe(0);
    // The colony really is that size and its depots really are store sites —
    // a wall-clock figure read off a colony that quietly failed to be large
    // measures nothing.
    expect(populationOf(crowded.samples.at(-1)!)).toBeGreaterThan(90);
    expect(crowded.storedAtEnd).toBeGreaterThan(0);
  }, 180000);

  it('prints what a tick costs when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Wall clock is PRINTED and never asserted: it is a property of the machine
    // the suite happens to run on. What section 4 can carry from it is the
    // SHAPE — how the figure moves as buildings, depots and haulers are added,
    // with everything else held fixed.
    //
    // Two caveats belong beside the numbers. The per-tick figure includes the
    // conservation sentinel's three probes, each of which walks every building
    // and every hauler, so it overstates a production tick and understates
    // dispatch's share of one. And a realistic colony is the 12-hauler row: the
    // 40- and 80-hauler rows are there to isolate the term, not to describe a
    // colony anyone would staff.
    const lines = ['', 'wall clock per tick — same machine, same run length, one variable at a time',
      'case                          buildings  haulers   pop  ms/tick  frozen  stored'];
    const timed = async (label: string, buildings: number, haulers: number, run: () => Promise<PopulationResult>) => {
      const started = performance.now();
      const r = await run();
      lines.push(
        `${label.padEnd(28)}  ${String(buildings).padStart(9)}  ${String(haulers).padStart(7)}  ` +
        `${String(populationOf(r.samples.at(-1)!)).padStart(4)}  ${((performance.now() - started) / 500).toFixed(3).padStart(7)}  ` +
        `${String(r.frozenSteps).padStart(6)}  ${String(r.storedAtEnd).padStart(6)}`,
      );
    };
    const realistic = { foodPerTick: 'chain' as const, huts: 8, haulers: 6, startingAdults: 40, ticks: 500, sampleEvery: 100 };
    await timed('realistic 40 buildings', 40, 6, () => runPopulationScenario({ ...realistic, houses: 32 }));
    await timed('realistic, 4 depots', 40, 6, () => runPopulationScenario({ ...realistic, houses: 28, storehouses: 4 }));
    for (const haulers of [4, 12, 40, 80]) await timed('stress 100 buildings, 8 depots', 100, haulers, () => stressColony(haulers));
    console.log(lines.join('\n'));
  }, 900000);
});
