import type { BuildingDefId } from '../shared/content-types';
import type { BuildingSnapshot, BuildingState, WorkerSnapshot } from '../shared/snapshot';
import { BALANCE } from './content/balance';
import { BUILDINGS } from './content/buildings';

/**
 * Plain per-entity facts, decoupled from sim-ecs and from where they came
 * from (live components during a tick, or a save file being restored).
 * The single shared aggregation below (buildEntitySections) is fed from
 * either source so the worker/building snapshot derivation logic — tool
 * multiplier, staffing state, progress percent — exists exactly once.
 */
export interface WorkerFacts {
  id: number;
  hunger: number;
  efficiency: number;
  buildingId: number | null;
  toolTicks: number;
}

export interface BuildingFacts {
  id: number;
  defId: BuildingDefId;
  workerSlots: number;
  progress: number;
  batchActive: boolean;
}

export interface EntitySections {
  workers: WorkerSnapshot[];
  buildings: BuildingSnapshot[];
  population: number;
  idleWorkers: number;
}

/** Pure aggregation shared by SnapshotSystem, the initial-snapshot seed, and the post-step refresh. */
export function buildEntitySections(workers: readonly WorkerFacts[], buildings: readonly BuildingFacts[]): EntitySections {
  const staffCount = new Map<number, number>();
  const powerByBuilding = new Map<number, number>();
  const tooledByBuilding = new Map<number, number>();

  for (const w of workers) {
    if (w.buildingId === null) continue;
    const tooled = w.toolTicks > 0;
    staffCount.set(w.buildingId, (staffCount.get(w.buildingId) ?? 0) + 1);
    powerByBuilding.set(
      w.buildingId,
      (powerByBuilding.get(w.buildingId) ?? 0) + w.efficiency * (tooled ? BALANCE.toolMultiplier : 1),
    );
    if (tooled) tooledByBuilding.set(w.buildingId, (tooledByBuilding.get(w.buildingId) ?? 0) + 1);
  }

  const workerSnaps: WorkerSnapshot[] = workers
    .map((w) => ({ id: w.id, hunger: w.hunger, efficiency: w.efficiency, buildingId: w.buildingId, toolTicks: w.toolTicks }))
    .sort((a, b) => a.id - b.id);

  const buildingSnaps: BuildingSnapshot[] = buildings
    .map((b) => {
      const def = BUILDINGS[b.defId];
      const staffed = staffCount.get(b.id) ?? 0;
      const state: BuildingState = staffed === 0 ? 'unstaffed' : b.batchActive ? 'producing' : 'waitingForInput';
      return {
        id: b.id,
        defId: b.defId,
        workers: staffed,
        workerSlots: b.workerSlots,
        state,
        progress: b.progress,
        batchActive: b.batchActive,
        progressPct: Math.min(100, Math.round((b.progress / def.recipe.ticksPerBatch) * 100)),
        tooledWorkers: tooledByBuilding.get(b.id) ?? 0,
        workPower: powerByBuilding.get(b.id) ?? 0,
      };
    })
    .sort((a, b) => a.id - b.id);

  return {
    workers: workerSnaps,
    buildings: buildingSnaps,
    population: workerSnaps.length,
    idleWorkers: workerSnaps.filter((w) => w.buildingId === null).length,
  };
}
