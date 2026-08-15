import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV6, MAX_SAVED_COUNTER } from '../shared/save';
import { migrateSaveToLatest } from '../shared/save-migration';
import type { SaveGameV6, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import {
  Age, Building, Efficiency, HaulTrip, Home, Hunger, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation, ToolCoverage,
  Colonist, WorkerSlots,
} from './components';
import { isBuffersValid, isBuildingsValid, isIdsValid, isPositionsValid, isStockpileValid, isColonistsValid } from './save-guard';
import { buildingComponents, colonistComponents } from './spawn';
import { restoredColonists, seedStoredGoods } from './restore';
import { initialSave } from './initial-save';
// Re-exported: every call site outside this file reaches initialSave through
// world.ts, and the extraction (moving the function itself to its own file,
// to make room here) must not force every one of those imports to be rewritten.
export { initialSave } from './initial-save';
import {
  CommandQueue, IdCounter, NoticeBoard, PendingChanges, ProductionLedger, RemovalLedger, SimClock, SnapshotStore, StatsHistory, Stockpile,
  WorldMap,
} from './resources';
import { buildInitialSnapshot } from './initial-snapshot';
import { buildEntitySections, gatherEntityFacts } from './snapshot-builder';
import { CommandSystem } from './systems/command-system';
import { HungerSystem } from './systems/hunger-system';
import { PopulationSystem } from './systems/population-system';
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
  PopulationSystem,
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
  Building, WorkerSlots, Production, Colonist, Hunger, JobAssignment, Efficiency, ToolCoverage, Position, OutputBuffer, InputBuffer, HaulTrip,
  Relocation, Age, Home,
];

/**
 * Structural validity (isSaveGameV6) plus referential integrity against the content
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
 * grandfathered at load (see spawnColonist) so retuning balance down never
 * orphans a previously valid save.
 */
export function isLoadableSave(data: unknown): data is SaveGameV6 {
  if (!isSaveGameV6(data)) return false;
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
  // Identical treatment for the birth clock, for the identical reason: the
  // engine only ever records a tick that has already happened, so a timestamp
  // ahead of `tick` would gate births on a cooldown that never expires.
  if (
    !Number.isSafeInteger(data.lastBirthTick) ||
    data.lastBirthTick > data.tick
  ) return false;
  if (!isStockpileValid(data.stockpile)) return false;
  if (!isBuildingsValid(data.buildings)) return false;
  // Structural/identity, not balance: a negative or fractional countdown is a
  // record no version of the engine could write. Magnitude is CLAMPED at
  // spawn instead (clampedRelocation), so a save written under a slower
  // relocationTilesPerTick still loads.
  if (data.buildings.some((b) => !Number.isSafeInteger(b.relocatingTicks) || b.relocatingTicks < 0)) return false;
  if (!isIdsValid(data)) return false;
  if (!isPositionsValid(data)) return false;
  if (!isBuffersValid(data)) return false;
  return isColonistsValid(data);
}

/**
 * The Obsidian shell's load entry point: migrate a save of any known version up
 * to the latest, then apply the catalog-aware checks. Returns null for anything
 * unloadable, which the shell turns into the corrupt-save backup path (spec
 * 7.2). Kept here rather than in src/shared/ because isLoadableSave needs the
 * content catalog, while the migration chain is pure structure.
 */
export function prepareLoadedSave(data: unknown): SaveGameV6 | null {
  const migrated = migrateSaveToLatest(data);
  return migrated !== null && isLoadableSave(migrated) ? migrated : null;
}

/** The three things the shell can do after reading data.json's `save` field. */
export type LoadDecision =
  | { kind: 'restore'; save: SaveGameV6 }
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
  saved: Omit<SavedBuilding, 'id' | 'buffer' | 'inputBuffer' | 'stored'> & {
    id?: number;
    buffer?: Partial<Record<ResourceId, number>>;
    inputBuffer?: Partial<Record<ResourceId, number>>;
  },
): IEntity {
  return attach(prep, buildingComponents({ ...saved, id: saved.id ?? ids.take() }));
}

