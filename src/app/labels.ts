import { BALANCE, BUILDINGS, RESOURCES, type BuildingDef, type BuildingDefId, type CostMap, type ResourceId } from '../engine/content';
import type { HaulKind } from '../shared/haul';
import type { LifeStage } from '../shared/population';
import type { BuildingSnapshot, BuildingState, ResourceStats } from '../shared/snapshot';
import type { Chain } from '../shared/content-types';
import type { DockPanel } from './stores/ui-store';

/**
 * "No idle adults — unassign someone first." Read by both staffing verbs
 * (assignWorker, on both surfaces, via `staffing.ts`) and both hauler verbs
 * (assignHauler, on both surfaces) — every one of them refuses on the exact
 * same colony-wide fact, so this is the one sentence, not four independently
 * worded copies that could drift the day one of them is reworded.
 */
export const NO_IDLE_ADULTS_REASON = 'No idle adults — unassign someone first.';

/** "No haulers to send back." — `unassignHauler`'s own refusal at zero, the
 * unassign-direction twin of `NO_IDLE_ADULTS_REASON` above. Missing on both
 * the strip and the Ledger before Task 12's sweep: `:disabled` fired, and
 * nothing said why. */
export const NO_HAULERS_REASON = 'No haulers to send back.';

/** "A building under construction cannot be moved." — `handleMoveBuilding`'s
 * one refusal that applies before a target tile is even chosen, read by the
 * Inspector's Move button (a single check, made before arming) and by the
 * Ledger's Move button (the first of three checks, since the Ledger already
 * has a target typed in). */
export const MOVE_SITE_REASON = 'A building under construction cannot be moved.';

/** "A construction site cannot be staffed until it is finished." — the first
 * of `staffing.ts`'s `staffingRefusal` branches. Named here, not inlined,
 * for the same reason every other refusal in this file is (M4, whole-branch
 * review): presentation strings live in `labels.ts`, so a caller that reads
 * `staffingRefusal`'s RETURN value never has to also import a literal it
 * could reword independently of the sentence the function actually returns. */
export const STAFFING_SITE_REASON = 'A construction site cannot be staffed until it is finished.';

/** "Every slot is filled." — `staffing.ts`'s `staffingRefusal` at capacity. */
export const STAFFING_FULL_REASON = 'Every slot is filled.';

/** "Nothing is staffed here to unassign." — `staffing.ts`'s `unassignRefusal`
 * at zero, the unassign-direction twin of the two constants above. */
export const NOTHING_STAFFED_REASON = 'Nothing is staffed here to unassign.';

/** "Whole tiles only." — `BuildingTableRow.vue`'s `moveRefusal`, guarding the
 * two typed coordinate inputs against a non-integer before `isTileBuildable`
 * (which assumes whole tiles) ever sees them. */
export const WHOLE_TILES_ONLY_REASON = 'Whole tiles only.';

/** "That tile is off the map, in the camp band, or already taken." —
 * `BuildingTableRow.vue`'s `moveRefusal`, the Ledger's own restatement of
 * `isTileBuildable`'s three failure modes in one sentence (the canvas shows
 * the same refusal as a red ghost tile instead of words). */
export const TILE_UNAVAILABLE_REASON = 'That tile is off the map, in the camp band, or already taken.';

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
const HAUL_KIND_LABELS: Record<HaulKind, string> = {
  collect: 'Hauling',
  supply: 'Hauling',
  transfer: 'Transferring',
};

/**
 * defId -> display name for every building currently in the snapshot — the
 * lookup `jobLabel` below needs to turn a colonist's bare `buildingId` into
 * the name its Job cell shows. Shared between PopulationView and
 * PopulationPanel (spec §2.7 — one derivation, two surfaces): both need this
 * exact map to feed `jobLabel`, and two components each walking
 * `snapshot.buildings` themselves would be two chances for the lookup to
 * disagree the day a def's naming rule changes.
 */
export function buildingNamesById(buildings: readonly BuildingSnapshot[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const b of buildings) names.set(b.id, BUILDINGS[b.defId].name);
  return names;
}

