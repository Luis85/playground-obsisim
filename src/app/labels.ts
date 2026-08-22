import { BALANCE, BUILDINGS, RESOURCES, type BuildingDef, type BuildingDefId, type CostMap, type ResourceId } from '../engine/content';
import type { HaulKind } from '../shared/haul';
import type { LifeStage } from '../shared/population';
import type { BuildingState } from '../shared/snapshot';

export const BUILDING_STATE_LABELS: Record<BuildingState, string> = {
  producing: 'Producing',
  waitingForInput: 'Waiting for input',
  unstaffed: 'Unstaffed',
  outputFull: 'Output full',
  underConstruction: 'Under construction',
  relocating: 'Relocating',
  housing: 'Housing',
  storing: 'Storing',
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
 * InspectorPanel.vue's relocation countdown, already carries its own inline
 * branch with different wording ("Relocating: 9t left", not "6t") — that,
 * not a lack of reuse, is why this has a single caller. */
export function downtimeLabel(relocatingTicks: number): string {
  return relocatingTicks > 0 ? `${relocatingTicks}t` : '—';
}

/** "1 Wheat → 1 Flour (3wt)" for a producer, "Shelters 4" for a house, "Stores
 * 60" for a storehouse — the Construct table's Recipe column, naming all
 * three roles a def can have. A def with no recipe used to default straight
 * to "Shelters", which read the storehouse as "Shelters 0" at exactly the
 * moment a player is deciding what to build; `storage` (0 for everything that
 * is not a store) is what tells the two apart, the same way `recipe` already
 * decides the first branch. Extracted for the same reason downtimeLabel is:
 * presentation lives in labels.ts, not the table's `<template>`, and a plain
 * function sidesteps narrowing a dynamically indexed `BUILDINGS[id]` access
 * inside the template itself. */
export function recipeLabel(def: BuildingDef): string {
  if (def.recipe !== null) {
    const { inputs, outputs, ticksPerBatch } = def.recipe;
    return `${costLabel(inputs) || '—'} → ${costLabel(outputs)} (${ticksPerBatch}wt)`;
  }
  return def.storage > 0 ? `Stores ${def.storage}` : `Shelters ${def.beds}`;
}

/** Keyed by the LifeStage union for exactly the reason BUILDING_STATE_LABELS is
 * keyed by BuildingState: a stage added to the union without a label here is a
 * compile error, not a raw `elder` leaking into the rendered table. */
export const LIFE_STAGE_LABELS: Record<LifeStage, string> = {
  child: 'Child',
  adult: 'Adult',
  elder: 'Elder',
};

/**
 * What a hauler's errand is called in the Population view's Job column, keyed
 * by the HaulKind union for the reason LIFE_STAGE_LABELS is keyed by LifeStage:
 * a fourth kind is a compile error here rather than an unlabelled one silently
 * inheriting whichever branch happened to be the fallback.
 *
 * `collect` and `supply` deliberately share one word. The player's question is
 * what the colony is doing with a colonist, and both of those are the same
 * answer — goods moving between a building and a store. A transfer is the one
 * that is not: it names no building at all (`haulTargetId` is null for its
 * whole life), so a cell that resolved the target to a building name has
 * nothing to say about it, and the world view draws it exactly like any other
 * hauler carrying goods in (spec §2.10 — no new colour, no new glyph). This
 * cell is therefore the ONLY surface that can identify WHICH hauler is
 * transferring; the legend can only name the encoding.
 */
export const HAUL_KIND_LABELS: Record<HaulKind, string> = {
  collect: 'Hauling',
  supply: 'Hauling',
  transfer: 'Transferring',
};

/** "25y". The sim counts only ticks and nothing downstream of BALANCE sees a
 * year (spec 2.8), so the conversion happens here, against the one constant
 * that declares it — never against a literal 100. */
export function ageLabel(ageTicks: number): string {
  return `${Math.floor(ageTicks / BALANCE.yearTicks)}y`;
}

/**
 * "#9 · 12.0 tiles · 70%" when housed, "Homeless · 50%" when not — the commute
 * cost stated where the player can act on it, since the only lever is moving
 * one of the two buildings (or building a house at all). The percentage is the
 * share of this colonist's work the placement actually delivers, and it is the
 * one part that must survive both branches: a homeless colonist pays the
 * single largest commute penalty in the game, so dropping the number here
 * would read as "not applicable" rather than "worst possible" (OBS-6-06) — the
 * house id and the distance are the only parts that genuinely have nothing to
 * say when there is no house.
 *
 * `homeId` is what decides the homeless wording, not a zero distance: a
 * colonist housed next door to their job also measures 0 tiles, and calling
 * that homelessness would invert the best case into the worst one.
 */
export function commuteLabel(homeId: number | null, tiles: number, factor: number): string {
  const pct = `${(factor * 100).toFixed(0)}%`;
  if (homeId === null) return `Homeless · ${pct}`;
  return `#${homeId} · ${tiles.toFixed(1)} tiles · ${pct}`;
}

/**
 * "12" for a producer's buffered output, "41 / 60" for a storehouse's held
 * goods against its capacity — the Buildings table's Waiting column serves
 * both, the same way `batchLabel`'s Batch/Beds column already serves a
 * producer and a house. Branches on `storage`, not on defId, for the same
 * reason `batchLabel` branches on `beds`: `BuildingSnapshot` already carries
 * the number that decides it, so a second def gaining storage needs no edit
 * here.
 */
export function waitingLabel(storage: number, stored: number, buffered: number): string {
  return storage > 0 ? `${stored} / ${storage}` : `${buffered}`;
}

/**
 * "14 Wood" for a site still short of one material, "10 Wood, 5 Planks" for
 * one short of several — the Buildings table's Needs column, spec §2.10's
 * "needs 14 wood". Reuses `costLabel`'s own formatting (the Construct table's
 * Cost column already renders a `CostMap` this way) rather than a second
 * formatter for what is structurally the same map. An em dash for a finished
 * building, matching `downtimeLabel`'s convention: `constructionNeeds` is `{}`
 * for everything that is not a site, and a blank cell there would read as a
 * bug rather than as "nothing owed".
 */
export function needsLabel(needs: CostMap): string {
  return Object.keys(needs).length > 0 ? costLabel(needs) : '—';
}

/**
 * "11 / 25 Wood, 5 / 5 Planks" — what a construction site holds against what it
 * takes, which is the progress `needsLabel`'s shortfall cannot show: "14 Wood"
 * reads the same on a site that has just been ordered as on one load from
 * finishing. The Inspector's Needs line (spec §2.3's "have / need") reads
 * this, not `needsLabel` — Task 12 will read it too, for the Ledger's own
 * Needs cell, so its signature is a cross-task interface rather than a
 * private helper of either caller.
 *
 * `have` is derived, not published: `BuildingSnapshot.constructionNeeds` is the
 * REMAINING need, so cost minus need is what has arrived. Reads the def's cost
 * from BUILDINGS rather than taking it as an argument, the same way
 * `recipeLabel` does, so a cost change cannot desync the two halves.
 */
export function suppliedLabel(defId: BuildingDefId, needs: CostMap): string {
  const cost = BUILDINGS[defId].cost;
  const parts = Object.entries(cost).map(([id, total]) => {
    const outstanding = needs[id as ResourceId] ?? 0;
    return `${total - outstanding} / ${total} ${RESOURCES[id as ResourceId].name}`;
  });
  return parts.length > 0 ? parts.join(', ') : '—';
}

/**
 * "3 / 4" for a house, "33%" for a producer — the Buildings table's one
 * progress column, answering the same question for both: is this building
 * doing its job?
 *
 * A house has no recipe, so its batch progress is pinned at 0% forever and the
 * column would be dead space on exactly the def increment 6 added. Beds are
 * what a house is FOR, and its occupancy is the number that changes.
 *
 * Branches on `beds`, not on the def id: `BuildingSnapshot.beds` is already the
 * def's bed count, so a second def gaining beds needs no edit here.
 */
export function batchLabel(beds: number, occupants: number, progressPct: number): string {
  return beds > 0 ? `${occupants} / ${beds}` : `${progressPct}%`;
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
