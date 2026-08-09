import { describe, expect, it } from 'vitest';
import { BALANCE, MAX_AGE_TICKS } from '../../src/engine/content/balance';
import { lifespanFor } from '../../src/shared/population';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import { Building, Hunger, JobAssignment, Relocation, ToolCoverage, Colonist } from '../../src/engine/components';
import { IdCounter, RemovalLedger, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import type { IRuntimeWorld } from 'sim-ecs';
import { GameEngine } from '../../src/engine/game-engine';
import {
  ALL_SYSTEMS, applyRemovals, buildColonyPrepWorld, createColonyWorld, decideLoad, getPrepResource, initialSave, isLoadableSave,
  prepareLoadedSave, refreshEntitySections,
} from '../../src/engine/world';
import { buildSaveFromWorld } from '../../src/engine/game-engine';
import { CommandSystem } from '../../src/engine/systems/command-system';
import { HaulSystem } from '../../src/engine/systems/haul-system';
import { SnapshotSystem } from '../../src/engine/systems/snapshot-system';
import type { SavedColonist, SaveGameV5 } from '../../src/shared/save';
import { isSaveGameV4, MAX_SAVED_ENTITIES } from '../../src/shared/save';
import { autoPlaceSequence, DEFAULT_MAP, MAX_MAP, relocationTicks, type TileRef } from '../../src/shared/placement';
import type { Command } from '../../src/shared/commands';
import type { Snapshot } from '../../src/shared/snapshot';
import { stepTick } from './fixtures';

describe('initialSave', () => {
  it('matches the spec starting state', () => {
    const save = initialSave();
    expect(save.stockpile).toEqual({ wood: 30, berries: 20 });
    expect(save.colonists).toHaveLength(3);
    expect(save.colonists.map((c) => c.id)).toEqual([2, 3, 4]);
    expect(save.tick).toBe(0);
    expect(save.nextEntityId).toBe(5);
  });

  it('opens with one house, everyone already in it, and one bed to spare', () => {
    // The only pre-placed building in the game. A house costs planks, planks
    // need a sawmill, and 30 wood cannot reach one for a long time — so
    // without this the whole opening runs at homelessFactor for reasons the
    // player cannot act on.
    const save = initialSave();
    expect(save.buildings.map((b) => b.defId)).toEqual(['house']);
    const house = save.buildings[0];
    expect(save.colonists.every((c) => c.homeId === house.id)).toBe(true);
    expect(save.colonists).toHaveLength(BALANCE.houseBeds - 1); // one spare bed, the first growth decision
    expect(isLoadableSave(save)).toBe(true);
  });

  it('staggers founder ages so they do not all die on one tick', () => {
    const ages = initialSave().colonists.map((c) => c.ageTicks);
    expect(new Set(ages).size).toBe(ages.length);
    for (const age of ages) {
      expect(age).toBeGreaterThanOrEqual(BALANCE.lifeBands.matureTicks); // adults, able to work from tick 0
      expect(age).toBeLessThan(BALANCE.lifeBands.retireTicks);
    }
  });

  it('starts past the birth cooldown rather than inside it', () => {
    // The sentinel, not 0: a fresh colony's first otherwise-eligible birth
    // must not be blocked for 50 ticks by a cooldown nothing ever spent.
    expect(initialSave().lastBirthTick).toBe(-BALANCE.birthCooldownTicks);
  });
});

/** The producer `dispatchMixedDrain` staffs, in the fixture right below. */
const MIXED_FORESTER_ID = 7;

/**
 * A colony with the slack to accept all five commands in one tick: three
 * shelters (so a relocation and a demolition can each take one and a bed is
 * still left for the nomad), a producer to staff, food past the nomad gate and
 * materials for a house.
 */
function colonyWithRoomToDoEverything(): SaveGameV5 {
  const save = initialSave();
  const plot = (id: number, defId: 'house' | 'forester', col: number) =>
    ({ id, defId, progress: 0, batchActive: false, col, row: 1, buffer: {}, relocatingTicks: 0 }) as const;
  save.buildings.push(plot(5, 'house', 6), plot(6, 'house', 8), plot(MIXED_FORESTER_ID, 'forester', 10));
  save.stockpile = { wood: 500, planks: 500, bread: 5000 };
  save.nextEntityId = MIXED_FORESTER_ID + 1;
  return save;
}

/** The first `count` buildable tiles nothing stands on, in placement order. */
function freeTiles(snap: Snapshot, count: number): TileRef[] {
  const taken = new Set(snap.buildings.map((b) => `${b.col},${b.row}`));
  const found: TileRef[] = [];
  for (const tile of autoPlaceSequence(DEFAULT_MAP)) {
    if (!taken.has(`${tile.col},${tile.row}`)) found.push(tile);
    if (found.length === count) return found;
  }
  throw new Error('no free tile left for the mixed drain');
}

/**
 * Five commands into ONE drain: construct, relocate, demolish, recruit and
 * assign.
 *
 * The house that moves is the one an arrival would be offered — the lowest id
 * with a bed free, which is exactly what `shelterWithRoom` picks — because a
 * relocation and an arrival contending for the SAME house is the pairing that
 * produced the dangling `homeId`. Moving any other house leaves the two
 * commands independent and the drain proves nothing. `recruitFirst` puts the
 * nomad on either side of that relocation: one order needs the move to evict
 * an arrival it cannot see in its query, the other needs the arrival to see a
 * relocation started moments earlier in the same drain.
 */
function dispatchMixedDrain(engine: GameEngine, snap: Snapshot, recruitFirst: boolean): void {
  const settled = snap.buildings.filter((b) => b.beds > 0 && b.relocatingTicks === 0);
  const contended = settled.filter((b) => b.occupants < b.beds).sort((a, b) => a.id - b.id)[0];
  const doomed = settled.filter((b) => b.id !== contended.id).sort((a, b) => b.id - a.id)[0];
  const [buildAt, moveTo] = freeTiles(snap, 2);
  const recruit: Command = { type: 'recruitWorker' };
  const move: Command = { type: 'moveBuilding', buildingId: contended.id, to: moveTo };
  const drain: Command[] = [
    { type: 'constructBuilding', buildingDefId: 'house', at: buildAt },
    ...(recruitFirst ? [recruit, move] : [move, recruit]),
    { type: 'assignWorker', buildingId: MIXED_FORESTER_ID },
    { type: 'demolishBuilding', buildingId: doomed.id },
  ];
  for (const command of drain) engine.dispatch(command);
}

describe('isLoadableSave', () => {
  it('accepts a fresh initial save', () => {
    expect(isLoadableSave(initialSave())).toBe(true);
  });

  it('rejects unknown building def ids', () => {
    const save = initialSave();
    save.buildings.push({ id: 5, defId: 'castle' as never, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a worker buildingId referencing a nonexistent building', () => {
    const save = initialSave();
    save.colonists[0].buildingId = 99; // an id no entity in this save holds
    expect(isLoadableSave(save)).toBe(false);
  });

  // A colonist WORKS at a producer and SLEEPS in a settled shelter, and
  // neither reference may name the other kind. All four rules below reject
  // rather than repair, because no engine version could have written them —
  // as distinct from the over-capacity and non-adult cases further down,
  // which a BALANCE retune genuinely produces and which are clamped at load.
  //
  // One test per rule, each against an otherwise-identical control: a fixture
  // that trips two at once proves neither.
  describe('a home and a job must each name the right kind of building', () => {
    /** initialSave() plus one producer, off the starter house's tile. */
    function withForester() {
      const save = initialSave();
      save.buildings.push({
        id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0,
      });
      save.nextEntityId = 6;
      return save;
    }

    it('rejects a homeId naming a building the save does not contain', () => {
      expect(isLoadableSave(initialSave())).toBe(true); // control
      const dangling = initialSave();
      dangling.colonists[0].homeId = 99;
      expect(isLoadableSave(dangling)).toBe(false);
    });

    it('rejects a homeId naming a building with no beds', () => {
      // The building IS in the save, so the presence rule above is satisfied
      // and only "it has beds" can fail: a colonist cannot live in a forester.
      expect(isLoadableSave(withForester())).toBe(true); // control
      const inAForester = withForester();
      inAForester.colonists[0].homeId = 5;
      expect(isLoadableSave(inAForester)).toBe(false);
    });

    it('rejects a homeId naming a house that is mid-relocation', () => {
      // A house in transit has no usable beds: `beds.total` excludes it and
      // rehome evicts its residents on sight. handleMoveBuilding sets the
      // countdown and never touches homes — eviction is rehome's, running
      // later in the same tick and before the end-of-tick autosave — so the
      // pairing cannot reach a save file. Nothing in BALANCE can turn an
      // evicted resident back into a housed one, which is why this rejects
      // where over-capacity repairs.
      expect(isLoadableSave(initialSave())).toBe(true); // control: same house, settled
      const moving = initialSave();
      moving.buildings[0].relocatingTicks = 6;
      expect(isLoadableSave(moving)).toBe(false);
    });

    it('rejects a buildingId naming a building with no recipe', () => {
      // The house exists, so the id-membership check alone accepts this. The
      // result would be permanent and silent: the colonist publishes as
      // `1 / 0` workers on a zero-slot building, drops out of idleAdults, and
      // produces nothing forever, because ProductionSystem skips recipe-less
      // buildings. No command can create the assignment.
      const control = withForester();
      control.colonists[0].buildingId = 5;
      expect(isLoadableSave(control)).toBe(true);
      const staffingAHouse = withForester();
      staffingAHouse.colonists[0].buildingId = 1; // the starter house
      expect(isLoadableSave(staffingAHouse)).toBe(false);
    });

    // Every test above is a HAND-BUILT fixture, so between them they pin the
    // four rules and not the premise the rules rest on — that no version of
    // the engine could write the states they refuse. A fixture cannot check
    // that premise, because it is built from the same assumption the guard
    // encodes; only the engine's own output can. And the premise was FALSE for
    // rule 3: a nomad drained alongside a `moveBuilding` produced exactly the
    // `homeId` -> relocating-house pairing it rejects (fixed in 4012dd2), so
    // `decideLoad` answered `{kind:'backup'}` and the shell would have moved a
    // live colony aside and started a fresh one.
    //
    // Commands INTERACTING inside one drain is what breaks the circularity —
    // one command at a time is what the fixtures already model. Driven through
    // GameEngine, so the assertion covers `serialize()`, the very call the
    // autosave listener is handed.
    it('accepts every autosave a live mixed command drain produces', async () => {
      const engine = await GameEngine.create(colonyWithRoomToDoEverything());
      const step = async () => {
        await engine.stepOnce();
        // isLoadableSave, per tick, over what the autosave would have written.
        expect(isLoadableSave(engine.serialize())).toBe(true);
      };
      const said = (pattern: RegExp) => engine.snapshot!.notices.some((n) => pattern.test(n.message));

      // Ordinary running first, and again between and after the drains: an
      // autosave lands on whatever tick the modulo picks, not only on the
      // interesting ones.
      for (let i = 0; i < 3; i++) await step();
      for (const recruitFirst of [true, false]) {
        dispatchMixedDrain(engine, engine.snapshot!, recruitFirst);
        await step();
        // Not vacuous: all five commands must have been ACCEPTED on this one
        // tick. A drain whose nomad was quietly refused for want of a bed
        // never puts an arrival and a relocation in contention at all, which
        // is the whole interaction under test.
        expect({
          built: said(/Built a House/), joined: said(/joined the colony/), moved: said(/Moved the/),
          assigned: said(/Assigned a worker/), demolished: said(/Demolished the/),
        }).toEqual({ built: true, joined: true, moved: true, assigned: true, demolished: true });
        // Past the recruit cooldown before the second drain, so its nomad is
        // gated on beds — the thing under test — and not on patience.
        for (let i = 0; i < BALANCE.recruitCooldownTicks + 1; i++) await step();
      }

      // And the consequence the rules exist to avoid, named: the shell restores
      // this colony rather than filing it as corrupt.
      expect(decideLoad(engine.serialize()).kind).toBe('restore');
    });
  });

  it('rejects a worker holding both a valid buildingId and hauling: true (one worker, two jobs)', () => {
    const save = initialSave();
    const building = { id: 5, defId: 'forester' as const, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 };
    save.buildings.push(building);
    save.nextEntityId = 6;
    save.colonists[0].buildingId = building.id; // a real building — the membership check alone would accept this
    save.colonists[0].hauling = true;
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
    negativeHunger.colonists[0].hunger = -1;
    expect(isLoadableSave(negativeHunger)).toBe(false);
    const tooled = initialSave();
    tooled.colonists[0].toolTicks = -1;
    expect(isLoadableSave(tooled)).toBe(false);
    const fractionalTool = initialSave();
    fractionalTool.colonists[0].toolTicks = 1.5;
    expect(isLoadableSave(fractionalTool)).toBe(false);
  });

  it('rejects a non-numeric, NaN, negative, or fractional ageTicks (a corrupted save must not silently kill the colonist)', () => {
    // The exact failure this closes: clampedAge(NaN) is
    // Math.max(0, Math.min(NaN, MAX_AGE_TICKS)) === NaN, and resolveOldAge's
    // `row.age.ticks < lifespanFor(...)` guard is false either way for NaN, so
    // its `continue` never fires — the colonist would be removed on the very
    // first tick after load instead of the save taking the corrupt-backup path.
    const nonNumeric = initialSave();
    nonNumeric.colonists[0].ageTicks = 'abc' as never;
    expect(isLoadableSave(nonNumeric)).toBe(false);
    const nan = initialSave();
    nan.colonists[0].ageTicks = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.colonists[0].ageTicks = -1;
    expect(isLoadableSave(negative)).toBe(false);
    const fractional = initialSave();
    fractional.colonists[0].ageTicks = 1.5;
    expect(isLoadableSave(fractional)).toBe(false);
  });

  it('requires ageTicks now that v5 always writes it, and grandfathers any non-negative value', () => {
    // The v4 record made it optional so an in-progress lifespan could survive
    // a save before v5 existed; v5 promotes it, so an absent field is now a
    // record no engine version could write rather than an old one.
    const withoutAge = initialSave() as unknown as { colonists: Record<string, unknown>[] };
    delete withoutAge.colonists[0].ageTicks;
    expect(isLoadableSave(withoutAge)).toBe(false);
    const withAge = initialSave();
    withAge.colonists[0].ageTicks = 500;
    expect(isLoadableSave(withAge)).toBe(true);
  });

  it('rejects a non-numeric, NaN, negative, or fractional starvingTicks (a corrupted save must not silently resume a starvation clock)', () => {
    const nonNumeric = initialSave();
    nonNumeric.colonists[0].starvingTicks = 'abc' as never;
    expect(isLoadableSave(nonNumeric)).toBe(false);
    const nan = initialSave();
    nan.colonists[0].starvingTicks = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.colonists[0].starvingTicks = -1;
    expect(isLoadableSave(negative)).toBe(false);
    const fractional = initialSave();
    fractional.colonists[0].starvingTicks = 1.5;
    expect(isLoadableSave(fractional)).toBe(false);
  });

  it('requires starvingTicks for the same reason, and grandfathers any non-negative value', () => {
    const withoutIt = initialSave() as unknown as { colonists: Record<string, unknown>[] };
    delete withoutIt.colonists[0].starvingTicks;
    expect(isLoadableSave(withoutIt)).toBe(false);
    const withIt = initialSave();
    withIt.colonists[0].starvingTicks = 40;
    expect(isLoadableSave(withIt)).toBe(true);
  });

  it('accepts and grandfathers balance-coupled values above CURRENT balance (spec 4.5: saves survive retuning)', () => {
    // hunger/toolTicks above current BALANCE were valid under a prior, higher
    // balance value; the guard no longer rejects them (spawnColonist clamps instead).
    const hungry = initialSave();
    hungry.colonists[0].hunger = 1000;
    expect(isLoadableSave(hungry)).toBe(true);
    const overTooled = initialSave();
    overTooled.colonists[0].toolTicks = 999999; // above toolDurationTicks (300), within MAX_SAVED_COUNTER
    expect(isLoadableSave(overTooled)).toBe(true);
    // an active batch's progress above the CURRENT recipe's ticksPerBatch (3) is
    // grandfathered: the production while-loop deterministically absorbs it.
    const overworked = initialSave();
    overworked.buildings.push({ id: 5, defId: 'forester', progress: 99, batchActive: true, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    overworked.nextEntityId = 6;
    expect(isLoadableSave(overworked)).toBe(true);
    // magnitude is harmless: spawnBuilding clamps active progress to the
    // CURRENT batch size, so even absurd values load without loop hazards.
    const astronomical = initialSave();
    astronomical.buildings.push({ id: 5, defId: 'forester', progress: 1e308, batchActive: true, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    astronomical.nextEntityId = 6;
    expect(isLoadableSave(astronomical)).toBe(true);
  });

  it('clamps oversized active progress to the current batch size on load', async () => {
    const save = initialSave();
    save.buildings.push({ id: 5, defId: 'forester', progress: 1e308, batchActive: true, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    save.nextEntityId = 6;
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.buildings.find((b) => b.id === 5)!.progress).toBeLessThanOrEqual(3); // forester ticksPerBatch
  });

  it('accepts and grandfathers more assigned workers than a building CURRENTLY has slots (spec 4.5)', () => {
    // slots retuned down after this save was written must not orphan it; assign
    // commands already validate against current slots, so this self-corrects.
    const save = initialSave();
    const building = { id: 5, defId: 'forester' as const, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 6;
    save.colonists = [2, 3, 4].map((id) => ({
      id, hunger: 0, buildingId: building.id, toolTicks: 0, hauling: false,
      ageTicks: BALANCE.startingAgeTicks, homeId: 1, starvingTicks: 0,
    }));
    expect(isLoadableSave(save)).toBe(true);
  });

  it('rejects a negative or fractional relocatingTicks (a record no engine version could write)', () => {
    // Structural/identity, not balance: unlike an oversized countdown (clamped
    // at spawn instead, see "clamps oversized relocatingTicks" below), negative
    // or fractional values are impossible for any version of ProductionSystem's
    // decrementing loop to have produced, so the load guard rejects them outright.
    const negative = initialSave();
    negative.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: -1 });
    negative.nextEntityId = 6;
    expect(isLoadableSave(negative)).toBe(false);

    const fractional = initialSave();
    fractional.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 1.5 });
    fractional.nextEntityId = 6;
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
    expect(written.buildings.map((b) => b.defId)).toEqual(['house']); // only the starter house: creation refused at the ceiling
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
    inherited.buildings.push({ id: 5, defId: 'toString' as never, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
  });

  it('rejects inactive-batch progress but accepts active progress above the CURRENT recipe size (spec 4.5)', () => {
    // active progress at/above ticksPerBatch is grandfathered: a recipe retuned
    // smaller after this save was written must not orphan it (production
    // deterministically absorbs the overshoot on the next tick).
    const completed = initialSave();
    completed.buildings.push({ id: 5, defId: 'forester', progress: 3, batchActive: true, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }); // == ticksPerBatch
    completed.nextEntityId = 6;
    expect(isLoadableSave(completed)).toBe(true);
    // stalled/idle buildings never bank progress: this is a balance-independent
    // engine invariant, so it's still rejected.
    const banked = initialSave();
    banked.buildings.push({ id: 5, defId: 'forester', progress: 1, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }); // inactive with progress
    expect(isLoadableSave(banked)).toBe(false);
  });

  it('rejects duplicate ids shared across buildings and workers', () => {
    const save = initialSave();
    save.buildings.push({ id: 3, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }); // collides with worker 3
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects nextEntityId that does not exceed every saved id', () => {
    const save = initialSave();
    save.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 });
    save.nextEntityId = 5; // must be strictly greater than the max id (5)
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects saves with absurd entity counts before walking them', () => {
    const flooded = initialSave();
    flooded.colonists = Array.from({ length: MAX_SAVED_ENTITIES + 1 }, (_, index) => ({
      id: index + 2, // 1 is the starter house
      hunger: 0,
      buildingId: null,
      toolTicks: 0,
      hauling: false,
      ageTicks: BALANCE.startingAgeTicks,
      homeId: null,
      starvingTicks: 0,
    }));
    flooded.nextEntityId = MAX_SAVED_ENTITIES + 3;
    expect(isLoadableSave(flooded)).toBe(false);
  });

  it('rejects positions off the map, on the camp band, or stacked on one tile', () => {
    const outOfBounds = initialSave();
    outOfBounds.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 24, row: 1, buffer: {}, relocatingTicks: 0 });
    outOfBounds.nextEntityId = 6;
    expect(isLoadableSave(outOfBounds)).toBe(false);

    const onCamp = initialSave();
    onCamp.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 2, row: 1, buffer: {}, relocatingTicks: 0 });
    onCamp.nextEntityId = 6;
    expect(isLoadableSave(onCamp)).toBe(false);

    const stacked = initialSave();
    stacked.buildings.push(
      { id: 5, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 5, buffer: {}, relocatingTicks: 0 },
      { id: 6, defId: 'farm', progress: 0, batchActive: false, col: 5, row: 5, buffer: {}, relocatingTicks: 0 },
    );
    stacked.nextEntityId = 7;
    expect(isLoadableSave(stacked)).toBe(false);
  });

  it('rejects a v3 save with buildings missing col/row', () => {
    const save = initialSave();
    save.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false } as never);
    save.nextEntityId = 6;
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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      buffer: { wood: BALANCE.outputBufferCap + 1 }, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === 5)!;
    expect(seeded.buffered).toBe(BALANCE.outputBufferCap);
  });

  it('rejects a buffer naming a resource the catalog does not have', () => {
    const save = initialSave();
    save.buildings.push({
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      buffer: { unobtainium: 1 } as never, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      buffer: buffer as never, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      buffer: { wood: -5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('restores buffered goods into the building that held them', async () => {
    const save = initialSave();
    save.buildings.push({
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: { wood: 5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
    const world = await createColonyWorld(save);
    expect(world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === 5)!.buffered).toBe(5);
  });

  it('clamps a multi-resource over-cap buffer deterministically, trimming in catalog order', async () => {
    const cap = BALANCE.outputBufferCap;
    const [first, second, third] = RESOURCE_IDS;
    const save = initialSave();
    save.buildings.push({
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      // `first` fits whole; `second` only partially (whatever room is left);
      // `third` has no room at all left and must be dropped entirely.
      buffer: { [first]: cap - 1, [second]: cap, [third]: cap }, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(true);

    const engine = await GameEngine.create(save);
    const buffer = engine.serialize().buildings.find((b) => b.id === 5)!.buffer;

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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1,
      buffer: { wood: BALANCE.outputBufferCap + 5 }, relocatingTicks: 0,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(true);

    const engine = await GameEngine.create(save);
    const written = engine.serialize();
    expect(written.buildings.find((b) => b.id === 5)!.buffer.wood).toBe(BALANCE.outputBufferCap); // clamped, not the original over-cap amount
    expect(isLoadableSave(written)).toBe(true);
  });
});

// Three states a save can arrive in that a BALANCE retune genuinely produces,
// so the load principle repairs them instead of orphaning the save (contrast
// the four reference rules above, which no engine version could write). All
// three are repaired at LOAD rather than on the first tick: a restored engine
// starts paused, so a repair that waits for tick 1 is a state the player looks
// at — and acts on — for as long as they leave it there.
describe('balance-coupled states a save is repaired into, not rejected for', () => {
  // Well clear of the roster's ids below, so a fixture can add colonists
  // without ever colliding with it.
  const FORESTER_ID = 50;

  /** initialSave() plus a producer, and exactly the roster the caller names. */
  function saveWith(colonists: Partial<SavedColonist>[]): SaveGameV5 {
    const save = initialSave();
    save.buildings.push({
      id: FORESTER_ID, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0,
    });
    save.colonists = colonists.map((overrides, index) => ({
      id: index + 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: BALANCE.startingAgeTicks, homeId: 1, starvingTicks: 0, ...overrides,
    }));
    save.nextEntityId = FORESTER_ID + 1;
    return save;
  }

  it('evicts down to capacity when a save puts more colonists in a house than it has beds', async () => {
    // What a houseBeds retune from 5 to 4 produces. Rejecting would orphan the
    // save for a balance change; the load principle says clamp, not refuse.
    const save = saveWith(Array.from({ length: BALANCE.houseBeds + 1 }, () => ({})));
    expect(isLoadableSave(save)).toBe(true); // accepted, then repaired
    const world = await createColonyWorld(save);

    // BEFORE any tick. Leaving the repair to rehome would display five
    // residents in a four-bed house, zero homeless, and work power based on
    // assignments the engine is about to revoke, for as long as the player
    // leaves it paused.
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.buildings.find((b) => b.beds > 0)!.occupants).toBe(BALANCE.houseBeds);
    expect(seeded.homeless).toBe(1);
    // Ascending colonist id fills first, so the HIGHEST id is the one
    // displaced — rehome's own rule, which is what makes reload stable.
    expect(seeded.colonists.filter((c) => c.homeId === null).map((c) => c.id)).toEqual([BALANCE.houseBeds + 2]);

    await stepTick(world);
    const snap = world.getResource(SnapshotStore).latest!;
    expect(snap.buildings.find((b) => b.beds > 0)!.occupants).toBe(BALANCE.houseBeds);
    expect(snap.homeless).toBe(1); // the surplus, not silently over capacity
  });

  it('does not evict down to the beds of a RELOCATING house — that is not an over-capacity save', async () => {
    // Same fixture as above, one field changed: the house they all name is in
    // transit. That makes it a rule-3 record the guard refuses outright, not a
    // `houseBeds` retune to repair — so `restoredColonists` must leave every
    // one of them exactly as written, the way it already leaves a `homeId`
    // naming nothing at all.
    //
    // Unreachable through the guard, but `createColonyWorld` is called
    // directly with unvalidated saves, and its bed map was the one place a
    // relocating shelter still counted as usable: it seated four of the five
    // and evicted the fifth, half-repairing a state no repair applies to.
    const save = saveWith(Array.from({ length: BALANCE.houseBeds + 1 }, () => ({})));
    save.buildings[0].relocatingTicks = 6;      // the house every colonist here names
    expect(isLoadableSave(save)).toBe(false);   // ...which is exactly why the guard refuses it

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists.every((c) => c.homeId === 1)).toBe(true); // nobody quietly displaced
    expect(seeded.homeless).toBe(0);

    // And leaving it alone is safe because the repair that DOES apply happens
    // on the first tick: rehome evicts every resident of a house in transit.
    await stepTick(world);
    expect(world.getResource(SnapshotStore).latest!.homeless).toBe(BALANCE.houseBeds + 1);
  });

  it('a retune that raises matureTicks does not seed a child as staff', async () => {
    // Only a retune can produce this record, so it is repaired rather than
    // rejected. Asserted BEFORE any tick: standDownNonAdults would fix it on
    // tick 1, and a paused engine never reaches tick 1.
    const save = saveWith([{ ageTicks: BALANCE.lifeBands.matureTicks - 1, buildingId: FORESTER_ID }]);
    // ACCEPTED, then repaired — the distinction this test exists to draw, and
    // the one the over-capacity case above already pins. Without this line the
    // test passes just as happily against a guard that REJECTED the save, since
    // createColonyWorld never consults isLoadableSave.
    expect(isLoadableSave(save)).toBe(true);
    const world = await createColonyWorld(save);

    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists[0].buildingId).toBeNull();
    const forester = seeded.buildings.find((b) => b.id === FORESTER_ID)!;
    expect(forester.workers).toBe(0);
    expect(forester.workPower).toBe(0);
  });

  it('a retune that lowers retireTicks does not seed an elder still hauling', async () => {
    // The other end of the same band, and the other field the repair clears:
    // `hauling` would otherwise leave a retired colonist counted as a working
    // hauler in the seeded snapshot, at full carry capacity.
    const save = saveWith([{ ageTicks: BALANCE.lifeBands.retireTicks, hauling: true }]);
    expect(isLoadableSave(save)).toBe(true); // accepted, then repaired — see above
    const world = await createColonyWorld(save);

    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists[0].stage).toBe('elder'); // fixture precondition
    expect(seeded.colonists[0].hauling).toBe(false);
  });

  it('never announces a band a colonist crossed OUTSIDE this session', async () => {
    // What the OBS-6-03 equality trigger rests on. `announceBandChanges` fires
    // on `age.ticks === matureTicks` / `=== retireTicks`, so a colonist
    // restored PAST a boundary — only a retune can write one — never meets it.
    // That is the intended reading, not a gap: the crossing happened while
    // nobody was playing, so it is a repair like the two cases above rather
    // than an event in the colony's life, and announcing it on load would
    // report something that never happened.
    const bands = BALANCE.lifeBands;
    const save = saveWith([
      { ageTicks: bands.retireTicks + 137 },  // a lowered retireTicks
      { ageTicks: bands.matureTicks + 40 },   // a lowered matureTicks
      { ageTicks: bands.retireTicks },        // sitting exactly ON a boundary at load
      { ageTicks: bands.matureTicks },
      // The last two crossed INSIDE this session: restored one tick SHORT of a
      // boundary, `ageEveryone` lands them exactly on it and the equality
      // fires. They are here rather than in a test of their own because they
      // are what makes the four above mean anything — every assertion on those
      // four is a silence, and a silence passes just as happily against an
      // `announceBandChanges` deleted outright. Announced and silent colonists
      // in ONE world on ONE tick is the only arrangement that tells the two
      // apart.
      //
      // They are also what rules out a save/load DOUBLE announcement. The pair
      // sitting exactly ON a boundary is silent because `ageEveryone` carries
      // it to `boundary + 1` before the phase runs — not because the phase is
      // dead, which these two now prove — so a colonist announced on the tick
      // it crossed, saved, and reloaded is not announced a second time.
      //
      // Homeless (`homeId: null`) so the four above keep the house's four beds
      // and no over-capacity eviction runs: this fixture is about bands.
      { ageTicks: bands.retireTicks - 1, homeId: null },
      { ageTicks: bands.matureTicks - 1, homeId: null },
    ]);
    expect(isLoadableSave(save)).toBe(true); // accepted, then repaired — see above
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    // fixture precondition: the two crossers have NOT crossed yet at load
    expect(seeded.colonists.map((c) => c.stage)).toEqual(['elder', 'adult', 'elder', 'adult', 'adult', 'child']);
    expect(seeded.notices).toEqual([]); // and nothing is announced AT load, crossers included

    // Several ticks, not one: an inequality in place of the equality would
    // re-announce all four on EVERY tick, which a single step could not tell
    // apart from a one-off announcement at load — and would re-announce the
    // two crossers every tick after their own, which is the same defect seen
    // from the other side.
    const perTick: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await stepTick(world);
      perTick.push(world.getResource(SnapshotStore).latest!.notices.map((n) => n.message));
    }
    expect(perTick).toEqual([
      ['Colonist #6 retired.', 'Colonist #7 came of age.'], // ids 6 and 7 — the crossers, and ONLY them
      [],
      [],
    ]);
  });

  it('does not restore a colonist whose saved age has passed their OWN lifespan', async () => {
    // The third instance of the same rule, and the one clampedAge cannot
    // reach: it bounds a restored age to MAX_AGE_TICKS, the LONGEST lifespan
    // current balance can draw, while each colonist's actual lifespan is drawn
    // per id and lands anywhere below that. An age in between is a colonist
    // the game's own rules have already killed — only a lifespan retune can
    // produce it — so it is repaired, not rejected.
    //
    // Dropped, not clamped down to lifespan - 1. Keeping them is its own
    // falsehood, and it does not even satisfy the principle: ageEveryone runs
    // before resolveOldAge, so a colonist seeded at lifespan - 1 is still
    // killed on tick 1 and the seeded snapshot still advertises someone the
    // first tick removes.
    const lifespan = lifespanFor(2, BALANCE.lifeBands);
    expect(lifespan).toBeLessThan(MAX_AGE_TICKS); // fixture precondition: clampedAge lets this age through
    const save = saveWith([{ ageTicks: lifespan }, {}]);
    expect(isLoadableSave(save)).toBe(true); // accepted, then repaired — see above

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists.map((c) => c.id)).toEqual([3]);
    expect(seeded.population).toBe(1);
    expect(seeded.demographics).toEqual({ children: 0, adults: 1, elders: 0 });

    // The property that actually matters: the paused player's snapshot says
    // the same thing the first tick does.
    await stepTick(world);
    const ticked = world.getResource(SnapshotStore).latest!;
    expect(ticked.colonists.map((c) => c.id)).toEqual(seeded.colonists.map((c) => c.id));
    expect(ticked.population).toBe(seeded.population);
  });

  it('does not let a colonist past their own lifespan hold a bed at load', async () => {
    // Ordering, not just membership: the drop happens BEFORE the
    // over-capacity eviction, or a colonist the rules have already killed
    // occupies one of the four beds and displaces a living one — whom tick 1
    // then rehomes into the bed the corpse vacated.
    const save = saveWith([
      { ageTicks: lifespanFor(2, BALANCE.lifeBands) },
      ...Array.from({ length: BALANCE.houseBeds }, () => ({})),
    ]);
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.population).toBe(BALANCE.houseBeds);
    expect(seeded.homeless).toBe(0); // the four living colonists fit exactly
    expect(seeded.buildings.find((b) => b.beds > 0)!.occupants).toBe(BALANCE.houseBeds);

    await stepTick(world);
    const ticked = world.getResource(SnapshotStore).latest!;
    expect(ticked.population).toBe(seeded.population);
    expect(ticked.homeless).toBe(seeded.homeless);
    expect(ticked.buildings.find((b) => b.beds > 0)!.occupants).toBe(seeded.buildings.find((b) => b.beds > 0)!.occupants);
  });

  it('leaves a working adult exactly as the save wrote them', async () => {
    // The control both repairs are measured against: same fixture, same
    // building, an adult — nothing is cleared and nobody is evicted.
    const save = saveWith([{ buildingId: FORESTER_ID }, { hauling: true }]);
    const world = await createColonyWorld(save);

    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists[0].buildingId).toBe(FORESTER_ID);
    expect(seeded.colonists[1].hauling).toBe(true);
    expect(seeded.homeless).toBe(0);
  });
});

