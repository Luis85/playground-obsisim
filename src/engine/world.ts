import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV1 } from '../shared/save';
import type { SaveGameV1, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import type { ResourceStats, Snapshot } from '../shared/snapshot';
import { BALANCE, STARTING_STOCK, STARTING_WORKERS, workerEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots,
} from './components';
import {
  CommandQueue, IdCounter, NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile,
} from './resources';
import type { BuildingFacts, WorkerFacts } from './snapshot-builder';
import { buildEntitySections } from './snapshot-builder';
import { CommandSystem } from './systems/command-system';
import { HungerSystem } from './systems/hunger-system';
import { EfficiencySystem } from './systems/efficiency-system';
import { ProductionSystem } from './systems/production-system';
import { StatsSystem } from './systems/stats-system';
import { SnapshotSystem } from './systems/snapshot-system';

// sim-ecs's built system type; kept loose so ALL_SYSTEMS can be filled in world composition.
export type TColonySystem = Parameters<
  Parameters<Parameters<ReturnType<typeof buildWorld>['withDefaultScheduling']>[0]>[0]['addNewStage']
>[0] extends (stage: infer S) => unknown
  ? S extends { addSystem(system: infer Sys): unknown } ? Sys : never
  : never;

/**
 * A BUILT system instance can only ever be registered in one world — sim-ecs
 * 0.6.4 throws on the second prepareRun. Systems are therefore passed around
 * as factories and each world builds its own instances (createColonyWorld runs
 * many times: tests, reset, restore).
 */
export type TColonySystemFactory = () => TColonySystem;

/** Fixed execution order per spec 4.4 — one system per stage; never reorder. Factories: each world builds fresh instances. */
export const ALL_SYSTEMS: TColonySystemFactory[] = [
  CommandSystem,
  HungerSystem,
  EfficiencySystem,
  ProductionSystem,
  StatsSystem,
  SnapshotSystem,
];

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
    workers: Array.from({ length: STARTING_WORKERS }, (_, index) => ({
      id: index + 1,
      hunger: 0,
      buildingId: null,
      toolTicks: 0,
    })),
    nextEntityId: STARTING_WORKERS + 1,
  };
}

// Object.hasOwn, never `in`: inherited keys like "toString" pass `in` and
// then indexing the catalog throws inside the guard
function isStockpileValid(stockpile: SaveGameV1['stockpile']): boolean {
  return Object.entries(stockpile).every(
    ([id, amount]) => Object.hasOwn(RESOURCES, id) && Number.isFinite(amount) && (amount as number) >= 0,
  );
}

function isBuildingsValid(buildings: SaveGameV1['buildings']): boolean {
  return buildings.every((b) => {
    if (!Object.hasOwn(BUILDINGS, b.defId)) return false;
    if (b.batchActive) {
      // the engine completes batches before a tick ends: an active batch is
      // always serialized strictly below its completion threshold
      return b.progress >= 0 && b.progress < BUILDINGS[b.defId].recipe.ticksPerBatch;
    }
    return b.progress === 0; // stalled/idle buildings never bank progress
  });
}

function isWorkerRecordValid(w: SaveGameV1['workers'][number], buildingIds: ReadonlySet<number>): boolean {
  if (w.hunger < 0 || w.hunger > BALANCE.hungerMax) return false;
  if (!Number.isInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > BALANCE.toolDurationTicks) return false;
  if (w.buildingId === null) return true;
  return buildingIds.has(w.buildingId);
}

// Only called once every worker record has already passed isWorkerRecordValid,
// so each buildingId here is guaranteed null or a valid saved building id.
function isStaffingValid(data: SaveGameV1): boolean {
  const staffCount = new Map<number, number>();
  for (const w of data.workers) {
    if (w.buildingId === null) continue;
    staffCount.set(w.buildingId, (staffCount.get(w.buildingId) ?? 0) + 1);
  }
  const buildingById = new Map(data.buildings.map((b) => [b.id, b]));
  for (const [buildingId, count] of staffCount) {
    if (count > BUILDINGS[buildingById.get(buildingId)!.defId].workerSlots) return false;
  }
  return true;
}

function isWorkersValid(data: SaveGameV1): boolean {
  const buildingIds = new Set(data.buildings.map((b) => b.id));
  if (!data.workers.every((w) => isWorkerRecordValid(w, buildingIds))) return false;
  return isStaffingValid(data);
}

