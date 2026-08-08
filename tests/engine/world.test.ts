import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import { Building, Hunger, JobAssignment, Relocation, ToolCoverage, Colonist } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import type { IRuntimeWorld } from 'sim-ecs';
import { GameEngine } from '../../src/engine/game-engine';
import { ALL_SYSTEMS, buildColonyPrepWorld, createColonyWorld, getPrepResource, initialSave, isLoadableSave, prepareLoadedSave, refreshEntitySections } from '../../src/engine/world';
import { buildSaveFromWorld } from '../../src/engine/game-engine';
import { CommandSystem } from '../../src/engine/systems/command-system';
import { HaulSystem } from '../../src/engine/systems/haul-system';
import { SnapshotSystem } from '../../src/engine/systems/snapshot-system';
import { isSaveGameV4, MAX_SAVED_ENTITIES } from '../../src/shared/save';
import { MAX_MAP, relocationTicks } from '../../src/shared/placement';

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
    save.buildings.push({ id: 4, defId: 'castle' as never, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a worker buildingId referencing a nonexistent building', () => {
    const save = initialSave();
    save.workers[0].buildingId = 3; // no buildings exist
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a worker holding both a valid buildingId and hauling: true (one worker, two jobs)', () => {
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 };
    save.buildings.push(building);
    save.nextEntityId = 5;
    save.workers[0].buildingId = building.id; // a real building — the membership check alone would accept this
    save.workers[0].hauling = true;
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

  it('rejects a non-numeric, NaN, negative, or fractional ageTicks (a corrupted save must not silently kill the colonist)', () => {
    // The exact failure this closes: clampedAge(NaN) is
    // Math.max(0, Math.min(NaN, MAX_AGE_TICKS)) === NaN, and resolveOldAge's
    // `row.age.ticks < lifespanFor(...)` guard is false either way for NaN, so
    // its `continue` never fires — the colonist would be removed on the very
    // first tick after load instead of the save taking the corrupt-backup path.
    const nonNumeric = initialSave();
    nonNumeric.workers[0].ageTicks = 'abc' as never;
    expect(isLoadableSave(nonNumeric)).toBe(false);
    const nan = initialSave();
    nan.workers[0].ageTicks = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.workers[0].ageTicks = -1;
    expect(isLoadableSave(negative)).toBe(false);
    const fractional = initialSave();
    fractional.workers[0].ageTicks = 1.5;
    expect(isLoadableSave(fractional)).toBe(false);
  });

  it('accepts ageTicks omitted or present as a valid non-negative integer (a v4 save predates the field until Task 9)', () => {
    const withoutAge = initialSave();
    // fixture precondition: genuinely absent, not merely undefined-valued —
    // this is what makes the pair below discriminate on ageTicks alone.
    expect(Object.hasOwn(withoutAge.workers[0], 'ageTicks')).toBe(false);
    expect(isLoadableSave(withoutAge)).toBe(true);
    const withAge = initialSave();
    withAge.workers[0].ageTicks = 500;
    expect(isLoadableSave(withAge)).toBe(true);
  });

  it('rejects a non-numeric, NaN, negative, or fractional starvingTicks (a corrupted save must not silently resume a starvation clock)', () => {
    const nonNumeric = initialSave();
    nonNumeric.workers[0].starvingTicks = 'abc' as never;
    expect(isLoadableSave(nonNumeric)).toBe(false);
    const nan = initialSave();
    nan.workers[0].starvingTicks = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.workers[0].starvingTicks = -1;
    expect(isLoadableSave(negative)).toBe(false);
    const fractional = initialSave();
    fractional.workers[0].starvingTicks = 1.5;
    expect(isLoadableSave(fractional)).toBe(false);
  });

  it('accepts starvingTicks omitted or present as a valid non-negative integer (a v4 save predates the field)', () => {
    const withoutIt = initialSave();
    // fixture precondition: genuinely absent, not merely undefined-valued —
    // this is what makes the pair below discriminate on starvingTicks alone.
    expect(Object.hasOwn(withoutIt.workers[0], 'starvingTicks')).toBe(false);
    expect(isLoadableSave(withoutIt)).toBe(true);
    const withIt = initialSave();
    withIt.workers[0].starvingTicks = 40;
    expect(isLoadableSave(withIt)).toBe(true);
  });

  it('accepts and grandfathers balance-coupled values above CURRENT balance (spec 4.5: saves survive retuning)', () => {
    // hunger/toolTicks above current BALANCE were valid under a prior, higher
    // balance value; the guard no longer rejects them (spawnColonist clamps instead).
    const hungry = initialSave();
    hungry.workers[0].hunger = 1000;
    expect(isLoadableSave(hungry)).toBe(true);
    const overTooled = initialSave();
    overTooled.workers[0].toolTicks = 999999; // above toolDurationTicks (300), within MAX_SAVED_COUNTER
    expect(isLoadableSave(overTooled)).toBe(true);
    // an active batch's progress above the CURRENT recipe's ticksPerBatch (3) is
    // grandfathered: the production while-loop deterministically absorbs it.
    const overworked = initialSave();
    overworked.buildings.push({ id: 4, defId: 'forester', progress: 99, batchActive: true, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
    overworked.nextEntityId = 5;
    expect(isLoadableSave(overworked)).toBe(true);
    // magnitude is harmless: spawnBuilding clamps active progress to the
    // CURRENT batch size, so even absurd values load without loop hazards.
    const astronomical = initialSave();
    astronomical.buildings.push({ id: 4, defId: 'forester', progress: 1e308, batchActive: true, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
    astronomical.nextEntityId = 5;
    expect(isLoadableSave(astronomical)).toBe(true);
  });

  it('clamps oversized active progress to the current batch size on load', async () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 1e308, batchActive: true, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.buildings[0].progress).toBeLessThanOrEqual(3); // forester ticksPerBatch
  });

  it('accepts and grandfathers more assigned workers than a building CURRENTLY has slots (spec 4.5)', () => {
    // slots retuned down after this save was written must not orphan it; assign
    // commands already validate against current slots, so this self-corrects.
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 5;
    save.workers = [1, 2, 3].map((id) => ({ id, hunger: 0, buildingId: building.id, toolTicks: 0, hauling: false }));
    expect(isLoadableSave(save)).toBe(true);
  });

  it('rejects a negative or fractional relocatingTicks (a record no engine version could write)', () => {
    // Structural/identity, not balance: unlike an oversized countdown (clamped
    // at spawn instead, see "clamps oversized relocatingTicks" below), negative
    // or fractional values are impossible for any version of ProductionSystem's
    // decrementing loop to have produced, so the load guard rejects them outright.
    const negative = initialSave();
    negative.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: -1 });
    negative.nextEntityId = 5;
    expect(isLoadableSave(negative)).toBe(false);

    const fractional = initialSave();
    fractional.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 1.5 });
    fractional.nextEntityId = 5;
    expect(isLoadableSave(fractional)).toBe(false);
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

  it('a save written from a ceiling stockpile is itself loadable (no boundary ping-pong)', async () => {
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
    inherited.buildings.push({ id: 4, defId: 'toString' as never, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
  });

  it('rejects inactive-batch progress but accepts active progress above the CURRENT recipe size (spec 4.5)', () => {
    // active progress at/above ticksPerBatch is grandfathered: a recipe retuned
    // smaller after this save was written must not orphan it (production
    // deterministically absorbs the overshoot on the next tick).
    const completed = initialSave();
    completed.buildings.push({ id: 4, defId: 'forester', progress: 3, batchActive: true, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }); // == ticksPerBatch
    completed.nextEntityId = 5;
    expect(isLoadableSave(completed)).toBe(true);
    // stalled/idle buildings never bank progress: this is a balance-independent
    // engine invariant, so it's still rejected.
    const banked = initialSave();
    banked.buildings.push({ id: 4, defId: 'forester', progress: 1, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }); // inactive with progress
    expect(isLoadableSave(banked)).toBe(false);
  });

  it('rejects duplicate ids shared across buildings and workers', () => {
    const save = initialSave();
    save.buildings.push({ id: 3, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }); // collides with worker 3
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects nextEntityId that does not exceed every saved id', () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
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
      hauling: false,
    }));
    flooded.nextEntityId = MAX_SAVED_ENTITIES + 2;
    expect(isLoadableSave(flooded)).toBe(false);
  });

  it('rejects positions off the map, on the camp band, or stacked on one tile', () => {
    const outOfBounds = initialSave();
    outOfBounds.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 24, row: 1, buffer: {}, relocatingTicks: 0 });
    outOfBounds.nextEntityId = 5;
    expect(isLoadableSave(outOfBounds)).toBe(false);

    const onCamp = initialSave();
    onCamp.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 2, row: 1, buffer: {}, relocatingTicks: 0 });
    onCamp.nextEntityId = 5;
    expect(isLoadableSave(onCamp)).toBe(false);

    const stacked = initialSave();
    stacked.buildings.push(
      { id: 4, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 5, buffer: {}, relocatingTicks: 0 },
      { id: 5, defId: 'farm', progress: 0, batchActive: false, col: 5, row: 5, buffer: {}, relocatingTicks: 0 },
    );
    stacked.nextEntityId = 6;
    expect(isLoadableSave(stacked)).toBe(false);
  });

  it('rejects a v3 save with buildings missing col/row', () => {
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

  // outputBufferCap is a tunable balance number (spec 4.5): a save written
  // under a larger cap — or one increment 5 orphans by tuning the cap down —
  // must still load. spawnBuilding clamps the buffer to the CURRENT cap
  // instead of the guard refusing the save (see clampedBuffer in world.ts).
  it('clamps a buffer holding more than the cap at load, instead of rejecting the save', async () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { wood: BALANCE.outputBufferCap + 1 }, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    expect(world.getResource(SnapshotStore).latest!.buildings[0].buffered).toBe(BALANCE.outputBufferCap);
  });

  it('rejects a buffer naming a resource the catalog does not have', () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { unobtainium: 1 } as never, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  // Both buffer guards cap key count BEFORE walking the object, the same
  // flooded-save principle isStockpileValid states: Object.keys/Object.values
  // on an adversarially wide buffer materializes every entry before the first
  // per-entry check could reject it, multiplied by up to MAX_SAVED_ENTITIES
  // buildings. isLoadableSave's catalog walk refuses this save either way — the
  // structural guard is what refuses it cheaply, which is why the assertion is
  // on isSaveGameV4 and not only on isLoadableSave.
  it('rejects a buffer naming more resources than exist, at the structural guard', () => {
    const buffer: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) buffer[`filler${i}`] = 1; // every amount structurally valid
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: buffer as never, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isSaveGameV4(save)).toBe(false);
    expect(isLoadableSave(save)).toBe(false);
  });

  // A negative amount names a real catalog resource, so isBuffersValid's
  // catalog-membership check alone would accept it: only isBufferShape's own
  // per-amount structural check (Number.isSafeInteger(amount) && amount >= 0)
  // catches this one.
  it('rejects a buffer holding a negative amount', () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { wood: -5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('restores buffered goods into the building that held them', async () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: { wood: 5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    expect(world.getResource(SnapshotStore).latest!.buildings[0].buffered).toBe(5);
  });

  it('clamps a multi-resource over-cap buffer deterministically, trimming in catalog order', async () => {
    const cap = BALANCE.outputBufferCap;
    const [first, second, third] = RESOURCE_IDS;
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      // `first` fits whole; `second` only partially (whatever room is left);
      // `third` has no room at all left and must be dropped entirely.
      buffer: { [first]: cap - 1, [second]: cap, [third]: cap }, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(true);

    const engine = await GameEngine.create(save);
    const buffer = engine.serialize().buildings[0].buffer;

    expect(buffer[first]).toBe(cap - 1);
    expect(buffer[second]).toBe(1); // room left after `first`: cap - (cap - 1)
    expect(Object.hasOwn(buffer, third)).toBe(false); // no room left: absent, not zero

    const kept = Object.values(buffer) as number[];
    expect(kept.reduce((sum, amount) => sum + amount, 0)).toBe(cap); // total is exactly the cap
    for (const amount of kept) {
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0); // never negative, never fractional, never a stray zero entry
    }
  });

  it('re-serializing a clamped over-cap load produces a save isLoadableSave still accepts (no ping-pong)', async () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { wood: BALANCE.outputBufferCap + 5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(true);

    const engine = await GameEngine.create(save);
    const written = engine.serialize();
    expect(written.buildings[0].buffer.wood).toBe(BALANCE.outputBufferCap); // clamped, not the original over-cap amount
    expect(isLoadableSave(written)).toBe(true);
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
    const workers = [...prep.getEntities()].filter((e) => e.hasComponent(Colonist));
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
    const clamped = snapshot.colonists.find((w) => w.id === save.workers[0].id)!;
    expect(clamped.hunger).toBeLessThanOrEqual(BALANCE.hungerMax);
    expect(clamped.toolTicks).toBeLessThanOrEqual(BALANCE.toolDurationTicks);

    const prep = buildColonyPrepWorld({ save });
    const spawnedWorker = [...prep.getEntities()].find(
      (e) => e.hasComponent(Colonist) && e.getComponent(Colonist)!.id === save.workers[0].id,
    )!;
    expect(spawnedWorker.getComponent(Hunger)!.value).toBeLessThanOrEqual(BALANCE.hungerMax);
    expect(spawnedWorker.getComponent(ToolCoverage)!.remainingTicks).toBeLessThanOrEqual(BALANCE.toolDurationTicks);
  });

  it('clamps oversized relocatingTicks to current balance at load, agreeing with the live spawned component (spec 4.5)', async () => {
    // isLoadableSave's structural check (Task 7) only rejects a negative or
    // fractional countdown — it never bounds-checks magnitude against current
    // balance, so clampedRelocation is the sole defense against an oversized
    // one: a save written under a larger maxRelocationTicks must still load
    // and clamp rather than being structurally rejected.
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {},
      relocatingTicks: BALANCE.maxRelocationTicks + 500,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(true);

    // Deliberately no world.step(): buildInitialSnapshot's own clamp is what
    // this proves. Stepping would let SnapshotSystem's live-query path
    // overwrite the seeded value first, leaving the load-time clamp
    // unexercised — exactly the gap this test closes.
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    const seededBuilding = seeded.buildings.find((b) => b.id === 4)!;
    expect(seededBuilding.relocatingTicks).toBeLessThanOrEqual(BALANCE.maxRelocationTicks);

    const prep = buildColonyPrepWorld({ save });
    const spawnedBuilding = [...prep.getEntities()].find(
      (e) => e.hasComponent(Building) && e.getComponent(Building)!.id === 4,
    )!;
    // Cross-check the live spawned component's exact value, not just its own
    // bound: proves the seeded snapshot and buildingComponents' Relocation
    // — the two independent clampedRelocation call sites — agree on the
    // actual number, not merely that both separately stayed under the cap.
    expect(spawnedBuilding.getComponent(Relocation)!.ticksLeft).toBe(seededBuilding.relocatingTicks);
  });

  it('a building mid-relocation survives save -> restore with its countdown', async () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 3, buffer: {}, relocatingTicks: 9 });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    const written = buildSaveFromWorld(world);
    expect(written.buildings[0].relocatingTicks).toBe(9);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('a relocation countdown legal on the largest map survives save/load unchanged', async () => {
    // isMapShape (src/shared/save.ts) accepts a map up to MAX_MAP, and
    // mapThatFits (src/shared/placement.ts) grows a migrated v1 colony's map
    // that large automatically, so this is not a hypothetical: MAX_MAP's
    // diagonal is the largest relocation downtime a legal save can ever
    // record. maxRelocationTicks must not clamp it away — that would cancel
    // a penalty the engine genuinely charged (spec §2.4).
    const save = initialSave();
    save.map = { ...MAX_MAP };
    const legalTicks = relocationTicks(Math.hypot(MAX_MAP.cols, MAX_MAP.rows), BALANCE.relocationTilesPerTick);
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: {},
      relocatingTicks: legalTicks,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    const seededBuilding = seeded.buildings.find((b) => b.id === 4)!;
    expect(seededBuilding.relocatingTicks).toBe(legalTicks); // NOT clamped down

    const written = buildSaveFromWorld(world);
    expect(written.buildings.find((b) => b.id === 4)!.relocatingTicks).toBe(legalTicks);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('each colonist survives save -> restore with its own exact starvingTicks, not a shared value', async () => {
    // Two distinct values on two distinct colonists: a bug that writes one
    // hardcoded number, or wires the wrong colonist's field, could still
    // satisfy a single-colonist assertion but not this pair.
    const save = initialSave();
    save.workers[0].starvingTicks = 40; // partway through the countdown
    save.workers[1].starvingTicks = 0;  // never starved
    expect(isLoadableSave(save)).toBe(true);

    // The SEEDED snapshot (buildInitialSnapshot), read before any tick runs —
    // proves the restore path, not SnapshotSystem's live query.
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists.find((c) => c.id === save.workers[0].id)!.starvingTicks).toBe(40);
    expect(seeded.colonists.find((c) => c.id === save.workers[1].id)!.starvingTicks).toBe(0);

    // And the round trip back out, from the live entities (buildSaveFromWorld
    // walks components, not the snapshot) — proves the live spawn path too.
    const written = buildSaveFromWorld(world);
    expect(written.workers.find((w) => w.id === save.workers[0].id)!.starvingTicks).toBe(40);
    expect(written.workers.find((w) => w.id === save.workers[1].id)!.starvingTicks).toBe(0);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('grandfathers overstaffed buildings from a save (spec 4.5: slots retuned down must not orphan saves)', async () => {
    const save = initialSave();
    const building = { id: 4, defId: 'forester' as const, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 5;
    save.workers = [1, 2, 3].map((id) => ({ id, hunger: 0, buildingId: building.id, toolTicks: 0, hauling: false }));
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
    expect(snapshot.idleAdults).toBe(3);
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
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 9, row: 7, buffer: {}, relocatingTicks: 0 });
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
    save.buildings = [{ id: 99, defId: 'notABuilding' as never, progress: 0, batchActive: false, col: 4, row: 1, buffer: {}, relocatingTicks: 0 }];
    save.nextEntityId = 100;
    expect(prepareLoadedSave(save)).toBeNull();
  });

  it('rejects a version this build does not know', () => {
    expect(prepareLoadedSave({ ...initialSave(), version: 5 })).toBeNull();
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
  // `efficiency` is recomputed from hunger every tick, never stored. `stage`
  // is the same shape: recomputed from `ageTicks` (which IS stored) every
  // tick by stageOf, never itself persisted (Task 3).
  // `haulTargetId`, `haulPhase`, `haulTicksLeft` and `carrying` are real state
  // too, but HaulTrip (Task 4) is deliberately runtime-only for good: a hauler
  // caught mid-trip banks its carried load into the saved stockpile instead
  // (Task 6), so the trip itself never has a save-record counterpart to agree
  // with. `haulPhase`/`haulTicksLeft` joined the snapshot in increment 5 to
  // drive the dot's position from the trip's real duration (OBS-4-09) — same
  // component, same runtime-only status. `haulLegTicks`/`haulPickupCol`/
  // `haulPickupRow` joined the same way for the same reason: they stop the
  // layout re-deriving a leg's length and a returning hauler's origin from the
  // building's LIVE tile, which desyncs once the building moves mid-leg
  // (OBS-5-01) — still HaulTrip, still never saved.
  // `starvingTicks` used to sit in this list too: real persistent state, just
  // not yet saved. SavedColonist now carries it (mirroring ageTicks), so it is
  // covered by default like everything else — see the dedicated round-trip
  // test below for the property this list can't express (per-colonist values,
  // not merely "the field exists").
  // `homeId` sits here for the identical reason `starvingTicks` once did: real
  // decision state (Task 6's Home component — its own doc comment says
  // "Saved (v5)"), just not yet saved. Task 6 stops short of the save-format
  // bump; a future task adds SavedColonist.homeId and this graduates out of
  // the list, the same way starvingTicks did.
  // `commuteTiles` and `commuteFactor` are in the list for the FIRST reason,
  // not `homeId`'s: they are recomputed every tick from two entities' live
  // positions, exactly like `efficiency` and `stage`, so there is nothing to
  // persist and nothing awaiting a save bump. (They will still change when
  // `homeId` graduates — a restored colonist starts homeless until rehome
  // runs — but that is a consequence of homeId's absence, not a second field
  // waiting on the same bump.)
  const DERIVED = [
    'efficiency', 'stage', 'haulTargetId', 'haulPhase', 'haulTicksLeft', 'haulLegTicks', 'haulPickupCol', 'haulPickupRow',
    'carrying', 'homeId', 'commuteTiles', 'commuteFactor',
  ] as const;

  function persisted(workers: readonly object[]): Record<string, unknown>[] {
    return workers.map((w) => {
      const copy: Record<string, unknown> = { ...w };
      for (const key of DERIVED) delete copy[key];
      return copy;
    });
  }

  /**
   * A colony with a staffed worker, a genuine hauler, live tool coverage,
   * hunger history and batch progress. Both save-v3 additions need REAL state
   * to be worth persisting: 60 ticks of unhauled forester production stalls
   * its buffer at the output cap (produced, not hand-set), and dispatching
   * assignHauler puts a second worker genuinely into job.hauling.
   */
  async function busyColony() {
    const save = initialSave();
    save.stockpile = { wood: 100, tools: 10, berries: 50 };
    const engine = await GameEngine.create(save);
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    engine.dispatch({ type: 'assignWorker', buildingId: engine.snapshot!.buildings[0].id });
    for (let i = 0; i < 60; i++) await engine.stepOnce();
    // The forester's buffer is now stalled at the output cap (nowhere left to
    // bank a finished batch). Assign a hauler and step ONCE more so hauling
    // turns genuinely true on a real worker — but stop right there: dispatch()
    // only points the trip at its target this tick, and load() (which would
    // empty the buffer) is still two ticks away. The buffer this test group
    // samples is therefore real, un-hauled production, not a pile a hauler
    // already cleared.
    engine.dispatch({ type: 'assignHauler' });
    await engine.stepOnce();
    return engine;
  }

  it('the query path, the walk path and serialize() report the same facts', async () => {
    const engine = await busyColony();
    const fromQueryPath = engine.snapshot!.colonists.map((w) => ({ ...w }));

    // force the walk path over the same unchanged world
    refreshEntitySections((engine as unknown as { world: IRuntimeWorld }).world);
    expect(engine.snapshot!.colonists.map((w) => ({ ...w }))).toEqual(fromQueryPath);

    // and the save projection must agree on every field it shares
    const saved = engine.serialize().workers;
    expect(persisted(fromQueryPath)).toEqual(saved.map((w) => ({ ...w })));
  });

  it('every non-derived worker fact is represented in the save record', async () => {
    const engine = await busyColony();
    const factKeys = Object.keys(engine.snapshot!.colonists[0])
      .filter((key) => !DERIVED.includes(key as (typeof DERIVED)[number]));
    const savedKeys = Object.keys(engine.serialize().workers[0]);
    expect(factKeys.filter((key) => !savedKeys.includes(key))).toEqual([]);
  });

  it('every persisted worker fact survives save -> restore', async () => {
    const engine = await busyColony();
    const before = persisted(engine.snapshot!.colonists);
    // Guard against vacuous coverage: busyColony's hauler must actually show up
    // hauling here, or the comparison below would pass just as happily with
    // hauling dropped entirely from the save (every worker reads false either way).
    expect(before.some((w) => w.hauling)).toBe(true);
    const restored = await GameEngine.create(engine.serialize());
    expect(persisted(restored.snapshot!.colonists)).toEqual(before);
  });

  it('a building keeps its buffered goods across save -> restore', async () => {
    const engine = await busyColony();
    // Ground truth from the live query path (buildingFactsOf), never from
    // serialize() (savedBuildingOf) — comparing a save against itself would
    // pass even if the save format dropped the buffer entirely.
    const before = engine.snapshot!.buildings[0].buffered;
    expect(before).toBeGreaterThan(0); // guard: otherwise this comparison is vacuous
    const restored = await GameEngine.create(engine.serialize());
    // buildInitialSnapshot recomputes `buffered` as the sum of restored
    // SavedBuilding.buffer, so this agreeing on the value proves the buffer
    // map itself round-tripped, not just its key.
    expect(restored.snapshot!.buildings[0].buffered).toBe(before);
  });

  it('every non-derived building fact is represented in the save record', async () => {
    const engine = await busyColony();
    // workerSlots and progressPct/state/workPower/tooledWorkers are display-derived.
    // buffered is a derived aggregate too, not a save-format gap: it is the SUM
    // of this building's buffer map, and the buffer map is the thing that
    // actually persists (SavedBuilding.buffer, save v3) — buildInitialSnapshot
    // recomputes the total from it on restore. Storing the sum a second time
    // would be exactly the second-source-of-truth this file avoids elsewhere
    // (see savedColonistOf's comment re: efficiency), so — like workPower and
    // progressPct — it has no save slot of its own. beds is derived exactly
    // like workerSlots: a content-catalog constant looked up by defId
    // (BUILDINGS[b.defId].beds), never a per-building save fact. occupants is
    // derived like buffered, but from a live pointer rather than a stored map
    // — it counts colonists whose home points here (Task 6), so it has no
    // save slot of its own either.
    const derivedBuilding = [
      'workers', 'workerSlots', 'state', 'progressPct', 'tooledWorkers', 'workPower', 'buffered', 'beds', 'occupants',
    ];
    const factKeys = Object.keys(engine.snapshot!.buildings[0]).filter((k) => !derivedBuilding.includes(k));
    const savedKeys = Object.keys(engine.serialize().buildings[0]);
    expect(factKeys.filter((key) => !savedKeys.includes(key))).toEqual([]);
  });
});

describe('buildColonyPrepWorld system order', () => {
  // OBS-4-03's stronger form: two harnesses ran systems in the reverse of
  // production order for a whole increment, which silently changed what they
  // proved and produced a real false positive. Reordering them fixed the two
  // known cases; this makes the wrong order impossible to express at all.
  it('accepts a subset in ALL_SYSTEMS order', () => {
    expect(() => buildColonyPrepWorld({ systems: [CommandSystem, HaulSystem, SnapshotSystem] })).not.toThrow();
  });

  it('rejects a subset in the reverse of production order, naming both systems', () => {
    expect(() => buildColonyPrepWorld({ systems: [HaulSystem, CommandSystem] }))
      .toThrow(/CommandSystem runs after HaulSystem/);
  });

  it('rejects an out-of-order pair even with correctly ordered systems around it', () => {
    expect(() => buildColonyPrepWorld({ systems: [CommandSystem, SnapshotSystem, HaulSystem] }))
      .toThrow(/must match ALL_SYSTEMS/);
  });

  it('lets a test-only system sit anywhere, since ALL_SYSTEMS says nothing about it', () => {
    const arrange = () => CommandSystem(); // a factory that is not in ALL_SYSTEMS
    // First is the shape stats-system.test.ts actually uses — an arrange system
    // staging state ahead of the real ones — and is the case that distinguishes
    // "skipped" from "sorted": if an unknown system took a rank, every known
    // system after it would look out of order.
    expect(() => buildColonyPrepWorld({ systems: [arrange, HaulSystem, SnapshotSystem] })).not.toThrow();
    expect(() => buildColonyPrepWorld({ systems: [HaulSystem, arrange, SnapshotSystem] })).not.toThrow();
    expect(() => buildColonyPrepWorld({ systems: [HaulSystem, SnapshotSystem, arrange] })).not.toThrow();
  });

  it('accepts ALL_SYSTEMS itself — the order production actually runs', () => {
    expect(() => buildColonyPrepWorld({ systems: ALL_SYSTEMS })).not.toThrow();
  });
});
