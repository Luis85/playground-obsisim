import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS, unitsOf } from '../../src/engine/content/buildings';
import type { BuildingDefId } from '../../src/shared/content-types';
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
const SUPPLIED_HAULERS = 4;
const suppliedChain = (storehouses?: TileRef[]) => runScenario({
  defId: 'forester', col: 8, row: 4, crew: 2, haulers: SUPPLIED_HAULERS, ticks: TICKS, resource: 'wood',
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

/**
 * The chain turned INSIDE OUT — a camp-adjacent forester feeding a far-corner
 * sawmill, with the depot beside the consumer rather than beside the producer.
 *
 * The one fixture in this file that dispatches transfers of BOTH classes, and
 * the layout is what makes it so. In the two chains above the depot sits next
 * to the producer, so `collect` banks the forester's wood straight into it and
 * the depot's own holding always covers the demand around it: every transfer it
 * ever dispatches is a drain, and `transfersStaging` would be a column of
 * zeros in every fixture measuring it. Here the wood is banked at the CAMP (the
 * nearest site with room to a leg-1 forester) while the demand — a sawmill
 * eating wood — sits thirteen tiles away beside a depot holding none, which is
 * a deficit at a bounded site with the surplus somewhere else: §2.4's staging
 * case, and the only shape that reaches it.
 */
const stagedChain = () => runScenario({
  defId: 'forester', col: 3, row: 0, crew: 2, haulers: 4, ticks: TICKS, resource: 'wood',
  second: { defId: 'sawmill', col: 20, row: 13, crew: 1, resource: 'planks' },
  storehouses: [{ col: 19, row: 12 }],
});

/** One forester and one hauler, run for as long as the caller likes and staffed
 * at whatever age it asks for — the shape the turnover instrument is measured
 * on, where the only variable is how much of a colonist's life the run spans. */
const turnoverWindow = (ticks: number, ageTicks?: number) => runScenario({
  defId: 'forester', col: 6, row: 3, crew: 2, haulers: 1, ticks, resource: 'wood', ageTicks,
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
    // `transfer` joins the job split here because this fixture PLACES A DEPOT,
    // and a transfer only exists where a bounded site does. Omitting it would
    // not merely lose a column: the identity below would fail, because a
    // transfer's ticks are counted in the leg split either way.
    const { idle, fetching, outbound, returning, collect, supply, transfer } = r.haulerTicks;
    expect(fetching).toBeGreaterThan(0);
    expect(supply).toBeGreaterThan(0);
    // The same non-vacuity the two lines above exist for, and the new bucket
    // needs it MORE than they do: an identity is satisfied just as well by a
    // column of zeros, so a later change that stopped dispatching transfers in
    // this fixture would leave the sum below still balancing and the transfer
    // share silently absent from §4's third question.
    expect(transfer).toBeGreaterThan(0);
    expect(collect + supply + transfer).toBe(fetching + outbound + returning);
    expect(r.haulerIdleTicks).toBe(idle);
  }, 120000);

  /**
   * THE IN-FLIGHT half only, and deliberately not evidence of the sink on its
   * own — see the completing scenario below for the fixture that is.
   *
   * This run stops well short of the site's countdown ever reaching 0:
   * `gatherersHut` costs 10 wood, sits one tile from camp, and the crew
   * assigned to `forester` here is 0 (a producer contributes nothing to this
   * fixture beyond satisfying `Scenario`'s own required stage), so delivery
   * lands within a handful of ticks and 15 ticks total is nowhere near
   * `BALANCE.buildTicks` (30) further. `ConstructionSystem`'s
   * `input.amounts.clear()` never fires, so `constructionInputs` stays 0 and
   * `conservationError` is 0 whether or not the sink exists at all — a
   * delivered-but-uncleared tray is still standing in `goodsStanding`
   * (`opening`, `made`, everything the sentinel already covered before this
   * increment). The assertions on `haulerTicks.supply` / `supplyReturns`
   * confirm goods really did move into that tray rather than never being
   * dispatched at all — `supplyReturnsLoaded` stays 0 here on purpose: a site
   * has no output buffer to round-trip a return load from, unlike the
   * producer `suppliedChain` measures above.
   */
  it('goods in a site in-tray are conserved', async () => {
    const r = await runScenario({
      defId: 'forester', col: 6, row: 0, crew: 0, haulers: 2, ticks: 15, resource: 'wood',
      sites: [{ defId: 'gatherersHut', col: 3, row: 0, atTick: 0 }],
    });
    expect(r.completions).toEqual([]);
    expect(r.haulerTicks.supply).toBeGreaterThan(0);
    expect(r.supplyReturns).toBeGreaterThan(0);
    expect(r.goods.constructionInputs).toBe(0);
    expect(r.goods.conservationError).toBe(0);
  });

  /**
   * THE ONE THAT CATCHES THE MISSING SINK, and the reason the comment above
   * insists a fixture must COMPLETE a site rather than merely deliver to one.
   * `ConstructionSystem` empties the site's in-tray the instant its countdown
   * reaches 0 (`input.amounts.clear()`), which is bookkeeping on goods
   * already charged to the colony ledger on delivery — but until this task,
   * `GoodsAudit` had no term for that emptying, so those units left `final`
   * with nothing in `predicted` accounting for the drop and every completing
   * scenario reported `conservationError` equal to the negative of the site's
   * own cost. Run past the countdown (80 ticks against a delivery that lands
   * in single digits plus 30 more to finish), not merely up to delivery.
   */
  it('a scenario that COMPLETES a supplied site reports conservationError === 0', async () => {
    const r = await runScenario({
      defId: 'forester', col: 6, row: 0, crew: 0, haulers: 2, ticks: 80, resource: 'wood',
      sites: [{ defId: 'gatherersHut', col: 3, row: 0, atTick: 0 }],
    });
    expect(r.completions).toHaveLength(1);
    expect(r.completions[0].defId).toBe('gatherersHut');
    // Non-vacuous: the sink actually fired, for exactly the site's own cost —
    // not some other figure that happened to zero the equation out.
    expect(r.goods.constructionInputs).toBe(unitsOf(BUILDINGS.gatherersHut.cost));
    expect(r.goods.constructionInputs).toBeGreaterThan(0);
    expect(r.goods.conservationError).toBe(0);
  });

  it('the transfer counter counts transfers and not supply fetches', async () => {
    // DISCRIMINATING, and it is increment 7's lesson exactly: an instrument
    // that over-counts is worse than none, because it is believed. A transfer
    // needs a bounded site to exist at all, so a chain with no depot must
    // report zero however much hauling it does — and this fixture does a great
    // deal, including the supply fetches a counter keyed on the `fetching` leg
    // rather than on the JOB would happily add in.
    const without = await suppliedChain();
    expect(without.haulerTicks.supply).toBeGreaterThan(0);
    expect(without.supplyReturns).toBeGreaterThan(0);
    expect(without.haulerTicks.fetching).toBeGreaterThan(0);
    expect(without.transfers).toBe(0);
    expect(without.transfersStaging).toBe(0);
    expect(without.transfersDrain).toBe(0);

    const withDepot = await suppliedChain([{ col: 10, row: 5 }]);
    expect(withDepot.transfers).toBeGreaterThan(0);
    // The split is a partition of the whole, not two independent tallies.
    expect(withDepot.transfersStaging + withDepot.transfersDrain).toBe(withDepot.transfers);
    // And the two buckets are the right way round. This depot stands beside the
    // producer whose output `collect` banks into it, so its own holding always
    // covers the demand around it and every transfer it dispatches is a DRAIN —
    // the split is lopsided here, which is exactly what makes it able to catch
    // an inverted flag. The staged fixture below is where both classes are
    // non-zero, and being symmetric it could not catch an inversion at all.
    expect(withDepot.transfersDrain).toBeGreaterThan(withDepot.transfersStaging);

    // AND IT IS NOT A TICK COUNT — pinned against a SECOND EDGE rather than
    // against the tick bucket's magnitude, because the magnitude does not
    // separate them here. `haulerTicks.transfer` counts once per active
    // hauler-tick, and this fixture measures 492 of them against 77 transfers,
    // a ratio of 6.4. But the likeliest wrong implementation — the one the
    // harness's own doc names, counting every tick in `fetching` on a transfer
    // job — reads 109, not the ~246 a half-of-the-bucket estimate suggests:
    // these haulers idle near the depot they drain, so the fetch leg averages
    // 1.4 ticks against a 5-tick walk out to the sawmill. 492 > 109 comfortably,
    // and so would 492 > 109 * 3. A bar drawn between 4.5x and 6.4x would have
    // to sit inside a 1.4x window and would be retuned by any fixture change.
    //
    // The turn for home is not a magnitude at all. Every transfer that reaches
    // its source and loads turns exactly once, however long either leg, so a
    // dispatch count and a turn-for-home count are THE SAME NUMBER derived at
    // opposite ends of the trip — measured, 77 and 77. A per-tick counter
    // agrees with neither (109 against 77), and so does one keyed on the wrong
    // leg or the wrong job.
    //
    // The tolerance is `SUPPLIED_HAULERS` and it is one-sided by construction:
    // `transfers` may exceed `transferReturns` by the trips still walking out
    // when the run ends (at most one per hauler) plus any transfer that found
    // its source spent and cancelled where it stood, and can never fall below
    // it. Currently 0 of both, so this asserts a real bound rather than a
    // fitted one — a widening gap is a zero-take regression, not noise.
    expect(withDepot.transferReturns).toBeGreaterThan(0);
    expect(withDepot.transfers - withDepot.transferReturns).toBeGreaterThanOrEqual(0);
    expect(withDepot.transfers - withDepot.transferReturns).toBeLessThanOrEqual(SUPPLIED_HAULERS);
  }, 180000);

  it('the two classes of transfer are counted apart, and both are reachable', async () => {
    // Without this the class split is a partition with one side always empty:
    // every fixture whose depot sits beside its producer dispatches drains
    // only, so `transfersStaging` would read 0 everywhere and an implementation
    // that had the flag inverted, or ignored it, would look identical.
    const r = await stagedChain();

    expect(r.transfersStaging).toBeGreaterThan(0);
    expect(r.transfersDrain).toBeGreaterThan(0);
    expect(r.transfersStaging + r.transfersDrain).toBe(r.transfers);
    // The TICK split's non-vacuity, and this is the only fixture that can
    // supply it: every other depot in the file dispatches drains only, so
    // `transferTicks.staging` is structurally 0 there and a bucket that was
    // never incremented would look exactly like a fixture with no staging in
    // it. The partition identity is asserted on the drain-heavy fixture; this
    // is what stops that identity from holding with one side always empty.
    expect(r.transferTicks.staging).toBeGreaterThan(0);
    expect(r.transferTicks.drain).toBeGreaterThan(0);
    // The class is read from `HaulTrip.staging` at dispatch and never
    // re-derived from the route, for the reason `BalanceResult.transfers`
    // gives: §2.2 makes the camp an ordinary site in the pull rule, so a
    // depot -> camp move is legitimately either class and route-based
    // attribution is wrong rather than approximate.
    //
    // THIS FIXTURE IS NOT THE EVIDENCE FOR THAT, and it would be overclaiming
    // to say so: one depot means the only sites are the camp and it, staging
    // runs camp -> depot and drain runs depot -> camp, so a direction-keyed
    // derivation would classify every trip here correctly. What actually
    // guards the flag is the pair above — the drain-heavy fixture, whose
    // lopsided split catches an inverted or ignored flag, and the partition
    // identity, which catches a class counted twice or not at all. This test's
    // job is narrower and is the one they cannot do: proving `transfersStaging`
    // is REACHABLE, so their split is not a partition with one side
    // structurally empty.
    //
    // And the staging really landed: goods stood in the depot at the end,
    // which is where a staging transfer puts them.
    expect(r.storedAtEnd).toBeGreaterThan(0);
  }, 120000);

  it('the stored series shows turnover, not just a final level', async () => {
    const r = await stretchedChain([{ col: 13, row: 8 }]);
    const without = await stretchedChain();

    // One reading per tick, and the last of them IS the closing figure — so
    // the series is the same measurement sampled more often, not a second
    // derivation that could disagree with it.
    expect(r.storedSeries).toHaveLength(TICKS);
    expect(r.storedSeries.at(-1)).toBe(r.storedAtEnd);
    // The control says the series measures DEPOTS: with none placed, nothing
    // in the colony can hold stock at any tick, not merely at the last one.
    expect(without.storedSeries.every((units) => units === 0)).toBe(true);

    // THE POINT. Acceptance criterion 4 is about turnover, and this depot
    // filled and then drained: the series is non-monotone. A test asserting
    // only `storedAtEnd < capacity` passes on a depot that never filled at all
    // — which is exactly what the control above looks like — so both halves
    // are asserted, the rise and the fall.
    const peak = Math.max(...r.storedSeries);
    expect(peak).toBeGreaterThan(0);
    expect(r.storedSeries.some((units, i) => i > 0 && units < r.storedSeries[i - 1])).toBe(true);
    // And it ended below its own high-water mark, which no single closing
    // number can say on its own.
    expect(r.storedAtEnd).toBeLessThan(peak);
  }, 180000);

  it('hauler-tick shares still sum to the total', async () => {
    const r = await suppliedChain([{ col: 10, row: 5 }]);
    const { idle, fetching, outbound, returning, collect, supply, transfer } = r.haulerTicks;

    // Every hauler-tick of the run is in the LEG split exactly once: four
    // haulers, TICKS ticks, nowhere else to be.
    expect(idle + fetching + outbound + returning).toBe(TICKS * SUPPLIED_HAULERS);
    // And every WORKING hauler-tick is in the job split exactly once. The
    // fourth category has to come OUT of the existing three rather than be
    // added beside them — a `transfer` bucket incremented in addition to a
    // `collect` or a `supply` one would overshoot this identity by exactly its
    // own size, and would still look like a plausible column in a report.
    expect(collect + supply + transfer).toBe(fetching + outbound + returning);
    // Non-vacuity: an identity is satisfied just as well by a column of zeros.
    expect(transfer).toBeGreaterThan(0);
    expect(collect).toBeGreaterThan(0);
    expect(supply).toBeGreaterThan(0);
    expect(idle).toBeGreaterThan(0);

    // And the transfer bucket splits by class without gaining or losing a tick.
    // The two sides are read from DIFFERENT PLACES — `transfer` off the
    // snapshot's published leg, `transferTicks` off the live trip, because the
    // snapshot deliberately does not carry `HaulTrip.staging` — so nothing else
    // in the file would notice them drifting apart. §4.2 quotes both columns
    // beside each other, which is only legitimate while this holds.
    expect(r.transferTicks.staging + r.transferTicks.drain).toBe(transfer);
  }, 120000);

  it('a run reports the deaths and retirements inside its own window', async () => {
    // The instrument that makes the horizon arithmetic unnecessary rather than
    // merely written down: section 4.2 asserts both are zero at every horizon it
    // measures a with/without-depot pair at, instead of trusting a prose claim
    // about which horizons are safe. Doing that arithmetic by hand is what put
    // an invalid 4,800-tick reading in the spec — 5,700 is an AGE, and founders
    // spawn at BALANCE.startingAgeTicks.
    const inside = await turnoverWindow(600);
    expect(inside.retirements).toBe(0);
    expect(inside.deaths).toBe(0);

    // DISCRIMINATING, and in both directions: a counter that is always zero
    // looks exactly like a clean run. Founders start at startingAgeTicks
    // (2,500), so retirement lands at elapsed tick 3,000 (retireTicks - that)
    // and the earliest old-age death at 3,200 (lifespanTicks - spreadTicks -
    // that); 3,900 ticks is past both.
    const past = await turnoverWindow(3900);
    expect(past.retirements).toBeGreaterThan(0);
    expect(past.deaths).toBeGreaterThan(0);

    // Same horizon, same layout, a young workforce — which moves retirement to
    // 4,500 and the earliest death to 4,700, so the same run is clean again.
    // This is what makes the two readings above a measurement of TURNOVER
    // rather than of run length, and it is the only test of `ageTicks`: a
    // harness that accepted the field and ignored it would report the middle
    // run's numbers here.
    const young = await turnoverWindow(3900, BALANCE.lifeBands.matureTicks);
    expect(young.retirements).toBe(0);
    expect(young.deaths).toBe(0);
    // And the field changed the run rather than only its notices: the older
    // crew stood down at tick 3,000 and stopped producing, the young one
    // worked the whole window.
    expect(young.made).toBeGreaterThan(past.made);
  }, 300000);
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

  it('a with/without-depot pair is identical below the turnover horizon', async () => {
    // OBS-7-05's own suggested assertion. Adding two storehouses spawns two
    // more entities, which shifts every colonist's id by two, and `lifespanFor`
    // jitters a lifespan by id — so above the first old-age death a
    // with/without pair diverges for a reason that has nothing to do with a
    // depot. This pins the harness's DETERMINISM without pinning that jitter,
    // and it is the assertion that says where the boundary is.
    //
    // 2,400 ticks. The population harness's founders spawn at `matureTicks`
    // (1,000, see spawnFounders), so its own retirement lands at elapsed 4,500
    // and its earliest old-age death at 4,700 — the balance harness's 3,000 and
    // 3,200 are the same arithmetic against a different starting age. 2,400 is
    // comfortably below either pair, and it is not left to that arithmetic:
    // `deathsByOldAge` is asserted zero below.
    const short = { ticks: 2400, sampleEvery: 100, houses: ROOMY_HOUSES };
    const without = await runPopulationScenario({ ...chain, ...short, storehouses: 0 });
    const withDepot = await runPopulationScenario({ ...chain, ...short, storehouses: 2 });

    // Inside the window by MEASUREMENT, which is the whole point of the
    // instrument: nobody has died of old age in either run, so nothing here can
    // be lifespan jitter.
    expect(without.deathsByOldAge).toBe(0);
    expect(withDepot.deathsByOldAge).toBe(0);
    // And a live colony rather than two empty ones — a pair that never bred
    // would match trivially and prove nothing about determinism.
    expect(without.births).toBeGreaterThan(0);

    // Digit for digit, which is the comparison that is NOT available above the
    // horizon. At ROOMY_HOUSES the depots are placed at plots the huts already
    // beat, so `storedAtEnd` is 0 in both — asserted, because it is what makes
    // this a determinism guard rather than a claim that depots change nothing.
    expect(withDepot.storedAtEnd).toBe(0);
    expect(without.storedAtEnd).toBe(0);
    expect(JSON.stringify(withDepot.samples)).toBe(JSON.stringify(without.samples));
    expect(withDepot.births).toBe(without.births);
    expect(withDepot.deathsByStarvation).toBe(without.deathsByStarvation);
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
const crewChain = (
  a: TileRef, b: TileRef, haulers: number, storehouses?: TileRef[], ticks = TICKS, ageTicks?: number,
) => runScenario({
  defId: 'forester', col: a.col, row: a.row, crew: 3, haulers, ticks, resource: 'wood',
  second: { defId: 'sawmill', col: b.col, row: b.row, crew: 2, resource: 'planks' },
  storehouses, ageTicks,
});

/** The far-corner instance of it: a leg-11 forester feeding a leg-13 sawmill. */
const CORNER: readonly [TileRef, TileRef] = [{ col: 20, row: 12 }, { col: 23, row: 15 }];
const cornerChain = (haulers: number, storehouses?: TileRef[], ticks = TICKS, ageTicks?: number) =>
  crewChain(CORNER[0], CORNER[1], haulers, storehouses, ticks, ageTicks);

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
    // THE RATIONALE THAT USED TO STAND HERE WAS REPEALED BY TASK 6. It read
    // "nothing pushes camp stock outward, so a depot beside a camp-fed
    // processor can never shorten the leg the input walks" — and a staging
    // transfer (haul-transfer.ts) is exactly a push of camp stock outward. The
    // second bound therefore rests on a MEASUREMENT now rather than on an
    // impossibility, and the measurement went the depot's way even less than
    // before. Read off this fixture, transfers counted at dispatch:
    //
    // - the camp really does stage wood into the depot, so the mechanism the
    //   old rationale denied is live — but only twice in 600 ticks, because
    //   `chooseJob` offers a transfer LAST and this run leaves its haulers just
    //   70 idle ticks out of 1,800 to spend on one.
    // - the depot intercepts the sawmill's plank output (it is the nearest site
    //   with room), and 11 drain loads then walk those planks back to the camp.
    // - 281 of 1,800 hauler-ticks go on transfer trips, and none of them
    //   shortens the leg the sawmill's wood walks.
    //
    // So the placement still does not pay, for a NEW reason: not that nothing
    // can fill the depot, but that what fills it is worth less than the trips
    // it costs.
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

    // AND THE MECHANIC RAN. Everything above this line passed with transfer
    // entirely inert — `storedAtEnd` of 60 is a depot that filled once and
    // stopped, and it satisfies `> 0` exactly as well as a depot that turns
    // over does. That is the increment-level shape of the failure mode
    // `docs/process/agent-workflow.md` exists to prevent: an assertion whose
    // value is indistinguishable between the feature working and the feature
    // never firing. The bound below is the one a dead mechanic cannot pass.
    //
    // `chainPlain` is the discriminator rather than a magnitude: a run with no
    // bounded site anywhere has no transfer to make, so it pins the counter to
    // zero from the other side and an over-counting instrument fails here
    // rather than flattering the row above.
    expect(chainPlain.transfers).toBe(0);
    expect(chainDepot.transfers).toBeGreaterThan(0);

    // Beside the chain it buys throughput a player would notice. Measured 230
    // against 204 planks, +13%.
    expect(chainDepot.stages[1].made).toBeGreaterThan(chainPlain.stages[1].made * 1.05);
    // Beside the camp-fed processor it buys nothing at all — measured 243
    // against 294, a LOSS of 17%. Both figures moved with Task 6: the control
    // still reads 294, and the with-depot run fell from the 266 recorded here
    // before transfers ran.
    //
    // The bound stays "no material gain" rather than being tightened onto that
    // loss, and the reason it is stated that way has changed. It used to be
    // that the sign flipped with hauler count — +3% at four haulers, as
    // recorded here — and that is no longer true: re-measured under the live
    // mechanic, four haulers read 276 against 296, a loss of 7%. The bound is
    // left where it is because the claim section 4 carries is that this
    // placement does not pay, and because a bound tightened onto a number this
    // increment has only just moved would be pinning the transfer mechanic's
    // current cost rather than the depot's value.
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
    // Whether the depot keeps paying or fills once and stops is NOT read off
    // this block: the horizon readings moved to their own report below, where
    // the pair can carry its turnover, its transfer classes and its own
    // deaths-and-retirements control instead of two columns of level.
    console.log(lines.join('\n'));
  }, 900000);
});

