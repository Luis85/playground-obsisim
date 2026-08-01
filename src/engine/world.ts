import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV3, LATEST_SAVE_VERSION, MAX_SAVED_COUNTER } from '../shared/save';
import { migrateSaveToLatest } from '../shared/save-migration';
import type { SaveGameV3, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import type { ResourceStats, Snapshot } from '../shared/snapshot';
import { CAMP_COLS, DEFAULT_MAP, isInsideMap } from '../shared/placement';
import { BALANCE, STARTING_STOCK, STARTING_WORKERS, workerEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, ToolCoverage, Worker, WorkerSlots,
} from './components';
import {
  CommandQueue, IdCounter, NoticeBoard, RemovalLedger, SimClock, SnapshotStore, StatsHistory, Stockpile, WorldMap,
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

// Object.hasOwn, never `in`: inherited keys like "toString" pass `in` and
// then indexing the catalog throws inside the guard.
// Safe-integer amounts only: organic stockpiles are integral, and an absurd
// magnitude (e.g. 1e308) would turn stock-value/wealth arithmetic infinite.
// The MAX_SAVED_COUNTER bound cannot ping-pong (accepted save -> one
// production tick, or a save banking a hauler's mid-trip load -> rejected
// save): Stockpile.add saturates at that same ceiling, and buildSaveFromWorld's
// deposit-on-save loop saturates identically, so the engine never banks an
// amount this guard would refuse.
function isStockpileValid(stockpile: SaveGameV3['stockpile']): boolean {
  // Key-count cap FIRST (same principle as MAX_SAVED_ENTITIES): a valid
  // stockpile has at most one key per catalog resource, and Object.entries
  // on an adversarially huge object would materialize every entry before
  // the first per-entry check could reject.
  if (Object.keys(stockpile).length > RESOURCE_IDS.length) return false;
  return Object.entries(stockpile).every(
    ([id, amount]) =>
      Object.hasOwn(RESOURCES, id) &&
      Number.isSafeInteger(amount) &&
      (amount as number) >= 0 &&
      (amount as number) <= MAX_SAVED_COUNTER,
  );
}

function isBuildingsValid(buildings: SaveGameV3['buildings']): boolean {
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

function isWorkerRecordValid(w: SaveGameV3['workers'][number], buildingIds: ReadonlySet<number>): boolean {
  // Upper bounds intentionally NOT checked against current BALANCE.hungerMax /
  // toolDurationTicks: those are clamped to current balance at spawn instead
  // (see spawnWorker), so a save written under a higher balance value still loads.
  if (!(w.hunger >= 0 && Number.isFinite(w.hunger))) return false;
  if (!Number.isSafeInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > MAX_SAVED_COUNTER) return false;
  if (w.buildingId === null) return true;
  // A worker is staffed XOR hauling, never both — handleAssignWorker refuses to
  // poach a hauler and handleAssignHauler refuses to poach a staffed worker, so
  // no version of the engine could ever write both onto one record. That makes
  // this an identity violation like the membership check below (a record no
  // playthrough could produce), not a balance-coupled value to clamp: there is
  // no "current" amount of double-staffing to grandfather down to.
  if (w.hauling) return false;
  return buildingIds.has(w.buildingId);
}

function isWorkersValid(data: SaveGameV3): boolean {
  const buildingIds = new Set(data.buildings.map((b) => b.id));
  return data.workers.every((w) => isWorkerRecordValid(w, buildingIds));
}

// Cross-array id validity: positive integers, unique across buildings AND
// workers combined (they share one id space), and nextEntityId strictly past
// every id already handed out so the restored IdCounter can never collide.
// The MAX_SAVED_COUNTER ceiling cannot ping-pong (accepted save -> play ->
// rejected save): IdCounter saturates at that same ceiling, refusing entity
// creation instead of writing a counter the guard would refuse to load.
function isIdsValid(data: SaveGameV3): boolean {
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
 * Position invariants are cross-field truths — they need the save's own map
 * — so they live here beside the id checks, not in the structural guard.
 * Set-based, not isTileBuildable-per-record: that would be O(n^2) on a
 * 10,000-building hand-edited save (the flooded-save principle: cheap
 * checks before expensive walks).
 */
function isPositionsValid(data: SaveGameV3): boolean {
  const tiles = new Set<string>();
  for (const b of data.buildings) {
    if (!isInsideMap(data.map, b.col, b.row) || b.col < CAMP_COLS) return false;
    const key = `${b.col},${b.row}`;
    if (tiles.has(key)) return false;
    tiles.add(key);
  }
  return true;
}

/**
 * Buffer contents are a cross-field truth like positions: catalog membership
 * needs the content catalog, which the structural guard in src/shared/ cannot
 * see. The cap is NOT checked here — see spawnBuilding, which clamps an
 * over-cap buffer at load exactly as it clamps saved batch progress.
 */
function isBuffersValid(data: SaveGameV3): boolean {
  return data.buildings.every((b) => {
    const ids = Object.keys(b.buffer);
    // Key-count cap FIRST (same principle as isStockpileValid above): a valid
    // buffer has at most one key per catalog resource, and the membership walk
    // below would otherwise run once per key of an adversarially wide object —
    // multiplied by up to MAX_SAVED_ENTITIES buildings.
    if (ids.length > RESOURCE_IDS.length) return false;
    return ids.every((id) => Object.hasOwn(RESOURCES, id));
  });
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
 * Balance-coupled clamp (spec 4.5), the same treatment `progress` gets above:
 * a buffer written under a larger cap loads trimmed to the CURRENT cap instead
 * of orphaning the save. Trimming walks the catalog in order so the result is
 * deterministic.
 */
function clampedBuffer(saved: Partial<Record<ResourceId, number>>): Map<ResourceId, number> {
  const buffer = new Map<ResourceId, number>();
  let total = 0;
  for (const id of RESOURCE_IDS) {
    const amount = saved[id] ?? 0;
    if (amount <= 0) continue;
    const room = BALANCE.outputBufferCap - total;
    if (room <= 0) break;
    const kept = Math.min(amount, room);
    buffer.set(id, kept);
    total += kept;
  }
  return buffer;
}

export function spawnBuilding(
  prep: IPreptimeWorld,
  ids: IdCounter,
  saved: Omit<SavedBuilding, 'id' | 'buffer'> & { id?: number; buffer?: Partial<Record<ResourceId, number>> },
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
    .with(new Position(saved.col, saved.row))
    .with(new OutputBuffer(clampedBuffer(saved.buffer ?? {})))
    .build();
}

export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { id?: number; hunger?: number; buildingId?: number | null; hauling?: boolean; efficiency?: number; toolTicks?: number } = {},
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
    .with(new JobAssignment(opts.buildingId ?? null, opts.hauling ?? false))
    .with(new Efficiency(opts.efficiency ?? 1))
    .with(new ToolCoverage(toolTicks))
    .with(new HaulTrip())
    .build();
}

export function buildColonyPrepWorld(
  options: { save?: SaveGameV3; systems?: readonly TColonySystemFactory[] } = {},
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
    // Mirror spawnWorker's clamp so the seeded snapshot matches the entities
    // buildColonyPrepWorld actually spawns (see spawnWorker for rationale).
    const hunger = Math.min(saved.hunger, BALANCE.hungerMax);
    const toolTicks = Math.min(saved.toolTicks, BALANCE.toolDurationTicks);
    return {
      id: saved.id,
      hunger,
      efficiency: workerEfficiency(hunger),
      buildingId: saved.buildingId,
      hauling: saved.hauling,
      haulTargetId: null, carrying: 0, carryingResource: null, // a restored colony's haulers start at the camp
      toolTicks,
    };
  });
  const buildingFacts: BuildingFacts[] = save.buildings.map((saved) => {
    // same balance-coupled clamp as spawnBuilding, so the seeded snapshot's
    // buffered total matches the buffer the spawned entity actually holds
    // (an over-cap saved buffer trims to the cap here too, not just in the world)
    const buffer = new OutputBuffer(clampedBuffer(saved.buffer));
    return {
      id: saved.id,
      defId: saved.defId,
      col: saved.col, row: saved.row,
      workerSlots: BUILDINGS[saved.defId].workerSlots,
      progress: Math.min(saved.progress, BUILDINGS[saved.defId].recipe.ticksPerBatch),
      batchActive: saved.batchActive,
      buffered: buffer.total(),
      buffer: Object.fromEntries(buffer.amounts) as Partial<Record<ResourceId, number>>,
    };
  });
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
