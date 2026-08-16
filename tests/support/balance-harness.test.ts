import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/engine/content/buildings';
import type { TileRef } from '../../src/shared/placement';
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

  /**
   * `Increment 8's own Task 10 is the precedent this one is named after: an
   * instrument that over-counts is worse than none, because it is believed.
   * `completions` is a LOG rather than a count for exactly that reason — §4.1
   * asks a question about ORDER (which of two contending sites finishes
   * first), and a count cannot answer it. This is the test that would catch
   * an implementation that counts correctly but reports the wrong sequence —
   * one that echoes `Scenario.sites`' own array order, say, rather than the
   * tick each site actually crossed `ticksLeft: 0`.
   *
   * The three sites are listed gatherersHut, forester, house — and ordered
   * (`atTick`) house first, forester second, gatherersHut last, 40 ticks
   * apart, so the three finish 40-ish ticks apart in EXACTLY the reverse of
   * their array position. A round-robin count sees three completions either
   * way; only reading the real finishing tick reproduces this sequence.
   */
  it('the completion log records order, not just totals', async () => {
    const r = await runScenario({
      defId: 'sawmill', col: 10, row: 0, crew: 0, haulers: 4, ticks: 140, resource: 'planks',
      sites: [
        { defId: 'gatherersHut', col: 3, row: 4, atTick: 80 },
        { defId: 'forester', col: 3, row: 5, atTick: 40 },
        { defId: 'house', col: 3, row: 6, atTick: 0 },
      ],
    });
    expect(r.completions.map((c) => c.defId)).toEqual(['house', 'forester', 'gatherersHut']);
    expect(r.completions[0].tick).toBeLessThan(r.completions[1].tick);
    expect(r.completions[1].tick).toBeLessThan(r.completions[2].tick);
    // Every entry names the real building the command spawned, not a
    // placeholder — three distinct ids, one per site.
    expect(new Set(r.completions.map((c) => c.buildingId)).size).toBe(3);
  });

  /**
   * THE ZERO SIDE, and the one that actually catches an over-counting
   * instrument: a completion log that fires on anything other than a
   * genuine `Scenario.sites` order — a building that starts finished, say,
   * or a stray notice a future change starts publishing — has nothing here
   * to produce a false entry from, and would still have to report `[]`.
   */
  it('a scenario with no sites reports no completions', async () => {
    const r = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 1, ticks: 30, resource: 'wood' });
    expect(r.completions).toEqual([]);
  });

  /**
   * THE FABRICATION GUARD, and the case that found it: a site ordered onto a
   * tile something is already standing on.
   *
   * `handleConstructBuilding` refuses that order ('Cannot build there.'), so
   * NO site is ever created — but the occupant is a real building at exactly
   * those coordinates with `constructionTicks: 0`, and a resolution matching
   * on the tile alone adopts it and logs a completion for a build that never
   * happened. That is the over-counting instrument increment 8's Task 10 named
   * as worse than no instrument at all, landing on the one reading §4.1 cannot
   * take any other way.
   *
   * The scenario below orders a `house` onto the SAWMILL STAGE'S OWN TILE, so
   * the occupant is a building the harness itself placed and the run is
   * otherwise ordinary. Asserting the REJECTION rather than `completions == []`
   * is the stronger form and the deliberate one: an unresolved descriptor is a
   * measurement that never happened, and a run that reports a plausible zero
   * for it is the same class of defect as one that reports a false completion.
   * Nothing may be published off it, so nothing is returned.
   *
   * DISCRIMINATING BY CONSTRUCTION: revert the resolution to a tile-only match
   * and this run stops throwing and reports one completion — verified by
   * reverting the guard and re-running, not by inspection.
   */
  it('a site ordered onto an occupied tile yields no result at all', async () => {
    await expect(runScenario({
      defId: 'sawmill', col: 10, row: 0, crew: 0, haulers: 2, ticks: 40, resource: 'planks',
      sites: [{ defId: 'house', col: 10, row: 0, atTick: 0 }],
    })).rejects.toThrow(/never appeared as a construction site/);
  }, 30000);

  /**
   * The same fabrication through the OTHER door: two descriptors on one tile.
   * The first order is accepted and the second refused, so exactly one site
   * exists — and a resolution that does not exclude ids another descriptor has
   * already taken hands both descriptors the same entity and reports one build
   * as two completions.
   */
  it('two site orders on one tile yield no result at all', async () => {
    await expect(runScenario({
      defId: 'sawmill', col: 10, row: 0, crew: 0, haulers: 2, ticks: 60, resource: 'planks',
      sites: [
        { defId: 'gatherersHut', col: 3, row: 4, atTick: 0 },
        { defId: 'gatherersHut', col: 3, row: 4, atTick: 1 },
      ],
    })).rejects.toThrow(/never appeared as a construction site/);
  }, 30000);

  /**
   * THE GUARD the reachability argument's second conjunct hangs on, pinned
   * directly rather than left as prose (OBS-8-01).
   *
   * That conjunct is "the moved building is never a store site", and its chain
   * ends at "a scenario stage must have a recipe". `ScenarioStage.defId` is
   * typed `BuildingDefId`, so `defId: 'storehouse'` is expressible today — what
   * actually stops it is `stageResultOf`'s throw. Nothing pinned that throw:
   * the test below it pins the CATALOG fact, and deleting the throw would void
   * the argument without reddening anything.
   *
   * WHAT THIS DOES AND DOES NOT GUARANTEE, stated precisely because the
   * argument is only as strong as this line. The throw fires AFTER the tick
   * loop, from `stageResultOf`, so a recipe-less stage runs the full simulation
   * — blind spot included — and only then rejects. What the guard buys is
   * therefore not "the defect never executes" but "no such run ever yields a
   * `BalanceResult`", which is the property §4.2 needs, since a figure can only
   * be published off a result that was returned. That is exactly what is
   * asserted here: the promise REJECTS, on that message, so nothing is
   * returned.
   */
  it('a stage the catalog gives no recipe yields no result at all', async () => {
    expect(BUILDINGS.storehouse.storage).toBeGreaterThan(0);
    expect(BUILDINGS.storehouse.recipe).toBeNull();
    await expect(runScenario({
      defId: 'storehouse', col: 8, row: 4, crew: 1, haulers: 1, ticks: 5, resource: 'wood',
    })).rejects.toThrow(/has no recipe to measure/);
  });

  /**
   * THE REACHABILITY PIN for the transfer counter's one known blind spot
   * (OBS-8-01), and it asserts the premises of that argument rather than
   * restating its conclusion — see `dispatchedTransfer` in balance-harness.ts
   * for the blind spot itself and for what a future fix would have to do.
   *
   * The argument is a CONJUNCTION of two facts, neither sufficient alone:
   * nothing a measured scenario runs can demolish (which rules out the
   * demolition half of the path), AND the one command `runScenario` does issue
   * can never cancel anything (the move half). This test carries the second.
   *
   * That second conjunct: the only mid-run command any measured scenario issues
   * is `moveBuilding` on `buildingIds[0]`, and `handleMoveBuilding` cancels only
   * a `fetching` trip whose `sourceSiteId` is the building it moves. A
   * `sourceSiteId` is a STORE SITE, so the blind spot needs the moved building
   * to be one — and it never can be, because a stage must have a recipe (the
   * test above pins that guard) and nothing in the catalog both stores and has
   * one. THAT is the catalog assertion below, and it is the warning: give the
   * storehouse a recipe, or a producer some storage, and it reddens, because
   * the reachability argument is void from that commit on.
   *
   * The behavioural half below is CORROBORATION, not a third premise, and it
   * buys less than it looks like it does: by the very argument above, a run
   * that relocates a stage beside a live depot is exactly as unable to reach
   * the blind spot as one that relocates nothing, so its agreement of the two
   * derivations (14 and 14 as written) confirms the counters on a fixture where
   * they were never in doubt. What it does buy is that the argument's premises
   * are about the fixture actually run rather than about an imagined one — the
   * move lands, the depot lives, transfers really are dispatched — and that the
   * class split partitions. It is one-sided for the reason balance.test.ts's
   * version is: a trip still walking out at the end has been dispatched and not
   * yet turned. The direction that cannot happen is the negative one, and that
   * is exactly what a missed dispatch would produce.
   *
   * DISCRIMINATING, per the rule these counters were built under: the control
   * is the SAME scenario with the depot taken away, hauling just as hard and
   * moving its building at just the same tick. A counter keyed on the
   * `fetching` leg, or on the move itself, reads positive there.
   */
  it('a mid-run move cannot reach the transfer counter, and the catalog is why', async () => {
    const stores = Object.values(BUILDINGS).filter((def) => def.storage > 0);
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((def) => def.recipe === null)).toBe(true);

    const HAULERS = 3;
    const moving = (storehouses?: TileRef[]) => runScenario({
      defId: 'forester', col: 12, row: 6, crew: 2, haulers: HAULERS, ticks: 250, resource: 'wood',
      second: { defId: 'sawmill', col: 15, row: 9, crew: 1, resource: 'planks' },
      storehouses,
      moveTo: { col: 12, row: 10, atTick: 120 },
    });
    const control = await moving();
    const withDepot = await moving([{ col: 13, row: 8 }]);

    // Both runs really did move a building mid-flight, and really did haul.
    expect(control.relocatingTicks).toBeGreaterThan(0);
    expect(withDepot.relocatingTicks).toBeGreaterThan(0);
    expect(control.supplyReturns).toBeGreaterThan(0);
    expect(control.haulerTicks.fetching).toBeGreaterThan(0);

    expect(control.transfers).toBe(0);
    expect(withDepot.transfers).toBeGreaterThan(0);
    expect(withDepot.transfersStaging + withDepot.transfersDrain).toBe(withDepot.transfers);
    expect(withDepot.transfers - withDepot.transferReturns).toBeGreaterThanOrEqual(0);
    expect(withDepot.transfers - withDepot.transferReturns).toBeLessThanOrEqual(HAULERS);
  }, 60000);
});