// ---------------------------------------------------------------------------
// §4.2: the transfer mechanic, measured. Everything below produces a number for
// §4.2–§4.5 of the increment-8 spec.
// ---------------------------------------------------------------------------

/**
 * §4.2's three clean horizons on the corner chain, and they are clean by
 * MEASUREMENT rather than by the arithmetic in this comment: every pair below
 * asserts `deaths` and `retirements` are 0 inside its own window.
 *
 * The arithmetic is written down anyway because it is what chose these numbers,
 * and because getting it wrong once is what put an invalid 4,800-tick reading in
 * the spec. `lifespanTicks - spreadTicks` is 5,700 but that is an AGE; founders
 * spawn at `BALANCE.startingAgeTicks` (2,500), so in ELAPSED ticks retirement
 * lands at 3,000, the earliest old-age death at 3,200, and the last founder is
 * gone by 4,800. 2,400 is therefore the longest clean horizon at the default
 * starting age — and a 4,800-tick run would compare a with-depot arm against a
 * without-depot arm whose colonists have different lifespans, because two extra
 * entities shift every colonist id and `lifespanFor` jitters by id (OBS-7-05).
 */
const HORIZONS = [600, 1200, 2400] as const;

/**
 * §4.2's fourth point, and the reason it needs its own starting age: §1.1's
 * claim is about GROWTH, so a longer horizon genuinely strengthens or weakens
 * it, but 4,000 ticks is past the default fixture's retirement at 3,000.
 * `lifeBands.matureTicks` (1,000) moves retirement to 4,500 and the earliest
 * death to 4,700, so the window is clean again — asserted, not assumed.
 *
 * BOTH arms take the override, so the pair stays comparable with each other.
 * The row is NOT comparable digit for digit with the three horizons above it:
 * a younger crew is a differently-jittered crew as well as a longer-serving
 * one.
 */
