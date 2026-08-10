// Browser harness for the world-renderer smoke test (scripts/world-smoke.mjs).
// Boots the REAL Excalibur adapter against scripted snapshots; the runner
// drives phases via window.__step(n) and asserts on screenshots and errors.
// This file is a declared fallow entry point (.fallowrc.json `entry`) — it is
// loaded by the built harness page, never imported by app or test code.
import type { BuildingSnapshot, ColonistSnapshot, Snapshot } from '../../src/shared/snapshot';
import { CAMP_TILE } from '../../src/shared/haul';
import { createExcaliburWorldRenderer } from '../../src/app/world/renderer';

declare global {
  interface Window {
    __ready: boolean;
    __errors: string[];
    __step: (index: number) => string;
    __probe: () => { building: number; colonist: number; empty: number };
  }
}

window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));

function building(id: number, defId: BuildingSnapshot['defId'], col: number, row: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId, col, row, workers: 0, workerSlots: 2, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0,
    inputBuffered: 0, stored: 0, storage: 0, relocatingTicks: 0,
    beds: 0, occupants: 0,
    ...overrides,
  };
}

/**
 * Grouped by what the RENDERER does with each field, not by the order they
 * happen to sit in on `ColonistSnapshot`: the first block is everything the
 * world view actually draws from (or, like `buildingId`, positions by) and
 * every scene below overrides out of, the second is the fields it never
 * reads at all and that stay static here for the same reason the empty
 * stockpile below is cast rather than filled in. This grouping must not
 * converge on `tests/app/fixtures.ts`'s field order — fallow's clone
 * detector is pinned at zero groups.
 */
function worker(id: number, overrides: Partial<ColonistSnapshot> = {}): ColonistSnapshot {
  return {
    id, hauling: false, carrying: 0, toolTicks: 0, stage: 'adult', homeId: null, efficiency: 1,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, haulLegTicks: 0,
    haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0,
    haulKind: null, haulPickedUp: false,
    haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row,
    buildingId: null, hunger: 0,
    starvingTicks: 0, ageTicks: 0,
    commuteTiles: 0, commuteFactor: 1, deliveredWorkPower: null,
    ...overrides,
  };
}

function snap(tick: number, buildings: BuildingSnapshot[], colonists: ColonistSnapshot[]): Snapshot {
  return {
    // the world renderer never reads the stockpile — an empty cast keeps this
    // smoke fixture decoupled from the resource catalog
    tick, lastRecruitTick: -30, lastBirthTick: -50, map: { cols: 24, rows: 16 }, stockpile: {} as Snapshot['stockpile'], colonyWealth: 0,
    // the world renderer never reads mealsPerHead either
    mealsPerHead: 0,
    population: colonists.length, idleAdults: 0,
    // the world renderer never reads these either — static zeros for the
    // same reason the stockpile cast above is empty
    homeless: 0, beds: { total: 0, occupied: 0 }, demographics: { children: 0, adults: 0, elders: 0 },
    buildings, colonists, notices: [],
  };
}

const renderer = createExcaliburWorldRenderer(document.getElementById('host')!);

// Phases 4 and 5 keep the same roster (only the sawmill's tile moves between
// them) — one helper expresses that identical-by-construction, instead of
// two copies fallow's clone detector would otherwise flag as drift-prone.
const growWorkers = () => [worker(10, { buildingId: 1, toolTicks: 100 }), worker(11, { buildingId: 1, efficiency: 0.3 }), worker(12, { buildingId: 2 }), worker(13)];

/**
 * The haul phases hold EVERYTHING constant except worker 12, so each haul check
 * isolates exactly one change (OBS-4-04). They previously moved five things at
 * once — a building removed, another reset to unstaffed, two worker overrides
 * dropped, and worker 12 reassigned — which left `!after.equals(before)` true
 * for reasons unrelated to hauling. The check named "the hauler returns to camp
 * carrying its load" would have stayed green with the load marker absent.
 *
 * Worker 12 is tooled in every phase, so the tool ring and the load marker are
 * still drawn on the same worker in the last one (the coverage the old fixture
 * was after) without the ring being part of what changes.
 *
 * Ticks must strictly increase: a sync at the same or an earlier tick is a
 * colony reset by design (see renderer.ts), which would wipe the scene between
 * phases instead of animating through it.
 *
 * Building 1 never moves across these phases, so worker 12's leg total is the
 * same constant (2 ticks) on every haul phase — baked in here rather than
 * repeated per phase, the way `hauler` overrides the phase and the leg's two
 * endpoints instead. haulSpot reads all of these off the snapshot rather than
 * recomputing them (OBS-5-01), so a stale or missing value here would move the
 * dot, not just fail silently. `haulPickedUp` is baked in too and never varies
 * across these four: this is a collect trip, and the phase that reveals the
 * load marker must differ from its predecessor by `carrying` alone.
 */
