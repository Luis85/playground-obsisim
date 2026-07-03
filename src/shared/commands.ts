import type { BuildingDefId } from './content-types';

export type Command =
  | { type: 'constructBuilding'; buildingDefId: BuildingDefId }
  | { type: 'recruitWorker' }
  | { type: 'assignWorker'; buildingId: number }
  | { type: 'unassignWorker'; buildingId: number };