const YOUNG_HORIZON = 4000;

/** One with/without-depot pair of the corner chain at one horizon, in the order
 * every reading below unpacks them: plain first, depot second. */
async function horizonPair(ticks: number, ageTicks?: number): Promise<[BalanceResult, BalanceResult]> {
  const plain = await cornerChain(3, undefined, ticks, ageTicks);
  return [plain, await cornerChain(3, [CORNER_DEPOT], ticks, ageTicks)];
}

/** Whether a depot's stock ever fell — turnover, as acceptance criterion 4
 * asks for it, rather than the monotone climb to 60 that a single closing
 * level cannot be told apart from. */
const turnedOver = (series: readonly number[]) => series.some((units, i) => i > 0 && units < series[i - 1]);

/** One run of a horizon pair, as a fixed-width row. Split out of the report
 * block for the reason `crossoverRow` is: the quality gate scores complexity
 * per function. */
function horizonRow(ticks: number, age: string, depot: boolean, r: BalanceResult): string {
  const pct = (n: number) => ((n / ticks) * 100).toFixed(0).padStart(3);
  return (
    `  ${String(ticks).padStart(5)}  ${age.padEnd(7)}  ${(depot ? 'yes' : 'no').padStart(5)}  ` +
    `${String(r.stages[1].made).padStart(6)}  ${String(r.stages[0].made).padStart(4)}  ` +
    `${pct(r.stages[0].stalledTicks)}  ${pct(r.stages[1].waitingForInputTicks)}  ` +
    `${String(r.storedAtEnd).padStart(6)}  ${String(Math.max(...r.storedSeries)).padStart(4)}  ` +
    `${pct(r.storedSeries.filter((units) => units >= BALANCE.storehouseCapacity).length)}  ` +
    `${String(turnedOver(r.storedSeries)).padStart(8)}  ${String(r.transfers).padStart(6)}  ` +
    `${String(r.transfersStaging).padStart(4)}  ${String(r.transfersDrain).padStart(5)}  ` +
    `${String(r.haulerIdleTicks).padStart(4)}  ${String(r.deaths).padStart(6)}  ${String(r.retirements).padStart(7)}`
  );
}

