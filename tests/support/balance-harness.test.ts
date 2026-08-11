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
   * THE REACHABILITY PIN for the transfer counter's one known blind spot
   * (OBS-8-01), and it asserts the two premises of that argument rather than
   * restating its conclusion — see `dispatchedTransfer` in balance-harness.ts
   * for the blind spot itself and for what a future fix would have to do.
   *
   * The argument: the only mid-run command any measured scenario issues is
   * `moveBuilding` on `buildingIds[0]`, and `handleMoveBuilding` cancels only a
   * `fetching` trip whose `sourceSiteId` is the building it moves. A
   * `sourceSiteId` is a STORE SITE, so the blind spot needs the moved building
   * to be one — and it never can be, because a stage must have a recipe
   * (`stageResultOf` throws otherwise) and nothing in the catalog both stores
   * and has one. THAT is the catalog assertion below, and it is the warning:
   * give the storehouse a recipe, or a producer some storage, and it reddens,
   * because the reachability argument is void from that commit on.
   *
   * The second premise is behavioural and measured rather than argued — a run
   * that moves a building mid-flight WHILE a depot is live still reports the
   * two independent derivations of the transfer count in agreement (14 and 14
   * as written). It is one-sided for the reason balance.test.ts's version is:
   * a trip still walking out at the end has been dispatched and not yet turned.
   * The direction that cannot happen is the negative one, and that is exactly
   * what a missed dispatch would produce.
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
