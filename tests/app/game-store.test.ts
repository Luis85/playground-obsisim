import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus, ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import type { ResourceId } from '../../src/shared/content-types';

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const stockpile = Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: 0, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
  return {
    tick: 0, lastRecruitTick: -30, stockpile, colonyWealth: 0,
    population: 0, idleWorkers: 0, buildings: [], workers: [], notices: [],
    ...overrides,
  };
}

const status: EngineStatus = { paused: true, speed: 1, error: null };

describe('useGameStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('ingests snapshot and status', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ tick: 5 }), { paused: false, speed: 2, error: null });
    expect(store.snapshot!.tick).toBe(5);
    expect(store.paused).toBe(false);
    expect(store.speed).toBe(2);
  });

  it('collects notices newest-first, capped at 5', () => {
    const store = useGameStore();
    for (let tick = 1; tick <= 7; tick++) {
      store.ingest(makeSnapshot({ tick, notices: [`n${tick}`] }), status);
    }
    expect(store.recentNotices).toHaveLength(5);
    expect(store.recentNotices[0]).toEqual({ tick: 7, message: 'n7' });
  });

  it('lowFood getter flags scarce edible stock', () => {
    const store = useGameStore();
    const snapshot = makeSnapshot({ population: 3 });
    snapshot.stockpile.bread.stock = 2;
    snapshot.stockpile.berries.stock = 3;
    store.ingest(snapshot, status);
    expect(store.lowFood).toBe(true); // 5 < 6
    snapshot.stockpile.berries.stock = 10;
    store.ingest({ ...snapshot }, status);
    expect(store.lowFood).toBe(false);
  });

  it('computes recruit cooldown remaining', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ tick: 10, lastRecruitTick: 0 }), status);
    expect(store.recruitCooldownRemaining).toBe(20);
    store.ingest(makeSnapshot({ tick: 40, lastRecruitTick: 0 }), status);
    expect(store.recruitCooldownRemaining).toBe(0);
  });
});
