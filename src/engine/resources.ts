import type { IEntity } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../shared/content-types';
import type { Command } from '../shared/commands';
import type { NoticeMessage, Snapshot } from '../shared/snapshot';
import type { WorldMapSize } from '../shared/placement';
import { MAX_SAVED_COUNTER } from '../shared/save';
import { BALANCE } from './content/balance';
import type { Home } from './components';

export { Stockpile } from './stockpile';

/**
 * Units banked into output buffers this tick — gross production, as opposed to
 * the Stockpile's `producedThisTick`, which since increment 4 records only what
 * a hauler actually delivered. Kept apart from Stockpile because they are
 * genuinely different quantities: the gap between them IS the haul backlog.
 */
export class ProductionLedger {
  readonly madeThisTick = new Map<ResourceId, number>();

  add(id: ResourceId, amount: number): void {
    this.madeThisTick.set(id, (this.madeThisTick.get(id) ?? 0) + amount);
  }

  reset(): void {
    this.madeThisTick.clear();
  }
}

export class SimClock {
  tick = 0;
  lastRecruitTick = -BALANCE.recruitCooldownTicks; // first recruit available immediately
  /** Tick of the last birth. Persisted (Task 9) for the reason lastRecruitTick
   * is: without it, reopening a save written just after a birth either grants
   * a free extra birth or blocks one that is due, so save-and-reload would
   * change population growth. Starts a full cooldown in the past, so a fresh
   * colony's first birth is gated on food and beds rather than on patience.
   *
   * Save v5 persists it (buildSaveFromWorld reads it directly off the
   * resource), which is what retired the suppression this used to need: the
   * in-tick readers all reach it through an interface-typed value that
   * fallow's static analysis cannot trace back here. */
  lastBirthTick = -BALANCE.birthCooldownTicks;
}

/**
 * Dispatches are accepted between ticks, and while paused nothing drains
 * them: a stuck-enabled button (or a held key) would otherwise grow this
 * array without limit. Far above any human click rate for one pause.
 */
export const MAX_PENDING_COMMANDS = 256;

export class CommandQueue {
  // PRIVATE, deliberately: while this array was public, every producer used
  // `queue.pending.push(...)` (GameEngine.dispatch plus three test helpers)
  // and the cap below would have been decorative — new call sites naturally
  // copy the pattern they see. Enqueue only through push(); read the depth
  // through `size`.
  private pending: Command[] = [];
  private dropped = 0;

  /** Enqueue unless full; overflow is counted, not thrown, so the UI never crashes. */
  push(command: Command): void {
    if (this.pending.length >= MAX_PENDING_COMMANDS) {
      this.dropped++;
      return;
    }
    this.pending.push(command);
  }

  /** Queue depth — what flush() needs, without handing out the array. */
  get size(): number {
    return this.pending.length;
  }

  drain(): Command[] {
    const commands = this.pending;
    this.pending = [];
    return commands;
  }

  /** Number of commands refused since the last call (reset on read). */
  takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }
}

export class NoticeBoard {
  private notices: NoticeMessage[] = [];

  succeed(message: string): void {
    this.notices.push({ kind: 'success', message });
  }

  reject(message: string): void {
    this.notices.push({ kind: 'rejection', message });
  }

  takeAll(): NoticeMessage[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }
}

export class IdCounter {
  private next: number;

  constructor(start = 1) {
    this.next = start;
  }

  take(): number {
    return this.next++;
  }

  /** Next id that would be handed out, without consuming it. Used for serialization. */
  peek(): number {
    return this.next;
  }

  /**
   * True when handing out another id would push peek() past MAX_SAVED_COUNTER,
   * i.e. the serialized save would no longer pass the load guard. Command
   * handlers MUST check this before take(): saturating here (organically
   * unreachable — it needs ~9e15 entities) is what lets the guard promise that
   * every save the engine writes from a loadable state is itself loadable.
   */
  exhausted(): boolean {
    return this.next >= MAX_SAVED_COUNTER;
  }
}

interface StatsFrame {
  produced: ReadonlyMap<ResourceId, number>;
  consumed: ReadonlyMap<ResourceId, number>;
  made: ReadonlyMap<ResourceId, number>;
}

export class StatsHistory {
  private readonly frames: StatsFrame[] = [];

  record(
    produced: ReadonlyMap<ResourceId, number>,
    consumed: ReadonlyMap<ResourceId, number>,
    made: ReadonlyMap<ResourceId, number>,
  ): void {
    this.frames.push({ produced: new Map(produced), consumed: new Map(consumed), made: new Map(made) });
    if (this.frames.length > BALANCE.statsWindowTicks) this.frames.shift();
  }

