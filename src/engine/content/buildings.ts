import type { BuildingDef, BuildingDefId, RecipeDef } from '../../shared/content-types';
import { BALANCE } from './balance';

export const BUILDINGS: Record<BuildingDefId, BuildingDef> = {
  gatherersHut: {
    id: 'gatherersHut', name: "Gatherer's Hut", cost: { wood: 10 }, workerSlots: 2,
    recipe: { inputs: {}, outputs: { berries: 1 }, ticksPerBatch: 3 }, beds: 0,
  },
  farm: {
    id: 'farm', name: 'Farm', cost: { wood: 20 }, workerSlots: 4,
    recipe: { inputs: {}, outputs: { wheat: 1 }, ticksPerBatch: 4 }, beds: 0,
  },
  mill: {
    id: 'mill', name: 'Mill', cost: { wood: 20, planks: 10 }, workerSlots: 2,
    recipe: { inputs: { wheat: 1 }, outputs: { flour: 1 }, ticksPerBatch: 3 }, beds: 0,
  },
  bakery: {
    id: 'bakery', name: 'Bakery', cost: { wood: 15, planks: 10 }, workerSlots: 2,
    recipe: { inputs: { flour: 1 }, outputs: { bread: 1 }, ticksPerBatch: 4 }, beds: 0,
  },
  forester: {
    id: 'forester', name: 'Forester', cost: { wood: 10 }, workerSlots: 2,
    recipe: { inputs: {}, outputs: { wood: 1 }, ticksPerBatch: 3 }, beds: 0,
  },
  sawmill: {
    id: 'sawmill', name: 'Sawmill', cost: { wood: 25 }, workerSlots: 2,
    recipe: { inputs: { wood: 1 }, outputs: { planks: 1 }, ticksPerBatch: 3 }, beds: 0,
  },
  workshop: {
    id: 'workshop', name: 'Workshop', cost: { planks: 20 }, workerSlots: 2,
    recipe: { inputs: { planks: 1 }, outputs: { tools: 1 }, ticksPerBatch: 5 }, beds: 0,
  },
  house: {
    id: 'house', name: 'House', cost: { wood: 15, planks: 5 }, workerSlots: 0,
    recipe: null, beds: BALANCE.houseBeds,
  },
};

export const BUILDING_IDS = Object.keys(BUILDINGS) as readonly BuildingDefId[];

/** Units one batch of a recipe adds to a building's output buffer. */
export function batchOutputUnits(recipe: RecipeDef | null): number {
  if (recipe === null) return 0;
  let units = 0;
  for (const amount of Object.values(recipe.outputs)) units += amount;
  return units;
}
