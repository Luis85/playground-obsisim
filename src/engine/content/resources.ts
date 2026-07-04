import type { ResourceDef, ResourceId } from '../../shared/content-types';

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
