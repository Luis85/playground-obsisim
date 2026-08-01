// Browser harness for the world-renderer smoke test (scripts/world-smoke.mjs).
// Boots the REAL Excalibur adapter against scripted snapshots; the runner
// drives phases via window.__step(n) and asserts on screenshots and errors.
// This file is a declared fallow entry point (.fallowrc.json `entry`) — it is
// loaded by the built harness page, never imported by app or test code.
import type { BuildingSnapshot, Snapshot, WorkerSnapshot } from '../../src/shared/snapshot';
import { createExcaliburWorldRenderer } from '../../src/app/world/renderer';

declare global {
  interface Window {
    __ready: boolean;
    __errors: string[];
    __step: (index: number) => string;
    __probe: () => { building: number; worker: number; empty: number };
  }
}

window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));

function building(id: number, defId: BuildingSnapshot['defId'], col: number, row: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId, col, row, workers: 0, workerSlots: 2, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0,
    ...overrides,
  };
}

function worker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id, hunger: 0, efficiency: 1, buildingId: null, hauling: false,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, carrying: 0, toolTicks: 0,
    ...overrides,
  };
}

function snap(tick: number, buildings: BuildingSnapshot[], workers: WorkerSnapshot[]): Snapshot {
  return {
    // the world renderer never reads the stockpile — an empty cast keeps this
    // smoke fixture decoupled from the resource catalog
    tick, lastRecruitTick: -30, map: { cols: 24, rows: 16 }, stockpile: {} as Snapshot['stockpile'], colonyWealth: 0,
    population: workers.length, idleWorkers: 0, buildings, workers, notices: [],
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
 */
const haulScene = (tick: number, hauler: Partial<WorkerSnapshot>) => snap(tick,
  [building(1, 'forester', 4, 1, { buffered: 12, state: 'outputFull' }), building(2, 'farm', 6, 1)],
  [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { toolTicks: 100, ...hauler })]);

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
  // ceil(2.24/2) = 2 ticks. The dot's position comes from haulTicksLeft
  // (OBS-4-09), so these values are what move it, not elapsed wall-clock.
  () => renderer.sync(haulScene(5, {})),                                                    // 6: baseline, idle at camp
  () => renderer.sync(haulScene(6, { hauling: true, haulTargetId: 1, haulPhase: 'outbound', haulTicksLeft: 0 })), // 7: arrived at the building
  () => renderer.sync(haulScene(7, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1 })), // 8: half way home — a genuinely interpolated point, neither endpoint
  () => renderer.sync(haulScene(8, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1, carrying: 6 })), // 9: same point, now loaded
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
  () => renderer.dispose(),
];

window.__step = (index: number) => {
  phases[index]();
  return `phase ${index} ok`;
};

// Sample a grid of page coordinates through renderer.pick — verifies the
// page -> world -> tile transform against the live camera end to end.
window.__probe = () => {
  const rect = document.querySelector('#host canvas')!.getBoundingClientRect();
  const found = { building: 0, worker: 0, empty: 0 };
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
