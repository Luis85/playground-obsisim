import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus, Snapshot } from '../../src/shared/snapshot';
import { makeSnapshot, stockedWith, makeBuilding, makeWorker } from './fixtures';
// The engine's own bed reader, imported so the store's clamped answer and the
// gate's signed one are asserted against each other rather than described.
import { spareBeds } from '../../src/engine/systems/population-handlers';
import { PendingChanges } from '../../src/engine/resources';
import { batchInputUnits, BUILDINGS } from '../../src/engine/content';

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
      progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0, inputBuffered: 0, stored: 0, storage: 0,
      relocatingTicks: 0, beds: 0, occupants: 0,
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

  // The input backlog, symmetric with unitsWaiting's output backlog (§2.10):
  // units the colony still owes the buildings that have stopped for want of
  // them, and how many those are.
  //
  // Why this fixture discriminates. The six rows put every rival derivation on
  // a different number: `unitsShort` is 2, `buildingsWaitingForInput` is 4,
  // `stalledBuildings` is 1 and `unitsWaiting` is 12, so no two of the four can
  // be swapped. Within `unitsShort`, summing the in-trays gives 5; dropping the
  // Math.max(0, …) floor gives -2 (row 3 holds more than a batch wants);
  // dropping the state filter gives 3 (row 5 is mid-batch, its inputs already
  // paid); charging every waiting building its full recipe demand regardless of
  // what it holds gives 3. Only the intended derivation gives 2.
  const shortOf = (defId: 'mill' | 'bakery') => batchInputUnits(BUILDINGS[defId].recipe);

  it('unitsShort and buildingsWaitingForInput describe the same starved set', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({
      buildings: [
        makeBuilding(1, { defId: 'mill', state: 'waitingForInput', inputBuffered: 0 }),
        makeBuilding(2, { defId: 'bakery', state: 'waitingForInput', inputBuffered: 0 }),
        // Waiting, but NOT for want of goods: a crew at zero work power never
        // reaches startBatch, so a building can sit in this state with a full
        // in-tray. Holding more than a batch wants is what exercises the floor.
        makeBuilding(3, { defId: 'mill', state: 'waitingForInput', inputBuffered: 5 }),
        // Waiting with no inputs in its recipe at all — a raw producer is never
        // short of anything, and it must not be charged a phantom unit.
        makeBuilding(4, { defId: 'forester', state: 'waitingForInput', inputBuffered: 0 }),
        // Mid-batch: its inputs are already paid, so it is short of nothing
        // however empty its in-tray now reads.
        makeBuilding(5, { defId: 'bakery', state: 'producing', inputBuffered: 0 }),
        // Stalled on the OTHER side: nothing about its in-tray is the problem.
        makeBuilding(6, { defId: 'forester', state: 'outputFull', buffered: 12 }),
      ],
    }), status);

    // Read off the catalog, so a recipe retune moves the fixture and the getter
    // together rather than turning this into a stale literal.
    expect(store.unitsShort).toBe(shortOf('mill') + shortOf('bakery'));
    expect(store.unitsShort).toBeGreaterThan(0); // non-vacuous: the catalog really does want inputs
    expect(store.buildingsWaitingForInput).toBe(4);
    // The four aggregates are four different numbers on this one colony, so
    // none of them can be quietly reading another's source.
    expect(store.unitsShort).not.toBe(store.buildingsWaitingForInput);
    expect(store.unitsShort).not.toBe(store.unitsWaiting);
    expect(store.buildingsWaitingForInput).not.toBe(store.stalledBuildings);
    expect(store.unitsWaiting).toBe(12);
    expect(store.stalledBuildings).toBe(1);
  });

  it('unitsShort and buildingsWaitingForInput are zero before the first snapshot', () => {
    const store = useGameStore();
    expect(store.unitsShort).toBe(0);
    expect(store.buildingsWaitingForInput).toBe(0);
  });

  // A colony that clears every nomad gate: a spare bed, food far past
  // nomadFoodPerHead, and the recruit cooldown long elapsed. Each case below
  // spoils exactly one of the three, so a getter that collapsed them into a
  // single catch-all could not satisfy all four at once.
  const welcoming = (overrides: Partial<Snapshot> = {}): Snapshot => makeSnapshot({
    population: 3,
    beds: { total: 4, occupied: 3 },
    stockpile: stockedWith({ bread: 500 }),
    tick: 1000,
    lastRecruitTick: 0,
    ...overrides,
  });

  it('bedsFree charges every colonist a bed, homeless ones included', () => {
    const store = useGameStore();
    store.ingest(welcoming(), status);
    expect(store.bedsFree).toBe(1); // 4 beds, 3 colonists

    // `occupied` and `population` disagree here, which they never do after a
    // tick's homing phase has run — that is exactly what tells the two
    // candidate formulas apart. The engine's own gate input (spareBeds)
    // subtracts the POPULATION, because a homeless colonist still has a claim
    // on a bed; subtracting `occupied` would advertise four free beds to a
    // nomad while four residents were still queueing for them.
    store.ingest(welcoming({ population: 6, beds: { total: 6, occupied: 2 } }), status);
    expect(store.bedsFree).toBe(0);
    store.ingest(welcoming({ population: 4, beds: { total: 6, occupied: 2 } }), status);
    expect(store.bedsFree).toBe(2);
  });

  // OBS-6-07 path 3. The case above stops at a deficit of exactly zero (6 beds,
  // 6 colonists), which `beds.total - population` reaches on its own — so the
  // clamp `spareBedsIn` wraps it in was never exercised, and neither was the
  // fact that the ENGINE's gate deliberately does not clamp.
  //
  // Both are right for their own caller and the divergence is not an accident:
  // a view binds `bedsFree` directly and must never render "-1 spare", while
  // `spareBeds` feeds `birthBlocker`/`nomadBlocker`, which test `<= 0` and need
  // to be able to see a colony that is genuinely over its beds. Asserted side by
  // side, on the same colony, because otherwise nothing fails if either one
  // drifts toward the other.
  it('bedsFree floors a bed deficit at zero, where the engine gate it mirrors reports the deficit', () => {
    const store = useGameStore();
    // A save can legitimately load this way — lowering `houseBeds` in a retune
    // leaves every existing house a resident over — and a relocation reaches it
    // in play, since `beds.total` drops by a whole house the tick it lifts off.
    store.ingest(welcoming({ population: 7, beds: { total: 6, occupied: 6 } }), status);
    expect(store.bedsFree).toBe(0);           // not -1: no view may render a negative
    expect(store.nomadBlocker).toBe('noBed'); // and the gate still refuses on it

    // The same colony through the engine's own reader: 6 beds, 7 colonists, no
    // arrival pending. Signed, on purpose.
    expect(spareBeds([{ id: 1, beds: 6, col: 5, row: 3, relocating: false }], 7, new PendingChanges())).toBe(-1);
  });

  it('nomadBlocker names each gate, in the order the player can act on it', () => {
    const store = useGameStore();
    store.ingest(welcoming({ beds: { total: 3, occupied: 3 } }), status);
    expect(store.nomadBlocker).toBe('noBed');

    store.ingest(welcoming({ stockpile: stockedWith({ bread: 1 }) }), status);
    expect(store.nomadBlocker).toBe('notEnoughFood');

    store.ingest(welcoming({ tick: 5, lastRecruitTick: 0 }), status);
    expect(store.nomadBlocker).toBe('cooldown');

    expect(store.nomadBlocker).not.toBeNull(); // the three above are genuinely blocking
    store.ingest(welcoming(), status);
    expect(store.nomadBlocker).toBeNull();
  });

  // Food is measured from the STOCKPILE, not read off the published
  // mealsPerHead: the ratio counts one more head than the colony has, so a
  // getter trusting the field would answer a different question the moment
  // population changed. Bread here is deliberately far under the bar while
  // mealsPerHead claims the opposite.
  it('nomadBlocker recomputes the food ratio rather than trusting the published one', () => {
    const store = useGameStore();
    store.ingest(welcoming({ stockpile: stockedWith({ bread: 1 }), mealsPerHead: 9999 }), status);
    expect(store.nomadBlocker).toBe('notEnoughFood');
  });

  it('nomadBlocker refuses, and bedsFree is zero, before the first snapshot', () => {
    // The button must render disabled while App.vue is still loading, and it
    // must name a gate rather than an empty string: a null blocker would mean
    // "go ahead" against a colony this store knows nothing about.
    const store = useGameStore();
    expect(store.bedsFree).toBe(0);
    expect(store.nomadBlocker).toBe('noBed');
  });
});