/** Restore a worker from a save record. See spawnBuilding on the shared list. */
export function spawnColonist(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: {
    id?: number; hunger?: number; buildingId?: number | null; hauling?: boolean; efficiency?: number; toolTicks?: number;
    ageTicks?: number; starvingTicks?: number; homeId?: number | null;
  } = {},
): IEntity {
  return attach(prep, colonistComponents({ ...opts, id: opts.id ?? ids.take() }));
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
  options: { save?: SaveGameV6; systems?: readonly TColonySystemFactory[] } = {},
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
  clock.lastBirthTick = Math.min(save.lastBirthTick, clock.tick);
  const ids = new IdCounter(save.nextEntityId);
  const store = new SnapshotStore();
  // The CAMP's contents, which is all `save.stockpile` is since v6. Every other
  // site is reconstructed from its own building's record, below.
  const stockpile = new Stockpile(save.stockpile);
  const instances = [
    stockpile,
    clock,
    new CommandQueue(),
    new NoticeBoard(),
    ids,
    new StatsHistory(),
    new ProductionLedger(),
    store,
    new WorldMap(save.map.cols, save.map.rows),
    new RemovalLedger(),
    new PendingChanges(),
  ];
  const registry = new Map<object, object>();
  for (const instance of instances) {
    prep.addResource(instance);
    registry.set(instance.constructor, instance);
  }
  PREP_RESOURCES.set(prep, registry);

  for (const saved of save.buildings) spawnBuilding(prep, ids, saved);
  // After the spawns, and against the same records: a storehouse's stock is
  // serialized off its building, so restoring it is a second pass over the same
  // list rather than anything spawnBuilding could carry (see seedStoredGoods).
  seedStoredGoods(stockpile, save.buildings);
  // Through restoredColonists, never straight off `save.colonists`: it is the
  // one place the load-time clamps and repairs live, and buildInitialSnapshot
  // reads the very same records — so the seeded snapshot and the entities
  // spawned here cannot disagree about what this save restores as.
  for (const saved of restoredColonists(save)) {
    spawnColonist(prep, ids, {
      id: saved.id,
      hunger: saved.hunger,
      toolTicks: saved.toolTicks,
      buildingId: saved.buildingId,
      hauling: saved.hauling,
      ageTicks: saved.ageTicks,
      starvingTicks: saved.starvingTicks,
      homeId: saved.homeId,
    });
  }
  // The UI must never see a null snapshot: a reset or freshly created engine is
  // paused until its first tick, so seed the store from the save. SnapshotSystem
  // replaces this on the first step.
  store.latest = buildInitialSnapshot(save);

  return prep;
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
  const stock = world.getResource(Stockpile).colonyStock() as Record<string, number>;
  store.latest = { ...store.latest, ...buildEntitySections(workers, buildings, stock) };
}

/**
 * sim-ecs types entity removal on `IMutableWorld` and on the concrete
 * `RuntimeWorld` class, but `IRuntimeWorld` — the type GameEngine and every
 * fixture hold a world by — extends only `IImmutableWorld`. The runtime world
 * genuinely implements both, so this narrows to what the object already is
 * rather than granting it anything. Declared once here, not at the call site.
 */
type MutableEntities = { removeEntity(entity: Readonly<IEntity>): void };

/**
 * Take one entity out of the world, tolerating sim-ecs 0.6.4's own bug and
 * nothing else.
 *
 * Its runtime `removeEntity` deletes the entity and updates every query, and
 * only THEN unhooks the entity's event listeners — which throws a TypeError
 * for any entity that entered the world at prep time, because `prepareRun`
 * copies the preptime entity set into the runtime world without going through
 * `addEntity` and so never records listeners for it. The removal has already
 * happened by the time it throws, so the throw is noise; but that is a claim
 * with a postcondition, and the postcondition is checked. Anything that leaves
 * the entity still in the world is a real failure and is re-thrown, rather
 * than swallowed the way the sync point used to swallow this one (OBS-6-02).
 */
