import { describe, expect, it } from 'vitest';
import { Hunger, JobAssignment, Worker } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import { buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, isLoadableSave } from '../../src/engine/world';

describe('initialSave', () => {
  it('matches the spec starting state', () => {
    const save = initialSave();
    expect(save.stockpile).toEqual({ wood: 30, berries: 20 });
    expect(save.workers).toHaveLength(3);
    expect(save.buildings).toHaveLength(0);
    expect(save.tick).toBe(0);
  });
});

describe('isLoadableSave', () => {
  it('accepts a fresh initial save', () => {
    expect(isLoadableSave(initialSave())).toBe(true);
  });

  it('rejects unknown building def ids', () => {
    const save = initialSave();
    save.buildings.push({ defId: 'castle' as never, progress: 0, batchActive: false });
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects out-of-range worker building indices', () => {
    const save = initialSave();
    save.workers[0].buildingIndex = 3; // no buildings exist
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
  });

  it('rejects unknown stockpile resource ids', () => {
    const save = initialSave();
    (save.stockpile as Record<string, unknown>).gold = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects out-of-range sim counters (hunger, toolTicks, progress)', () => {
    const hungry = initialSave();
    hungry.workers[0].hunger = 1000;
    expect(isLoadableSave(hungry)).toBe(false);
    const tooled = initialSave();
    tooled.workers[0].toolTicks = -1;
    expect(isLoadableSave(tooled)).toBe(false);
    const overworked = initialSave();
    overworked.buildings.push({ defId: 'forester', progress: 99, batchActive: true }); // ticksPerBatch is 3
    expect(isLoadableSave(overworked)).toBe(false);
  });

  it('rejects more assigned workers than a building has slots', () => {
    const save = initialSave();
    save.buildings.push({ defId: 'forester', progress: 0, batchActive: false }); // 2 slots
    save.workers = [0, 1, 2].map(() => ({ hunger: 0, buildingIndex: 0, toolTicks: 0 }));
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects recruit cooldown timestamps outside the valid engine range', () => {
    const future = initialSave();
    future.lastRecruitTick = 1000000; // engine only ever records past ticks
    expect(isLoadableSave(future)).toBe(false);
    const tooLow = initialSave();
    tooLow.lastRecruitTick = -999; // below the fresh-colony floor
    expect(isLoadableSave(tooLow)).toBe(false);
  });

  it('rejects fractional ticks and inherited-object-key building ids', () => {
    const fractional = initialSave();
    fractional.tick = 0.5; // would desync the autosave modulo forever
    expect(isLoadableSave(fractional)).toBe(false);
    const inherited = initialSave();
    inherited.buildings.push({ defId: 'toString' as never, progress: 0, batchActive: false });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
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