/** One camp-fed processor run, as a fixed-width row: the throughput columns
 * OBS-7-02 is stated in, beside the hauler-tick columns §4.2 names as the
 * suspect for the loss. */
function processorRow(haulers: number, depot: boolean, r: BalanceResult): string {
  const t = r.haulerTicks;
  const working = t.fetching + t.outbound + t.returning;
  const pct = (n: number, width: number) => ((n / working) * 100).toFixed(0).padStart(width);
  return (
    `  ${String(haulers).padStart(7)}  ${(depot ? 'yes' : 'no').padStart(5)}  ${String(r.made).padStart(4)}  ` +
    `${String(r.delivered).padStart(5)}  ${((r.delivered / r.ceiling) * 100).toFixed(0).padStart(5)}  ` +
    `${((r.waitingForInputTicks / TICKS) * 100).toFixed(0).padStart(5)}  ${String(r.finalInputBuffer).padStart(7)}  ` +
    `${String(r.haulerIdleTicks).padStart(4)}  ${pct(t.fetching, 6)}  ${pct(t.collect, 8)}  ` +
    `${pct(t.supply, 7)}  ${pct(t.transfer, 5)}  ` +
    `${String(r.transfers).padStart(5)}  ${String(r.transfersStaging).padStart(4)}  ${String(r.transfersDrain).padStart(5)}  ` +
    `${String(r.transferTicks.staging).padStart(6)}  ${String(r.transferTicks.drain).padStart(7)}  ` +
    `${String(r.storedAtEnd).padStart(6)}`
  );
}

