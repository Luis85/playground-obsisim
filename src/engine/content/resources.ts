import type { ResourceDef, ResourceId } from '../../shared/content-types';
import { BALANCE } from './balance';

export const RESOURCES: Record<ResourceId, ResourceDef> = {
  berries: { id: 'berries', name: 'Berries', tier: 'raw', value: 1, edible: true },
  wheat: { id: 'wheat', name: 'Wheat', tier: 'raw', value: 1, edible: false },
  wood: { id: 'wood', name: 'Wood', tier: 'raw', value: 1, edible: false },
  flour: { id: 'flour', name: 'Flour', tier: 'processed', value: 3, edible: false },
  planks: { id: 'planks', name: 'Planks', tier: 'processed', value: 3, edible: false },
  bread: { id: 'bread', name: 'Bread', tier: 'finished', value: 8, edible: true },
  tools: { id: 'tools', name: 'Tools', tier: 'finished', value: 10, edible: false },
};

export const RESOURCE_IDS = Object.keys(RESOURCES) as readonly ResourceId[];

/**
 * Meals per unit, derived from what each edible actually restores rather than
 * hand-written. One meal is `mealThreshold` hunger points — what a bread
 * delivers when eaten the moment a colonist becomes eligible — so berries at
 * `berriesHungerRestore` score 30/50 = 0.6. Derived so a hunger retune cannot
 * silently desync the Population view's headline number from what eating
 * actually does.
 */
export const MEAL_WEIGHTS: Readonly<Record<string, number>> = {
  bread: 1,
  berries: BALANCE.berriesHungerRestore / BALANCE.mealThreshold,
};