/**
 * Counters keep incrementing after load, so a save sitting AT the safe-integer
 * ceiling would stop advancing precisely on its next ++. Require generous
 * headroom: ~4 billion post-load increments (~17 years of play at 8 ticks/s).
 */
const MAX_SAVED_COUNTER = Number.MAX_SAFE_INTEGER - 2 ** 32;

// Cross-array id validity: positive integers, unique across buildings AND
// workers combined (they share one id space), and nextEntityId strictly past
// every id already handed out so the restored IdCounter can never collide.
function isIdsValid(data: SaveGameV1): boolean {
  const allIds = [...data.buildings.map((b) => b.id), ...data.workers.map((w) => w.id)];
  // SAFE integers: past 2^53, ++ stops incrementing and ids would collide
  if (!allIds.every((id) => Number.isSafeInteger(id) && id > 0)) return false;
  if (new Set(allIds).size !== allIds.length) return false;
  if (
    !Number.isSafeInteger(data.nextEntityId) ||
    data.nextEntityId < 1 ||
    data.nextEntityId > MAX_SAVED_COUNTER
  ) return false;
  return allIds.every((id) => id < data.nextEntityId);
}

/**
 * Structural validity (isSaveGameV1) plus referential integrity against the content
 * catalog. The Obsidian shell must use THIS before restoring: a stale or hand-edited
 * save with an unknown building id would otherwise crash createColonyWorld instead of
 * taking the corrupt-save backup path (spec 7.2).
 */
export function isLoadableSave(data: unknown): data is SaveGameV1 {
  if (!isSaveGameV1(data)) return false;
  // SAFE integers: a fractional tick would desync every modulo-based cadence
  // (autosave, recruit cooldown) forever; past 2^53, ++ stops incrementing.
  // Bounded below the ceiling so post-load increments stay safe too.
  if (!Number.isSafeInteger(data.tick) || data.tick < 0 || data.tick > MAX_SAVED_COUNTER) return false;
  // the engine only ever sets lastRecruitTick to -recruitCooldownTicks (fresh
  // colony) or to a past tick; anything else blocks recruiting spuriously
  if (
    !Number.isSafeInteger(data.lastRecruitTick) ||
    data.lastRecruitTick < -BALANCE.recruitCooldownTicks ||
    data.lastRecruitTick > data.tick
  ) return false;
  if (!isStockpileValid(data.stockpile)) return false;
  if (!isBuildingsValid(data.buildings)) return false;
  if (!isIdsValid(data)) return false;
  return isWorkersValid(data);
}

export function spawnBuilding(
  prep: IPreptimeWorld,
  ids: IdCounter,
  saved: Omit<SavedBuilding, 'id'> & { id?: number },
): IEntity {
  const def = BUILDINGS[saved.defId];
  return prep
    .buildEntity()
    .with(new Building(saved.id ?? ids.take(), saved.defId))
    .with(new WorkerSlots(def.workerSlots))
    .with(new Production(saved.progress, saved.batchActive))
    .build();
}

export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { id?: number; hunger?: number; buildingId?: number | null; efficiency?: number; toolTicks?: number } = {},
): IEntity {
  return prep
    .buildEntity()
    .with(new Worker(opts.id ?? ids.take()))
    .with(new Hunger(opts.hunger ?? 0))
    .with(new JobAssignment(opts.buildingId ?? null))
    .with(new Efficiency(opts.efficiency ?? 1))
    .with(new ToolCoverage(opts.toolTicks ?? 0))
    .build();
}

