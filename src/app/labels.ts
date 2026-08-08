import { RESOURCES, type BuildingDef, type CostMap, type ResourceId } from '../engine/content';
import type { BuildingState } from '../shared/snapshot';

export const BUILDING_STATE_LABELS: Record<BuildingState, string> = {
  producing: 'Producing',
  waitingForInput: 'Waiting for input',
  unstaffed: 'Unstaffed',
  outputFull: 'Output full',
  relocating: 'Relocating',
  housing: 'Housing',
};

/** "10 Wood, 5 Planks" — shared by the construct table and the build palette. */
export function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}

/** "6t" while a moved building's countdown still runs, "—" once it has
 * settled — the Buildings table's Downtime column. Extracted (rather than an
 * inline ternary) so the table's `<template>` doesn't carry the branch:
 * presentation lives in labels.ts, per BuildingsView's own comment. Its one
 * caller today is that table; the natural second call site,
 * SelectionPanel.vue's relocation countdown, already carries its own inline
 * branch with different wording ("Relocating: 9t left", not "6t") — that,
 * not a lack of reuse, is why this has a single caller. */
export function downtimeLabel(relocatingTicks: number): string {
  return relocatingTicks > 0 ? `${relocatingTicks}t` : '—';
}

/** "1 Wheat → 1 Flour (3wt)" for a producer, "Shelters 4" for a def with no
 * recipe — the Construct table's Recipe column. Extracted for the same reason
 * downtimeLabel is: presentation lives in labels.ts, not the table's
 * `<template>`, and a plain function sidesteps narrowing a dynamically
 * indexed `BUILDINGS[id]` access inside the template itself. */
export function recipeLabel(def: BuildingDef): string {
  if (def.recipe === null) return `Shelters ${def.beds}`;
  const { inputs, outputs, ticksPerBatch } = def.recipe;
  return `${costLabel(inputs) || '—'} → ${costLabel(outputs)} (${ticksPerBatch}wt)`;
}