  /**
   * `delivered` is store inflow (what `produced` has meant since increment 4);
   * `made` is what buildings banked into their own buffers. Named for what they
   * measure — the old `production` described neither once haulers existed.
   */
  rates(id: ResourceId): { delivered: number; consumed: number; made: number } {
    if (this.frames.length === 0) return { delivered: 0, consumed: 0, made: 0 };
    let delivered = 0;
    let consumed = 0;
    let made = 0;
    for (const frame of this.frames) {
      delivered += frame.produced.get(id) ?? 0;
      consumed += frame.consumed.get(id) ?? 0;
      made += frame.made.get(id) ?? 0;
    }
    const n = this.frames.length;
    return { delivered: delivered / n, consumed: consumed / n, made: made / n };
  }
}

export class SnapshotStore {
  latest: Snapshot | null = null;
}

/** The colony's world dimensions, restored from the save (v2). */
export class WorldMap implements WorldMapSize {
  constructor(public cols: number, public rows: number) {}
}

/**
 * Everything this tick killed or demolished, held until the post-step drain.
 *
 * NOT `actions.commands.removeEntity`, which is where these used to go, and
 * OBS-6-02 is why. sim-ecs 0.6.4's runtime removal deletes the entity and
 * updates every query FIRST and unhooks the entity's event listeners LAST —
 * and an entity that entered the world at prep time has no listener record to
 * unhook, because `prepareRun` copies the preptime entity set straight into
 * the runtime world without going through `addEntity`. That last step throws,
 * the scheduler's sync point swallows the error, and every command still
 * queued behind the throw is left for a later `step()` — one per step, each of
 * them running no systems at all. Two colonists dying together therefore froze
 * the whole colony for a tick, while `SimClock` advanced across it.
 *
 * What is deferred is the removal, NOT its invisibility: an entity on this
 * ledger is still in every query for the rest of the tick, exactly as a queued
 * command was. `standDown` and `PendingChanges.demolished` are what compensate
 * for that, and they still have to.
 *
 * The ledger also answers the question a `dirty` flag used to: entity removal
 * consumes no id, so the id-counter delta that gates the post-step snapshot
 * refresh cannot see it (the "INVARIANT from increment 2" in game-engine.ts).
 * A drain that returned entities IS that signal, so there is no second thing
 * for a remover to remember to raise — the invariant now rides on the removal
 * itself.
 */
export class RemovalLedger {
  private readonly pending: Readonly<IEntity>[] = [];

  /** Take this entity out of the world at the end of the tick. */
  remove(entity: Readonly<IEntity>): void {
    this.pending.push(entity);
  }

  /**
   * Everything queued, in the order it was queued; empties the ledger.
   *
   * In production this is called only from `applyRemovals`, through
   * `world.getResource(RemovalLedger)` — a generic lookup fallow's static
   * analysis cannot trace back to this class, the same blind spot
   * PendingChanges.clear() carries — so it used to need a
   * `fallow-ignore-next-line unused-class-member`. The teardown guard
   * (tests/support/removal-guard.ts) now calls it on a directly-typed
   * receiver, which fallow CAN trace, and the suppression became stale.
   * If that call ever goes away the suppression has to come back; the quality
   * ratchet reports it either way, as an unused member or a stale suppression.
   */
  drain(): Readonly<IEntity>[] {
    return this.pending.splice(0, this.pending.length);
  }

  /**
   * Put drained entries back, at the FRONT: they were queued before anything
   * that reached the ledger since, so the front is where they belong.
   *
   * `drain` empties the ledger before `applyRemovals` starts detaching, which
   * means a throw part-way through would otherwise lose the entry that failed
   * AND every entry it never reached. This is how they survive. Same generic
   * `world.getResource` lookup as `drain`, so the same blind spot.
   */
  // fallow-ignore-next-line unused-class-member
  requeue(entities: readonly Readonly<IEntity>[]): void {
    this.pending.unshift(...entities);
  }

  /**
   * Queue depth, for exactly the reason `CommandQueue.size` exists: `flush()`
   * has to know whether there is unfinished business without being handed the
   * array (handing it out is how a caller ends up draining it by accident).
   *
   * Non-zero only between a `requeue` and the retry that clears it — see
   * `applyRemovals`. Same generic `world.getResource` lookup as `requeue`, so
   * the same fallow blind spot.
   */
  // fallow-ignore-next-line unused-class-member
  get size(): number {
    return this.pending.length;
  }
}