/**
 * What the Job column shows for one colonist — the Population view's and, as
 * of the Population panel, the dock's Population panel's, both reading this
 * one function rather than each keeping its own copy that could drift the
 * first time either was reworded (the same reasoning as
 * `BUILDING_STATE_LABELS` and `LIFE_STAGE_LABELS` above, extended to a
 * function rather than a Record because this cell also depends on the
 * colonist's own hauling state, not just a lookup key).
 *
 * `jobNames` is passed in rather than derived here: `src/app/labels.ts` has
 * no store to read `snapshot.buildings` from, and a caller recomputing it
 * once (via `buildingNamesById` above) and handing it to every row is cheaper
 * than this function re-walking the buildings array per colonist.
 *
 * '?' rather than throwing: `jobNames` only tracks buildings still in the
 * snapshot, so a stale `buildingId` (a building removed mid-tick) degrades to
 * an unknown label instead of crashing the whole table.
 *
 * `haulKind` rather than `haulTargetId`: a transfer names no building for its
 * whole life, so the id this column otherwise resolves to a name is null on
 * exactly the rows that need distinguishing. Null kind means a hauler between
 * trips, which is still hauling — `HAUL_KIND_LABELS` above covers the three
 * kinds a running trip can be.
 */
export function jobLabel(buildingId: number | null, hauling: boolean, haulKind: HaulKind | null, jobNames: Map<number, string>): string {
  if (hauling) return haulKind === null ? 'Hauling' : HAUL_KIND_LABELS[haulKind];
  if (buildingId === null) return 'Idle';
  return jobNames.get(buildingId) ?? '?';
}

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

/**
 * One rendered stage of an Economy chain — a formatted row over one CHAINS
 * step, not a def's raw numbers. Shared between EconomyView (the Ledger's
 * wide table) and EconomyPanel (the dock's narrower one) per spec §2.7's
 * "one figure, one derivation, two surfaces": both surfaces show the exact
 * same Made/t, Delivered/t and Status a stage carries, so this is the one
 * place that walks CHAINS and reads staffingByDef/stageStatuses/runways —
 * neither view derives its own copy that could drift from the other's.
 */
export interface ChainStageRow {
  building: BuildingDefId;
  stage: string;
  crew: string;
  status: string;
  starved: boolean;
  output: string;
  made: string;
  delivered: string;
  cons: string;
  stock: number;
  outputId: ResourceId;
  runway: string;
}

export interface ChainTableRow {
  name: string;
  steps: ChainStageRow[];
}

/**
 * Every CHAINS step, formatted for a table row. Takes the store's own
 * getters as plain data (never the store itself — `labels.ts` has no store
 * to read, the same boundary `buildingNamesById`/`jobLabel` already keep)
 * so a def with no buildings still renders — `staffingByDef`/`stageStatuses`
 * default to "0 (0)"/"not built" for exactly that def, which is what lets an
 * Economy stage row exist (and be clickable) before the first building of
 * that kind is ever placed.
 */
export function chainTableRows(
  chains: readonly Chain[],
  staffingByDef: Partial<Record<BuildingDefId, { total: number; staffed: number; starved: number }>>,
  stageStatuses: Partial<Record<BuildingDefId, { label: string; starved: boolean }>>,
  runways: Partial<Record<ResourceId, number>>,
  stockpile: Record<ResourceId, ResourceStats>,
): ChainTableRow[] {
  return chains.map((chain) => ({
    name: chain.name,
    steps: chain.steps.map((step) => {
      const staffing = staffingByDef[step.building] ?? { total: 0, staffed: 0, starved: 0 };
      const status = stageStatuses[step.building] ?? { label: 'not built', starved: false };
      const runway = runways[step.output];
      const stats = stockpile[step.output];
      return {
        building: step.building,
        stage: BUILDINGS[step.building].name,
        crew: `${staffing.total} (${staffing.staffed})`,
        status: status.label,
        starved: status.starved,
        output: RESOURCES[step.output].name,
        made: stats.madeRate.toFixed(2),
        // Store inflow, not gross output (OBS-4-06): since increment 4 goods
        // reach the stockpile when a hauler delivers them, not when they are
        // made, so this is the per-stage haul backlog EconomyView's own
        // "Delivered/t" heading names.
        delivered: stats.deliveredRate.toFixed(2),
        cons: stats.consumptionRate.toFixed(2),
        stock: stats.stock,
        outputId: step.output,
        runway: runway !== undefined ? `~${runway}t` : '—',
      };
    }),
  }));
}

