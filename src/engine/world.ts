import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV3, LATEST_SAVE_VERSION, MAX_SAVED_COUNTER } from '../shared/save';
import { migrateSaveToLatest } from '../shared/save-migration';
import type { SaveGameV3, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import type { ResourceStats, Snapshot } from '../shared/snapshot';
import { DEFAULT_MAP } from '../shared/placement';
import { BALANCE, STARTING_STOCK, STARTING_WORKERS, workerEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage, Worker,
  WorkerSlots,
} from './components';
import { isBuffersValid, isBuildingsValid, isIdsValid, isPositionsValid, isStockpileValid, isWorkersValid } from './save-guard';
import {
  buildingComponents, clampedBuffer, clampedHunger, clampedProgress, clampedRelocation, clampedToolTicks, workerComponents,
} from './spawn';
import {
  CommandQueue, IdCounter, NoticeBoard, ProductionLedger, RemovalLedger, SimClock, SnapshotStore, StatsHistory, Stockpile, WorldMap,
} from './resources';
import type { BuildingFacts, WorkerFacts } from './snapshot-builder';
import { buildEntitySections, gatherEntityFacts } from './snapshot-builder';
import { CommandSystem } from './systems/command-system';
import { HungerSystem } from './systems/hunger-system';
import { EfficiencySystem } from './systems/efficiency-system';
import { ProductionSystem } from './systems/production-system';
import { HaulSystem } from './systems/haul-system';
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
  HaulSystem,
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

// Typed as a uniform constructor array (not the inferred union of each
// class's own constructor signature) so a caller can pass any one element
// straight into IEntity.getComponent<T>: with the naked union, TS infers T as
// a single arbitrary member of that union instead of distributing across it,
// and rejects every other member as unassignable. `any[]` (not `unknown[]` or
// `never[]`) mirrors sim-ecs's own TTypeProto<T> exactly — its bidirectional
// escape hatch is what keeps both directions assignable: concrete component
// constructors (each with its own specific parameter list) INTO this array,
// and elements of this array back OUT into getComponent's parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors sim-ecs's own TTypeProto<T> constructor-parameter shape exactly
export const COMPONENT_TYPES: (new (...args: any[]) => object)[] = [
  Building, WorkerSlots, Production, Worker, Hunger, JobAssignment, Efficiency, ToolCoverage, Position, OutputBuffer, HaulTrip,
  Relocation,
];

export function initialSave(): SaveGameV3 {
  return {
    version: LATEST_SAVE_VERSION,
    tick: 0,
    lastRecruitTick: -BALANCE.recruitCooldownTicks,
    stockpile: { ...STARTING_STOCK },
    map: { ...DEFAULT_MAP },
    buildings: [],
    workers: Array.from({ length: STARTING_WORKERS }, (_, index) => ({
      id: index + 1,
      hunger: 0,
      buildingId: null,
      toolTicks: 0,
      hauling: false,
    })),
    nextEntityId: STARTING_WORKERS + 1,
  };
}

/**
 * Structural validity (isSaveGameV3) plus referential integrity against the content
 * catalog, for a save that is ALREADY at the current version. This is the internal
 * current-version validator, not the shell's entry point: it has no idea how to
 * migrate an older save, so calling it directly on unmigrated data would crash
 * createColonyWorld (or wrongly reject a valid old save) instead of taking the
 * corrupt-save backup path (spec 7.2). prepareLoadedSave (below) is the shell's
 * entry point — and any future load path (import-save, a devtools command) must
 * go through it too, not through this function directly.
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
export function isLoadableSave(data: unknown): data is SaveGameV3 {
  if (!isSaveGameV3(data)) return false;
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
  if (!isPositionsValid(data)) return false;
  if (!isBuffersValid(data)) return false;
  return isWorkersValid(data);
}

/**
 * The Obsidian shell's load entry point: migrate a save of any known version up
 * to the latest, then apply the catalog-aware checks. Returns null for anything
 * unloadable, which the shell turns into the corrupt-save backup path (spec
 * 7.2). Kept here rather than in src/shared/ because isLoadableSave needs the
 * content catalog, while the migration chain is pure structure.
 */
export function prepareLoadedSave(data: unknown): SaveGameV3 | null {
  const migrated = migrateSaveToLatest(data);
  return migrated !== null && isLoadableSave(migrated) ? migrated : null;
}

/** The three things the shell can do after reading data.json's `save` field. */
export type LoadDecision =
  | { kind: 'restore'; save: SaveGameV3 }
  | { kind: 'backup' }
  | { kind: 'fresh' };

/**
 * Pure decision for the Obsidian shell's load path (spec 7.2), given the raw
 * `save` field read from data.json (undefined/null on a first-ever install,
 * or whatever shape a prior version wrote). This is the ONLY production call
 * site of prepareLoadedSave, and extracting the decision out of main.ts's
 * loadSave() (which the Obsidian Plugin API makes hard to unit-test directly)
 * is what makes that call site testable at all — main.ts's loadSave() is
 * reduced to calling this and performing the I/O each branch implies.
 */
export function decideLoad(data: unknown): LoadDecision {
  if (data === undefined || data === null) return { kind: 'fresh' };
  const save = prepareLoadedSave(data);
  return save !== null ? { kind: 'restore', save } : { kind: 'backup' };
}

/**
 * Attach a component list built by src/engine/spawn.ts to a preptime entity.
 * The runtime path uses `ctx.spawn(...components)` instead; that difference in
 * mechanism is the only reason these two paths are still separate functions.
 */
function attach(prep: IPreptimeWorld, components: object[]): IEntity {
  let builder = prep.buildEntity();
  for (const component of components) builder = builder.with(component);
  return builder.build();
}

/**
 * Restore a building from a save record. Which components it gets — and the
 * balance-coupled clamps on progress and buffer — live in `buildingComponents`,
 * shared with the live construct path so the two cannot drift (OBS-4-02).
 */
export function spawnBuilding(
  prep: IPreptimeWorld,
  ids: IdCounter,
  saved: Omit<SavedBuilding, 'id' | 'buffer'> & { id?: number; buffer?: Partial<Record<ResourceId, number>> },
): IEntity {
  return attach(prep, buildingComponents({ ...saved, id: saved.id ?? ids.take() }));
}

/** Restore a worker from a save record. See spawnBuilding on the shared list. */
export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { id?: number; hunger?: number; buildingId?: number | null; hauling?: boolean; efficiency?: number; toolTicks?: number } = {},
): IEntity {
  return attach(prep, workerComponents({ ...opts, id: opts.id ?? ids.take() }));
}

