import { describe, expect, it } from 'vitest';
import { BALANCE, STARTING_STOCK, colonistEfficiency } from '../../src/engine/content/balance';
import { MEAL_WEIGHTS, RESOURCES, RESOURCE_IDS } from '../../src/engine/content/resources';
import { BUILDINGS, BUILDING_IDS } from '../../src/engine/content/buildings';
import { CHAINS } from '../../src/engine/content/chains';
import { MIGRATION_CONSTANTS } from '../../src/shared/save-migration';
import type { ResourceId } from '../../src/shared/content-types';

// Content validation (spec §7.1): the catalog is plain typed data, so nothing
// but these tests stops a typo'd resource id, an orphaned recipe, or a
// building nobody can ever afford from shipping. Structural rules live here;
// balance numbers are the sim tests' concern.

const hasProducer = (res: string) =>
  BUILDING_IDS.some((b) => (BUILDINGS[b].recipe?.outputs[res as ResourceId] ?? 0) > 0);

describe('content catalog', () => {
  it('has 7 resources and 9 buildings', () => {
    expect(RESOURCE_IDS).toHaveLength(7);
    expect(BUILDING_IDS).toHaveLength(9);
  });

  describe.each(BUILDING_IDS)('%s', (id) => {
    const def = BUILDINGS[id];

    it('references only existing resources', () => {
      const referenced = [
        ...Object.keys(def.cost),
        ...Object.keys(def.recipe?.inputs ?? {}),
        ...Object.keys(def.recipe?.outputs ?? {}),
      ];
      for (const res of referenced) expect(RESOURCES[res as ResourceId], `${res} missing`).toBeDefined();
    });

    it('has positive batch length and worker slots', () => {
      // A shelter has no batch and no crew — the exactly-one-of-recipe-or-beds
      // test below covers it instead.
      if (def.recipe === null) return;
      expect(def.recipe.ticksPerBatch).toBeGreaterThan(0);
      expect(def.workerSlots).toBeGreaterThan(0);
    });

    it('has a construction cost reachable from the starting stock', () => {
      // every cost resource is either in STARTING_STOCK or produced by some
      // building, so the wood bootstrap can eventually pay for everything
      const starting = new Set(Object.keys(STARTING_STOCK));
      for (const res of Object.keys(def.cost)) {
        expect(starting.has(res) || hasProducer(res), `cost ${res} unreachable`).toBe(true);
      }
    });
  });

  it.each(RESOURCE_IDS)('%s is produced by at least one recipe', (id) => {
    expect(hasProducer(id), `${id} has no producer`).toBe(true);
  });

  it.each(CHAINS.map((chain) => [chain.name, chain] as const))(
    'chain %s references real buildings that output the claimed resource',
    (_name, chain) => {
      for (const step of chain.steps) {
        const def = BUILDINGS[step.building];
        expect(def).toBeDefined();
        expect((def.recipe?.outputs[step.output] ?? 0) > 0).toBe(true);
      }
    },
  );

  it('exactly bread and berries are edible', () => {
    const edible = RESOURCE_IDS.filter((id) => RESOURCES[id].edible);
    expect(edible.sort()).toEqual(['berries', 'bread']);
  });

  it('colonistEfficiency matches the spec curve', () => {
    expect(colonistEfficiency(0)).toBe(1);
    expect(colonistEfficiency(BALANCE.mealThreshold)).toBe(1);
    expect(colonistEfficiency(75)).toBeCloseTo(0.6);
    expect(colonistEfficiency(100)).toBeCloseTo(0.2);
  });

  it('every building def fills exactly one role: produces, shelters, or stores', () => {
    // Increment 6 pinned "exactly one of a recipe or beds". This is that same
    // rule generalised, not replaced, to a third role: a def with none does
    // nothing at all, and a def with two is two mechanics in one entry. If it
    // ever needs a fourth arm, that is the moment to ask whether roles want to
    // be data rather than three fields.
    for (const def of Object.values(BUILDINGS)) {
      const roles = [def.recipe !== null, def.beds > 0, def.storage > 0].filter(Boolean).length;
      expect(roles, `${def.id} fills ${roles} roles`).toBe(1);
    }
  });

  it('the storehouse stores and does nothing else', () => {
    expect(BUILDINGS.storehouse.storage).toBe(BALANCE.storehouseCapacity);
    expect(BUILDINGS.storehouse.workerSlots).toBe(0); // a shed, not a job
    expect(BUILDINGS.storehouse.recipe).toBeNull();
    expect(BUILDINGS.storehouse.beds).toBe(0);
  });

  it('minSupplyUnits is small enough that a short trip is still worth it', () => {
    // Nothing spends this constant yet — HaulSystem's supply leg is Task 6's.
    // Written and tested now anyway, per this increment's suppression policy:
    // an exported symbol with no caller yet gets a test, not a lint escape.
    // Value from spec §4: low enough a small colony is never locked out of
    // supply, high enough a hauler is never sent thirteen tiles for one unit.
    expect(BALANCE.minSupplyUnits).toBe(2);
  });

  it('the three transfer constants are the values spec §4 starts them at', () => {
    // Starting points with a §4 question attached, not measured values — each
    // one's doc comment names the question it is unmeasured against. Pinned
    // here so a retune is a deliberate edit in two places rather than a number
    // that drifted, exactly as `minSupplyUnits` above is.
    expect(BALANCE.siteStagingTarget).toBe(12);
    expect(BALANCE.minTransferUnits).toBe(4);
    expect(BALANCE.storehouseFreeFloor).toBe(12);
  });

  it('a transfer costs more to justify than a supply delivery', () => {
    // The relationship, not the literals (spec §2.4): a supply trip serves a
    // building blocked right now and a transfer serves one that might be
    // blocked later, so the speculative job takes the stricter threshold.
    // Retune either constant and this still holds; swap their roles and it
    // does not.
    expect(BALANCE.minTransferUnits).toBeGreaterThan(BALANCE.minSupplyUnits);
  });

  it('a bounded site keeps a floor it can still hold real stock above', () => {
    // The floor is room a depot holds BACK, so a floor at or above the whole
    // capacity would leave a storehouse with no usable space at all — every
    // staging term would be zero and the drain would never stop. Also the
    // demand cap (`capacity - storehouseFreeFloor`, spec §2.2) has to leave
    // room for at least one consuming building's target, or no site could ever
    // hold what a single mill beside it asks for.
    expect(BALANCE.storehouseFreeFloor).toBeLessThan(BALANCE.storehouseCapacity);
    expect(BALANCE.storehouseCapacity - BALANCE.storehouseFreeFloor)
      .toBeGreaterThanOrEqual(BALANCE.siteStagingTarget);
  });

  it('every edible has a meal weight, and nothing else does', () => {
    // Both directions. A new edible with no weight is invisible to the food
    // gates — the colony would starve while the store looked full — and a
    // weight for something nobody eats inflates mealsPerHead against food
    // that can never be eaten. Derived from the catalog's own `edible` flag
    // rather than a second hand-written list, which is the thing that drifts.
    const edible = RESOURCE_IDS.filter((id) => RESOURCES[id].edible).sort();
    expect(Object.keys(MEAL_WEIGHTS).sort()).toEqual(edible);
  });

  it('a meal weight is what that food restores, relative to one meal', () => {
    // Pins the derivation, not the literal: retune berriesHungerRestore and
    // this still holds, while a hand-typed 0.6 would silently be wrong.
    expect(MEAL_WEIGHTS.bread).toBe(1);
    expect(MEAL_WEIGHTS.berries).toBe(BALANCE.berriesHungerRestore / BALANCE.mealThreshold);
    expect(MEAL_WEIGHTS.berries).toBeLessThan(MEAL_WEIGHTS.bread); // discriminating: not all 1
  });

  it('a nomad costs more stored food than a birth', () => {
    // Spec 2.7: the recovery valve is itself a trap, and this is the price.
    //
    // This assertion earned its keep during the increment-6 balance retune.
    // `birthFoodPerHead` was raised 6 -> 12 on measurement while
    // `nomadFoodPerHead` still sat at 10, and this is the test that failed —
    // the pair had silently inverted, making a stranger CHEAPER than your own
    // child and turning the trap into the easy option. The resolution was to
    // move the nomad gate with it (to 20, holding the 5:3 proportion the pair
    // shipped with), never to soften the comparison. A relationship two
    // literals happen to satisfy is one retune away from being false; this
    // line is what makes it a rule.
    expect(BALANCE.nomadFoodPerHead).toBeGreaterThan(BALANCE.birthFoodPerHead);
  });

  it('homelessness is exactly as bad as the worst commute', () => {
    // Spec 4: one number for the player to beat. A drift between these two
    // would make being homeless quietly better than living far away.
    expect(BALANCE.homelessFactor).toBe(BALANCE.commute.floor);
  });

  it('the migration constants match the balance they duplicate', () => {
    // The duplication is forced — src/shared/save-migration.ts may not import
    // BALANCE — so each one is pinned instead of trusted. Drift here would age
    // or house a migrated colony differently from a fresh one, silently.
    expect(MIGRATION_CONSTANTS.houseBeds).toBe(BALANCE.houseBeds);
    expect(MIGRATION_CONSTANTS.startingAgeTicks).toBe(BALANCE.startingAgeTicks);
    expect(MIGRATION_CONSTANTS.spreadTicks).toBe(BALANCE.lifeBands.spreadTicks);
    expect(MIGRATION_CONSTANTS.birthCooldownTicks).toBe(BALANCE.birthCooldownTicks);
  });

  it("'house' is still the only sheltering def the migration can name", () => {
    // The migration identifies a saved shelter as `defId === 'house'`, because
    // src/shared/** cannot import BUILDINGS. That literal is a duplicated fact
    // like the numbers above, and it fails in a nastier way: add a second
    // building with beds and the migration silently stops seeing it as
    // housing, seeding its residents homeless with nothing to point at.
    const sheltering = BUILDING_IDS.filter((id) => BUILDINGS[id].beds > 0);
    expect(sheltering).toEqual(['house']);
  });

  it('the house shelters and never produces', () => {
    expect(BUILDINGS.house.recipe).toBeNull();
    expect(BUILDINGS.house.beds).toBe(BALANCE.houseBeds);
    expect(BUILDINGS.house.workerSlots).toBe(0);
    // Costs planks, which before this had no demand outside mill/bakery/workshop.
    expect(BUILDINGS.house.cost.planks).toBeGreaterThan(0);
  });
});
