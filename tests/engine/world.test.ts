import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { Hunger, JobAssignment, ToolCoverage, Worker } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import type { IRuntimeWorld } from 'sim-ecs';
import { GameEngine } from '../../src/engine/game-engine';
import { buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, isLoadableSave, prepareLoadedSave, refreshEntitySections } from '../../src/engine/world';
import { MAX_SAVED_ENTITIES } from '../../src/shared/save';

describe('initialSave', () => {
  it('matches the spec starting state', () => {
    const save = initialSave();
    expect(save.stockpile).toEqual({ wood: 30, berries: 20 });
    expect(save.workers).toHaveLength(3);
    expect(save.workers.map((w) => w.id)).toEqual([1, 2, 3]);
    expect(save.buildings).toHaveLength(0);
    expect(save.tick).toBe(0);
    expect(save.nextEntityId).toBe(4);
  });
});

describe('isLoadableSave', () => {
  it('accepts a fresh initial save', () => {
    expect(isLoadableSave(initialSave())).toBe(true);
  });

  it('rejects unknown building def ids', () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'castle' as never, progress: 0, batchActive: false, col: 4, row: 1 });
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a worker buildingId referencing a nonexistent building', () => {
    const save = initialSave();
    save.workers[0].buildingId = 3; // no buildings exist
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects non-numeric, NaN, or negative stockpile amounts', () => {
    const bad = initialSave();
    (bad.stockpile as Record<string, unknown>).wood = 'lots';
    expect(isLoadableSave(bad)).toBe(false);
    const nan = initialSave();
    nan.stockpile.wood = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.stockpile.wood = -5;
    expect(isLoadableSave(negative)).toBe(false);
    const overflowing = initialSave();
    overflowing.stockpile.tools = 1e308; // finite, but stock x value would go Infinity
    expect(isLoadableSave(overflowing)).toBe(false);
    const fractional = initialSave();
    fractional.stockpile.wood = 1.5; // organic stockpiles are integral
    expect(isLoadableSave(fractional)).toBe(false);
  });

  it('rejects unknown stockpile resource ids', () => {
    const save = initialSave();
    (save.stockpile as Record<string, unknown>).gold = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects stockpiles with more keys than the resource catalog (count gate before entry walk)', () => {
    const bloated = initialSave();
    for (let i = 0; i < 20; i++) {
      (bloated.stockpile as Record<string, unknown>)[`junk${i}`] = 1;
    }
    expect(isLoadableSave(bloated)).toBe(false);
  });

  it('rejects negative or non-integer sim counters (hunger, toolTicks)', () => {
    const negativeHunger = initialSave();
    negativeHunger.workers[0].hunger = -1;
    expect(isLoadableSave(negativeHunger)).toBe(false);
    const tooled = initialSave();
    tooled.workers[0].toolTicks = -1;
    expect(isLoadableSave(tooled)).toBe(false);
    const fractionalTool = initialSave();
    fractionalTool.workers[0].toolTicks = 1.5;
    expect(isLoadableSave(fractionalTool)).toBe(false);
  });

  it('accepts and grandfathers balance-coupled values above CURRENT balance (spec 4.5: saves survive retuning)', () => {
    // hunger/toolTicks above current BALANCE were valid under a prior, higher
    // balance value; the guard no longer rejects them (spawnWorker clamps instead).
    const hungry = initialSave();
    hungry.workers[0].hunger = 1000;
    expect(isLoadableSave(hungry)).toBe(true);
    const overTooled = initialSave();
    overTooled.workers[0].toolTicks = 999999; // above toolDurationTicks (300), within MAX_SAVED_COUNTER
    expect(isLoadableSave(overTooled)).toBe(true);
    // an active batch's progress above the CURRENT recipe's ticksPerBatch (3) is
    // grandfathered: the production while-loop deterministically absorbs it.
    const overworked = initialSave();
    overworked.buildings.push({ id: 4, defId: 'forester', progress: 99, batchActive: true, col: 4, row: 1 });
    overworked.nextEntityId = 5;
    expect(isLoadableSave(overworked)).toBe(true);
    // magnitude is harmless: spawnBuilding clamps active progress to the
    // CURRENT batch size, so even absurd values load without loop hazards.
    const astronomical = initialSave();
    astronomical.buildings.push({ id: 4, defId: 'forester', progress: 1e308, batchActive: true, col: 4, row: 1 });
    astronomical.nextEntityId = 5;
    expect(isLoadableSave(astronomical)).toBe(true);
  });

  it('clamps oversized active progress to the current batch size on load', async () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 1e308, batchActive: true, col: 4, row: 1 });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.buildings[0].progress).toBeLessThanOrEqual(3); // forester ticksPerBatch
  });

  it('accepts and grandfathers more assigned workers than a building CURRENTLY has slots (spec 4.5)', () => {
    // slots retuned down after this save was written must not orphan it; assign
    // commands already validate against current slots, so this self-corrects.
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false, col: 4, row: 1 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 5;
    save.workers = [1, 2, 3].map((id) => ({ id, hunger: 0, buildingId: building.id, toolTicks: 0 }));
    expect(isLoadableSave(save)).toBe(true);
  });

  it('rejects a future recruit cooldown timestamp but accepts one below the fresh-colony sentinel', () => {
    const future = initialSave();
    future.lastRecruitTick = 1000000; // engine only ever records past ticks
    expect(isLoadableSave(future)).toBe(false);
    // below -recruitCooldownTicks just means "cooldown long expired" under a
    // prior, larger cooldown value — harmless, so it's grandfathered (spec 4.5).
    const tooLow = initialSave();
    tooLow.lastRecruitTick = -999;
    expect(isLoadableSave(tooLow)).toBe(true);
  });

  it('rejects counters beyond safe-integer range (++ would stall or collide)', () => {
    const unsafeCounter = initialSave();
    unsafeCounter.nextEntityId = Number.MAX_SAFE_INTEGER + 2; // still an "integer" per isInteger
    expect(isLoadableSave(unsafeCounter)).toBe(false);
    const unsafeTick = initialSave();
    unsafeTick.tick = Number.MAX_SAFE_INTEGER + 2;
    expect(isLoadableSave(unsafeTick)).toBe(false);
  });

  it('accepts ceiling-magnitude ticks (clamped on load) but rejects a ceiling id counter', async () => {
    // any hard accept-bound on tick would orphan a save that plays past it,
    // so ticks clamp on load instead; the id counter cannot clamp (uniqueness)
    // and keeps its hard bound.
    const ceilingTick = initialSave();
    ceilingTick.tick = Number.MAX_SAFE_INTEGER;
    ceilingTick.lastRecruitTick = 0;
    expect(isLoadableSave(ceilingTick)).toBe(true);
    const world = await createColonyWorld(ceilingTick);
    const seededTick = world.getResource(SnapshotStore).latest!.tick;
    expect(seededTick).toBeLessThan(Number.MAX_SAFE_INTEGER); // clamped: headroom restored
    expect(world.getResource(SimClock).tick).toBe(seededTick); // clock and snapshot agree
    const ceilingCounter = initialSave();
    ceilingCounter.nextEntityId = Number.MAX_SAFE_INTEGER;
    expect(isLoadableSave(ceilingCounter)).toBe(false);
  });

  it('every save written from an accepted id state is itself accepted (no boundary ping-pong)', async () => {
    // No accept-bound alone can deliver this at its own boundary (the state
    // sitting exactly at any bound writes bound+1), so the id counter
    // saturates instead: at the ceiling the engine refuses entity creation,
    // and the written counter never leaves the accepted range.
    const atCeiling = initialSave();
    atCeiling.nextEntityId = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER
    expect(isLoadableSave(atCeiling)).toBe(true);
    const justAbove = initialSave();
    justAbove.nextEntityId = Number.MAX_SAFE_INTEGER - 2 ** 32 + 1;
    expect(isLoadableSave(justAbove)).toBe(false);
    const { GameEngine } = await import('../../src/engine/game-engine');
    const engine = await GameEngine.create(atCeiling);
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    const written = engine.serialize();
    expect(written.buildings).toHaveLength(0); // creation refused at the ceiling
    expect(written.nextEntityId).toBe(atCeiling.nextEntityId);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('a save producing onto a ceiling stockpile stays loadable (no boundary ping-pong)', async () => {
    // Stockpile.add saturates at MAX_SAVED_COUNTER, so a delivery onto a
    // ceiling stock must not push the written amount past the accept-bound.
    // Production now banks into a building's own OutputBuffer rather than the
    // Stockpile directly (Task 2), so a staffed forester can no longer drive
    // this — only the mechanism that puts goods into the Stockpile moved.
    // This deposits straight onto the live Stockpile instead, the same thing
    // a hauler delivery will do from Task 4 onward.
    const atWood = (wood: number) => {
      const save = initialSave();
      save.stockpile.wood = wood;
      return save;
    };
    const run = async (wood: number) => {
      const engine = await GameEngine.create(atWood(wood));
      (engine as unknown as { world: IRuntimeWorld }).world.getResource(Stockpile).add('wood', 5);
      await engine.stepOnce();
      return engine.serialize();
    };
    // control: this setup really does put wood in before serializing
    expect((await run(10)).stockpile.wood!).toBeGreaterThan(10);
    const ceiling = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER
    expect(isLoadableSave(atWood(ceiling))).toBe(true);
    const written = await run(ceiling);
    expect(written.stockpile.wood).toBe(ceiling); // saturated, not overflowed
    expect(isLoadableSave(written)).toBe(true);
  });

  it('rejects array-shaped stockpiles (would silently restore empty)', () => {
    const arrayStockpile = initialSave();
    (arrayStockpile as { stockpile: unknown }).stockpile = [];
    expect(isLoadableSave(arrayStockpile)).toBe(false);
  });

  it('rejects fractional ticks and inherited-object-key building ids', () => {
    const fractional = initialSave();
    fractional.tick = 0.5; // would desync the autosave modulo forever
    expect(isLoadableSave(fractional)).toBe(false);
    const inherited = initialSave();
    inherited.buildings.push({ id: 4, defId: 'toString' as never, progress: 0, batchActive: false, col: 4, row: 1 });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
  });

  it('rejects inactive-batch progress but accepts active progress above the CURRENT recipe size (spec 4.5)', () => {
    // active progress at/above ticksPerBatch is grandfathered: a recipe retuned
    // smaller after this save was written must not orphan it (production
    // deterministically absorbs the overshoot on the next tick).
    const completed = initialSave();
    completed.buildings.push({ id: 4, defId: 'forester', progress: 3, batchActive: true, col: 4, row: 1 }); // == ticksPerBatch
    completed.nextEntityId = 5;
    expect(isLoadableSave(completed)).toBe(true);
    // stalled/idle buildings never bank progress: this is a balance-independent
    // engine invariant, so it's still rejected.
    const banked = initialSave();
    banked.buildings.push({ id: 4, defId: 'forester', progress: 1, batchActive: false, col: 4, row: 1 }); // inactive with progress
    expect(isLoadableSave(banked)).toBe(false);
  });

  it('rejects duplicate ids shared across buildings and workers', () => {
    const save = initialSave();
    save.buildings.push({ id: 3, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 }); // collides with worker 3
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects nextEntityId that does not exceed every saved id', () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    save.nextEntityId = 4; // must be strictly greater than the max id (4)
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects saves with absurd entity counts before walking them', () => {
    const flooded = initialSave();
    flooded.workers = Array.from({ length: MAX_SAVED_ENTITIES + 1 }, (_, index) => ({
      id: index + 1,
      hunger: 0,
      buildingId: null,
      toolTicks: 0,
    }));
    flooded.nextEntityId = MAX_SAVED_ENTITIES + 2;
    expect(isLoadableSave(flooded)).toBe(false);
  });

  it('rejects positions off the map, on the camp band, or stacked on one tile', () => {
    const outOfBounds = initialSave();
    outOfBounds.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 24, row: 1 });
    outOfBounds.nextEntityId = 5;
    expect(isLoadableSave(outOfBounds)).toBe(false);

    const onCamp = initialSave();
    onCamp.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 2, row: 1 });
    onCamp.nextEntityId = 5;
    expect(isLoadableSave(onCamp)).toBe(false);

    const stacked = initialSave();
    stacked.buildings.push(
      { id: 4, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 5 },
      { id: 5, defId: 'farm', progress: 0, batchActive: false, col: 5, row: 5 },
    );
    stacked.nextEntityId = 6;
    expect(isLoadableSave(stacked)).toBe(false);
  });

  it('rejects a v2 save with buildings missing col/row', () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false } as never);
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a map outside the structural bounds', () => {
    const tiny = initialSave();
    tiny.map = { cols: 4, rows: 4 };
    expect(isLoadableSave(tiny)).toBe(false);
  });
});

