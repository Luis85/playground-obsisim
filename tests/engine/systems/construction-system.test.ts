import { describe, expect, it } from 'vitest';
import { SystemError } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import { BALANCE } from '../../../src/engine/content/balance';
import { Building, Construction, Home, InputBuffer, Production } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { ConstructionSystem } from '../../../src/engine/systems/construction-system';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { PopulationSystem } from '../../../src/engine/systems/population-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import {
  buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist, type TColonySystemFactory,
} from '../../../src/engine/world';
import { campAdjacentFreeTile } from '../fixtures';

/**
 * `ConstructionSystem` (Task 5) — the countdown, and completion.
 *
 * Every SITE here is built the same reach `world.test.ts`'s `finishEverySite`
 * and `haul-dispatch.test.ts`'s `site: true` spec already use: `spawnBuilding`
 * has no save field for a countdown or an over-cap in-tray until Task 8, so
 * `Construction.ticksLeft` and `InputBuffer.amounts` are set on the live
 * component AFTER `prepareRun` rather than threaded through the save record.
 */

const ADULT = BALANCE.lifeBands.matureTicks;

interface BuildSpec {
  defId: BuildingDefId;
  col: number;
  row: number;
  crew?: number;
  /** Turns the spawned building into a site, applied after `prepareRun` (see
   * file doc comment). */
  site?: { ticksLeft: number; tray?: Partial<Record<ResourceId, number>> };
}

async function setup(
  specs: readonly BuildSpec[],
  systems: readonly TColonySystemFactory[],
  opts: { camp?: Partial<Record<ResourceId, number>>; haulers?: number; homeless?: number } = {},
) {
  const save = initialSave();
  save.colonists = [];
  save.buildings = [];
  save.stockpile = { ...opts.camp };
  const prep = buildColonyPrepWorld({ save, systems });
  const ids = getPrepResource(prep, IdCounter);
  const buildings = specs.map((spec) => spawnBuilding(prep, ids, {
    defId: spec.defId, progress: 0, batchActive: false, col: spec.col, row: spec.row, relocatingTicks: 0,
  }));
  specs.forEach((spec, i) => {
    const buildingId = buildings[i].getComponent(Building)!.id;
    for (let c = 0; c < (spec.crew ?? 0); c++) spawnColonist(prep, ids, { buildingId, homeId: buildingId, ageTicks: ADULT });
  });
  const haulerCount = opts.haulers ?? 0;
  const haulerHomeId = haulerCount > 0 ? spawnBuilding(prep, ids, {
    defId: 'house', progress: 0, batchActive: false, relocatingTicks: 0, ...campAdjacentFreeTile(specs),
  }).getComponent(Building)!.id : null;
  const haulers = Array.from({ length: haulerCount }, () => spawnColonist(prep, ids, { hauling: true, homeId: haulerHomeId, ageTicks: ADULT }));
  const homeless = Array.from({ length: opts.homeless ?? 0 }, () => spawnColonist(prep, ids, { homeId: null, ageTicks: ADULT }));

  const world = await prep.prepareRun();
  specs.forEach((spec, i) => {
    if (spec.site === undefined) return;
    buildings[i].getComponent(Construction)!.ticksLeft = spec.site.ticksLeft;
    const input = buildings[i].getComponent(InputBuffer)!;
    for (const [id, amount] of Object.entries(spec.site.tray ?? {})) input.amounts.set(id as ResourceId, amount);
  });

  let systemErrors = 0;
  world.eventBus.subscribe(SystemError, () => { systemErrors++; });
  const step = async (times: number) => { for (let i = 0; i < times; i++) await world.step(); };
  return {
    world, buildings, haulers, homeless, step, stockpile: world.getResource(Stockpile),
    errors: () => systemErrors,
  };
}

