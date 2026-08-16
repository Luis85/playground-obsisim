import { describe, expect, it } from 'vitest';
import { SystemError } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { Building, Construction, Home, InputBuffer, Production } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { ConstructionSystem } from '../../../src/engine/systems/construction-system';
import { HaulSystem, haulerCapacity } from '../../../src/engine/systems/haul-system';
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
  opts: {
    camp?: Partial<Record<ResourceId, number>>; haulers?: number; homeless?: number;
    /** Haulers with NO home, so `haulerCapacity` charges `homelessFactor` and
     * they carry 3 rather than 6. A hauler's carry is what decides which unit
     * of a site's bill is the last one, so it is a subject here rather than a
     * detail — see the gatherer's hut case below. */
    homelessHaulers?: number;
  } = {},
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
  const nomadHaulers = Array.from(
    { length: opts.homelessHaulers ?? 0 },
    () => spawnColonist(prep, ids, { hauling: true, homeId: null, ageTicks: ADULT }),
  );

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
    world, buildings, haulers, homeless, nomadHaulers, step, stockpile: world.getResource(Stockpile),
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

/**
 * OBS-9-01 — A SITE'S LAST LOAD MAY FALL BELOW `minSupplyUnits`, AND THE SITE
 * MUST STILL BE FINISHED.
 *
 * A site's room shrinks by whole hauler-loads and nothing at a site ever
 * consumes anything, so the room left after the last full load is
 * `cost[r] mod capacity` and it never grows back. Where that remainder is
 * below `BALANCE.minSupplyUnits`, `worthMoving`'s floor refused the trip on
 * every tick forever and the building could not be built AT ALL — measured at
 * every distance and hauler count, with the missing unit standing at the camp.
 *
 * These cases assert COMPLETION rather than a dispatch decision, because that
 * is the promise that was broken: the increment's whole claim is that a site
 * finishes once its materials arrive. Each names the arithmetic that puts its
 * remainder under the floor, so a fixture that stops being the case it was
 * written for says so instead of passing quietly.
 */
describe('a site whose last load is below the supply floor', () => {
  /** The remainder a def's bill for one material leaves after the last full
   * load — the quantity `worthMoving` used to refuse. Derived rather than
   * written out, since it is a relationship between three shipped numbers and
   * any of them may be retuned. */
  const lastLoad = (defId: BuildingDefId, resource: ResourceId, capacity: number) =>
    (BUILDINGS[defId].cost[resource] ?? 0) % capacity;

  it('a sawmill site completes, though its last unit is below minSupplyUnits', async () => {
    // THE HEADLINE CASE, and the one the defect was found on: a sawmill costs
    // 25 wood, a housed hauler carries 6, and 25 = 4x6 + 1. The site filled to
    // 24/25 and stopped there for the rest of the game.
    const capacity = BALANCE.haulCarryCapacity; // the haulers below are housed beside the camp
    expect(lastLoad('sawmill', 'wood', capacity)).toBe(1);
    expect(lastLoad('sawmill', 'wood', capacity)).toBeLessThan(BALANCE.minSupplyUnits); // the floor refused it
    expect(lastLoad('sawmill', 'wood', capacity)).toBeGreaterThan(0); // and there really is a tail to strand

    const { buildings, step, stockpile, errors } = await setup(
      [{ defId: 'sawmill', col: 4, row: 1, site: { ticksLeft: BALANCE.buildTicks } }],
      [HaulSystem, ConstructionSystem],
      { camp: { wood: 1000 }, haulers: 2 },
    );

    await step(600); // generous: five loads of round-robin delivery plus the countdown

    expect(buildings[0].getComponent(Construction)!.ticksLeft).toBe(0); // BUILT
    expect(buildings[0].getComponent(InputBuffer)!.total()).toBe(0); // tray emptied at completion
    // Conserved, and the whole bill was really carried: 25 units left the camp,
    // which is what distinguishes "completed" from "completed early".
    expect(stockpile.get('wood')).toBe(1000 - 25);
    expect(errors()).toBe(0);
  });

  it('a site short of a single unit for any other reason completes too', async () => {
    // THE GENERAL SHAPE, not the sawmill's arithmetic. A mill site already
    // holding 20 wood and 9 of its 10 planks owes exactly one plank, and the
    // shortfall arises from what is already in the tray rather than from
    // `cost mod capacity` — 10 planks against a carry of 6 would leave a
    // remainder of 4, comfortably above the floor. An exemption keyed on a
    // def's cost and a hauler's capacity rather than on the room actually
    // left passes the case above and fails this one.
    expect(lastLoad('mill', 'planks', BALANCE.haulCarryCapacity)).toBeGreaterThanOrEqual(BALANCE.minSupplyUnits);

    const { buildings, step, stockpile, errors } = await setup(
      [{ defId: 'mill', col: 4, row: 1, site: { ticksLeft: BALANCE.buildTicks, tray: { wood: 20, planks: 9 } } }],
      [HaulSystem, ConstructionSystem],
      { camp: { planks: 40 }, haulers: 1 },
    );

    await step(200);

    expect(buildings[0].getComponent(Construction)!.ticksLeft).toBe(0);
    expect(buildings[0].getComponent(InputBuffer)!.total()).toBe(0);
    expect(stockpile.get('planks')).toBe(40 - 1); // exactly the one unit outstanding, no more
    expect(errors()).toBe(0);
  });

  it('a gatherer\'s hut completes for homeless haulers, whose carry makes ITS bill the awkward one', async () => {
    // WHICH DEFS ARE AFFECTED IS A PROPERTY OF THE HAULER, not of the catalog:
    // a homeless hauler carries 3, and 10 wood is 3x3 + 1. So the hut — which
    // the housed fixtures above build without trouble — is the def that
    // stranded, at 9/10, while a farm ordered beside it finished normally.
    // This is why the fix may not be keyed on any particular def or on the
    // flat `haulCarryCapacity`.
    const capacity = haulerCapacity(null);
    expect(capacity).toBeLessThan(BALANCE.haulCarryCapacity); // a real penalty, not the flat rate
    expect(lastLoad('gatherersHut', 'wood', capacity)).toBe(1);
    expect(lastLoad('gatherersHut', 'wood', BALANCE.haulCarryCapacity)).toBeGreaterThanOrEqual(BALANCE.minSupplyUnits);

    const { buildings, step, stockpile, errors } = await setup(
      [
        { defId: 'gatherersHut', col: 4, row: 1, site: { ticksLeft: BALANCE.buildTicks } },
        { defId: 'farm', col: 8, row: 1, site: { ticksLeft: BALANCE.buildTicks } },
      ],
      [HaulSystem, ConstructionSystem],
      { camp: { wood: 1000 }, homelessHaulers: 2 },
    );

    await step(600);

    // The hut, which is the subject — and the farm beside it, which is the
    // control the measurement used: 20 wood is 6x3 + 2, above the floor, so it
    // completed even before the fix and its completion here says the fixture
    // is delivering at all.
    expect(buildings[0].getComponent(Construction)!.ticksLeft).toBe(0);
    expect(buildings[1].getComponent(Construction)!.ticksLeft).toBe(0);
    expect(stockpile.get('wood')).toBe(1000 - 10 - 20);
    expect(errors()).toBe(0);
  });
});
