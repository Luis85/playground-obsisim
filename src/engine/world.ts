import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV1, MAX_SAVED_COUNTER } from '../shared/save';
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
// then indexing the catalog throws inside the guard.
// Safe-integer amounts only: organic stockpiles are integral, and an absurd
// magnitude (e.g. 1e308) would turn stock-value/wealth arithmetic infinite.
function isStockpileValid(stockpile: SaveGameV1['stockpile']): boolean {
  return Object.entries(stockpile).every(
    ([id, amount]) =>
      Object.hasOwn(RESOURCES, id) &&
      Number.isSafeInteger(amount) &&
      (amount as number) >= 0 &&
      (amount as number) <= MAX_SAVED_COUNTER,
  );
}

function isBuildingsValid(buildings: SaveGameV1['buildings']): boolean {
  return buildings.every((b) => {
    if (!Object.hasOwn(BUILDINGS, b.defId)) return false;
    if (b.batchActive) {
      // Upper bound intentionally NOT checked against the current recipe's
      // ticksPerBatch: a recipe retuned smaller after this save was written
      // would otherwise orphan it. Magnitude is irrelevant here because
      // spawnBuilding clamps active progress to the CURRENT batch size, so
      // the production loop never has a huge remainder to grind through.
      return b.progress >= 0 && Number.isFinite(b.progress);
    }
    return b.progress === 0; // stalled/idle buildings never bank progress (balance-independent engine invariant)
  });
}

function isWorkerRecordValid(w: SaveGameV1['workers'][number], buildingIds: ReadonlySet<number>): boolean {
  // Upper bounds intentionally NOT checked against current BALANCE.hungerMax /
  // toolDurationTicks: those are clamped to current balance at spawn instead
  // (see spawnWorker), so a save written under a higher balance value still loads.
  if (!(w.hunger >= 0 && Number.isFinite(w.hunger))) return false;
  if (!Number.isSafeInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > MAX_SAVED_COUNTER) return false;
  if (w.buildingId === null) return true;
  return buildingIds.has(w.buildingId);
}

function isWorkersValid(data: SaveGameV1): boolean {
  const buildingIds = new Set(data.buildings.map((b) => b.id));
  return data.workers.every((w) => isWorkerRecordValid(w, buildingIds));
}

// Cross-array id validity: positive integers, unique across buildings AND
// workers combined (they share one id space), and nextEntityId strictly past
// every id already handed out so the restored IdCounter can never collide.
// The MAX_SAVED_COUNTER ceiling cannot ping-pong (accepted save -> play ->
// rejected save): IdCounter saturates at that same ceiling, refusing entity
// creation instead of writing a counter the guard would refuse to load.
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
 *
 * Principle (spec 4.5 — saves survive balancing changes): reject only what NO
 * version of the engine could have written (structural/identity invariants —
 * shape, safe-integer ranges, id uniqueness/headroom, catalog membership,
 * cross-references). Values coupled to tunable BALANCE/catalog numbers
 * (hunger max, tool duration, recruit cooldown sentinel, recipe batch size,
 * worker slots) are deliberately NOT bounds-checked here: they're clamped or
 * grandfathered at load (see spawnWorker) so retuning balance down never
 * orphans a previously valid save.
 */
export function isLoadableSave(data: unknown): data is SaveGameV1 {
  if (!isSaveGameV1(data)) return false;
  // SAFE integers: a fractional tick would desync every modulo-based cadence
  // (autosave, recruit cooldown) forever; past 2^53, ++ stops incrementing.
  // No upper REJECT bound: any hard accept-bound would orphan a save that
  // plays past it, so oversized ticks are CLAMPED on load instead (the tick
  // only feeds the autosave modulo and display). nextEntityId keeps its hard
  // bound below: it cannot be clamped without breaking id uniqueness, and
  // crossing it organically would require creating ~9e15 entities.
  if (!Number.isSafeInteger(data.tick) || data.tick < 0) return false;
  // Lower bound intentionally NOT checked against -BALANCE.recruitCooldownTicks:
  // a value lower than the current sentinel just means "cooldown long expired",
  // which is harmless (isSafeInteger already floors it to a real number, and
  // the upper bound below still guarantees it never blocks recruiting).
  if (
    !Number.isSafeInteger(data.lastRecruitTick) ||
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
  // Balance-coupled clamp (spec 4.5): progress from a save written under a
  // larger recipe (or hand-edited to an absurd magnitude) clamps to the
  // CURRENT batch size — the save still loads, at most one batch completes
  // instantly, and the production loop can never spin on a huge remainder.
  const progress = Math.min(saved.progress, def.recipe.ticksPerBatch);
  return prep
    .buildEntity()
    .with(new Building(saved.id ?? ids.take(), saved.defId))
    .with(new WorkerSlots(def.workerSlots))
    .with(new Production(progress, saved.batchActive))
    .build();
}

export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { id?: number; hunger?: number; buildingId?: number | null; efficiency?: number; toolTicks?: number } = {},
): IEntity {
  // Balance-coupled fields from old saves clamp to CURRENT balance here: a
  // save written under a higher hungerMax/toolDurationTicks still loads
  // (isLoadableSave no longer bounds-checks these against BALANCE), so the
  // clamp is what actually keeps in-world values sane after a downward retune.
  const hunger = Math.min(opts.hunger ?? 0, BALANCE.hungerMax);
  const toolTicks = Math.min(opts.toolTicks ?? 0, BALANCE.toolDurationTicks);
  return prep
    .buildEntity()
    .with(new Worker(opts.id ?? ids.take()))
    .with(new Hunger(hunger))
    .with(new JobAssignment(opts.buildingId ?? null))
    .with(new Efficiency(opts.efficiency ?? 1))
    .with(new ToolCoverage(toolTicks))
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
  // clamp on load (never reject): leaves 2^32 increments of headroom every
  // session regardless of what a prior session wrote
  clock.tick = Math.min(save.tick, MAX_SAVED_COUNTER);
  clock.lastRecruitTick = Math.min(save.lastRecruitTick, clock.tick);
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
  const workerFacts: WorkerFacts[] = save.workers.map((saved) => {
    // Mirror spawnWorker's clamp so the seeded snapshot matches the entities
    // buildColonyPrepWorld actually spawns (see spawnWorker for rationale).
    const hunger = Math.min(saved.hunger, BALANCE.hungerMax);
    const toolTicks = Math.min(saved.toolTicks, BALANCE.toolDurationTicks);
    return {
      id: saved.id,
      hunger,
      efficiency: workerEfficiency(hunger),
      buildingId: saved.buildingId,
      toolTicks,
    };
  });
  const buildingFacts: BuildingFacts[] = save.buildings.map((saved) => ({
    id: saved.id,
    defId: saved.defId,
    workerSlots: BUILDINGS[saved.defId].workerSlots,
    // same balance-coupled clamp as spawnBuilding, so the seeded snapshot
    // matches the spawned world
    progress: Math.min(saved.progress, BUILDINGS[saved.defId].recipe.ticksPerBatch),
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
    tick: Math.min(save.tick, MAX_SAVED_COUNTER), // same clamp as the spawned clock
    lastRecruitTick: Math.min(save.lastRecruitTick, Math.min(save.tick, MAX_SAVED_COUNTER)),
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
