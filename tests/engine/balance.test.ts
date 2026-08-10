import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { CAMP_TILE } from '../../src/shared/haul';
import type { TileRef } from '../../src/shared/placement';
import { runScenario } from '../support/balance-harness';
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
