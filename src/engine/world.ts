import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV1 } from '../shared/save';
import type { SaveGameV1, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import type { BuildingState, ResourceStats, Snapshot } from '../shared/snapshot';
import { BALANCE, STARTING_STOCK, STARTING_WORKERS, workerEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots,
} from './components';
import {
  CommandQueue, IdCounter, NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile,
} from './resources';

// sim-ecs's built system type; kept loose so ALL_SYSTEMS can be filled in world composition.
export type TColonySystem = Parameters<
  Parameters<Parameters<ReturnType<typeof buildWorld>['withDefaultScheduling']>[0]>[0]['addNewStage']
>[0] extends (stage: infer S) => unknown
  ? S extends { addSystem(system: infer Sys): unknown } ? Sys : never
  : never;

/** Filled in Task 11 (world composition). Empty until then so early tests can build worlds. */
export const ALL_SYSTEMS: TColonySystem[] = [];

/**
 * sim-ecs 0.6.4 gotcha: getResource() works on RUNTIME worlds only. The
 * preptime world keys instance-registered resources by the instance itself,
 * so prep.getResource(Ctor) throws (and for ctor-registered ones it would
 * return the args array). Never call getResource on a preptime world; use
 * this helper, backed by what buildColonyPrepWorld registered.
 */
const PREP_RESOURCES = new WeakMap<IPreptimeWorld, Map<object, object>>();

export function getPrepResource<T extends object>(prep: IPreptimeWorld, type: new (...args: never[]) => T): T {
  const instance = PREP_RESOURCES.get(prep)?.get(type);
  if (!instance) throw new Error(`Preptime resource ${type.name} was not registered by buildColonyPrepWorld`);
  return instance as T;
}

const COMPONENT_TYPES = [Building, WorkerSlots, Production, Worker, Hunger, JobAssignment, Efficiency, ToolCoverage];

export function initialSave(): SaveGameV1 {
  return {
    version: 1,
    tick: 0,
    lastRecruitTick: -BALANCE.recruitCooldownTicks,
    stockpile: { ...STARTING_STOCK },
    buildings: [],
    workers: Array.from({ length: STARTING_WORKERS }, () => ({ hunger: 0, buildingIndex: null, toolTicks: 0 })),
  };
}

/**
 * Structural validity (isSaveGameV1) plus referential integrity against the content
 * catalog. The Obsidian shell must use THIS before restoring: a stale or hand-edited
 * save with an unknown building id would otherwise crash createColonyWorld instead of
 * taking the corrupt-save backup path (spec 7.2).
 */
export function isLoadableSave(data: unknown): data is SaveGameV1 {
  if (!isSaveGameV1(data)) return false;
  // integer clocks: a fractional tick would desync every modulo-based cadence
  // (autosave, recruit cooldown) forever
  if (!Number.isInteger(data.tick) || data.tick < 0) return false;
  // the engine only ever sets lastRecruitTick to -recruitCooldownTicks (fresh
  // colony) or to a past tick; anything else blocks recruiting spuriously
  if (
    !Number.isInteger(data.lastRecruitTick) ||
    data.lastRecruitTick < -BALANCE.recruitCooldownTicks ||
    data.lastRecruitTick > data.tick
  ) return false;
  // Object.hasOwn, never `in`: inherited keys like "toString" pass `in` and
  // then indexing the catalog throws inside the guard
  const stockpileOk = Object.entries(data.stockpile).every(
    ([id, amount]) => Object.hasOwn(RESOURCES, id) && Number.isFinite(amount) && (amount as number) >= 0,
  );
  if (!stockpileOk) return false;
  const buildingsOk = data.buildings.every(
    (b) =>
      Object.hasOwn(BUILDINGS, b.defId) &&
      b.progress >= 0 &&
      b.progress <= BUILDINGS[b.defId].recipe.ticksPerBatch,
  );
  if (!buildingsOk) return false;
  const staffCount = new Map<number, number>();
  for (const w of data.workers) {
    if (w.hunger < 0 || w.hunger > BALANCE.hungerMax) return false;
    if (!Number.isInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > BALANCE.toolDurationTicks) return false;
    if (w.buildingIndex === null) continue;
    if (!Number.isInteger(w.buildingIndex) || w.buildingIndex < 0 || w.buildingIndex >= data.buildings.length) {
      return false;
    }
    staffCount.set(w.buildingIndex, (staffCount.get(w.buildingIndex) ?? 0) + 1);
  }
  for (const [index, count] of staffCount) {
    if (count > BUILDINGS[data.buildings[index].defId].workerSlots) return false;
  }
  return true;
}

export function spawnBuilding(prep: IPreptimeWorld, ids: IdCounter, saved: SavedBuilding): IEntity {
  const def = BUILDINGS[saved.defId];
  return prep
    .buildEntity()
    .with(new Building(ids.take(), saved.defId))
    .with(new WorkerSlots(def.workerSlots))
    .with(new Production(saved.progress, saved.batchActive))
    .build();
}

export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { hunger?: number; buildingId?: number | null; efficiency?: number; toolTicks?: number } = {},
): IEntity {
  return prep
    .buildEntity()
    .with(new Worker(ids.take()))
    .with(new Hunger(opts.hunger ?? 0))
    .with(new JobAssignment(opts.buildingId ?? null))
    .with(new Efficiency(opts.efficiency ?? 1))
    .with(new ToolCoverage(opts.toolTicks ?? 0))
    .build();
}

