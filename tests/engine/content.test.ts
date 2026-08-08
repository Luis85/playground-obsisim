import { describe, expect, it } from 'vitest';
import { BALANCE, STARTING_STOCK, colonistEfficiency } from '../../src/engine/content/balance';
import { MEAL_WEIGHTS, RESOURCES, RESOURCE_IDS } from '../../src/engine/content/resources';
import { BUILDINGS, BUILDING_IDS } from '../../src/engine/content/buildings';
import { CHAINS } from '../../src/engine/content/chains';
import type { ResourceId } from '../../src/shared/content-types';

// Content validation (spec §7.1): the catalog is plain typed data, so nothing
// but these tests stops a typo'd resource id, an orphaned recipe, or a
// building nobody can ever afford from shipping. Structural rules live here;
// balance numbers are the sim tests' concern.

const hasProducer = (res: string) =>
  BUILDING_IDS.some((b) => (BUILDINGS[b].recipe?.outputs[res as ResourceId] ?? 0) > 0);

describe('content catalog', () => {
  it('has 7 resources and 8 buildings', () => {
    expect(RESOURCE_IDS).toHaveLength(7);
    expect(BUILDING_IDS).toHaveLength(8);
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

  it('every building def has exactly one of a recipe or beds', () => {
    // The rule that keeps `recipe: RecipeDef | null` honest: a def with neither
    // does nothing at all, and a def with both is two mechanics in one entry.
    for (const def of Object.values(BUILDINGS)) {
      const produces = def.recipe !== null;
      const shelters = def.beds > 0;
      expect(produces !== shelters, `${def.id} must produce or shelter, not neither or both`).toBe(true);
    }
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
    expect(BALANCE.nomadFoodPerHead).toBeGreaterThan(BALANCE.birthFoodPerHead);
  });

  it('homelessness is exactly as bad as the worst commute', () => {
    // Spec 4: one number for the player to beat. A drift between these two
    // would make being homeless quietly better than living far away.
    expect(BALANCE.homelessFactor).toBe(BALANCE.commute.floor);
  });

  it('the house shelters and never produces', () => {
    expect(BUILDINGS.house.recipe).toBeNull();
    expect(BUILDINGS.house.beds).toBe(BALANCE.houseBeds);
    expect(BUILDINGS.house.workerSlots).toBe(0);
    // Costs planks, which before this had no demand outside mill/bakery/workshop.
    expect(BUILDINGS.house.cost.planks).toBeGreaterThan(0);
  });
});