const OUT_LEG = { haulLegFromCol: CAMP_TILE.col, haulLegFromRow: CAMP_TILE.row, haulLegToCol: 4, haulLegToRow: 1 };
const HOME_LEG = { haulLegFromCol: 4, haulLegFromRow: 1, haulLegToCol: CAMP_TILE.col, haulLegToRow: CAMP_TILE.row };

const haulScene = (tick: number, hauler: Partial<ColonistSnapshot>, forester: Partial<BuildingSnapshot> = {}) => snap(tick,
  [building(1, 'forester', 4, 1, { buffered: 12, state: 'outputFull', ...forester }), building(2, 'farm', 6, 1)],
  [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, {
    toolTicks: 100, haulLegTicks: 2, haulPickedUp: true, ...hauler,
  })]);

/**
 * The four demographic phases hold EVERYTHING constant except one field on
 * colonist 4 — the same shape the haul phases above were rebuilt into after
 * OBS-4-04. Both colonists arrive homeless (`worker()` defaults `homeId` to
 * null and `stage` to adult), so the house appearing is the only change in the
 * first frame, and each later phase moves exactly one field on the same
 * settled dot: it moves in, then it turns child, then elder.
 *
 * `occupants` tracks the resident so the fixture is not internally
 * inconsistent, but it is invisible to the canvas — `PlacedBuilding` does not
 * carry it and only `describePick` reads it — so it can never be the reason
 * two frames differ.
 *
 * Ticks must strictly increase here too: a sync at the same or an earlier tick
 * is a colony reset (see renderer.ts) and would wipe the scene between phases
 * instead of changing one thing in it.
 */
const DEPOT = { col: 10, row: 5 };

/**
 * The store phases hold EVERYTHING constant except one field on the depot or
 * on hauler 30 — the same shape the haul and demographic scenes were rebuilt
 * into after OBS-4-04.
 *
 * The bakery sits at (4,1) and the depot at (10,5), so camp -> bakery and
 * depot -> bakery are two genuinely different lines. That is the whole point
 * of the pair of phases below: the camp-anchored geometry this increment
 * replaces drew every leg from the camp tent, which would have made the two
 * frames identical — a check that stayed green with the feature absent.
 *
 * `haulKind` is 'supply' on BOTH carrying phases, also deliberately: the
 * carrying-in/carrying-out marker is driven by `haulPickedUp`, and a marker
 * that read the job kind instead would draw the two the same way.
 */
const depotHolding = (over: Partial<BuildingSnapshot> = {}) => [building(2, 'storehouse', DEPOT.col, DEPOT.row, {
  workerSlots: 0, state: 'storing', storage: 60, stored: 15, ...over,
})];

const storeScene = (
  tick: number, depot: BuildingSnapshot[], hauler: Partial<ColonistSnapshot> = {}, extra: BuildingSnapshot[] = [],
) => snap(tick,
  [building(1, 'bakery', 4, 1, { workers: 1, state: 'waitingForInput' }), ...depot, ...extra],
  [worker(30, {
    hauling: true, haulPhase: 'idle', haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row, ...hauler,
  })]);

/**
 * A NON-store building beside the depot: `storage` stays 0 (the `building()`
 * default) in every phase below, only `stored` moves — the fixture the fill
 * gauge's `storage > 0` gate has never had. Without it, nothing distinguishes
 * "no gauge drawn" from "a gauge always drawn, reading near zero": a track
 * ring at full radius and a near-invisible fill look the same as no ring at
 * all in a screenshot diff, so a gate that always passed would still leave
 * every existing check green. `stored` on a non-store building is not a state
 * play ever produces — it is forced here purely to pin the gate against a
 * player-facing symptom (a phantom ring on every tile) that would otherwise
 * ship silently. id 3 and its own tile, distinct from the bakery, the depot
 * and the camp.
 */
const NEIGHBOR = { col: DEPOT.col + 1, row: DEPOT.row };
const neighborAt = (stored: number) => [building(3, 'forester', NEIGHBOR.col, NEIGHBOR.row, { stored })];

