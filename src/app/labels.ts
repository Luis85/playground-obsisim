import { BALANCE, RESOURCES, type BuildingDef, type CostMap, type ResourceId } from '../engine/content';
import type { LifeStage } from '../shared/population';
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

/** Keyed by the LifeStage union for exactly the reason BUILDING_STATE_LABELS is
 * keyed by BuildingState: a stage added to the union without a label here is a
 * compile error, not a raw `elder` leaking into the rendered table. */
export const LIFE_STAGE_LABELS: Record<LifeStage, string> = {
  child: 'Child',
  adult: 'Adult',
  elder: 'Elder',
};

/** "25y". The sim counts only ticks and nothing downstream of BALANCE sees a
 * year (spec 2.8), so the conversion happens here, against the one constant
 * that declares it — never against a literal 100. */
export function ageLabel(ageTicks: number): string {
  return `${Math.floor(ageTicks / BALANCE.yearTicks)}y`;
}

/**
 * "#9 · 12.0 tiles · 70%", or "Homeless" — the commute cost stated where the
 * player can act on it, since the only lever is moving one of the two
 * buildings. All three parts matter: the house id says WHICH building to move,
 * the distance says how far it currently is, and the percentage is the share of
 * this colonist's work the placement actually delivers.
 *
 * `homeId` is what decides the homeless wording, not a zero distance: a
 * colonist housed next door to their job also measures 0 tiles, and calling
 * that homelessness would invert the best case into the worst one.
 */
export function commuteLabel(homeId: number | null, tiles: number, factor: number): string {
  if (homeId === null) return 'Homeless';
  return `#${homeId} · ${tiles.toFixed(1)} tiles · ${(factor * 100).toFixed(0)}%`;
}

/**
 * Which tier the store's meals-per-head sits in, as a CSS class: below the
 * birth bar the colony cannot grow at all, between the two bars it can only
 * grow its own, and above both a nomad may join.
 *
 * A class rather than a label, and here rather than in a view, because BOTH
 * the Dashboard and the Population view render this figure — the tiers are
 * BALANCE's own two arrival thresholds, and two copies of the comparison are
 * two chances for the screens to colour the same number differently.
 */
export function mealsClass(perHead: number): string {
  if (perHead < BALANCE.birthFoodPerHead) return 'obsisim-negative';
  if (perHead < BALANCE.nomadFoodPerHead) return 'obsisim-warning';
  return 'obsisim-positive';
}

/** An em dash until the starvation clock starts, then the ticks LEFT before
 * this colonist dies — counting down, the way the player experiences it, not
 * the raw `starvingTicks` counting up. Same em-dash convention as
 * downtimeLabel above, for the same reason: a blank cell reads as a bug. */
export function starvingLabel(starvingTicks: number): string {
  return starvingTicks > 0 ? `${BALANCE.starvationDeathTicks - starvingTicks}t` : '—';
}