/** The haul backlog sentence — the answer to "my production fell and I did
 * not change anything" (PRD §5). Shared between EconomyView and EconomyPanel
 * (spec §2.7): both read the exact same three store getters, so the two
 * surfaces cannot report different numbers for the same stall. */
export function haulPressureLabel(unitsWaiting: number, haulerCount: number, stalledBuildings: number): string {
  if (unitsWaiting === 0) return 'Hauling is keeping up: nothing is waiting at a building.';
  const haulers = `${haulerCount} hauler${haulerCount === 1 ? '' : 's'}`;
  const stalled = `${stalledBuildings} stalled`;
  return `${unitsWaiting} units waiting for collection — ${stalled} — ${haulers} on duty.`;
}

/** The input-side twin of haulPressureLabel above — the answer to "why is my
 * bakery stopped?" (§2.10). */
export function inputPressureLabel(buildingsWaitingForInput: number, unitsShort: number): string {
  if (buildingsWaitingForInput === 0) return 'Input delivery is keeping up: no building is waiting.';
  const buildings = `${buildingsWaitingForInput} building${buildingsWaitingForInput === 1 ? '' : 's'}`;
  return `${unitsShort} units short — ${buildings} waiting for input.`;
}

/** The build-side third of the same shape (§2.10, beside haulPressureLabel
 * and inputPressureLabel above): what the colony's construction queue still
 * owes. No "obsisim-negative" class decision here, deliberately: unlike the
 * two backlogs above, a site under construction is not a stall — that
 * judgement stays with the caller, which is why this returns only text. */
export function buildPressureLabel(buildingsUnderConstruction: number, unitsNeededForConstruction: number): string {
  if (buildingsUnderConstruction === 0) return 'Nothing is under construction.';
  const sites = `${buildingsUnderConstruction} site${buildingsUnderConstruction === 1 ? '' : 's'}`;
  return `${unitsNeededForConstruction} units needed — ${sites} under construction.`;
}

/**
 * Keyed by the `DockPanel` union for the same reason `BUILDING_STATE_LABELS`
 * above is: a sixth panel added to that union with no entry here is a
 * compile error in this file, not a live tab button that silently renders an
 * unlabelled blank (WorldScreen.vue's tab strip reads `DOCK_LABELS[p]`
 * directly, with nothing between the union and the label).
 */
export const DOCK_LABELS: Record<DockPanel, string> = {
  inspector: 'Inspector',
  colony: 'Colony',
  population: 'Population',
  economy: 'Economy',
  attention: 'Attention',
};

/**
 * The dock's four UNCONDITIONAL tabs, in display order — every `DockPanel`
 * EXCEPT `inspector`. Typed over `Exclude<DockPanel, 'inspector'>` rather
 * than a bare `DockPanel[]` so that omission is enforced here too, not
 * merely asserted in this comment.
 *
 * Inspector is deliberately absent from this array, but it is NOT
 * unreachable from the dock: `DockTabs.vue` renders it as a fifth tab of its
 * own, gated on `ui.selection.kind !== 'none'` rather than always-on like
 * these four. A tab that opened it with no selection behind it would show an
 * empty panel with nothing to point at — that is why it is not simply added
 * here — but excluding it from the dock entirely, the way an earlier version
 * of this file did, broke spec §2.3's "the Inspector one click away" for
 * every selection made from a panel row rather than the canvas (I3,
 * whole-branch review): see `DockTabs.vue`'s own template comment for the
 * gating logic this array does not carry.
 */
export const DOCK_PANELS: readonly Exclude<DockPanel, 'inspector'>[] = ['colony', 'population', 'economy', 'attention'];
