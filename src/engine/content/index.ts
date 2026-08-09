// The content catalog's single import surface for the app layer: views and
// stores read definitions through this barrel instead of reaching into the
// individual catalog modules (engine internals keep their direct imports).
export { BALANCE } from './balance';
export { BUILDINGS, BUILDING_IDS } from './buildings';
export { CHAINS } from './chains';
export { MEAL_WEIGHTS, RESOURCES, RESOURCE_IDS } from './resources';
export type { BuildingDef, BuildingDefId, CostMap, ResourceId } from '../../shared/content-types';
