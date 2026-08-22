import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot, makeWorker, stockedWith } from './fixtures';

function ingest(overrides = {}) {
  const store = useGameStore();
  store.ingest(makeSnapshot(overrides), { paused: false, speed: 1, error: null });
  return store;
}

describe('game-store attention', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('names a stalled building and selects it', () => {
    const store = ingest({ buildings: [makeBuilding(4, { defId: 'sawmill', state: 'outputFull' })] });
    const row = store.attention.find((r) => r.message.includes('nothing is collecting'));
    expect(row).toBeDefined();
    expect(row!.subject).toEqual({ kind: 'building', id: 4 });
  });

  it('names a building with nothing to work with', () => {
    const store = ingest({ buildings: [makeBuilding(5, { defId: 'bakery', state: 'waitingForInput' })] });
    const row = store.attention.find((r) => r.message.includes('nothing to work with'));
    expect(row).toBeDefined();
    expect(row!.subject).toEqual({ kind: 'building', id: 5 });
  });

  it('names a staffable building with nobody on it', () => {
    const store = ingest({ buildings: [makeBuilding(6, { workers: 0, workerSlots: 3, state: 'unstaffed' })] });
    const row = store.attention.find((r) => r.message.includes('no one working it'));
    expect(row).toBeDefined();
    expect(row!.subject).toEqual({ kind: 'building', id: 6 });
  });

  // A site keeps its def's workerSlots and has zero workers, but
  // handleAssignWorker refuses a site outright — so an unstaffed row here
  // would report a problem with no fix, beside the materials row that has one.
  it('does not call a construction site unstaffed', () => {
    const store = ingest({
      buildings: [makeBuilding(6, { workers: 0, workerSlots: 3, state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 5 } })],
    });
    expect(store.attention.some((r) => r.message.includes('no one working it'))).toBe(false);
    expect(store.attention.some((r) => r.message.includes('needs 5 Wood'))).toBe(true);
  });

  it('names what a site still needs', () => {
    const store = ingest({
      buildings: [makeBuilding(7, { state: 'underConstruction', constructionTicks: 20, constructionNeeds: { wood: 14 } })],
    });
    const row = store.attention.find((r) => r.message.includes('needs 14 Wood'));
    expect(row).toBeDefined();
    expect(row!.subject).toEqual({ kind: 'building', id: 7 });
  });

  it('names a runway at or under 30 ticks, and carries no subject', () => {
    const store = ingest({
      stockpile: { ...stockedWith({ bread: 60 }), bread: { stock: 60, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const row = store.attention.find((r) => r.message.includes('empties in'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);   // a resource has no subject on the map
    expect(row!.highlight).toEqual([]);
    // Pinned directly: this is the only 'danger' row beside starving, and the
    // sort-order test below only proves ordering when at least one row of
    // each severity actually exists — this is what supplies the danger one.
    expect(row!.severity).toBe('danger');
  });

  it('groups homeless colonists into one row that pulses them and selects nothing', () => {
    const store = ingest({
      homeless: 2,
      colonists: [makeWorker(1, { homeId: 4 }), makeWorker(2), makeWorker(3)],
    });
    const row = store.attention.find((r) => r.message.includes('no bed'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);
    expect(row!.highlight).toEqual([{ kind: 'colonist', id: 2 }, { kind: 'colonist', id: 3 }]);
    // M7 (whole-branch review): explicit against the PUBLISHED `homeless`
    // figure, not just the array literal above — `highlight` re-derives
    // `homeId === null` independently of that count (game-store.ts's own
    // comment on why), and this is what pins the two agreeing.
    expect(row!.highlight).toHaveLength(2);
  });

  it('names a single homeless colonist in the singular', () => {
    const store = ingest({
      homeless: 1,
      colonists: [makeWorker(1, { homeId: 4 }), makeWorker(2)],
    });
    const row = store.attention.find((r) => r.message.includes('no bed'));
    expect(row).toBeDefined();
    expect(row!.message).toBe('1 colonist has no bed');
    expect(row!.highlight).toEqual([{ kind: 'colonist', id: 2 }]);
  });

  it('names several starving colonists in the plural', () => {
    const store = ingest({
      colonists: [makeWorker(1, { starvingTicks: 3 }), makeWorker(2, { starvingTicks: 5 })],
    });
    const row = store.attention.find((r) => r.message.includes('starving'));
    expect(row).toBeDefined();
    expect(row!.severity).toBe('danger');
    expect(row!.subject).toBe(null);
    expect(row!.message).toBe('2 colonists are starving');
    expect(row!.highlight).toEqual([{ kind: 'colonist', id: 1 }, { kind: 'colonist', id: 2 }]);
  });

  it('names a single starving colonist in the singular', () => {
    const store = ingest({
      colonists: [makeWorker(1, { starvingTicks: 3 })],
    });
    const row = store.attention.find((r) => r.message.includes('starving'));
    expect(row).toBeDefined();
    expect(row!.message).toBe('1 colonist is starving');
    // M7 (whole-branch review): the row's message and its highlight set are
    // two independent derivations off the snapshot (see game-store.ts's own
    // comment on why) — nothing before this pinned that the singular case
    // agrees with the plural one above rather than, say, always highlighting
    // every starving colonist regardless of what the message claims.
    expect(row!.highlight).toHaveLength(1);
  });

  it('names several idle adults in the plural', () => {
    const store = ingest({
      idleAdults: 2,
      colonists: [
        makeWorker(1, { stage: 'adult', buildingId: null, hauling: false }),
        makeWorker(2, { stage: 'adult', buildingId: null, hauling: false }),
      ],
    });
    const row = store.attention.find((r) => r.message.includes('idle'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);
    expect(row!.message).toBe('2 adults are idle');
    expect(row!.highlight).toEqual([{ kind: 'colonist', id: 1 }, { kind: 'colonist', id: 2 }]);
    // M7: explicit against the PUBLISHED `idleAdults` figure — see the
    // homeless test above for why this is not merely restating the line
    // just above it.
    expect(row!.highlight).toHaveLength(2);
  });

  it('names a single idle adult in the singular', () => {
    const store = ingest({
      idleAdults: 1,
      colonists: [makeWorker(1, { stage: 'adult', buildingId: null, hauling: false })],
    });
    const row = store.attention.find((r) => r.message.includes('idle'));
    expect(row).toBeDefined();
    expect(row!.message).toBe('1 adult is idle');
    // M7 (whole-branch review): `idleAdults` in the message is the PUBLISHED
    // snapshot count; `highlight` re-derives the same "adult, unassigned,
    // not hauling" predicate independently (game-store.ts's own comment on
    // why, forced by criterion 12 keeping this file out of `src/engine`).
    // Nothing pinned the two figures agree until this line.
    expect(row!.highlight).toHaveLength(1);
  });

  it('is empty for a colony with nothing wrong', () => {
    const store = ingest({ buildings: [makeBuilding(1, { workers: 2, workerSlots: 2, state: 'producing' })] });
    expect(store.attention).toEqual([]);
  });

  it('gives every row a stable unique id', () => {
    const store = ingest({
      buildings: [
        makeBuilding(1, { state: 'outputFull' }),
        makeBuilding(2, { state: 'waitingForInput' }),
      ],
    });
    const ids = store.attention.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('counts starving colonists once, shared between the row and the raw count', () => {
    const store = ingest({
      colonists: [makeWorker(1, { starvingTicks: 3 }), makeWorker(2, { starvingTicks: 5 }), makeWorker(3)],
    });
    expect(store.starvingCount).toBe(2);
  });

  it('is zero when nobody is starving', () => {
    const store = ingest({ colonists: [makeWorker(1)] });
    expect(store.starvingCount).toBe(0);
  });

  it('sorts danger rows before warn rows', () => {
    const store = ingest({
      buildings: [makeBuilding(4, { defId: 'sawmill', state: 'outputFull' })],
      stockpile: { ...stockedWith({ bread: 60 }), bread: { stock: 60, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const severities = store.attention.map((r) => r.severity);
    // Asserted as the whole array, not as indexOf('danger') < indexOf('warn'):
    // indexOf returns -1 for an absent value, and -1 is less than every real
    // index, so that comparison would keep passing even if 'danger' vanished
    // from the fixture entirely (e.g. a regression that reclassified the
    // runway row as 'warn'). toEqual pins both the membership and the order.
    expect(severities).toEqual(['danger', 'warn']);
  });
});
