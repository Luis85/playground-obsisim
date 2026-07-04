import { describe, expect, it } from 'vitest';
import { BALANCE, STARTING_STOCK, workerEfficiency } from '../../src/engine/content/balance';
import { RESOURCES, RESOURCE_IDS } from '../../src/engine/content/resources';
import { BUILDINGS, BUILDING_IDS } from '../../src/engine/content/buildings';
import { CHAINS } from '../../src/engine/content/chains';
import type { ResourceId } from '../../src/shared/content-types';

describe('content catalog', () => {
  it('has 7 resources and 7 buildings', () => {
    expect(RESOURCE_IDS).toHaveLength(7);
    expect(BUILDING_IDS).toHaveLength(7);
  });

  it('recipes and costs only reference existing resources', () => {
    for (const id of BUILDING_IDS) {
      const def = BUILDINGS[id];
      for (const res of Object.keys(def.cost)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      for (const res of Object.keys(def.recipe.inputs)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      for (const res of Object.keys(def.recipe.outputs)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      expect(def.recipe.ticksPerBatch).toBeGreaterThan(0);
      expect(def.workerSlots).toBeGreaterThan(0);
    }
  });

  it('every resource is produced by at least one recipe', () => {
    for (const id of RESOURCE_IDS) {
      const produced = BUILDING_IDS.some((b) => (BUILDINGS[b].recipe.outputs[id] ?? 0) > 0);
      expect(produced, `${id} has no producer`).toBe(true);
    }
  });

  it('all construction costs are reachable from the starting stock', () => {
    // every cost resource is either in STARTING_STOCK or produced by a building
    // whose own cost only needs starting-stock resources (wood bootstrap)
    const starting = new Set(Object.keys(STARTING_STOCK));
    for (const id of BUILDING_IDS) {
      for (const res of Object.keys(BUILDINGS[id].cost)) {
        const producedSomewhere = BUILDING_IDS.some((b) => (BUILDINGS[b].recipe.outputs[res as ResourceId] ?? 0) > 0);
        expect(starting.has(res) || producedSomewhere, `cost ${res} unreachable`).toBe(true);
      }
    }
  });

  it('chains reference real buildings that output the claimed resource', () => {
    for (const chain of CHAINS) {
      for (const step of chain.steps) {
        const def = BUILDINGS[step.building];
        expect(def).toBeDefined();
        expect((def.recipe.outputs[step.output] ?? 0) > 0).toBe(true);
      }
    }
  });

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