describe('createColonyWorld', () => {
  it('builds a runnable world with resources initialized from the save', async () => {
    const world = await createColonyWorld();
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    expect(world.getResource(SimClock).tick).toBe(0);
    await world.step(); // no systems registered yet -> must still step cleanly
  });

  it('spawns save entities with working component access', async () => {
    const save = initialSave();
    save.workers[0].hunger = 42;
    const prep = buildColonyPrepWorld({ save });
    const workers = [...prep.getEntities()].filter((e) => e.hasComponent(Worker));
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.getComponent(Hunger)!.value).sort((a, b) => b - a)[0]).toBe(42);
    expect(workers.every((w) => w.getComponent(JobAssignment)!.buildingId === null)).toBe(true);
  });

  it('clamps balance-coupled worker fields above CURRENT balance at load (spec 4.5)', async () => {
    const save = initialSave();
    save.workers[0].hunger = 1000;
    save.workers[0].toolTicks = 999999; // within MAX_SAVED_COUNTER, above toolDurationTicks (300)
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const snapshot = world.getResource(SnapshotStore).latest!;
    const clamped = snapshot.workers.find((w) => w.id === save.workers[0].id)!;
    expect(clamped.hunger).toBeLessThanOrEqual(BALANCE.hungerMax);
    expect(clamped.toolTicks).toBeLessThanOrEqual(BALANCE.toolDurationTicks);

    const prep = buildColonyPrepWorld({ save });
    const spawnedWorker = [...prep.getEntities()].find(
      (e) => e.hasComponent(Worker) && e.getComponent(Worker)!.id === save.workers[0].id,
    )!;
    expect(spawnedWorker.getComponent(Hunger)!.value).toBeLessThanOrEqual(BALANCE.hungerMax);
    expect(spawnedWorker.getComponent(ToolCoverage)!.remainingTicks).toBeLessThanOrEqual(BALANCE.toolDurationTicks);
  });

  it('grandfathers overstaffed buildings from a save (spec 4.5: slots retuned down must not orphan saves)', async () => {
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false, col: 4, row: 1 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 5;
    save.workers = [1, 2, 3].map((id) => ({ id, hunger: 0, buildingId: building.id, toolTicks: 0 }));
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const snapshot = world.getResource(SnapshotStore).latest!;
    const seededBuilding = snapshot.buildings.find((b) => b.id === building.id)!;
    expect(seededBuilding.workers).toBe(3); // grandfathered above the current 2-slot cap
  });

  it('IdCounter continues past spawned entities', () => {
    const prep = buildColonyPrepWorld();
    const ids = getPrepResource(prep, IdCounter);
    expect(ids.take()).toBe(4); // workers took 1..3
  });

  it('seeds an initial snapshot so the UI never sees null', async () => {
    const world = await createColonyWorld();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.tick).toBe(0);
    expect(snapshot.population).toBe(3);
    expect(snapshot.idleWorkers).toBe(3);
    expect(snapshot.stockpile.wood.stock).toBe(30);
    expect(snapshot.colonyWealth).toBe(50); // 30 wood@1 + 20 berries@1
    expect(snapshot.notices).toEqual([]);
  });

  it('seeds the map dimensions into the snapshot', async () => {
    const world = await createColonyWorld();
    expect(world.getResource(SnapshotStore).latest!.map).toEqual({ cols: 24, rows: 16 });
  });

  it('carries building positions from components into snapshots', async () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 9, row: 7 });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    const b = world.getResource(SnapshotStore).latest!.buildings[0];
    expect(b).toMatchObject({ col: 9, row: 7 });
  });
});