/**
 * Systems must be scheduled in `ALL_SYSTEMS` order. Production always is — it
 * passes `ALL_SYSTEMS` itself — but every test composes its own subset by hand,
 * and two of them ran systems in the reverse of production order for a whole
 * increment (OBS-4-03). That is not a harmless difference: it silently changes
 * what a test proves, and it produced a real false positive, because a haul
 * trip cancelled by a demolition is only observable when `CommandSystem` drains
 * ahead of `HaulSystem` the way production runs them.
 *
 * Rather than reorder the offending harnesses and hope, this makes a wrong
 * order impossible to express: a subset in the wrong relative order throws at
 * setup, naming both systems. Systems not in `ALL_SYSTEMS` — test-only arrange
 * systems like `stats-system.test.ts`'s `DepositWoodSystem` — are skipped
 * rather than sorted, so a test can still stage state before the real systems
 * run without this guessing where it meant to put them.
 */
function assertSystemOrder(systems: readonly TColonySystemFactory[]): void {
  let previousRank = -1;
  let previous = '';
  for (const factory of systems) {
    const rank = ALL_SYSTEMS.indexOf(factory);
    if (rank === -1) continue; // test-only system: not ours to order
    if (rank < previousRank) {
      throw new Error(
        `System order must match ALL_SYSTEMS: ${factory.name || 'system'} runs after ${previous || 'an earlier system'}, but production runs it before.`,
      );
    }
    previousRank = rank;
    previous = factory.name || previous;
  }
}