export function buildColonyPrepWorld(
  options: { save?: SaveGameV1; systems?: readonly TColonySystemFactory[] } = {},
): IPreptimeWorld {
  const save = options.save ?? initialSave();
  const systems = options.systems ?? ALL_SYSTEMS;

  let builder = buildWorld().withDefaultScheduling((root) => {
    for (const systemFactory of systems) {
      root = root.addNewStage((stage) => stage.addSystem(systemFactory()));
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
  const ids = new IdCounter(save.nextEntityId);
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

  for (const saved of save.buildings) spawnBuilding(prep, ids, saved);
  for (const saved of save.workers) {
    spawnWorker(prep, ids, {
      id: saved.id,
      hunger: saved.hunger,
      toolTicks: saved.toolTicks,
      buildingId: saved.buildingId,
    });
  }
  // The UI must never see a null snapshot: a reset or freshly created engine is
  // paused until its first tick, so seed the store from the save. SnapshotSystem
  // replaces this on the first step.
  store.latest = buildInitialSnapshot(save);

  return prep;
}

function buildInitialSnapshot(save: SaveGameV1): Snapshot {
  const workerFacts: WorkerFacts[] = save.workers.map((saved) => ({
    id: saved.id,
    hunger: saved.hunger,
    efficiency: workerEfficiency(saved.hunger),
    buildingId: saved.buildingId,
    toolTicks: saved.toolTicks,
  }));
  const buildingFacts: BuildingFacts[] = save.buildings.map((saved) => ({
    id: saved.id,
    defId: saved.defId,
    workerSlots: BUILDINGS[saved.defId].workerSlots,
    progress: saved.progress,
    batchActive: saved.batchActive,
  }));
  const { workers, buildings, population, idleWorkers } = buildEntitySections(workerFacts, buildingFacts);
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
    population,
    idleWorkers,
    buildings,
    workers,
    notices: [],
  };
}

/**
 * sim-ecs syncs entities created by a tick's commands (construct/recruit) only
 * AFTER all systems — including SnapshotSystem — have run, so the snapshot
 * SnapshotSystem just wrote can be missing that tick's own new entities. Called
 * after world.step() resolves, this re-walks the now-fully-synced world and
 * patches SnapshotStore.latest's entity-derived sections in place, leaving the
 * stockpile/wealth/notices sections SnapshotSystem already assembled untouched.
 * No-op before the store has ever been populated (never happens in practice:
 * buildColonyPrepWorld always seeds it).
 */
export function refreshEntitySections(world: IRuntimeWorld): void {
  const store = world.getResource(SnapshotStore);
  if (store.latest === null) return;

  const workerFacts: WorkerFacts[] = [];
  const buildingFacts: BuildingFacts[] = [];
  for (const entity of world.getEntities()) {
    const building = entity.getComponent(Building);
    if (building) {
      buildingFacts.push({
        id: building.id,
        defId: building.defId,
        workerSlots: entity.getComponent(WorkerSlots)!.max,
        progress: entity.getComponent(Production)!.progress,
        batchActive: entity.getComponent(Production)!.batchActive,
      });
      continue;
    }
    const worker = entity.getComponent(Worker);
    if (worker) {
      workerFacts.push({
        id: worker.id,
        hunger: entity.getComponent(Hunger)!.value,
        efficiency: entity.getComponent(Efficiency)!.value,
        buildingId: entity.getComponent(JobAssignment)!.buildingId,
        toolTicks: entity.getComponent(ToolCoverage)!.remainingTicks,
      });
    }
  }

  store.latest = { ...store.latest, ...buildEntitySections(workerFacts, buildingFacts) };
}

/**
 * sim-ecs's Scheduler drives each step() through `requestAnimationFrame` (or,
 * absent that global, `setTimeout`) purely to yield a macrotask between frames
 * for continuous run loops. GameEngine already owns pacing via its own
 * setInterval and calls step() for single, discrete ticks, so that indirection
 * only adds latency: under Node's real timers it's a harmless ~1ms, but under
 * vitest fake timers each hop is clamped to a whole simulated millisecond,
 * which can push a step() past an exact-boundary `advanceTimersByTimeAsync`
 * window. Running the executor synchronously removes the extra hop with no
 * change to simulation order or results.
 *
 * CAUTION: never call `world.start()` (the library's continuous run loop) on a
 * world created by createColonyWorld — without the macrotask yield that loop
 * would never cede the event loop and would hang until an external `stop()`.
 * The engine drives time exclusively through discrete `step()` calls.
 *
 * sim-ecs types `executionFunction` as `(callback: Function) => any` (loose,
 * to also accept `setTimeout`/`requestAnimationFrame` directly) but always
 * invokes it with exactly one zero-arg callback (verified against sim-ecs
 * 0.6.4's compiled runtime-world source). `() => void` is therefore the true
 * call shape; the cast below is scoped to this one invocation, not a bypass.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- mirrors sim-ecs's TExecutionFunction callback type exactly
const runSynchronously = (callback: Function): void => (callback as () => void)();

export async function createColonyWorld(save?: SaveGameV1): Promise<IRuntimeWorld> {
  return buildColonyPrepWorld({ save }).prepareRun({ executionFunction: runSynchronously });
}
