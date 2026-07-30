import { describe, expect, it } from 'vitest';
import { BALANCE, STARTING_STOCK, workerEfficiency } from '../../src/engine/content/balance';
import { RESOURCES, RESOURCE_IDS } from '../../src/engine/content/resources';
import { BUILDINGS, BUILDING_IDS } from '../../src/engine/content/buildings';
import { CHAINS } from '../../src/engine/content/chains';
import type { ResourceId } from '../../src/shared/content-types';

// Content validation (spec §7.1): the catalog is plain typed data, so nothing
// but these tests stops a typo'd resource id, an orphaned recipe, or a
// building nobody can ever afford from shipping. Structural rules live here;
// balance numbers are the sim tests' concern.

const hasProducer = (res: string) =>
  BUILDING_IDS.some((b) => (BUILDINGS[b].recipe.outputs[res as ResourceId] ?? 0) > 0);

describe('content catalog', () => {
  it('has 7 resources and 7 buildings', () => {
    expect(RESOURCE_IDS).toHaveLength(7);
    expect(BUILDING_IDS).toHaveLength(7);
  });

  describe.each(BUILDING_IDS)('%s', (id) => {
    const def = BUILDINGS[id];

    it('references only existing resources', () => {
      const referenced = [
        ...Object.keys(def.cost),
        ...Object.keys(def.recipe.inputs),
        ...Object.keys(def.recipe.outputs),
      ];
      for (const res of referenced) expect(RESOURCES[res as ResourceId], `${res} missing`).toBeDefined();
    });

    it('has positive batch length and worker slots', () => {
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
        expect((def.recipe.outputs[step.output] ?? 0) > 0).toBe(true);
      }
    },
  );

  it('exactly bread and berries are edible', () => {
    const edible = RESOURCE_IDS.filter((id) => RESOURCES[id].edible);
    expect(edible.sort()).toEqual(['berries', 'bread']);
  });

  it('workerEfficiency matches the spec curve', () => {
    expect(workerEfficiency(0)).toBe(1);
    expect(workerEfficiency(BALANCE.mealThreshold)).toBe(1);
    expect(workerEfficiency(75)).toBeCloseTo(0.6);
    expect(workerEfficiency(100)).toBeCloseTo(0.2);
  });
});