// Half way along a 2-tick leg into the bakery's door, carrying four units.
// Only the leg's `from` end differs between the two.
const SUPPLY_FROM_CAMP: Partial<ColonistSnapshot> = {
  haulTargetId: 1, haulPhase: 'outbound', haulKind: 'supply', carrying: 4,
  haulTicksLeft: 1, haulLegTicks: 2,
  haulLegFromCol: CAMP_TILE.col, haulLegFromRow: CAMP_TILE.row, haulLegToCol: 4, haulLegToRow: 1,
};
const SUPPLY_FROM_DEPOT: Partial<ColonistSnapshot> = {
  ...SUPPLY_FROM_CAMP, haulLegFromCol: DEPOT.col, haulLegFromRow: DEPOT.row,
};

const homeScene = (tick: number, resident: Partial<ColonistSnapshot> = {}) => snap(tick,
  [building(1, 'house', 4, 1, {
    workerSlots: 0, state: 'housing', beds: 4, occupants: (resident.homeId ?? null) === null ? 0 : 1,
  })],
  [worker(4, resident), worker(5)]);

// Phase script, advanced from the runner. Worker 12 walks in phase 1; the
// batch progresses in both; phase 4 adds a building and a tooled worker.
const phases: Array<() => void> = [
  () => renderer.sync(snap(1,
    [building(1, 'forester', 4, 1, { workers: 2, state: 'producing', batchActive: true, progressPct: 20 }), building(2, 'farm', 6, 1)],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12)])),
  () => renderer.sync(snap(2,
    [building(1, 'forester', 4, 1, { workers: 2, state: 'producing', batchActive: true, progressPct: 60 }), building(2, 'farm', 6, 1, { workers: 1, state: 'waitingForInput' })],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { buildingId: 2 })])),
  () => renderer.stop(),
  () => renderer.start(),
  () => renderer.sync(snap(3,
    [building(1, 'forester', 4, 1, { workers: 2, state: 'producing', batchActive: true, progressPct: 90 }), building(2, 'farm', 6, 1, { workers: 1, state: 'producing', batchActive: true, progressPct: 10 }), building(3, 'sawmill', 8, 1)],
    growWorkers())),
  // the WORKERLESS sawmill moves from (8,1) to a fresh tile: with no worker
  // target changing, the only thing that may alter the frame is the building
  // actor itself — which is exactly what this phase exists to catch (its
  // position must be re-applied on every sync, not only at spawn)
  () => renderer.sync(snap(4,
    [building(1, 'forester', 4, 1, { workers: 2, state: 'producing', batchActive: true, progressPct: 90 }), building(2, 'farm', 6, 1, { workers: 1, state: 'producing', batchActive: true, progressPct: 10 }), building(3, 'sawmill', 14, 7)],
    growWorkers())),
  // Four haul phases, one change each — see haulScene above. Building 1 sits at
  // (4,1), hypot(2,1) = 2.24 tiles from the camp, so each leg is
  // ceil(2.24/2) = 2 ticks — haulScene's haulLegTicks/haulPickupCol/Row
  // constants. The dot's position comes from haulTicksLeft against that
  // published total (OBS-4-09, OBS-5-01), so these values are what move it,
  // not elapsed wall-clock.
  () => renderer.sync(haulScene(5, {})),                                                    // 6: baseline, idle at camp
  () => renderer.sync(haulScene(6, { hauling: true, haulTargetId: 1, haulPhase: 'outbound', haulTicksLeft: 0, ...OUT_LEG })), // 7: arrived at the building
  () => renderer.sync(haulScene(7, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1, ...HOME_LEG })), // 8: half way home — a genuinely interpolated point, neither endpoint
  () => renderer.sync(haulScene(8, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1, carrying: 6, ...HOME_LEG })), // 9: same point, now loaded
  // ONE change from the previous phase: building 1 flips to relocating. Its
  // ring colour must differ, and nothing else in the scene moves.
  () => renderer.sync(haulScene(9, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1, carrying: 6, ...HOME_LEG }, { state: 'relocating', relocatingTicks: 6 })),
  () => {
    renderer.setGhost({ defId: 'bakery', col: 10, row: 5, valid: true });
    renderer.setSelection(1);
  },
  () => renderer.setGhost({ defId: 'bakery', col: 10, row: 5, valid: false }),
  () => {
    renderer.setGhost(null);
    renderer.setSelection(null);
  },
  // colony reset: tick regresses, entity ids restart — the scene must forget
  // the old colony instead of gliding recycled ids from their former posts
  () => renderer.sync(snap(1, [], [worker(1), worker(2), worker(3)])),
  // reset of a tick-1 colony: a NEW snapshot at the SAME tick is also a new
  // timeline (round 10 — e.g. resetting a freshly-loaded save)
  () => renderer.sync(snap(1, [], [worker(4), worker(5)])),
  // Four demographic phases, one change each — see homeScene above. They go
  // HERE, before dispose(), not appended after it: the renderer is destroyed
  // by that phase and every sync past it would draw nothing while every
  // `!after.equals(before)` check went red for the wrong reason.
  () => renderer.sync(homeScene(2)),                                // 16: a house appears; nothing else moves
  () => renderer.sync(homeScene(3, { homeId: 1 })),                 // 17: colonist 4 moves in — ONLY its homeId changes
  () => renderer.sync(homeScene(4, { homeId: 1, stage: 'child' })), // 18: the same colonist becomes a child
  () => renderer.sync(homeScene(5, { homeId: 1, stage: 'elder' })), // 19: the same colonist becomes an elder
  // Ten store phases, one change each — see storeScene above.
  () => renderer.sync(storeScene(6, [])),                                          // 20: baseline — a bakery and one hauler idle at camp
  () => renderer.sync(storeScene(7, depotHolding({ state: 'unstaffed' }))),         // 21: a storehouse appears, in a state it shares with every other def
  () => renderer.sync(storeScene(8, depotHolding())),                              // 22: ONLY the depot's state changes — unstaffed to storing
  () => renderer.sync(storeScene(9, depotHolding({ stored: 45 }))),                // 23: ONLY `stored` changes — 15 of 60 to 45 of 60
  () => renderer.sync(storeScene(10, depotHolding({ stored: 45 }), SUPPLY_FROM_CAMP)),   // 24: the hauler takes a supply leg out of the camp
  () => renderer.sync(storeScene(11, depotHolding({ stored: 45 }), SUPPLY_FROM_DEPOT)),  // 25: ONLY the leg's `from` end changes — camp to depot
  () => renderer.sync(storeScene(12, depotHolding({ stored: 45 }), { ...SUPPLY_FROM_DEPOT, haulPickedUp: true })), // 26: ONLY `haulPickedUp` changes
  () => renderer.sync(storeScene(13, depotHolding({ stored: 45 }))),               // 27: the trip ends — the hauler is idle at the camp
  () => renderer.sync(storeScene(14, depotHolding({ stored: 45 }), { haulAtCol: DEPOT.col, haulAtRow: DEPOT.row })), // 28: ONLY where it rests changes
  // A non-store building appears beside the depot, `stored` forced to 0 — the
  // gate fixture (see NEIGHBOR/neighborAt above). Nothing else in the scene
  // moves from phase 28, but a whole new building appearing is itself a
  // many-pixel change, so this frame carries no check of its own — the same
  // role phases 20, 24 and 27 already play.
  () => renderer.sync(storeScene(15, depotHolding({ stored: 45 }), { haulAtCol: DEPOT.col, haulAtRow: DEPOT.row }, neighborAt(0))),  // 29
  () => renderer.sync(storeScene(16, depotHolding({ stored: 45 }), { haulAtCol: DEPOT.col, haulAtRow: DEPOT.row }, neighborAt(50))), // 30: ONLY the neighbor's `stored` changes, 0 -> 50 (its `storage` stays 0)
  () => renderer.dispose(),                                         // 31
];

window.__step = (index: number) => {
  phases[index]();
  return `phase ${index} ok`;
};

// Sample a grid of page coordinates through renderer.pick — verifies the
// page -> world -> tile transform against the live camera end to end.
window.__probe = () => {
  const rect = document.querySelector('#host canvas')!.getBoundingClientRect();
  // Keys match WorldPick['kind'] exactly — `found[pick.kind] += 1` below is
  // what ties them, so a rename on either side is a type error rather than a
  // tally that silently counts nothing.
  const found = { building: 0, colonist: 0, empty: 0 };
  for (let ix = 0; ix < 40; ix++) {
    for (let iy = 0; iy < 26; iy++) {
      const pick = renderer.pick(rect.left + (rect.width * (ix + 0.5)) / 40, rect.top + (rect.height * (iy + 0.5)) / 26);
      if (pick === null) found.empty += 1;
      else found[pick.kind] += 1;
    }
  }
  return found;
};
window.__ready = true;
