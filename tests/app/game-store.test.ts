import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus } from '../../src/shared/snapshot';
import { makeSnapshot, stockedWith } from './fixtures';

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
  });

  // recruitCooldownRemaining is unrelated to this task, but it shares the
  // getters block with lowFood, so a quick regression check here is cheap
  // insurance against an unintended edit to the surrounding code.
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
});