describe('ConstructionSystem', () => {
  it('a site short of one material does not count down', async () => {
    // Everything but one plank of a mill's 20-wood/10-plank cost:
    // DISCRIMINATING — an implementation testing "has any materials" (wood
    // alone) or "has the first material" (RESOURCE_IDS order) passes wrongly.
    const { buildings, step, errors } = await setup(
      [{ defId: 'mill', col: 4, row: 1, site: { ticksLeft: BALANCE.buildTicks, tray: { wood: 20, planks: 9 } } }],
      [ConstructionSystem],
    );

    await step(BALANCE.buildTicks + 20);

    expect(buildings[0].getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks); // UNCHANGED
    expect(buildings[0].getComponent(InputBuffer)!.total()).toBe(29); // nothing cleared either
    expect(errors()).toBe(0);
  });

  it('a fully supplied site counts down and completes, and the building produces on the NEXT tick', async () => {
    // gatherersHut: cost wood:10 only, and a recipe with NO inputs, so once
    // ProductionSystem stops skipping it (construction finished) a batch
    // starts on the very next ordinary pass with nothing further to deliver.
    const { buildings, step, errors } = await setup(
      [{ defId: 'gatherersHut', col: 4, row: 1, crew: 1, site: { ticksLeft: BALANCE.buildTicks, tray: { wood: 10 } } }],
      [ProductionSystem, ConstructionSystem],
    );
    const building = buildings[0];

    for (let i = 0; i < BALANCE.buildTicks - 1; i++) {
      await step(1);
      expect(building.getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks - 1 - i); // still counting
      expect(building.getComponent(InputBuffer)!.total()).toBe(10); // held until the very last tick
    }
    await step(1); // the tick that brings it to zero
    expect(building.getComponent(Construction)!.ticksLeft).toBe(0);
    expect(building.getComponent(InputBuffer)!.total()).toBe(0); // in-tray emptied at completion
    // Not yet produced THIS tick — ProductionSystem, ranked ahead of
    // ConstructionSystem, read the site as still under construction before
    // this same tick's own completion runs.
    expect(building.getComponent(Production)!.batchActive).toBe(false);

    await step(1); // the NEXT tick: an ordinary ProductionSystem pass
    expect(building.getComponent(Production)!.batchActive).toBe(true);
    expect(building.getComponent(Production)!.progress).toBeGreaterThan(0);
    expect(errors()).toBe(0);
  });

  it('completion records no consumption', async () => {
    // §2.8: emptying the in-tray at zero must not touch consumedThisTick —
    // those goods were consumed when `unload` (haul-system.ts) recorded their
    // ARRIVAL, not when construction finally spends them. `recordConsumed`
    // here would double the flow this build ever cost the colony.
    const { buildings, step, stockpile, errors } = await setup(
      [{ defId: 'sawmill', col: 4, row: 1, site: { ticksLeft: 1, tray: { wood: 25 } } }], // one tick from completion
      [ConstructionSystem],
    );

    expect(stockpile.consumedThisTick.get('wood') ?? 0).toBe(0); // control: nothing recorded yet
    await step(1);

    expect(buildings[0].getComponent(Construction)!.ticksLeft).toBe(0); // it DID complete this tick
    expect(buildings[0].getComponent(InputBuffer)!.total()).toBe(0);
    expect(stockpile.consumedThisTick.get('wood') ?? 0).toBe(0); // and STILL nothing recorded
    expect(errors()).toBe(0);
  });

  it('a house completes and is then homed by the ordinary pass', async () => {
    // No special case in completion: `rehome` (PopulationSystem) simply reads
    // `isUnderConstruction` off the live component the next time it runs, one
    // rank AHEAD of ConstructionSystem in ALL_SYSTEMS. So a homeless colonist
    // stays homeless through the completion tick and is seated the tick after.
    const { buildings, homeless, step, errors } = await setup(
      [{ defId: 'house', col: 4, row: 1, site: { ticksLeft: 1, tray: { wood: 15, planks: 5 } } }],
      [PopulationSystem, ConstructionSystem],
      { homeless: 1 },
    );
    const house = buildings[0];
    const nomad = homeless[0];

    await step(1); // the completion tick: PopulationSystem ran BEFORE this tick's own completion
    expect(house.getComponent(Construction)!.ticksLeft).toBe(0);
    expect(nomad.getComponent(Home)!.buildingId).toBeNull(); // still homeless

    await step(1); // the ordinary next pass
    expect(nomad.getComponent(Home)!.buildingId).toBe(house.getComponent(Building)!.id);
    expect(errors()).toBe(0);
  });

  it('three affordable sites ordered at once ALL complete', async () => {
    // ACCEPTANCE CRITERION 4. No assertion about which finishes first or how
    // long it takes — dispatch ordering is untouched this increment, so
    // round-robin filling across three sites and two haulers is EXPECTED, not
    // a defect to "fix" by tuning the tick budget to sequential delivery.
    const specs: BuildSpec[] = [
      { defId: 'gatherersHut', col: 6, row: 0, site: { ticksLeft: BALANCE.buildTicks } },
      { defId: 'gatherersHut', col: 10, row: 0, site: { ticksLeft: BALANCE.buildTicks } },
      { defId: 'gatherersHut', col: 14, row: 0, site: { ticksLeft: BALANCE.buildTicks } },
    ];
    const { buildings, step, stockpile, errors } = await setup(specs, [HaulSystem, ConstructionSystem], {
      camp: { wood: 1000 }, haulers: 2,
    });

    // Generous on purpose (see above): three 10-wood sites, two haulers'
    // worth of round-robin delivery, plus BALANCE.buildTicks once each is
    // fully supplied — comfortably looser than a sequential-delivery estimate
    // would need.
    await step(600);

    for (const site of buildings) {
      expect(site.getComponent(Construction)!.ticksLeft).toBe(0);
      expect(site.getComponent(InputBuffer)!.total()).toBe(0);
    }
    expect(stockpile.get('wood')).toBe(1000 - 3 * 10); // conserved: 30 units left the camp, none minted
    expect(errors()).toBe(0);
  });
});