/**
 * `rehome` is EVICT-then-FILL (spec 2.3), and the load repair has to be both
 * halves or the seeded snapshot advertises a housing state the first tick
 * revokes — the same principle the repairs above enforce, applied to the half
 * that was missing. Every case here asserts the property directly: the paused
 * player's snapshot IS what tick 1 produces, in `homeless`, `beds` and every
 * colonist's `homeId`.
 *
 * Equality alone is not the whole bar — the fill also has to reproduce
 * `rehome`'s ORDER (ascending colonist id into ascending building id), or the
 * seed lands on a different-but-equally-full assignment and tick 1 shuffles
 * people between houses. So each case pins the concrete homeId too.
 */
describe('the load repair fills as well as evicts, in rehome\'s own order', () => {
  /**
   * `initialSave()` with exactly the houses and roster named, and NO FOOD.
   *
   * Empty stockpile is load-bearing, not scenery: `initialSave()` seeds
   * `lastBirthTick` off cooldown, so tick 1 of a colony with spare beds and a
   * full larder produces a BIRTH — a fifth colonist claiming a bed, which
   * moves `homeless`, `beds.occupied` and the roster all at once and would
   * fail every equality below for a reason having nothing to do with homing.
   */
  function colonyOf(houseIds: readonly number[], colonists: Partial<SavedColonist>[]): SaveGameV5 {
    const base = initialSave();
    return {
      ...base,
      stockpile: {},
      buildings: houseIds.map((id, index) => ({
        id, defId: 'house' as const, col: 5 + index * 2, row: 3,
        progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
      })),
      colonists: colonists.map((overrides, index) => ({
        id: index + 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
        ageTicks: BALANCE.startingAgeTicks, homeId: null, starvingTicks: 0, ...overrides,
      })),
      nextEntityId: 200,
    };
  }

  /** The three fields the brief names, keyed by colonist id so snapshot
   * ordering cannot make two disagreeing rosters compare equal. */
  function housing(snap: Snapshot) {
    return {
      homeless: snap.homeless,
      beds: snap.beds,
      homes: [...snap.colonists].sort((a, b) => a.id - b.id).map((c) => [c.id, c.homeId]),
    };
  }

  /** Load the save paused, read the seed, run exactly one tick, read again. */
  async function seedAndTick(save: SaveGameV5) {
    const world = await createColonyWorld(save);
    const seeded = housing(world.getResource(SnapshotStore).latest!);
    await stepTick(world);
    return { seeded, ticked: housing(world.getResource(SnapshotStore).latest!) };
  }

  it('re-houses the colonist the over-capacity eviction just displaced', async () => {
    // Route 1: what a houseBeds retune from 5 to 4 writes, with a second house
    // standing empty. The eviction repair is itself the producer here — it
    // creates the homelessness, and without the fill the seed reported
    // `homeless 1` while tick 1 reported 0 with colonist 6 in house 91.
    const save = colonyOf([90, 91], Array.from({ length: BALANCE.houseBeds + 1 }, () => ({ homeId: 90 })));
    expect(isLoadableSave(save)).toBe(true); // accepted, then repaired

    const { seeded, ticked } = await seedAndTick(save);
    expect(seeded.homeless).toBe(0);
    expect(seeded.homes).toEqual([[2, 90], [3, 90], [4, 90], [5, 90], [6, 91]]);
    expect(seeded).toEqual(ticked);
  });

  it('re-houses into the bed a colonist the rules already killed just freed', async () => {
    // Route 2: no over-capacity anywhere. `hasLifeLeft` drops colonist 2 (a
    // lifespan retune put them past their own draw), which frees the fourth
    // bed in house 90 — and colonist 6, whom the save itself wrote homeless,
    // is the one rehome puts in it on tick 1.
    const save = colonyOf([90], [
      { homeId: 90, ageTicks: lifespanFor(2, BALANCE.lifeBands) },
      { homeId: 90 }, { homeId: 90 }, { homeId: 90 },
      { homeId: null },
    ]);
    expect(isLoadableSave(save)).toBe(true);

    const { seeded, ticked } = await seedAndTick(save);
    expect(seeded.homes.map(([id]) => id)).toEqual([3, 4, 5, 6]); // the dead one is gone: pop 4
    expect(seeded.homeless).toBe(0);
    expect(seeded.homes).toEqual([[3, 90], [4, 90], [5, 90], [6, 90]]);
    expect(seeded).toEqual(ticked);
  });

  it('fills from beds left AFTER the eviction pass, not from the catalog\'s bed counts', async () => {
    // Route 3, and the one that discriminates the ORDER rule from "any free
    // bed will do": house 90 is over capacity and house 91 is exactly full, so
    // the only real opening is 92. A fill reading `BUILDINGS[defId].beds`
    // instead of what the eviction pass left would put colonist 6 straight
    // back into 90 — the lowest id with a nonzero catalog count — and tick 1
    // would evict them all over again.
    const save = colonyOf([90, 91, 92], [
      ...Array.from({ length: BALANCE.houseBeds + 1 }, () => ({ homeId: 90 })),
      ...Array.from({ length: BALANCE.houseBeds }, () => ({ homeId: 91 })),
    ]);
    expect(isLoadableSave(save)).toBe(true);

    const { seeded, ticked } = await seedAndTick(save);
    expect(seeded.homeless).toBe(0);
    expect(seeded.homes).toEqual([
      [2, 90], [3, 90], [4, 90], [5, 90], [6, 92],
      [7, 91], [8, 91], [9, 91], [10, 91],
    ]);
    expect(seeded).toEqual(ticked);
  });

  it('fills ascending colonist id into ascending building id, not merely into some free bed', async () => {
    // The ORDER rule on its own, which the equality property above cannot
    // reach: with two homeless colonists and one opening in each of two
    // houses, BOTH assignments are stable across tick 1 — rehome keeps
    // whatever the seed wrote, because everybody is housed and nothing is over
    // capacity. Only the concrete pairing distinguishes `rehome`'s rule from
    // "find some free bed", and getting it wrong means a reload silently
    // swaps two colonists between houses (and their commutes with them).
    const save = colonyOf([90, 91], [
      ...Array.from({ length: BALANCE.houseBeds - 1 }, () => ({ homeId: 90 })),
      ...Array.from({ length: BALANCE.houseBeds - 1 }, () => ({ homeId: 91 })),
      { homeId: null }, { homeId: null },
    ]);
    expect(isLoadableSave(save)).toBe(true);

    const { seeded, ticked } = await seedAndTick(save);
    expect(seeded.homeless).toBe(0);
    // 8 before 9, and 90 before 91: the LOWER id takes the LOWER house.
    expect(seeded.homes).toEqual([
      [2, 90], [3, 90], [4, 90], [5, 91], [6, 91], [7, 91], [8, 90], [9, 91],
    ]);
    expect(seeded).toEqual(ticked);
  });

  it('does not fill a homeless colonist into a house that is in transit', async () => {
    // The exclusion every other bed count already makes (`spareBeds`,
    // `shelterWithRoom`, `freeBeds`, the eviction's own map): a house in
    // transit offers no beds. The fill has to match, or the seed houses
    // someone tick 1 immediately evicts — the inverse of the bug above and
    // just as much a contradiction. Nobody is homed here, so the save stays
    // guard-valid: it is `homeId` naming a RELOCATING house that rule 3
    // refuses, not the house existing.
    const save = colonyOf([90], [{ homeId: null }]);
    save.buildings[0].relocatingTicks = 6;
    expect(isLoadableSave(save)).toBe(true);

    const { seeded, ticked } = await seedAndTick(save);
    expect(seeded.homeless).toBe(1);
    expect(seeded.homes).toEqual([[2, null]]);
    expect(seeded).toEqual(ticked);
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
    save.colonists[0].hunger = 42;
    const prep = buildColonyPrepWorld({ save });
    const workers = [...prep.getEntities()].filter((e) => e.hasComponent(Colonist));
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.getComponent(Hunger)!.value).sort((a, b) => b - a)[0]).toBe(42);
    expect(workers.every((w) => w.getComponent(JobAssignment)!.buildingId === null)).toBe(true);
  });

  it('clamps balance-coupled worker fields above CURRENT balance at load (spec 4.5)', async () => {
    const save = initialSave();
    save.colonists[0].hunger = 1000;
    save.colonists[0].toolTicks = 999999; // within MAX_SAVED_COUNTER, above toolDurationTicks (300)
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const snapshot = world.getResource(SnapshotStore).latest!;
    const clamped = snapshot.colonists.find((w) => w.id === save.colonists[0].id)!;
    expect(clamped.hunger).toBeLessThanOrEqual(BALANCE.hungerMax);
    expect(clamped.toolTicks).toBeLessThanOrEqual(BALANCE.toolDurationTicks);

    const prep = buildColonyPrepWorld({ save });
    const spawnedWorker = [...prep.getEntities()].find(
      (e) => e.hasComponent(Colonist) && e.getComponent(Colonist)!.id === save.colonists[0].id,
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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {},
      relocatingTicks: BALANCE.maxRelocationTicks + 500,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(true);

    // Deliberately no world.step(): buildInitialSnapshot's own clamp is what
    // this proves. Stepping would let SnapshotSystem's live-query path
    // overwrite the seeded value first, leaving the load-time clamp
    // unexercised — exactly the gap this test closes.
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    const seededBuilding = seeded.buildings.find((b) => b.id === 5)!;
    expect(seededBuilding.relocatingTicks).toBeLessThanOrEqual(BALANCE.maxRelocationTicks);

    const prep = buildColonyPrepWorld({ save });
    const spawnedBuilding = [...prep.getEntities()].find(
      (e) => e.hasComponent(Building) && e.getComponent(Building)!.id === 5,
    )!;
    // Cross-check the live spawned component's exact value, not just its own
    // bound: proves the seeded snapshot and buildingComponents' Relocation
    // — the two independent clampedRelocation call sites — agree on the
    // actual number, not merely that both separately stayed under the cap.
    expect(spawnedBuilding.getComponent(Relocation)!.ticksLeft).toBe(seededBuilding.relocatingTicks);
  });

  it('a building mid-relocation survives save -> restore with its countdown', async () => {
    const save = initialSave();
    save.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 3, buffer: {}, relocatingTicks: 9 });
    save.nextEntityId = 6;
    const world = await createColonyWorld(save);
    const written = buildSaveFromWorld(world);
    expect(written.buildings.find((b) => b.id === 5)!.relocatingTicks).toBe(9);
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
      id: 5, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 1, buffer: {},
      relocatingTicks: legalTicks,
    });
    save.nextEntityId = 6;
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    const seededBuilding = seeded.buildings.find((b) => b.id === 5)!;
    expect(seededBuilding.relocatingTicks).toBe(legalTicks); // NOT clamped down

    const written = buildSaveFromWorld(world);
    expect(written.buildings.find((b) => b.id === 5)!.relocatingTicks).toBe(legalTicks);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('each colonist survives save -> restore with its own exact starvingTicks, not a shared value', async () => {
    // Two distinct values on two distinct colonists: a bug that writes one
    // hardcoded number, or wires the wrong colonist's field, could still
    // satisfy a single-colonist assertion but not this pair.
    const save = initialSave();
    save.colonists[0].starvingTicks = 40; // partway through the countdown
    save.colonists[1].starvingTicks = 0;  // never starved
    expect(isLoadableSave(save)).toBe(true);

    // The SEEDED snapshot (buildInitialSnapshot), read before any tick runs —
    // proves the restore path, not SnapshotSystem's live query.
    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists.find((c) => c.id === save.colonists[0].id)!.starvingTicks).toBe(40);
    expect(seeded.colonists.find((c) => c.id === save.colonists[1].id)!.starvingTicks).toBe(0);

    // And the round trip back out, from the live entities (buildSaveFromWorld
    // walks components, not the snapshot) — proves the live spawn path too.
    const written = buildSaveFromWorld(world);
    expect(written.colonists.find((w) => w.id === save.colonists[0].id)!.starvingTicks).toBe(40);
    expect(written.colonists.find((w) => w.id === save.colonists[1].id)!.starvingTicks).toBe(0);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('round-trips a mid-starvation, mid-cooldown colony', async () => {
    // Both are penalties already incurred: dropping either would let
    // save-and-reload cancel it.
    const save: SaveGameV5 = { ...initialSave(), tick: 910, lastBirthTick: 900 };
    save.colonists = save.colonists.map((c, i) => (i === 0 ? { ...c, starvingTicks: 40 } : c));
    const world = await createColonyWorld(save);
    const round = buildSaveFromWorld(world);

    expect(round.colonists.find((c) => c.id === save.colonists[0].id)!.starvingTicks).toBe(40);
    expect(round.lastBirthTick).toBe(900);
    // Discriminating: a second colonist's clock must NOT have picked up the 40,
    // or this would pass with starvingTicks written from a single shared value.
    expect(round.colonists.find((c) => c.id === save.colonists[1].id)!.starvingTicks).toBe(0);
  });

  it('round-trips who sleeps where, so a reload does not reshuffle the colony', async () => {
    // The v5 field this whole bump is for. Dropping homeId would restore all
    // nine homeless — at homelessFactor work power, on a paused engine — and
    // the first homing pass would then hand out beds in an order the player
    // never chose.
    //
    // Two FULL houses, with the homeless colonist in the MIDDLE of the id
    // range, is what keeps this discriminating now that the load repair fills
    // as well as evicts. A colonist written homeless beside a free bed is a
    // state the engine itself never writes, and the repair no longer restores
    // it verbatim; and a roster whose homeless one is the HIGHEST id is
    // precisely what homing from scratch produces, so that arrangement would
    // pass with homeId dropped entirely.
    const save = initialSave();
    save.buildings.push({
      id: 5, defId: 'house', progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0,
    });
    const homes: (number | null)[] = [1, 1, 1, 1, null, 5, 5, 5, 5];
    save.colonists = homes.map((homeId, index) => ({
      id: index + 6, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: BALANCE.startingAgeTicks, homeId, starvingTicks: 0,
    }));
    save.nextEntityId = 6 + homes.length;
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.colonists.map((c) => c.homeId)).toEqual(homes); // before any tick
    expect(seeded.homeless).toBe(1);

    const written = buildSaveFromWorld(world);
    expect(written.colonists.map((c) => c.homeId)).toEqual(homes);
    expect(isLoadableSave(written)).toBe(true);
  });

  it('grandfathers overstaffed buildings from a save (spec 4.5: slots retuned down must not orphan saves)', async () => {
    const save = initialSave();
    const building = { id: 5, defId: 'forester' as const, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }; // 2 slots
    save.buildings.push(building);
    save.nextEntityId = 6;
    save.colonists = [2, 3, 4].map((id) => ({
      id, hunger: 0, buildingId: building.id, toolTicks: 0, hauling: false,
      ageTicks: BALANCE.startingAgeTicks, homeId: 1, starvingTicks: 0,
    }));
    expect(isLoadableSave(save)).toBe(true);

    const world = await createColonyWorld(save);
    const snapshot = world.getResource(SnapshotStore).latest!;
    const seededBuilding = snapshot.buildings.find((b) => b.id === building.id)!;
    expect(seededBuilding.workers).toBe(3); // grandfathered above the current 2-slot cap
  });

  it('IdCounter continues past spawned entities', () => {
    const prep = buildColonyPrepWorld();
    const ids = getPrepResource(prep, IdCounter);
    expect(ids.take()).toBe(5); // the starter house took 1, the founders 2..4
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
    save.buildings.push({ id: 5, defId: 'forester', progress: 0, batchActive: false, col: 9, row: 7, buffer: {}, relocatingTicks: 0 });
    save.nextEntityId = 6;
    const world = await createColonyWorld(save);
    const b = world.getResource(SnapshotStore).latest!.buildings.find((x) => x.id === 5)!;
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
    save.buildings = [{ id: 99, defId: 'notABuilding' as never, progress: 0, batchActive: false, col: 6, row: 1, buffer: {}, relocatingTicks: 0 }];
    save.nextEntityId = 100;
    expect(prepareLoadedSave(save)).toBeNull();
  });

  it('rejects a version this build does not know', () => {
    expect(prepareLoadedSave({ ...initialSave(), version: 6 })).toBeNull();
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
  // `homeId` used to sit here too, for the identical reason: real decision
  // state awaiting the save-format bump. Save v5 carries it, so it graduated
  // out of the list exactly as starvingTicks did, and is now covered by
  // default — a restored colonist wakes up in the bed they went to sleep in
  // rather than homeless until the first homing pass.
  // `commuteTiles` and `commuteFactor` stay, for the FIRST reason: they are
  // recomputed every tick from two entities' live positions, exactly like
  // `efficiency` and `stage`, so there is nothing to persist.
  // `deliveredWorkPower` (OBS-6-06) joined them for the same reason, one step
  // removed: it IS `workerWorkPower(efficiency, toolTicks, commuteFactor)`, so
  // anything that makes `efficiency` or `commuteFactor` unpersistable makes
  // this one too — there is no independent state in it to save.
  const DERIVED = [
    'efficiency', 'stage', 'haulTargetId', 'haulPhase', 'haulTicksLeft', 'haulLegTicks', 'haulPickupCol', 'haulPickupRow',
    'carrying', 'commuteTiles', 'commuteFactor', 'deliveredWorkPower',
  ] as const;

  function persisted(workers: readonly object[]): Record<string, unknown>[] {
    return workers.map((w) => {
      const copy: Record<string, unknown> = { ...w };
      for (const key of DERIVED) delete copy[key];
      return copy;
    });
  }

  /** The one producer busyColony builds, past initialSave()'s starter house. */
  const foresterOf = (engine: GameEngine) => engine.snapshot!.buildings.find((b) => b.defId === 'forester')!;

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
    // By defId, not buildings[0]: the starter house sorts ahead of the
    // forester, and assigning a worker to a shelter is refused outright.
    engine.dispatch({ type: 'assignWorker', buildingId: foresterOf(engine).id });
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
    const saved = engine.serialize().colonists;
    expect(persisted(fromQueryPath)).toEqual(saved.map((w) => ({ ...w })));
  });

  it('the walk path publishes colony-wide mealsPerHead, not the camp-only figure, on a refreshing tick', async () => {
    // Exactly what two storehouses cost, so the camp is fully drained and can
    // never itself hold food: a camp-only read has nothing to fall back on
    // but 0, so a wrong read is caught on the VALUE, not merely a total that
    // happens to differ from the right one.
    const save = initialSave();
    save.stockpile = { wood: 40, planks: 20 };
    const engine = await GameEngine.create(save);

    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'storehouse' });
    await engine.stepOnce(); // an entity-creating tick, but no food banked yet
    const depot = engine.snapshot!.buildings.find((b) => b.defId === 'storehouse')!;

    // Bank bread straight into the depot, bypassing HaulSystem for
    // determinism: 33 units, weight 1, never touching the camp.
    const world = (engine as unknown as { world: IRuntimeWorld }).world;
    world.getResource(Stockpile).addAt(
      { id: depot.id, col: depot.col, row: depot.row, capacity: BALANCE.storehouseCapacity }, 'bread', 33,
    );

    // A second entity-creating tick: it consumes an id, so GameEngine.runStep's
    // post-step gate fires refreshEntitySections THIS tick, overwriting the
    // mealsPerHead SnapshotSystem already published with buildEntitySections'
    // own recomputation from the walk path — the seam this test pins.
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'storehouse' });
    await engine.stepOnce();

    // Sanity: population is unchanged at the 3 founders, so the assertion
    // below is on the stock read, not a denominator surprise.
    expect(engine.snapshot!.population).toBe(3);
    // 33 bread / 4 heads = 8.25 -- a camp-only read sees 0 bread and publishes 0.
    expect(engine.snapshot!.mealsPerHead).toBeCloseTo(8.25);
  });

  it('every non-derived worker fact is represented in the save record', async () => {
    const engine = await busyColony();
    const factKeys = Object.keys(engine.snapshot!.colonists[0])
      .filter((key) => !DERIVED.includes(key as (typeof DERIVED)[number]));
    const savedKeys = Object.keys(engine.serialize().colonists[0]);
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
    const before = foresterOf(engine).buffered;
    expect(before).toBeGreaterThan(0); // guard: otherwise this comparison is vacuous
    const restored = await GameEngine.create(engine.serialize());
    // buildInitialSnapshot recomputes `buffered` as the sum of restored
    // SavedBuilding.buffer, so this agreeing on the value proves the buffer
    // map itself round-tripped, not just its key.
    expect(foresterOf(restored).buffered).toBe(before);
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
    const factKeys = Object.keys(foresterOf(engine)).filter((k) => !derivedBuilding.includes(k));
    const savedKeys = Object.keys(engine.serialize().buildings[0]);
    expect(factKeys.filter((key) => !savedKeys.includes(key))).toEqual([]);
  });
});