describe('prepareLoadedSave', () => {
  it('accepts a latest-version save and returns it unchanged', () => {
    const save = initialSave();
    expect(prepareLoadedSave(save)).toEqual(save);
  });

  it('still applies the catalog checks after migration', () => {
    const save = initialSave();
    save.buildings = [{ id: 99, defId: 'notABuilding' as never, progress: 0, batchActive: false, col: 4, row: 1 }];
    save.nextEntityId = 100;
    expect(prepareLoadedSave(save)).toBeNull();
  });

  it('rejects a version this build does not know', () => {
    expect(prepareLoadedSave({ ...initialSave(), version: 3 })).toBeNull();
    expect(prepareLoadedSave({ ...initialSave(), version: 99 })).toBeNull();
  });

  it('rejects a missing or non-object save', () => {
    expect(prepareLoadedSave(undefined)).toBeNull();
    expect(prepareLoadedSave('nope')).toBeNull();
  });
});

describe('live-world projections agree', () => {
  // Facts DERIVED each tick and deliberately not persisted. Everything else must
  // be persisted AND survive save -> restore, so a new fact is covered by
  // default and opting out is a visible, deliberate edit to this list.
  const DERIVED = ['efficiency'] as const;

  function persisted(workers: readonly object[]): Record<string, unknown>[] {
    return workers.map((w) => {
      const copy: Record<string, unknown> = { ...w };
      for (const key of DERIVED) delete copy[key];
      return copy;
    });
  }

  /** A colony with a staffed worker, live tool coverage, hunger history and batch progress. */
  async function busyColony() {
    const save = initialSave();
    save.stockpile = { wood: 100, tools: 10, berries: 50 };
    const engine = await GameEngine.create(save);
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    engine.dispatch({ type: 'assignWorker', buildingId: engine.snapshot!.buildings[0].id });
    for (let i = 0; i < 60; i++) await engine.stepOnce();
    return engine;
  }

  it('the query path, the walk path and serialize() report the same facts', async () => {
    const engine = await busyColony();
    const fromQueryPath = engine.snapshot!.workers.map((w) => ({ ...w }));

    // force the walk path over the same unchanged world
    refreshEntitySections((engine as unknown as { world: IRuntimeWorld }).world);
    expect(engine.snapshot!.workers.map((w) => ({ ...w }))).toEqual(fromQueryPath);

    // and the save projection must agree on every field it shares
    const saved = engine.serialize().workers;
    expect(persisted(fromQueryPath)).toEqual(saved.map((w) => ({ ...w })));
  });

  it('every non-derived worker fact is represented in the save record', async () => {
    const engine = await busyColony();
    const factKeys = Object.keys(engine.snapshot!.workers[0])
      .filter((key) => !DERIVED.includes(key as (typeof DERIVED)[number]));
    const savedKeys = Object.keys(engine.serialize().workers[0]);
    expect(factKeys.filter((key) => !savedKeys.includes(key))).toEqual([]);
  });

  it('every persisted worker fact survives save -> restore', async () => {
    const engine = await busyColony();
    const before = persisted(engine.snapshot!.workers);
    const restored = await GameEngine.create(engine.serialize());
    expect(persisted(restored.snapshot!.workers)).toEqual(before);
  });

  it('every non-derived building fact is represented in the save record', async () => {
    const engine = await busyColony();
    // workerSlots and progressPct/state/workPower/tooledWorkers are display-derived.
    // buffered is real state, not derived — but Task 2 deliberately does not persist
    // output-buffer contents yet (spawnBuilding always starts one empty; save v3 in
    // Task 6 restores real contents), so it is excluded here too until then.
    const derivedBuilding = ['workers', 'workerSlots', 'state', 'progressPct', 'tooledWorkers', 'workPower', 'buffered'];
    const factKeys = Object.keys(engine.snapshot!.buildings[0]).filter((k) => !derivedBuilding.includes(k));
    const savedKeys = Object.keys(engine.serialize().buildings[0]);
    expect(factKeys.filter((key) => !savedKeys.includes(key))).toEqual([]);
  });
});
