import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus } from '../../src/shared/snapshot';
import { makeSnapshot } from './fixtures';

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

  it('defaults lowFood and recruitCooldownRemaining before the first snapshot arrives', () => {
    // App.vue renders a loading state while store.snapshot is still null (pre-first-tick);
    // both getters must degrade safely rather than throw on the missing snapshot.
    const store = useGameStore();
    expect(store.snapshot).toBeNull();
    expect(store.lowFood).toBe(false);
    expect(store.recruitCooldownRemaining).toBe(0);
  });

  it('runways: ticks until a draining resource empties, absent otherwise', () => {
    const store = useGameStore();
    const snapshot = makeSnapshot();
    snapshot.stockpile.wheat = { stock: 10, productionRate: 0, consumptionRate: 0.5, netFlow: -0.5, stockValue: 0 };
    snapshot.stockpile.bread = { stock: 4, productionRate: 1, consumptionRate: 0.5, netFlow: 0.5, stockValue: 0 };
    snapshot.stockpile.wood = { stock: 0, productionRate: 0, consumptionRate: 1, netFlow: -1, stockValue: 0 };
    store.ingest(snapshot, status);
    expect(store.runways.wheat).toBe(20); // 10 / 0.5
    expect(store.runways.bread).toBeUndefined(); // growing, no runway
    expect(store.runways.wood).toBe(0); // already empty and still draining
    expect(store.runways.berries).toBeUndefined(); // idle resource
  });

  it('staffingByDef aggregates totals, staffing, and starvation per def', () => {
    const store = useGameStore();
    const base = {
      workers: 0, workerSlots: 2, progress: 0, batchActive: false,
      progressPct: 0, tooledWorkers: 0, workPower: 0,
    };
    store.ingest(makeSnapshot({
      buildings: [
        { ...base, id: 1, defId: 'mill', workers: 2, state: 'waitingForInput' },
        { ...base, id: 2, defId: 'mill', workers: 1, state: 'producing' },
        { ...base, id: 3, defId: 'farm', workers: 0, state: 'unstaffed' },
      ],
    }), status);
    expect(store.staffingByDef.mill).toEqual({ total: 2, staffed: 2, starved: 1 });
    expect(store.staffingByDef.farm).toEqual({ total: 1, staffed: 0, starved: 0 });
    expect(store.staffingByDef.bakery).toBeUndefined();
  });

  it('runways and staffingByDef degrade safely before the first snapshot', () => {
    const store = useGameStore();
    expect(store.runways).toEqual({});
    expect(store.staffingByDef).toEqual({});
  });
});
