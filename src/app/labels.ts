import { RESOURCES, type CostMap, type ResourceId } from '../engine/content';
import type { BuildingState } from '../shared/snapshot';

export const BUILDING_STATE_LABELS: Record<BuildingState, string> = {
  producing: 'Producing',
  waitingForInput: 'Waiting for input',
  unstaffed: 'Unstaffed',
  outputFull: 'Output full',
};

/** "10 Wood, 5 Planks" — shared by the construct table and the build palette. */
export function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}
