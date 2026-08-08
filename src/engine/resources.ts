import type { BuildingDefId, CostMap, ResourceId } from '../shared/content-types';
import type { Command } from '../shared/commands';
import type { NoticeMessage, Snapshot } from '../shared/snapshot';
import type { TileRef, WorldMapSize } from '../shared/placement';
import { MAX_SAVED_COUNTER } from '../shared/save';
import { BALANCE } from './content/balance';
import type { Home } from './components';

export class Stockpile {
  private readonly amounts = new Map<ResourceId, number>();
  readonly producedThisTick = new Map<ResourceId, number>();
  readonly consumedThisTick = new Map<ResourceId, number>();

  constructor(initial: Partial<Record<ResourceId, number>> = {}) {
    for (const [id, amount] of Object.entries(initial)) {
      this.amounts.set(id as ResourceId, amount);
    }
  }

  get(id: ResourceId): number {
    return this.amounts.get(id) ?? 0;
  }

  /**
   * Saturates at MAX_SAVED_COUNTER (like IdCounter): banking onto a stock
   * sitting at the save-format ceiling must not write an amount the load
   * guard would reject on the next reopen. Organically unreachable (~9e15).
   * Shared by `add` and `refund` — the two differ only in whether the bank
   * counts as a delivery, never in how the amount is clamped.
   */
  private bank(id: ResourceId, amount: number): number {
    const banked = Math.min(amount, MAX_SAVED_COUNTER - this.get(id));
    this.amounts.set(id, this.get(id) + banked);
    return banked;
  }

  /**
   * Banks resources a hauler actually carried in, recording into
   * `producedThisTick` — stats record only what was actually banked, never
   * the pre-saturation amount.
   */
  add(id: ResourceId, amount: number): void {
    const banked = this.bank(id, amount);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + banked);
  }

  /**
   * Banks resources without recording a delivery. `producedThisTick` is what
   * `StatsSystem` publishes as `deliveredRate`, so anything banked that a
   * hauler did not carry — a demolition's construction-cost refund, for
   * instance — must go through here rather than through `add`, or it
   * inflates the Economy view's Delivered/t for a resource nobody hauled.
   */
  refund(id: ResourceId, amount: number): void {
    this.bank(id, amount);
  }

  canAfford(cost: CostMap): boolean {
    return Object.entries(cost).every(([id, amount]) => this.get(id as ResourceId) >= amount);
  }

  /** All-or-nothing across the whole cost map. Returns success. */
  pay(cost: CostMap): boolean {
    if (!this.canAfford(cost)) return false;
    for (const [id, amount] of Object.entries(cost)) this.remove(id as ResourceId, amount);
    return true;
  }

  /** Take a quantity of one resource if fully available. Returns success. */
  take(id: ResourceId, amount: number): boolean {
    if (this.get(id) < amount) return false;
    this.remove(id, amount);
    return true;
  }

  resetTickFlows(): void {
    this.producedThisTick.clear();
    this.consumedThisTick.clear();
  }

  toJSON(): Partial<Record<ResourceId, number>> {
    return Object.fromEntries(this.amounts) as Partial<Record<ResourceId, number>>;
  }

  private remove(id: ResourceId, amount: number): void {
    this.amounts.set(id, this.get(id) - amount);
    this.consumedThisTick.set(id, (this.consumedThisTick.get(id) ?? 0) + amount);
  }
}

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
 * Entity removal consumes no id, so the id-counter delta that gates
 * GameEngine's post-step snapshot refresh cannot see it (the "INVARIANT for
 * increment 2" reserved in game-engine.ts). The demolish handler raises this
 * flag instead; runStep reads-and-clears it beside the id check.
 */
export class RemovalLedger {
  dirty = false;
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
 * `constructed` is the mirror image: a house built this tick is absent from
 * PopulationSystem's `buildings` query for the rest of the tick, so without
 * it rehome would leave that house's future residents homeless for the tick
 * it was built on — resolving itself the tick after, but persisting
 * indefinitely if the game is paused right after building.
 *
 * `arrivals` is unused until Task 8 introduces births and nomads; it is
 * declared here so the three halves cannot drift apart, and so `clear()` has
 * one definition rather than growing a fourth field later.
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
   * Buildings constructed this tick. Absent from every query until the sync,
   * the mirror image of `demolished` — and the reason homing must be told
   * about them: a house built this tick would otherwise shelter nobody until
   * the next one, publishing free beds beside homeless colonists.
   */
  readonly constructed: { id: number; defId: BuildingDefId; col: number; row: number }[] = [];

  /**
   * Where a building constructed earlier THIS tick stands, or null if no
   * pending construction has that id.
   *
   * Every reader that resolves a building id to a tile needs this, not just
   * homing. `rehome` seats a colonist in a house built this tick; if
   * `ProductionSystem` and `HaulSystem` then resolve that `homeId` against
   * their own pre-sync queries alone, they find nothing and charge the
   * colonist `homelessFactor` on the very tick they were housed — while the
   * post-sync `refreshEntitySections` publishes them as housed. One method,
   * so the three readers cannot drift apart on what "pending" means.
   */
  tileOf(id: number): TileRef | null {
    const built = this.constructed.find((b) => b.id === id);
    return built === undefined ? null : { col: built.col, row: built.row };
  }

  // Called through an interface-typed value (PopulationContext.pending,
  // CommandContext.pending), which fallow's static analysis cannot trace
  // back to this class.
  // fallow-ignore-next-line unused-class-member
  clear(): void {
    this.arrivals.length = 0;
    this.demolished.clear();
    this.constructed.length = 0;
  }
}