/** One row of the constant sweep. `storedSeries.length` IS the run's tick
 * count, so a fixture's own horizon normalises its wait percentage without the
 * caller passing it. */
function sweepRow(label: string, r: BalanceResult): string {
  const last = r.stages.at(-1)!;
  return (
    `${label.padEnd(26)}  ${String(last.made).padStart(5)}  ${String(r.stages[0].made).padStart(5)}  ` +
    `${String(r.storedAtEnd).padStart(6)}  ${String(Math.max(...r.storedSeries)).padStart(4)}  ` +
    `${String(r.transfers).padStart(5)}  ${String(r.transfersStaging).padStart(4)}  ${String(r.transfersDrain).padStart(5)}  ` +
    `${String(r.transferTicks.staging).padStart(6)}  ${String(r.transferTicks.drain).padStart(7)}  ` +
    `${String(r.haulerIdleTicks).padStart(4)}  ` +
    `${((last.waitingForInputTicks / r.storedSeries.length) * 100).toFixed(0).padStart(5)}`
  );
}

describe('the transfer mechanic — §4.2', () => {
  it('a depot beside a chain turns over, and its advantage over the horizon is what §4.2 records', async () => {
    const advantage: number[] = [];
    for (const ticks of HORIZONS) {
      const [plain, depot] = await horizonPair(ticks);
      // THE CONTROL, asserted rather than computed (§4.2, §4.5). A colonist who
      // retires stops working and one who dies stops existing, and either turns
      // a logistics comparison into a demographic one. Both arms, because the
      // depot arm is the one whose ids are shifted.
      expect(plain.deaths + plain.retirements).toBe(0);
      expect(depot.deaths + depot.retirements).toBe(0);
      // And the mechanic ran in the arm that has a depot to run it in.
      expect(plain.transfers).toBe(0);
      expect(depot.transfers).toBeGreaterThan(0);
      // ACCEPTANCE CRITERION 4, at every horizon measured: below capacity, and
      // a series that falls as well as rises. Both halves, because a depot that
      // never filled satisfies the first on its own.
      expect(depot.storedAtEnd).toBeLessThan(BALANCE.storehouseCapacity);
      expect(Math.max(...depot.storedSeries)).toBeGreaterThan(0);
      expect(turnedOver(depot.storedSeries)).toBe(true);
      advantage.push(depot.stages[1].made - plain.stages[1].made);
    }

    // ACCEPTANCE CRITERION 3, as an ABSOLUTE advantage — a percentage of a
    // growing base can shrink while the advantage grows, and increment 7 §4.3
    // found flatness a percentage was hiding. Measured 81 / 126 / 222 planks at
    // 600 / 1,200 / 2,400, which is the shape §1.1 predicted and the opposite of
    // increment 7's 26 / 24 / 28 one-off buffer.
    expect(advantage[2]).toBeGreaterThan(advantage[0]);
    // Not merely bigger at the far end: monotone across all three, which a
    // one-off buffer plus noise is not. This is the bound §4.2 rests §1.1 on.
    expect(advantage[1]).toBeGreaterThan(advantage[0]);
    expect(advantage[2]).toBeGreaterThan(advantage[1]);
  }, 300000);

  it('the fourth horizon is clean because its workforce is young, not because 4,000 is short', async () => {
    const [plain, depot] = await horizonPair(YOUNG_HORIZON, BALANCE.lifeBands.matureTicks);

    // The same control as the three horizons above, and it is the only thing
    // that licenses reading this row: 4,000 ticks is 1,000 past the DEFAULT
    // fixture's retirement, so without the override this pair would be
    // comparing two differently-aged colonies (§4.5, OBS-7-05).
    expect(plain.deaths + plain.retirements).toBe(0);
    expect(depot.deaths + depot.retirements).toBe(0);
    // A zero-valued control is indistinguishable from a counter that never
    // fires, and the discrimination for THIS one is taken once, in 'a run
    // reports the deaths and retirements inside its own window': the same
    // harness at 3,900 ticks and the default starting age reports retirements
    // and deaths above zero, and reports both back at zero when handed
    // `matureTicks`. Re-taking it here would cost two more 4,000-tick runs to
    // learn what that test already establishes about the same field.
    expect(depot.transfers).toBeGreaterThan(0);
    expect(depot.stages[1].made).toBeGreaterThan(plain.stages[1].made);
  }, 300000);

  it('prints the §4.2 horizon readings when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    const lines = ['', '§4.2 horizons — corner chain, forester crew 3 -> sawmill crew 2, 3 haulers',
      '  ticks  age      depot  planks  wood  st0  wt1  stored  peak  full%  turnover  xfers  stag  drain  idle  deaths  retires'];
    const advantages: string[] = ['', '  the advantage per horizon, absolute and as a percentage',
      '  ticks  age      no depot  depot  advantage  advantage%'];
    for (const [ticks, ageTicks, age] of [
      ...HORIZONS.map((t) => [t, undefined, 'default'] as const),
      [YOUNG_HORIZON, BALANCE.lifeBands.matureTicks, 'young'] as const,
    ]) {
      const [plain, depot] = await horizonPair(ticks, ageTicks);
      lines.push(horizonRow(ticks, age, false, plain), horizonRow(ticks, age, true, depot));
      const [a, b] = [plain.stages[1].made, depot.stages[1].made];
      advantages.push(
        `  ${String(ticks).padStart(5)}  ${age.padEnd(7)}  ${String(a).padStart(8)}  ${String(b).padStart(5)}  ` +
        `${String(b - a).padStart(9)}  ${(((b - a) / a) * 100).toFixed(1).padStart(10)}`,
      );
    }
    console.log([...lines, ...advantages].join('\n'));
  }, 900000);

  it('prints the camp-fed processor and OBS-7-02 readings when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // TWO questions on one fixture family, and they are the same runs read for
    // different columns.
    //
    // §4.2's cost column: the camp-fed processor is the configuration §1.2
    // committed in advance to reporting including worse, and §2.13 puts the
    // obvious remedy out of scope. `%ceiling`, `fetch%` and the transfer split
    // are what say WHY, and the fetch-leg share is the named suspect.
    //
    // §4.4's answer: this is the fixture that established `inputBufferCap: 12`
    // as the binding constraint (OBS-7-02) — a far-corner sawmill fed from the
    // camp, plateauing at 71-72% of ceiling however many haulers it hires. The
    // depot rows are the re-run the issue was waiting for: a staging transfer
    // is the one mechanism that could feed this building without occupying its
    // in-tray, so if the cap has stopped binding it shows up here.
    const lines = ['', 'camp-fed sawmill (23,15) crew 2 — §4.2\'s cost and §4.4\'s answer',
      '  haulers  depot  made  deliv  %ceil  wait%  in-tray  idle  fetch%  collect%  supply%  xfer%  xfers  stag  drain  stagTk  drainTk  stored'];
    for (const haulers of [2, 3, 4]) {
      for (const storehouses of [undefined, [CORNER_DEPOT]]) {
        lines.push(processorRow(haulers, storehouses !== undefined, await campFedSawmill(23, 15, haulers, storehouses)));
      }
    }
    console.log(lines.join('\n'));
  }, 900000);

  it('prints the constant sweep fixtures when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // §4.2's last bullet. This block is run ONCE PER VALUE of the constant under
    // test, by editing `src/engine/content/balance.ts` between runs and putting
    // the shipped value back afterwards — the constants are swept, never tuned,
    // and the header line prints all three so a sweep row cannot be filed under
    // the wrong value.
    //
    // The no-depot arm is deliberately absent: all three constants are read only
    // through a BOUNDED site (`siteDemandFrom` and `ledgerOf` in
    // haul-transfer.ts, `drainCandidates` in haul-dispatch.ts), so a run with no
    // storehouse cannot see any of them and its figures are the same at every
    // value by construction. §4.2 quotes the horizon block's plain arm.
    //
    // Four fixtures, because the three constants govern different halves of the
    // mechanic: the corner chain dispatches DRAINS only (`storehouseFreeFloor`,
    // and `minTransferUnits` on the drain's exemption), the staged chain is the
    // only fixture in the file that reaches STAGING at all (`siteStagingTarget`,
    // `minTransferUnits`), and the camp-fed processor is where staging would
    // have to pay if it paid anywhere.
    const lines = ['', 'constant sweep — ' +
      `siteStagingTarget=${BALANCE.siteStagingTarget} minTransferUnits=${BALANCE.minTransferUnits} ` +
      `storehouseFreeFloor=${BALANCE.storehouseFreeFloor}`,
      'fixture                       made1  made0  stored  peak  xfers  stag  drain  stagTk  drainTk  idle  wait%'];
    lines.push(sweepRow('corner chain 600, depot', await cornerChain(3, [CORNER_DEPOT], 600)));
    lines.push(sweepRow('corner chain 2400, depot', await cornerChain(3, [CORNER_DEPOT], 2400)));
    lines.push(sweepRow('staged chain, depot', await stagedChain()));
    lines.push(sweepRow('camp-fed far 3h, depot', await campFedSawmill(23, 15, 3, [CORNER_DEPOT])));
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

/** OBS-7-01's control row — the same two buildings with neither of them far
 * from the camp. The two tiles the issue used are not recorded anywhere, so
 * these were chosen to land on its two LEGS (2 and 3) rather than on its two
 * tiles; run against the pre-floor commit they reproduce the issue's row
 * exactly (397 flour, 144 bread, 2% and 72% waiting), so the row IS comparable
 * digit for digit and §4.1 quotes it as such. */
const CAMP_MILL: TileRef = { col: 5, row: 2 };
const CAMP_BAKERY: TileRef = { col: 6, row: 3 };

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
    //
    // ONE hauler, and that is a discrimination point rather than a saving on
    // run time: at three haulers this fixture reads identically before and
    // after the floor, digit for digit in both layouts (335 flour / 319 bread
    // and 310 / 292), because with that much hauling nobody is starved for the
    // ordering to sort out. A guard taken there would stay green on a
    // dispatcher with no floor at all. §4.1 of the increment-8 spec has the
    // whole table, taken before any transfer code existed in the tree.
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
    //
    // A RATIO with a named tolerance, not an absolute gap, because the absolute
    // form hid its own margin: the two runs measure 108 and 108, so
    // `Math.abs(far - near) < 10` was passing at a difference of ZERO and
    // nothing recorded whether 10 was generous or a hair's breadth. The same
    // fixture at two and three haulers — printed by the report below and
    // deliberately not asserted — spreads to 189/210 and 319/292, ratios of
    // 0.90 and 0.92. So this fixture family's own widest spread is about a
    // tenth and 0.85 sits just below it. Be clear that this is a LOOSENING and
    // not just a reshaping: at 108, `< 10` is a ratio floor of about 0.915, so
    // 0.85 admits a gap of roughly 16 where 10 was admitted. It is also
    // calibrated at the family level — the 0.90/0.92 spreads are at two and
    // three haulers, while this assertion runs at one, where the ratio is 1.00
    // and there is no spread to calibrate against. §4.1 point 6 records both.
    // A later task that shifts throughput asymmetrically reds here reading as a
    // tolerance to re-take rather than as a balance regression, and it should
    // re-take it knowing that. Both failure modes are nowhere near it: a
    // dispatcher that starves the far bakery whatever the layout, and the
    // pre-floor tree itself, both read 0 / 108 = 0.
    const [far, near] = [bakeryFar.stages[1].made, bakeryNear.stages[1].made];
    expect(Math.min(far, near) / Math.max(far, near)).toBeGreaterThan(0.85);
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

  it('prints the fairness table when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // OBS-7-01's own table, re-taken in the same columns so the issue's "before"
    // and section 4.1's "after" can be set side by side and read row for row.
    // The quantity the issue turns on is the SECOND stage's gross output with
    // the two tiles exchanged, and the wait percentages are what say whether a
    // low figure is a starved building or merely a slow one.
    const lines = ['', 'fairness floor — OBS-7-01\'s table, mill/bakery with the tiles exchanged',
      'layout                  haulers  mill leg  bakery leg  flour  bread  mill wait%  bakery wait%'];
    const emit = (label: string, haulers: number, r: BalanceResult) => {
      const [mill, bakery] = r.stages;
      const wait = (s: { waitingForInputTicks: number }) => ((s.waitingForInputTicks / TICKS) * 100).toFixed(0);
      lines.push(
        `${label.padEnd(22)}  ${String(haulers).padStart(7)}  ${String(mill.legTicks).padStart(8)}  ` +
        `${String(bakery.legTicks).padStart(10)}  ${String(mill.made).padStart(5)}  ${String(bakery.made).padStart(5)}  ` +
        `${wait(mill).padStart(10)}  ${wait(bakery).padStart(12)}`,
      );
    };
    for (const haulers of [1, 2, 3]) {
      emit('mill near, bakery far', haulers, await millAndBakery(NEAR, FAR, haulers));
      emit('mill far, bakery near', haulers, await millAndBakery(FAR, NEAR, haulers));
    }
    emit('both beside the camp', 1, await millAndBakery(CAMP_MILL, CAMP_BAKERY, 1));
    console.log(lines.join('\n'));
  }, 900000);

  it('prints the hauler-tick split when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // Section 4.1 asks for three numbers here: the split of hauler-ticks
    // between the two kinds of job, the fetch leg's share of them, and how
    // often a supply trip comes home loaded. The depot rows are printed beside
    // the plain ones because the fetch leg is the term a depot moves — a hauler
    // that banked at a depot starts its next fetch there, and the camp is the
    // only site holding a seeded input.
    //
    // THE TWO TRANSFER CLASSES ARE PRINTED APART (§4.2), because since the
    // dispatch order changed they are paid for out of different budgets and one
    // `transfer%` column can no longer answer the question that is being asked
    // of it. Staging is offered LAST, behind collect, so §2.6's "paid for out of
    // idle time" claim is now a claim about `stag%` against `idle` and about
    // nothing else. A drain is offered AHEAD of collect, so `drain%` is by
    // construction taken from `collect%` — that is the occupancy cost §2.6
    // names, and this split is the only instrument in the file that can see it.
    const lines = ['', 'hauler-tick split — percentages of WORKING (non-idle) hauler ticks',
      'fixture              haulers  made0  made1   idle  working  collect%  supply%  transfer%  drain%  stag%  fetch%  out%  return%  supplyReturns  loaded%'];
    const emit = (label: string, haulers: number, r: BalanceResult) => {
      const t = r.haulerTicks;
      const working = t.fetching + t.outbound + t.returning;
      const pct = (n: number, width: number) => ((n / working) * 100).toFixed(0).padStart(width);
      lines.push(
        `${label.padEnd(20)} ${String(haulers).padStart(7)}  ${String(r.stages[0].made).padStart(5)}  ${String(r.stages.at(-1)!.made).padStart(5)}  ` +
        `${String(t.idle).padStart(5)}  ${String(working).padStart(7)}  ${pct(t.collect, 8)}  ${pct(t.supply, 7)}  ` +
        `${pct(t.transfer, 9)}  ${pct(r.transferTicks.drain, 6)}  ${pct(r.transferTicks.staging, 5)}  ` +
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
    // The depot arm of §4.2's own fixture, which is the row that measurement is
    // read off, and the staged chain — the only fixture in the file that
    // dispatches BOTH classes, so the only one where `stag%` is not zero.
    for (const haulers of [1, 2, 3, 4]) emit('forester->sawmill+depot', haulers, await cornerChain(haulers, [CORNER_DEPOT]));
    emit('staged chain', 4, await stagedChain());
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

// ---------------------------------------------------------------------------
// §4.1 of the increment-9 spec: construction, measured. Everything below this
// line produces a number for that section rather than guarding a behaviour,
// so each `it` pins the ONE relationship its measurement establishes and the
// report block prints the curves those relationships were read off.
//
// Every fixture here is a site beside an INERT stage — `crew: 0`, so the
// forester produces nothing and never competes for a hauler. A one-stage
// scenario seeds every recipe input at the camp (`seededResourcesFor`), so
// wood and planks are inexhaustible: the affordability check never binds and
// nothing else in the colony wants the goods. That is deliberate. It isolates
// delivery and the countdown, which is what §4.1's first and fourth questions
// ask about; the CONTENDED readings (§4.1's third question) cannot be taken on
// this harness at all, and §4.1 says so rather than substituting these for
// them.
// ---------------------------------------------------------------------------

const siteScenario = (defId: BuildingDefId, at: TileRef, haulers: number, ticks: number) => runScenario({
  defId: 'forester', col: 6, row: 0, crew: 0, haulers, ticks, resource: 'wood',
  sites: [{ defId, col: at.col, row: at.row, atTick: 0 }],
});

/**
 * Ticks a site spent WAITING FOR MATERIALS, derived from its completion tick
 * rather than instrumented separately: `ConstructionSystem` decrements only on
 * a tick whose in-tray already holds the full cost, and a delivered material
 * can only leave a site by completion or cancellation, so a site that
 * completed at tick `c` had its last unit land at `c - buildTicks + 1`. One
 * derivation, so the delivery half and the countdown half of a wait can never
 * add up to something other than the wait.
 */
const deliveryTicksOf = (r: BalanceResult) => r.completions[0].tick - BALANCE.buildTicks + 1;

/** N house sites ordered on the same tick, at tiles that are ALL leg 4 from
 * the camp — so the completion curve is a fact about dispatch order and not
 * about one site being further out than another. */
const SITE_TILES: readonly TileRef[] = [
  { col: 9, row: 1 }, { col: 9, row: 2 }, { col: 9, row: 3 }, { col: 8, row: 3 },
  { col: 8, row: 4 }, { col: 8, row: 5 }, { col: 7, row: 5 }, { col: 7, row: 6 },
];

const queueScenario = (n: number, haulers: number, ticks: number) => runScenario({
  defId: 'forester', col: 6, row: 0, crew: 0, haulers, ticks, resource: 'wood',
  sites: SITE_TILES.slice(0, n).map((t) => ({ defId: 'house' as const, col: t.col, row: t.row, atTick: 0 })),
});

describe('construction, measured — §4.1', () => {
  it('the countdown is not invisible beside the walk — beside the camp it IS the wait', async () => {
    // §4.1's first question, asked the way the spec asks it: is `buildTicks`
    // doing anything the delivery leg is not already doing? The answer is the
    // opposite of the shape the question expects. A house (15 wood, 5 planks)
    // at the camp's elbow is delivered in 7 ticks and then stands still for 30;
    // the same house at the far corner is delivered in 43.
    //
    // The FULL SWEEP is taken by editing `BALANCE.buildTicks` between runs and
    // putting the shipped value back — the same procedure §4.2 of the
    // increment-8 spec uses for its constants, and the report block below
    // prints the current value in its header so a row cannot be filed under
    // the wrong one. Measured, delivery ticks first and total second:
    //
    //   buildTicks     10     30     60    120
    //   leg  1        7/16   7/36   7/66   7/126
    //   leg  8       28/37  28/57  28/87  28/147
    //   leg 13       43/52  43/72  43/102 43/162
    //
    // The delivery column does not move with the constant, which is what makes
    // the two halves separable at all, and the constant is 81% of the wait at
    // leg 1 and 41% of it at leg 13.
    const near = await siteScenario('house', { col: 3, row: 0 }, 2, 200);
    const far = await siteScenario('house', { col: 23, row: 15 }, 2, 200);

    expect(near.completions).toHaveLength(1);
    expect(far.completions).toHaveLength(1);
    // THE READING, as the one relationship it establishes: beside the camp the
    // countdown outweighs the walk, and at the far corner the walk outweighs
    // the countdown. The bar between them is the shipped constant itself, so
    // this states a relationship rather than pinning two magnitudes — and it
    // is a READING, not a guard: retuning `buildTicks` far enough is meant to
    // falsify it, and §4.1 has to be re-measured if it does.
    expect(deliveryTicksOf(near)).toBeLessThan(BALANCE.buildTicks);
    expect(deliveryTicksOf(far)).toBeGreaterThan(BALANCE.buildTicks);
    // And not marginally: the walk beside the camp is under a quarter of the
    // countdown (7 against 30), which is what "the countdown IS the wait"
    // means and what a bare inequality would let slide.
    expect(deliveryTicksOf(near) * 4).toBeLessThan(BALANCE.buildTicks);
  }, 120000);

  it('several sites at once finish together and late, exactly as §2.4 predicted', async () => {
    // §4.1's fourth question, and the measurement that sizes increment 10. It
    // is a READING and not a pass/fail: §2.4 says round-robin filling is the
    // expected behaviour here, and acceptance criterion 4 deliberately states
    // nothing about order or timing.
    const alone = await queueScenario(1, 1, 200);
    const queued = await queueScenario(4, 1, 400);
    const hauled = await queueScenario(4, 4, 200);

    // Nothing is lost: every ordered site finishes in all three runs, which is
    // the half of §2.4 that says round-robin is SLOW rather than BROKEN.
    expect(alone.completions).toHaveLength(1);
    expect(queued.completions).toHaveLength(4);
    expect(hauled.completions).toHaveLength(4);

    // WHAT THE QUEUE COSTS: the FIRST house, not the last. One house alone is
    // finished at tick 65; order four together and the first of them arrives
    // at 155, which is 2.4x later for a house the colony could have had at 65.
    // The last arrives at 185 against a serial ordering's ~230, so the queue
    // as a whole is not slower — its whole yield is simply deferred to the end.
    expect(queued.completions[0].tick).toBeGreaterThan(alone.completions[0].tick * 2);

    // AND THE CURVE IS FLAT, which is the shape §2.4 predicted and the thing
    // increment 10 is sized against. At four haulers all four sites cross zero
    // on the SAME TICK — not merely close together, identical — because they
    // filled round-robin and their last materials landed in the same wave.
    // A dispatcher that served the oldest site first could not produce this.
    expect(new Set(hauled.completions.map((c) => c.tick)).size).toBe(1);
    // At one hauler the curve is a staircase rather than a single step, and
    // the step is one round trip: 155 / 165 / 175 / 185. Still flat in the
    // sense that matters — the spread is 30 ticks against a 185-tick wait,
    // 16% — so nothing useful arrives before nearly everything does.
    const ticksOf = queued.completions.map((c) => c.tick);
    expect(ticksOf.at(-1)! - ticksOf[0]).toBeLessThan(ticksOf.at(-1)! * 0.25);
  }, 180000);

  it('prints the construction readings when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    // §4.1's first, second and fourth questions in three blocks, all read off
    // `completions`. The header prints the constant under test, because the
    // sweep is taken by editing it between runs (see the first case above).
    const lines = ['', `construction — buildTicks=${BALANCE.buildTicks}`,
      '', '  the wait, split into the walk and the countdown — one house site, 2 haulers',
      '  tile        leg  completion  delivery  countdown%'];
    for (const [at, leg] of [[{ col: 3, row: 0 }, 1], [{ col: 15, row: 8 }, 8], [{ col: 23, row: 15 }, 13]] as const) {
      const r = await siteScenario('house', at, 2, 400);
      const done = r.completions[0].tick;
      lines.push(
        `  (${String(at.col).padStart(2)},${String(at.row).padStart(2)})   ${String(leg).padStart(8)}  ` +
        `${String(done).padStart(10)}  ${String(deliveryTicksOf(r)).padStart(8)}  ` +
        `${((BALANCE.buildTicks / (done + 1)) * 100).toFixed(0).padStart(10)}`,
      );
    }
    lines.push('', '  does the wait already scale with cost? one site, 2 haulers, near and far',
      '  def            units  materials  near delivery  far delivery');
    for (const defId of ['gatherersHut', 'house', 'workshop', 'mill', 'sawmill'] as const) {
      const near = await siteScenario(defId, { col: 3, row: 0 }, 2, 400);
      const far = await siteScenario(defId, { col: 23, row: 15 }, 2, 600);
      const cost = BUILDINGS[defId].cost;
      // A site that never completed prints `stalled`. The sawmill WAS one —
      // 25 wood leaves a last unit of 1 against `minSupplyUnits: 2`, so its
      // in-tray stuck at 24 for the whole run (OBS-9-01, fixed: `worthMoving`
      // now exempts the load that settles a site's bill). The column keeps the
      // word: a run that stalls for some later reason must say so rather than
      // print a blank that reads as a slow build.
      const delivery = (r: BalanceResult) => (r.completions.length === 0 ? 'stalled' : deliveryTicksOf(r));
      lines.push(
        `  ${defId.padEnd(13)}  ${String(unitsOf(cost)).padStart(5)}  ${String(Object.keys(cost).length).padStart(9)}  ` +
        `${String(delivery(near)).padStart(13)}  ${String(delivery(far)).padStart(12)}`,
      );
    }
    lines.push('', '  the completion CURVE: N house sites ordered together, all at leg 4',
      '  haulers  N  first  last  spread  per-site completion ticks');
    for (const haulers of [1, 4]) {
      for (const n of [1, 2, 3, 4, 6, 8]) {
        const r = await queueScenario(n, haulers, 1200);
        const ticksOf = r.completions.map((c) => c.tick).sort((a, b) => a - b);
        lines.push(
          `  ${String(haulers).padStart(7)}  ${n}  ${String(ticksOf[0]).padStart(5)}  ` +
          `${String(ticksOf.at(-1)).padStart(4)}  ${String(ticksOf.at(-1)! - ticksOf[0]).padStart(6)}  ${ticksOf.join(' ')}`,
        );
      }
    }
    console.log(lines.join('\n'));
  }, 1800000);
});
