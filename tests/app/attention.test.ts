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
    expect(store.attention.some((r) => r.message.includes('nothing to work with'))).toBe(true);
  });

  it('names a staffable building with nobody on it', () => {
    const store = ingest({ buildings: [makeBuilding(6, { workers: 0, workerSlots: 3, state: 'unstaffed' })] });
    expect(store.attention.some((r) => r.message.includes('no one working it'))).toBe(true);
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
    expect(store.attention.some((r) => r.message.includes('needs 14 Wood'))).toBe(true);
  });

  it('names a runway at or under 30 ticks, and carries no subject', () => {
    const store = ingest({
      stockpile: { ...stockedWith({ bread: 60 }), bread: { stock: 60, deliveredRate: 0, madeRate: 0, consumptionRate: 2, netFlow: -2, stockValue: 0 } },
    });
    const row = store.attention.find((r) => r.message.includes('empties in'));
    expect(row).toBeDefined();
    expect(row!.subject).toBe(null);   // a resource has no subject on the map
    expect(row!.highlight).toEqual([]);
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
  });

  it('names a single idle adult in the singular', () => {
    const store = ingest({
      idleAdults: 1,
      colonists: [makeWorker(1, { stage: 'adult', buildingId: null, hauling: false })],
    });
    const row = store.attention.find((r) => r.message.includes('idle'));
    expect(row).toBeDefined();
    expect(row!.message).toBe('1 adult is idle');
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
    const firstWarn = severities.indexOf('warn');
    const firstDanger = severities.indexOf('danger');
    expect(firstDanger).toBeLessThan(firstWarn);
  });
});
