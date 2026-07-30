// Browser harness for the world-renderer smoke test (scripts/world-smoke.mjs).
// Boots the REAL Excalibur adapter against scripted snapshots; the runner
// drives phases via window.__step(n) and asserts on screenshots and errors.
import type { BuildingSnapshot, Snapshot, WorkerSnapshot } from '../../src/shared/snapshot';
import { createExcaliburWorldRenderer } from '../../src/app/world/renderer';

declare global {
  interface Window {
    __ready: boolean;
    __errors: string[];
    __step: (index: number) => string;
  }
}

window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push(String(event.reason)));

function building(id: number, defId: BuildingSnapshot['defId'], overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId, workers: 0, workerSlots: 2, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0,
    ...overrides,
  };
}

function worker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return { id, hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0, ...overrides };
}

function snap(tick: number, buildings: BuildingSnapshot[], workers: WorkerSnapshot[]): Snapshot {
  return {
    // the world renderer never reads the stockpile — an empty cast keeps this
    // smoke fixture decoupled from the resource catalog
    tick, lastRecruitTick: -30, stockpile: {} as Snapshot['stockpile'], colonyWealth: 0,
    population: workers.length, idleWorkers: 0, buildings, workers, notices: [],
  };
}

const renderer = createExcaliburWorldRenderer(document.getElementById('host')!);

// Phase script, advanced from the runner. Worker 12 walks in phase 1; the
// batch progresses in both; phase 4 adds a building and a tooled worker.
const phases: Array<() => void> = [
  () => renderer.sync(snap(1,
    [building(1, 'forester', { workers: 2, state: 'producing', batchActive: true, progressPct: 20 }), building(2, 'farm')],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12)])),
  () => renderer.sync(snap(2,
    [building(1, 'forester', { workers: 2, state: 'producing', batchActive: true, progressPct: 60 }), building(2, 'farm', { workers: 1, state: 'waitingForInput' })],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { buildingId: 2 })])),
  () => renderer.stop(),
  () => renderer.start(),
  () => renderer.sync(snap(3,
    [building(1, 'forester', { workers: 2, state: 'producing', batchActive: true, progressPct: 90 }), building(2, 'farm', { workers: 1, state: 'producing', batchActive: true, progressPct: 10 }), building(3, 'sawmill')],
    [worker(10, { buildingId: 1, toolTicks: 100 }), worker(11, { buildingId: 1, efficiency: 0.3 }), worker(12, { buildingId: 2 }), worker(13)])),
  () => renderer.dispose(),
];

window.__step = (index: number) => {
  phases[index]();
  return `phase ${index} ok`;
};
window.__ready = true;
