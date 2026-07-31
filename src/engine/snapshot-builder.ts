import type { IRuntimeWorld } from 'sim-ecs';
import type { BuildingDefId } from '../shared/content-types';
import type { SavedBuilding, SavedWorker } from '../shared/save';
import type { BuildingSnapshot, BuildingState, WorkerSnapshot } from '../shared/snapshot';
import { BALANCE, workerWorkPower } from './content/balance';
import { batchOutputUnits, BUILDINGS } from './content/buildings';
import {
  Building, Efficiency, Hunger, JobAssignment, OutputBuffer, Position, Production, ToolCoverage, Worker, WorkerSlots,
} from './components';

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
  hauling: boolean;
  toolTicks: number;
}

export interface BuildingFacts {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  workerSlots: number;
  progress: number;
  batchActive: boolean;
  buffered: number;
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
      (powerByBuilding.get(w.buildingId) ?? 0) + workerWorkPower(w.efficiency, w.toolTicks),
    );
    if (tooled) tooledByBuilding.set(w.buildingId, (tooledByBuilding.get(w.buildingId) ?? 0) + 1);
  }

  const workerSnaps: WorkerSnapshot[] = workers
    .map((w) => ({
      id: w.id, hunger: w.hunger, efficiency: w.efficiency, buildingId: w.buildingId, hauling: w.hauling, toolTicks: w.toolTicks,
    }))
    .sort((a, b) => a.id - b.id);

  const buildingSnaps: BuildingSnapshot[] = buildings
    .map((b) => {
      const def = BUILDINGS[b.defId];
      const staffed = staffCount.get(b.id) ?? 0;
      // A staffed building that cannot bank another batch is stalled on output,
      // whether or not its current batch has finished — the player's remedy is
      // the same either way: send a hauler. Staffing still takes precedence,
      // since an unstaffed building is not waiting on transport.
      const outputBlocked = BALANCE.outputBufferCap - b.buffered < batchOutputUnits(def.recipe);
      const state: BuildingState = staffed === 0
        ? 'unstaffed'
        : outputBlocked ? 'outputFull' : b.batchActive ? 'producing' : 'waitingForInput';
      return {
        id: b.id,
        defId: b.defId,
        col: b.col, row: b.row,
        workers: staffed,
        workerSlots: b.workerSlots,
        state,
        progress: b.progress,
        batchActive: b.batchActive,
        progressPct: Math.min(100, Math.round((b.progress / def.recipe.ticksPerBatch) * 100)),
        tooledWorkers: tooledByBuilding.get(b.id) ?? 0,
        workPower: powerByBuilding.get(b.id) ?? 0,
        buffered: b.buffered,
      };
    })
    .sort((a, b) => a.id - b.id);

  return {
    workers: workerSnaps,
    buildings: buildingSnaps,
    population: workerSnaps.length,
    // Idle, on-a-building, and hauling are mutually exclusive states: a
    // hauler's buildingId is null too, so idle must also exclude hauling.
    idleWorkers: workerSnaps.filter((w) => w.buildingId === null && !w.hauling).length,
  };
}

/**
 * THE component -> facts conversion for a live world, one function per entity
 * kind. Both live-world readers go through these: SnapshotSystem's ECS queries
 * (component instances destructured from the query) and gatherEntityFacts's
 * getEntities() walk (the same instances via getComponent). A new worker or
 * building field is therefore ONE edit here plus its Facts interface, instead of
 * drifting between access paths (increment-1 review: 3-site edit risk).
 *
 * Save records are NOT convertible here — buildInitialSnapshot runs before any
 * entity exists and maps SavedWorker/SavedBuilding instead.
 */
export function workerFactsOf(
  worker: Worker, hunger: Hunger, job: JobAssignment, efficiency: Efficiency, coverage: ToolCoverage,
): WorkerFacts {
  return {
    id: worker.id,
    hunger: hunger.value,
    efficiency: efficiency.value,
    buildingId: job.buildingId,
    hauling: job.hauling,
    toolTicks: coverage.remainingTicks,
  };
}

export function buildingFactsOf(
  building: Building, slots: WorkerSlots, production: Production, position: Position, buffer: OutputBuffer,
): BuildingFacts {
  return {
    id: building.id,
    defId: building.defId,
    col: position.col,
    row: position.row,
    workerSlots: slots.max,
    progress: production.progress,
    batchActive: production.batchActive,
    buffered: buffer.total(),
  };
}

/**
 * Facts -> save records. SavedWorker is deliberately a SUBSET of WorkerFacts:
 * `efficiency` is recomputed from hunger every tick by EfficiencySystem, so
 * storing it would be a second source of truth. That subsetting is why this
 * cannot be derived automatically — but keeping it here, beside workerFactsOf,
 * means the persist decision for a new fact is one obvious edit rather than a
 * whitelist buried inside the serializer.
 */
export function savedWorkerOf(facts: WorkerFacts): SavedWorker {
  return { id: facts.id, hunger: facts.hunger, buildingId: facts.buildingId, toolTicks: facts.toolTicks };
}

export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return { id: facts.id, defId: facts.defId, col: facts.col, row: facts.row, progress: facts.progress, batchActive: facts.batchActive };
}

export interface EntityFacts {
  workers: WorkerFacts[];
  buildings: BuildingFacts[];
}

/**
 * The getEntities() walk, shared by the post-step snapshot refresh and save
 * serialization. Built on the mappers above, so it can never disagree with
 * SnapshotSystem about what a worker or building is.
 */
export function gatherEntityFacts(world: IRuntimeWorld): EntityFacts {
  const workers: WorkerFacts[] = [];
  const buildings: BuildingFacts[] = [];
  for (const entity of world.getEntities()) {
    const building = entity.getComponent(Building);
    if (building) {
      buildings.push(buildingFactsOf(
        building,
        entity.getComponent(WorkerSlots)!,
        entity.getComponent(Production)!,
        entity.getComponent(Position)!,
        entity.getComponent(OutputBuffer)!,
      ));
      continue;
    }
    const worker = entity.getComponent(Worker);
    if (worker) {
      workers.push(workerFactsOf(
        worker,
        entity.getComponent(Hunger)!,
        entity.getComponent(JobAssignment)!,
        entity.getComponent(Efficiency)!,
        entity.getComponent(ToolCoverage)!,
      ));
    }
  }
  return { workers, buildings };
}