/**
 * Entity changes made this tick that no query can see yet. sim-ecs syncs
 * creations and removals only after every system has run, so within one tick a
 * spawned colonist is invisible, a newly constructed building is invisible,
 * and a demolished building is still present. All three are the same
 * question, so they share one answer and one clear point — the same hazard,
 * and the same remedy, as CommandContext.claimedTiles.
 *
 * `demolished` is what makes handleDemolishBuilding's eviction stick: it nulls
 * its residents' homes, but the house stays in PopulationSystem's shelters
 * query for the rest of the tick, so rehome would put those same colonists
 * straight back into a building that no longer exists.
 *
 * `constructed` is the mirror image: a building ordered this tick is absent
 * from every query for the rest of the tick. Through increment 9 that made it
 * load-bearing for the order-time affordability check (`outstandingMaterials`,
 * once in placement-handlers.ts), which needed it to see a site a command
 * earlier in this same drain had just queued. Increment 10 §2.1 deletes that
 * check outright — ordering is a request now, so nothing at order time reads
 * the colony's outstanding queue, and `constructed` currently has no reader.
 * Every OTHER system's "does not fold in `constructed`" comment
 * (population-system.ts, haul-sites.ts, haul-system.ts, command-system.ts)
 * predates this and records a SEPARATE decision — those systems were never
 * going to treat a same-tick site as live regardless of what read this list —
 * so the field stays rather than being pulled out from under them.
 *
 * `arrivals` is the third of the same shape, and since Task 8 it carries real
 * traffic: `spawnArrival` pushes every nomad and every newborn onto it, and
 * `spareBeds`, `shelterWithRoom`, `freeBeds`, `reseatArrivalsOf` and both
 * arrival gates (nomad and birth) read it. The three live together so they
 * cannot drift apart, and so `clear()` has one definition rather than a fourth
 * field added later.
 */
export class PendingChanges {
  /**
   * One entry per colonist spawned this tick, holding its LIVE `Home`
   * component — not a copied id.
   *
   * The component, because this tick may still need to change it. If
   * `recruitWorker` is queued before `demolishBuilding`, the nomad has already
   * spawned with a `homeId` pointing at that house, and
   * `handleDemolishBuilding` cannot reach it: its loop walks `ctx.workers`,
   * whose query will not see the new entity until the post-step sync. The
   * nomad would keep a reference to a building that no longer exists, the
   * autosave at the end of the tick would serialize it, and the v5 load guard
   * — which requires every `homeId` to name a real shelter — would send that
   * save down the corrupt-backup path. Holding the component lets the
   * demolition null it in place.
   *
   * `ageTicks` rides along because `tryBirth` counts arrivals toward the
   * POPULATION it must feed and toward the ADULTS who may parent, and those
   * two answers differ: a nomad is both, a child born this tick is only the
   * first. Deriving the second from `arrivals.length` — as this ledger's first
   * version forced — is only correct while every arrival visible at that read
   * happens to be an adult. That was true, but by accident of ordering rather
   * than by anything stated: `tryBirth` is the only pusher of non-adults and
   * it reads the ledger before its own push. Carrying the age states the fact
   * instead of relying on the schedule to keep it true.
   */
  readonly arrivals: { home: Home; ageTicks: number }[] = [];
  /** Buildings demolished this tick. Still in every query until the sync. */
  readonly demolished = new Set<number>();
  /**
   * Construction SITES ordered this tick. Absent from every query until the
   * sync, the mirror image of `demolished`.
   *
   * From §2.5 through increment 9 its one reader was `outstandingMaterials`
   * (placement-handlers.ts), which charged each entry its WHOLE cost against
   * the next order's affordability check — `defId` and `id` because that
   * check needed the def and a site to key its shortfall on, `col`/`row`
   * because homing once read the tile before a site stopped being a shelter.
   * Increment 10 §2.1 deletes that check, so nothing currently reads this
   * list — see the class doc above for why it stays rather than coming out
   * with its one reader.
   */
  readonly constructed: { id: number; defId: BuildingDefId; col: number; row: number }[] = [];

  // Called through an interface-typed value (PopulationContext.pending,
  // CommandContext.pending), which fallow's static analysis cannot trace
  // back to this class.
  //
  // Every field, `constructed` included even though nothing reads it any
  // more (see its own doc above): a list that survived its tick would just
  // grow without bound, and clearing costs nothing to keep doing on the
  // off chance a future reader forgets this is a THIS-DRAIN-ONLY record.
  // fallow-ignore-next-line unused-class-member
  clear(): void {
    this.arrivals.length = 0;
    this.demolished.clear();
    this.constructed.length = 0;
  }
}
