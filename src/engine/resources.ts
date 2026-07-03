import type { CostMap, ResourceId } from '../shared/content-types';
import type { Command } from '../shared/commands';
import type { Snapshot } from '../shared/snapshot';
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

  add(id: ResourceId, amount: number): void {
    this.amounts.set(id, this.get(id) + amount);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + amount);
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

export class CommandQueue {
  pending: Command[] = [];

  drain(): Command[] {
    const commands = this.pending;
    this.pending = [];
    return commands;
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
  private next = 1;

  take(): number {
    return this.next++;
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
