import { RESOURCES, type CostMap, type ResourceId } from '../engine/content';
import type { BuildingState } from '../shared/snapshot';

export const BUILDING_STATE_LABELS: Record<BuildingState, string> = {
  producing: 'Producing',
  waitingForInput: 'Waiting for input',
  unstaffed: 'Unstaffed',
  outputFull: 'Output full',
  relocating: 'Relocating',
};

/** "10 Wood, 5 Planks" — shared by the construct table and the build palette. */
export function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}

/** "6t" while a moved building's countdown still runs, "—" once it has
 * settled — the Buildings table's Downtime column. Extracted (rather than an
 * inline ternary) so the table's `<template>` doesn't carry the branch: this
 * mirrors why costLabel already lives here instead of in the view. */
export function downtimeLabel(relocatingTicks: number): string {
  return relocatingTicks > 0 ? `${relocatingTicks}t` : '—';
}