function detach(world: IRuntimeWorld, entity: Readonly<IEntity>): void {
  try {
    (world as IRuntimeWorld & MutableEntities).removeEntity(entity);
  } catch (err) {
    if (world.hasEntity(entity)) throw err;
  }
}

/**
 * Apply the removals this tick recorded, now that `world.step()` has resolved
 * and every system has had its last look at the entities. Returns how many
 * were removed.
 *
 * That count is the refresh signal: removal consumes no id, so the id-counter
 * delta the post-step `refreshEntitySections` gate is built on cannot see one.
 * Both drivers of a tick — `GameEngine.runStep` and `tests/engine/fixtures.ts`'s
 * `stepTick` — call this immediately after `step()` and before the gate, and
 * they MUST keep doing the same thing: a tick driven any other way removes
 * nobody at all.
 *
 * Both also call it AGAIN before the step, which is a no-op on every tick that
 * did not inherit a re-queued entry (below) and is the whole defence when one
 * did. The post-step call cannot simply move to the top instead: OBS-6-02 put
 * it after the step so that a death lands before the same tick's
 * `refreshEntitySections` and autosave, and a tick that publishes or persists
 * somebody it has already killed is the defect that motivated the ledger.
 *
 * One removal per call, deliberately. Batching them through sim-ecs's command
 * queue is what froze the simulation for a tick per extra corpse — see
 * RemovalLedger.
 *
 * The re-queue below covers `detach`'s re-throw arm, which as far as anyone
 * knows is UNREACHABLE against sim-ecs 0.6.4: its bug deletes the entity and
 * only then throws, so `hasEntity` is false and the throw is swallowed. This
 * is a defensive path made correct, not a live player-facing bug fixed. The
 * arm exists to fire if a sim-ecs upgrade changes that — the thing OBS-6-02's
 * note names as the item to re-check on upgrade — and on the day it does fire,
 * losing the queue silently is the wrong way to find out.
 */
export function applyRemovals(world: IRuntimeWorld): number {
  const ledger = world.getResource(RemovalLedger);
  const removed = ledger.drain();
  for (let i = 0; i < removed.length; i++) {
    try {
      detach(world, removed[i]);
    } catch (err) {
      // `drain()` already emptied the ledger, so without this the entry that
      // threw and every entry after it are gone for good — and the player can
      // resume straight past the error, because GameEngine.start() clears it.
      // A demolition whose command was already consumed would leave a
      // refunded, cleared building standing with nothing left to remove it.
      //
      // This is an UNBOUNDED retry: an entry that fails permanently is
      // re-attempted every tick, forever. It is tolerable only because
      // `GameEngine.runStep` catches and PAUSES rather than continuing to
      // tick, so "forever" costs one attempt per deliberate resume. That is a
      // load-bearing assumption about a DIFFERENT file: if runStep ever keeps
      // ticking through this, the retry becomes a per-tick throw.
      //
      // And because the ledger is FIFO and the re-queue goes to the front, a
      // permanently stuck entry does not just retry forever — it blocks every
      // entry behind it forever too, including ones queued long after it by
      // something unrelated. That is deliberate: the entries are ordered, the
      // loop this catch sits in is the only thing that applies them, and
      // skipping past a failure to keep the queue moving would mean deciding
      // an uncharacterised sim-ecs failure is safe to ignore for THIS entry —
      // the guess the paragraph below rejects. Stated here because it is
      // invisible from the code.
      //
      // Bounding it was considered and rejected. Every bound ends in either
      // dropping the entry — which is exactly the harm above, only silent — or
      // throwing forever anyway, which is this without the chance to recover.
      // The arm that reaches here exists for a sim-ecs change nobody has
      // characterised, so a policy that discards state on it would be guessing.
      ledger.requeue(removed.slice(i));
      throw err;
    }
  }
  return removed.length;
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

export async function createColonyWorld(save?: SaveGameV6): Promise<IRuntimeWorld> {
  return buildColonyPrepWorld({ save }).prepareRun({ executionFunction: runSynchronously });
}
