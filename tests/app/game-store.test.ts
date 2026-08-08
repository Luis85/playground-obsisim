import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus } from '../../src/shared/snapshot';
import { makeSnapshot, stockedWith, makeBuilding, makeWorker } from './fixtures';

// wheat is edible ONLY in this mock: the hardcoded getter ignores it (test
// fails), the catalog-driven getter counts it (test passes). Without this the
// switch to ResourceDef.edible is untested and can silently regress. bread and
// berries keep their real edible:true, so the ordinary-path test below is
// unaffected by this file-wide mock.
vi.mock('../../src/engine/content/resources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/content/resources')>();
  return {
    ...actual,
    RESOURCES: { ...actual.RESOURCES, wheat: { ...actual.RESOURCES.wheat, edible: true } },
  };
});

const status: EngineStatus = { paused: true, speed: 1, error: null };

describe('useGameStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('ingests snapshot and status', () => {
    const store = useGameStore();
    // A single ingest with no prior snapshot is always "new" by definition,
    // so this also exercises the isNewSnapshot happy path on its own.
    store.ingest(makeSnapshot({ tick: 5 }), { paused: false, speed: 2, error: null });
    expect(store.snapshot!.tick).toBe(5);
    expect(store.paused).toBe(false);
    expect(store.speed).toBe(2);
  });

  it('collects notices newest-first, capped at 5', () => {
    const store = useGameStore();
    for (let tick = 1; tick <= 7; tick++) {
      store.ingest(makeSnapshot({ tick, notices: [{ kind: 'rejection', message: `n${tick}` }] }), status);
    }
    expect(store.recentNotices).toHaveLength(5);
    expect(store.recentNotices[0]).toEqual({ id: 7, tick: 7, kind: 'rejection', message: 'n7' });
  });

  it('re-ingesting the same snapshot object does not re-append notices, but a new one does', () => {
    const store = useGameStore();
    const snapshot = makeSnapshot({ tick: 1, notices: [{ kind: 'success', message: 'Built a Forester.' }] });
    store.ingest(snapshot, status);
    expect(store.recentNotices).toHaveLength(1);
    // publish() re-sends the CURRENT snapshot on pause/play/speed changes;
    // the object identity is unchanged, so no new notices should append.
    store.ingest(snapshot, { paused: false, speed: 2, error: null });
    expect(store.recentNotices).toHaveLength(1);
    expect(store.paused).toBe(false);
    // a genuinely new snapshot object still appends its own notices
    store.ingest(makeSnapshot({ tick: 2, notices: [{ kind: 'success', message: 'second' }] }), status);
    expect(store.recentNotices).toHaveLength(2);
    expect(store.recentNotices[0].message).toBe('second');
  });

  it('a snapshot carrying two identical notices yields two entries with distinct ids', () => {
    const store = useGameStore();
    const twice = 'Assigned a worker to Forester.';
    store.ingest(makeSnapshot({
      tick: 1,
      notices: [{ kind: 'success', message: twice }, { kind: 'success', message: twice }],
    }), status);
    expect(store.recentNotices).toHaveLength(2);
    const ids = store.recentNotices.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });

  // Bread-only stays covered (the ordinary path); wheat only clears the
  // shortage under the file-wide mock above, which is what proves lowFood
  // sums whatever the catalog marks edible rather than a hardcoded pair.
  it('lowFood counts every catalog-marked-edible resource, not a hardcoded pair', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ population: 3, stockpile: stockedWith({ bread: 2 }) }), status);
    expect(store.lowFood).toBe(true); // 2 < 6
    store.ingest(makeSnapshot({ population: 3, stockpile: stockedWith({ bread: 10 }) }), status);
    expect(store.lowFood).toBe(false);
    store.ingest(makeSnapshot({ population: 3, stockpile: stockedWith({ wheat: 10 }) }), status);
    expect(store.lowFood).toBe(false); // 10 wheat covers 3 workers once wheat is edible
    // Two edible resources stocked at once: neither alone covers population 3
    // (4 < 6), but their sum does (8 >= 6), pinning the getter to a sum
    // across every edible resource rather than the max of any single one.
    store.ingest(makeSnapshot({ population: 3, stockpile: stockedWith({ bread: 4, berries: 4 }) }), status);
    expect(store.lowFood).toBe(false);
  });

  // Pins the `edible` filter itself: a reducer that summed every resource
  // regardless of ResourceDef.edible would also pass every case above (none
  // of them stock a non-edible resource), so this is the one case that
  // distinguishes "sum of edible stock" from "sum of all stock". wood is not
  // edible in the real catalog (unaffected by this file's wheat mock above).
  it('lowFood ignores non-edible resources no matter how much is stocked', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ population: 3, stockpile: stockedWith({ wood: 100 }) }), status);
    expect(store.lowFood).toBe(true); // 0 edible < 6
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
    snapshot.stockpile.wheat = { stock: 10, deliveredRate: 0, madeRate: 0, consumptionRate: 0.5, netFlow: -0.5, stockValue: 0 };
    snapshot.stockpile.bread = { stock: 4, deliveredRate: 1, madeRate: 0, consumptionRate: 0.5, netFlow: 0.5, stockValue: 0 };
    snapshot.stockpile.wood = { stock: 0, deliveredRate: 0, madeRate: 0, consumptionRate: 1, netFlow: -1, stockValue: 0 };
    store.ingest(snapshot, status);
    expect(store.runways.wheat).toBe(20); // 10 / 0.5
    expect(store.runways.bread).toBeUndefined(); // growing, no runway
    expect(store.runways.wood).toBe(0); // already empty and still draining
    expect(store.runways.berries).toBeUndefined(); // idle resource
  });

  it('staffingByDef aggregates totals, staffing, and starvation per def', () => {
    const store = useGameStore();
    const base = {
      col: 0, row: 0, workers: 0, workerSlots: 2, progress: 0, batchActive: false,
      progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0, relocatingTicks: 0, beds: 0, occupants: 0,
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

  it('affordableDefs reflects the stockpile per def', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ stockpile: stockedWith({ wood: 10 }) }), { paused: true, speed: 1, error: null });
    expect(store.affordableDefs.forester).toBe(true);  // costs 10 wood
    expect(store.affordableDefs.farm).toBe(false);     // costs 20 wood
    expect(store.affordableDefs.workshop).toBe(false); // costs 20 planks
  });

  it('affordableDefs is all-false before the first snapshot', () => {
    expect(useGameStore().affordableDefs.forester).toBe(false);
  });

  it('counts haulers, waiting units, and stalled buildings', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 12, state: 'outputFull' }),
        makeBuilding(2, { buffered: 3, state: 'producing' }),
        makeBuilding(3, { buffered: 0, state: 'unstaffed' }),
      ],
      colonists: [makeWorker(1, { hauling: true }), makeWorker(2, { hauling: true }), makeWorker(3, {})],
    }), { paused: false, speed: 1, error: null });
    expect(store.haulerCount).toBe(2);
    expect(store.unitsWaiting).toBe(15);
    expect(store.stalledBuildings).toBe(1);
  });

  it('reports zeroes before the first snapshot', () => {
    const store = useGameStore();
    expect(store.haulerCount).toBe(0);
    expect(store.unitsWaiting).toBe(0);
    expect(store.stalledBuildings).toBe(0);
  });
});
