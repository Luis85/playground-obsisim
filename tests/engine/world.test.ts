import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { Hunger, JobAssignment, ToolCoverage, Worker } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import { buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, isLoadableSave } from '../../src/engine/world';
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
    save.buildings.push({ id: 4, defId: 'castle' as never, progress: 0, batchActive: false });
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
    overworked.buildings.push({ id: 4, defId: 'forester', progress: 99, batchActive: true });
    overworked.nextEntityId = 5;
    expect(isLoadableSave(overworked)).toBe(true);
    // ...but only below the counter ceiling: past 2^53, progress - ticksPerBatch
    // no longer changes the value and the production loop would hang.
    const astronomical = initialSave();
    astronomical.buildings.push({ id: 4, defId: 'forester', progress: 1e308, batchActive: true });
    astronomical.nextEntityId = 5;
    expect(isLoadableSave(astronomical)).toBe(false);
  });

  it('accepts and grandfathers more assigned workers than a building CURRENTLY has slots (spec 4.5)', () => {
    // slots retuned down after this save was written must not orphan it; assign
    // commands already validate against current slots, so this self-corrects.
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false }; // 2 slots
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

  it('rejects counters at the safe-integer ceiling (no headroom for post-load ++)', () => {
    const ceilingTick = initialSave();
    ceilingTick.tick = Number.MAX_SAFE_INTEGER; // passes isSafeInteger, stalls on the next ++
    expect(isLoadableSave(ceilingTick)).toBe(false);
    const ceilingCounter = initialSave();
    ceilingCounter.nextEntityId = Number.MAX_SAFE_INTEGER;
    expect(isLoadableSave(ceilingCounter)).toBe(false);
  });

  it('rejects fractional ticks and inherited-object-key building ids', () => {
    const fractional = initialSave();
    fractional.tick = 0.5; // would desync the autosave modulo forever
    expect(isLoadableSave(fractional)).toBe(false);
    const inherited = initialSave();
    inherited.buildings.push({ id: 4, defId: 'toString' as never, progress: 0, batchActive: false });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
  });

  it('rejects inactive-batch progress but accepts active progress above the CURRENT recipe size (spec 4.5)', () => {
    // active progress at/above ticksPerBatch is grandfathered: a recipe retuned
    // smaller after this save was written must not orphan it (production
    // deterministically absorbs the overshoot on the next tick).
    const completed = initialSave();
    completed.buildings.push({ id: 4, defId: 'forester', progress: 3, batchActive: true }); // == ticksPerBatch
    completed.nextEntityId = 5;
    expect(isLoadableSave(completed)).toBe(true);
    // stalled/idle buildings never bank progress: this is a balance-independent
    // engine invariant, so it's still rejected.
    const banked = initialSave();
    banked.buildings.push({ id: 4, defId: 'forester', progress: 1, batchActive: false }); // inactive with progress
    expect(isLoadableSave(banked)).toBe(false);
  });

  it('rejects duplicate ids shared across buildings and workers', () => {
    const save = initialSave();
    save.buildings.push({ id: 3, defId: 'forester', progress: 0, batchActive: false }); // collides with worker 3
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects nextEntityId that does not exceed every saved id', () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false });
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
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false }; // 2 slots
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
});
