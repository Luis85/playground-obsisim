import type { BuildingDefId } from './content-types';

export type Command =
  | { type: 'constructBuilding'; buildingDefId: BuildingDefId; at?: { col: number; row: number } }
  | { type: 'recruitWorker' }
  | { type: 'assignWorker'; buildingId: number }
  | { type: 'unassignWorker'; buildingId: number }
  | { type: 'demolishBuilding'; buildingId: number };