describe('applyRemovals', () => {
  // The seam OBS-6-02 moved entity removal onto. End-to-end cases prove a
  // die-off costs no ticks; these prove the two properties that make that
  // true, at the one function that has them.

  it('removes EVERY entity on the ledger in a single call, and says how many', async () => {
    // Three at once, deliberately: batching more than one removal through
    // sim-ecs's command queue is precisely what froze the simulation, because
    // its runtime removal throws (harmlessly, after the fact) for any entity
    // spawned at prep time and the sync point abandoned the rest of the batch.
    const world = await createColonyWorld();
    const ledger = world.getResource(RemovalLedger);
    const colonists = [...world.getEntities()].filter((e) => e.hasComponent(Colonist));
    expect(colonists).toHaveLength(3); // fixture precondition
    for (const entity of colonists) ledger.remove(entity);

    expect(applyRemovals(world)).toBe(3);
    expect([...world.getEntities()].filter((e) => e.hasComponent(Colonist))).toHaveLength(0);
    // Drained, not merely read: a second call must find nothing left to do,
    // or a later tick would try to remove the same entities again.
    expect(applyRemovals(world)).toBe(0);
  });

  it('re-throws when the entity is still in the world, rather than swallowing it', async () => {
    // The tolerated throw is sim-ecs unhooking listeners that were never
    // registered — which happens AFTER the entity is gone. A throw that
    // leaves the entity present is something else entirely, and the silent
    // catch at sim-ecs's own sync point is what made this defect invisible
    // for a whole increment. This guard is the difference.
    const ledger = new RemovalLedger();
    ledger.remove({} as never);
    const boom = new Error('removal genuinely failed');
    const stubWorld = {
      getResource: () => ledger,
      removeEntity: () => { throw boom; },
      hasEntity: () => true,
    } as unknown as IRuntimeWorld;

    expect(() => applyRemovals(stubWorld)).toThrow(boom);
    // The throw took the requeue arm, so the entry is back on the ledger — the
    // one place in the suite where a loaded ledger at teardown is correct
    // rather than a dropped removal. Drained here so it stays a statement this
    // test makes, checked, instead of an exemption the teardown guard
    // (tests/support/removal-guard.ts) would have to carry. The full retention
    // property, including the entries the throw never reached, is the next case.
    expect(ledger.drain()).toHaveLength(1);
  });

  it('keeps the failed removal and the ones after it on the ledger when a detachment throws', async () => {
    // The re-throw arm above is the ONLY way out of applyRemovals other than
    // returning, and `drain()` empties the ledger before the first detach — so
    // a throw on entry two used to discard entry two AND entry three with it.
    // GameEngine.runStep catches and pauses; start() clears the error and
    // resumes; so those removals were gone permanently and nothing would ever
    // try them again. The case is defensive — sim-ecs 0.6.4 deletes before it
    // throws, so `hasEntity` is false and detach swallows it — which is why
    // the failure has to be staged rather than provoked.
    const world = await createColonyWorld();
    const colonists = [...world.getEntities()].filter((e) => e.hasComponent(Colonist));
    expect(colonists).toHaveLength(3); // fixture precondition: enough for a middle entry
    for (const entity of colonists) world.getResource(RemovalLedger).remove(entity);

    // The shape detach re-throws on, staged on the real world: removeEntity
    // throws for ONE entity and leaves it in place. Every other entity goes
    // through sim-ecs's own removeEntity, including its harmless post-delete
    // throw, so the entries either side are removed for real.
    const mutable = world as IRuntimeWorld & { removeEntity(entity: unknown): void };
    const real = mutable.removeEntity.bind(world);
    const boom = new Error('removal genuinely failed');
    mutable.removeEntity = (entity: unknown) => {
      if (entity === colonists[1]) throw boom;
      real(entity);
    };

    expect(() => applyRemovals(world)).toThrow(boom);
    expect(world.hasEntity(colonists[0])).toBe(false); // the one that got through, gone
    expect(world.hasEntity(colonists[1])).toBe(true);  // the one that threw, still here
    expect(world.hasEntity(colonists[2])).toBe(true);  // never even visited

    // The assertion this test exists for: BOTH survivors are still queued, so
    // the next tick finishes the job instead of leaving them alive forever.
    mutable.removeEntity = real;
    expect(applyRemovals(world)).toBe(2);
    expect([...world.getEntities()].filter((e) => e.hasComponent(Colonist))).toHaveLength(0);
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