export function buildColonyPrepWorld(
  options: { save?: SaveGameV1; systems?: readonly TColonySystem[] } = {},
): IPreptimeWorld {
  const save = options.save ?? initialSave();
  const systems = options.systems ?? ALL_SYSTEMS;

  let builder = buildWorld().withDefaultScheduling((root) => {
    for (const system of systems) {
      root = root.addNewStage((stage) => stage.addSystem(system));
    }
    return root;
  });
  for (const componentType of COMPONENT_TYPES) {
    builder = builder.withComponent(componentType);
  }
  const prep = builder.build();

  const clock = new SimClock();
  clock.tick = save.tick;
  clock.lastRecruitTick = save.lastRecruitTick;
  const ids = new IdCounter();
  const store = new SnapshotStore();
  const instances = [
    new Stockpile(save.stockpile),
    clock,
    new CommandQueue(),
    new NoticeBoard(),
    ids,
    new StatsHistory(),
    store,
  ];
  const registry = new Map<object, object>();
  for (const instance of instances) {
    prep.addResource(instance);
    registry.set(instance.constructor, instance);
  }
  PREP_RESOURCES.set(prep, registry);

  const buildingIds = save.buildings.map(
    (saved) => spawnBuilding(prep, ids, saved).getComponent(Building)!.id,
  );
  const workerIds = save.workers.map(
    (saved) =>
      spawnWorker(prep, ids, {
        hunger: saved.hunger,
        toolTicks: saved.toolTicks,
        buildingId: saved.buildingIndex === null ? null : buildingIds[saved.buildingIndex],
      }).getComponent(Worker)!.id,
  );
  // The UI must never see a null snapshot: a reset or freshly created engine is
  // paused until its first tick, so seed the store from the save. SnapshotSystem
  // replaces this on the first step.
  store.latest = buildInitialSnapshot(save, buildingIds, workerIds);

  return prep;
}

function buildInitialSnapshot(save: SaveGameV1, buildingIds: number[], workerIds: number[]): Snapshot {
  const staffCount = new Map<number, number>();
  const powerByBuilding = new Map<number, number>();
  const tooledByBuilding = new Map<number, number>();
  const workers = save.workers.map((saved, index) => {
    const buildingId = saved.buildingIndex === null ? null : buildingIds[saved.buildingIndex];
    const efficiency = workerEfficiency(saved.hunger);
    const tooled = saved.toolTicks > 0;
    if (buildingId !== null) {
      staffCount.set(buildingId, (staffCount.get(buildingId) ?? 0) + 1);
      powerByBuilding.set(
        buildingId,
        (powerByBuilding.get(buildingId) ?? 0) + efficiency * (tooled ? BALANCE.toolMultiplier : 1),
      );
      if (tooled) tooledByBuilding.set(buildingId, (tooledByBuilding.get(buildingId) ?? 0) + 1);
    }
    return { id: workerIds[index], hunger: saved.hunger, efficiency, buildingId, toolTicks: saved.toolTicks };
  });
  const buildings = save.buildings.map((saved, index) => {
    const def = BUILDINGS[saved.defId];
    const id = buildingIds[index];
    const staffed = staffCount.get(id) ?? 0;
    const state: BuildingState = staffed === 0 ? 'unstaffed' : saved.batchActive ? 'producing' : 'waitingForInput';
    return {
      id,
      defId: saved.defId,
      workers: staffed,
      workerSlots: def.workerSlots,
      state,
      progress: saved.progress,
      batchActive: saved.batchActive,
      progressPct: Math.min(100, Math.round((saved.progress / def.recipe.ticksPerBatch) * 100)),
      tooledWorkers: tooledByBuilding.get(id) ?? 0,
      workPower: powerByBuilding.get(id) ?? 0,
    };
  });
  const stockpile = {} as Record<ResourceId, ResourceStats>;
  let colonyWealth = 0;
  for (const resourceId of RESOURCE_IDS) {
    const stock = save.stockpile[resourceId] ?? 0;
    const stockValue = stock * RESOURCES[resourceId].value;
    colonyWealth += stockValue;
    stockpile[resourceId] = { stock, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
  }
  return {
    tick: save.tick,
    lastRecruitTick: save.lastRecruitTick,
    stockpile,
    colonyWealth,
    population: workers.length,
    idleWorkers: workers.filter((w) => w.buildingId === null).length,
    buildings,
    workers,
    notices: [],
  };
}

export async function createColonyWorld(save?: SaveGameV1): Promise<IRuntimeWorld> {
  return buildColonyPrepWorld({ save }).prepareRun();
}
