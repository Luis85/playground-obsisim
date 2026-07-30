import type { CostMap, ResourceId } from '../shared/content-types';
import type { Command } from '../shared/commands';
import type { Snapshot } from '../shared/snapshot';
import { MAX_SAVED_COUNTER } from '../shared/save';
import { BALANCE } from './content/balance';

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
   * Saturates at MAX_SAVED_COUNTER (like IdCounter): production onto a stock
   * sitting at the save-format ceiling must not write an amount the load
   * guard would reject on the next reopen. Organically unreachable (~9e15),
   * and stats record only what was actually banked.
   */
  add(id: ResourceId, amount: number): void {
    const banked = Math.min(amount, MAX_SAVED_COUNTER - this.get(id));
    this.amounts.set(id, this.get(id) + banked);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + banked);
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

export class SimClock {
  tick = 0;
  lastRecruitTick = -BALANCE.recruitCooldownTicks; // first recruit available immediately
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
  // copy the pattern they see (PR #3 review, Codex P2). Enqueue only through
  // push(); read the depth through `size`.
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
  private notices: string[] = [];

  push(message: string): void {
    this.notices.push(message);
  }

  takeAll(): string[] {
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
}

export class StatsHistory {
  private readonly frames: StatsFrame[] = [];

  record(produced: ReadonlyMap<ResourceId, number>, consumed: ReadonlyMap<ResourceId, number>): void {
    this.frames.push({ produced: new Map(produced), consumed: new Map(consumed) });
    if (this.frames.length > BALANCE.statsWindowTicks) this.frames.shift();
  }

  rates(id: ResourceId): { production: number; consumption: number } {
    if (this.frames.length === 0) return { production: 0, consumption: 0 };
    let produced = 0;
    let consumed = 0;
    for (const frame of this.frames) {
      produced += frame.produced.get(id) ?? 0;
      consumed += frame.consumed.get(id) ?? 0;
    }
    return { production: produced / this.frames.length, consumption: consumed / this.frames.length };
  }
}

export class SnapshotStore {
  latest: Snapshot | null = null;
}