export function buildColonyPrepWorld(
  options: { save?: SaveGameV3; systems?: readonly TColonySystemFactory[] } = {},
): IPreptimeWorld {
  const save = options.save ?? initialSave();
  const systems = options.systems ?? ALL_SYSTEMS;
  assertSystemOrder(systems);

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
    new ProductionLedger(),
    store,
    new WorldMap(save.map.cols, save.map.rows),
    new RemovalLedger(),
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
      hauling: saved.hauling,
    });
  }
  // The UI must never see a null snapshot: a reset or freshly created engine is
  // paused until its first tick, so seed the store from the save. SnapshotSystem
  // replaces this on the first step.
  store.latest = buildInitialSnapshot(save);

  return prep;
}

function buildInitialSnapshot(save: SaveGameV3): Snapshot {
  const workerFacts: WorkerFacts[] = save.workers.map((saved) => {
    // The same clamps workerComponents applies, so the seeded snapshot matches
    // the entities buildColonyPrepWorld actually spawns (see src/engine/spawn.ts).
    const hunger = clampedHunger(saved.hunger);
    const toolTicks = clampedToolTicks(saved.toolTicks);
    return {
      id: saved.id,
      hunger,
      efficiency: workerEfficiency(hunger),
      buildingId: saved.buildingId,
      hauling: saved.hauling,
      // a restored colony's haulers start at the camp: HaulTrip never enters the save
      haulTargetId: null, haulPhase: 'idle' as const, haulTicksLeft: 0, carrying: 0, carryingResource: null,
      toolTicks,
    };
  });
  const buildingFacts: BuildingFacts[] = save.buildings.map((saved) => {
    // The same clamps buildingComponents applies, so the seeded snapshot's
    // buffered total matches the buffer the spawned entity actually holds
    // (an over-cap saved buffer trims to the cap here too, not just in the world)
    const buffer = new OutputBuffer(clampedBuffer(saved.buffer));
    return {
      id: saved.id,
      defId: saved.defId,
      col: saved.col, row: saved.row,
      workerSlots: BUILDINGS[saved.defId].workerSlots,
      progress: clampedProgress(saved.defId, saved.progress),
      batchActive: saved.batchActive,
      buffered: buffer.total(),
      buffer: Object.fromEntries(buffer.amounts) as Partial<Record<ResourceId, number>>,
      relocatingTicks: clampedRelocation(saved.relocatingTicks ?? 0),
    };
  });
  const { workers, buildings, population, idleWorkers } = buildEntitySections(workerFacts, buildingFacts);
  const stockpile = {} as Record<ResourceId, ResourceStats>;
  let colonyWealth = 0;
  for (const resourceId of RESOURCE_IDS) {
    const stock = save.stockpile[resourceId] ?? 0;
    const stockValue = stock * RESOURCES[resourceId].value;
    colonyWealth += stockValue;
    stockpile[resourceId] = { stock, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
  }
  return {
    tick: Math.min(save.tick, MAX_SAVED_COUNTER), // same clamp as the spawned clock
    lastRecruitTick: Math.min(save.lastRecruitTick, Math.min(save.tick, MAX_SAVED_COUNTER)),
    map: { cols: save.map.cols, rows: save.map.rows },
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
  const { workers, buildings } = gatherEntityFacts(world);
  store.latest = { ...store.latest, ...buildEntitySections(workers, buildings) };
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

export async function createColonyWorld(save?: SaveGameV3): Promise<IRuntimeWorld> {
  return buildColonyPrepWorld({ save }).prepareRun({ executionFunction: runSynchronously });
}
