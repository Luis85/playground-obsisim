import { describe, expect, it } from 'vitest';
import type { MigrationStep, SaveGuards } from '../../src/shared/save-migration';
import { MIGRATION_CONSTANTS, migrateSaveToLatest, readSaveVersion } from '../../src/shared/save-migration';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, createColonyWorld, decideLoad, getPrepResource, initialSave, prepareLoadedSave,
} from '../../src/engine/world';
import { Building, Construction } from '../../src/engine/components';
import { SnapshotStore, Stockpile } from '../../src/engine/resources';
import { BALANCE } from '../../src/engine/content/balance';
import type { SaveGameV4, SaveGameV5, SaveGameV6, SaveGameV7 } from '../../src/shared/save';
import { CAMP_SITE_ID } from '../../src/shared/haul';
import { stepTick } from '../engine/fixtures';

/** A structurally valid v1 save (pre-spatial: no map, no positions). */
function v1Fixture(buildingCount: number) {
  return {
    version: 1, tick: 5, lastRecruitTick: -30,
    stockpile: { wood: 10 },
    buildings: Array.from({ length: buildingCount }, (_, i) => ({
      id: i + 10, defId: 'forester', progress: 0, batchActive: false,
    })),
    workers: [{ id: 1, hunger: 0, buildingId: null, toolTicks: 0 }],
    nextEntityId: 1000,
  };
}

// A fake chain: the runner is exercised end-to-end while the real chain is
// still empty (v1 IS latest).
//
// Each fake guard requires a structural field (`payload`) BESIDES the version.
// A version-only guard would make the "source guard fails" fixture below
// impossible to write — `{ version: 2 }` satisfies `version === 2`, so the
// chain would complete and the test could only ever fail against a correct
// implementation. `stepped` spreads the save, so payload survives every hop.
const stepped = (v: number): MigrationStep => ({
  from: v, to: v + 1,
  migrate: (save) => ({ ...(save as object), version: v + 1, [`from${v}`]: true }),
});
const fakeGuard = (v: number) => (d: unknown) => {
  const save = d as { version?: unknown; payload?: unknown };
  return save.version === v && typeof save.payload === 'string';
};
const guards: SaveGuards = { 1: fakeGuard(1), 2: fakeGuard(2), 3: fakeGuard(3) };
const v1 = { version: 1, payload: 'x' }; // a structurally valid v1 for the fake chain

describe('readSaveVersion', () => {
  it('reads a positive integer version and rejects anything else', () => {
    expect(readSaveVersion({ version: 1 })).toBe(1);
    expect(readSaveVersion({ version: '1' })).toBeNull();
    expect(readSaveVersion({ version: 1.5 })).toBeNull();
    expect(readSaveVersion({ version: 0 })).toBeNull();
    expect(readSaveVersion({})).toBeNull();
    expect(readSaveVersion(null)).toBeNull();
  });
});

// Every negative case below must fail for the ONE reason it names, so each
// fixture keeps `payload` (and therefore stays guard-valid) unless the point of
// the case is a failing guard.
describe('migrateSaveToLatest (runner)', () => {
  it('applies every step in order up to the target', () => {
    const out = migrateSaveToLatest(v1, guards, [stepped(2), stepped(1)], 3);
    expect(out).toMatchObject({ version: 3, from1: true, from2: true });
  });

  it('stops at the target version instead of running past it', () => {
    const out = migrateSaveToLatest(v1, guards, [stepped(1), stepped(2)], 2);
    expect(out).toMatchObject({ version: 2, from1: true });
    expect(out).not.toHaveProperty('from2');
  });

  it('refuses a chain with a gap', () => {
    expect(migrateSaveToLatest(v1, guards, [stepped(2)], 3)).toBeNull();
  });

  it('refuses a step that jumps over a version', () => {
    // { from: 1, to: 3 } would land on a passing v3 guard with v2's
    // transformation never applied and v2's guard never run. Payload is
    // preserved, so adjacency is the only thing that can reject this.
    const jump = { from: 1, to: 3, migrate: (s: unknown) => ({ ...(s as object), version: 3 }) };
    expect(migrateSaveToLatest(v1, guards, [jump], 3)).toBeNull();
  });

  it('refuses a step whose output fails the guard for the version it claims', () => {
    // payload survives; only the version is wrong, so the hop guard is what fails
    const liar = { from: 1, to: 2, migrate: (s: unknown) => ({ ...(s as object), version: 'two' }) };
    expect(migrateSaveToLatest(v1, guards, [liar, stepped(2)], 3)).toBeNull();
  });

  it('refuses two steps sharing a source version', () => {
    // both produce guard-valid v2 output, so which one ran would silently
    // depend on array order — ambiguity is the only reason this can reject
    const other = {
      ...stepped(1),
      migrate: (s: unknown) => ({ ...(s as object), version: 2, viaOther: true }),
    };
    expect(migrateSaveToLatest(v1, guards, [stepped(1), other], 2)).toBeNull();
  });

  it('rejects a save whose own version guard fails', () => {
    // Claims v2 and IS a v2 by version alone, but has no payload. The step
    // deliberately HEALS the missing payload so the target guard would accept
    // the result: the source guard is the only thing that can reject this.
    const healing = {
      from: 2, to: 3,
      migrate: (s: unknown) => ({ ...(s as object), version: 3, payload: 'x' }),
    };
    expect(migrateSaveToLatest({ version: 2 }, guards, [healing], 3)).toBeNull();
  });

  it('treats a throwing migration step as an unloadable save', () => {
    // a faulty future migration must reach the corrupt-backup path, not escape
    // as a rejection that stops the view from opening at all
    const boom = {
      from: 1, to: 2,
      migrate: () => { throw new TypeError("Cannot read properties of undefined (reading 'workers')"); },
    };
    expect(migrateSaveToLatest(v1, guards, [boom], 2)).toBeNull();
  });

  it('rejects a version that has no guard at all', () => {
    // An unguarded version means UNKNOWN, not "nothing to check". Target 5 with
    // zero hops reaches both guard lookups, and both find undefined: if absence
    // were treated as a pass, this object would be RETURNED as a SaveGameV1 that
    // nothing had validated. The SaveGuards doc states this; nothing pinned it.
    expect(migrateSaveToLatest({ version: 5, payload: 'x' }, guards, [], 5)).toBeNull();
  });

  it('treats a throwing SOURCE guard as an unloadable save', () => {
    // Same reasoning as the throwing step above, at the other extension point:
    // a guard that blows up on malformed data must degrade to "start fresh",
    // not escape as a rejection that stops the view from opening at all.
    const boom: SaveGuards = { 1: () => { throw new TypeError('bad save shape'); } };
    expect(() => migrateSaveToLatest(v1, boom, [], 1)).not.toThrow();
    expect(migrateSaveToLatest(v1, boom, [], 1)).toBeNull();
  });

  it('treats a throwing PER-HOP guard as an unloadable save', () => {
    // The v2 guard runs inside runSteps, after step 1->2 has already applied,
    // so this covers a different call site from the source-guard case above.
    const boom: SaveGuards = { ...guards, 2: () => { throw new TypeError('bad v2 shape'); } };
    expect(() => migrateSaveToLatest(v1, boom, [stepped(1)], 2)).not.toThrow();
    expect(migrateSaveToLatest(v1, boom, [stepped(1)], 2)).toBeNull();
  });

  it('refuses a newer save even when the target guard would accept it', () => {
    // A version-agnostic v1 guard. Without the `version > target` check the v3
    // save is returned AS a v1 — a silent downgrade.
    const permissive: SaveGuards = {
      ...guards,
      1: (d: unknown) => typeof (d as { payload?: unknown }).payload === 'string',
    };
    expect(migrateSaveToLatest({ version: 3, payload: 'x' }, permissive, [], 1)).toBeNull();
  });
});

describe('migrateSaveToLatest (real chain)', () => {
  it('passes a latest-version save through unchanged', () => {
    const save = initialSave();
    expect(migrateSaveToLatest(save)).toEqual(save);
  });

  // SAVE_GUARDS is deliberately not exported, so this can only be probed
  // behaviorally. Guards against the one failure mode this whole increment
  // exists to prevent: forgetting a guard entry for LATEST_SAVE_VERSION would
  // make the real chain's own zero-hop guard check (`guards[target]?.()`)
  // always fail, silently routing every existing save — not just malformed
  // ones — down the corrupt-backup path. initialSave() writes exactly
  // LATEST_SAVE_VERSION, so a non-null result here is that guard existing.
  it('has a guard registered for LATEST_SAVE_VERSION, so a fresh save is loadable at all', () => {
    expect(migrateSaveToLatest(initialSave())).not.toBeNull();
  });

  it('rejects unknown versions and non-objects', () => {
    expect(migrateSaveToLatest({ ...initialSave(), version: 99 })).toBeNull();
    expect(migrateSaveToLatest({ ...initialSave(), version: undefined })).toBeNull();
    expect(migrateSaveToLatest('nope')).toBeNull();
  });
});

describe('migrateSaveToLatest (v1 -> v2)', () => {
  it('migrates v1 to v2 with legacy-pattern positions and the default map', () => {
    const out = migrateSaveToLatest(v1Fixture(7)) as SaveGameV7;
    expect(out.version).toBe(7);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    // The legacy buildings only: v4->v5 appends a starter house of its own,
    // which lands on the first tile the plot sequence has left over.
    const legacy = out.buildings.filter((b) => b.defId === 'forester');
    expect(legacy.map((b) => ({ col: b.col, row: b.row }))).toEqual([
      { col: 4, row: 1 }, { col: 6, row: 1 }, { col: 8, row: 1 }, { col: 10, row: 1 }, { col: 12, row: 1 },
      { col: 4, row: 3 }, { col: 6, row: 3 },
    ]);
    expect(legacy.map((b) => b.id)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it('assigns positions in ascending id order regardless of array order', () => {
    const shuffled = v1Fixture(2);
    shuffled.buildings.reverse();
    const out = migrateSaveToLatest(shuffled) as SaveGameV7;
    expect(out.buildings.find((b) => b.id === 10)).toMatchObject({ col: 4, row: 1 });
    expect(out.buildings.find((b) => b.id === 11)).toMatchObject({ col: 6, row: 1 });
  });

  it('preserves a valid colony bigger than the default map by growing the map', () => {
    // v1 had no building cap: 337 buildings is a legal save, never a corrupt
    // one — the migration must not route it to the backup-and-start-fresh path
    const out = migrateSaveToLatest(v1Fixture(337)) as SaveGameV7;
    expect(out.version).toBe(7);
    expect(out.buildings.filter((b) => b.defId === 'forester')).toHaveLength(337);
    expect(out.map.rows).toBeGreaterThan(16); // grown past the 336-tile default
    const tiles = new Set(out.buildings.map((b) => `${b.col},${b.row}`));
    expect(tiles.size).toBe(out.buildings.length); // every position distinct and on the map
    // legacy fidelity holds PAST the default map's 40 plots: the 41st
    // building (id 50 — fixture ids start at 10) keeps the exact tile
    // increment 2's derived grid drew it at, row 17 included
    expect(out.buildings.find((b) => b.id === 50)).toMatchObject({ col: 4, row: 17 });
  });

  it('migrates the guard-cap worst case (10,000 buildings) without stalling', () => {
    // the sequence walk is linear — this is a performance contract as much as
    // a correctness one (a save must never hang plugin startup); vitest's
    // default per-test timeout doubles as the stall detector
    const out = migrateSaveToLatest(v1Fixture(10_000)) as SaveGameV7;
    // No starter house on top: the structural guard admits at most
    // MAX_SAVED_ENTITIES buildings, so gifting a 10,000-building colony one
    // more would make the migration's own output unloadable.
    expect(out.buildings).toHaveLength(10_000);
    expect(out.colonists.every((c) => c.homeId === null)).toBe(true);
    const tiles = new Set(out.buildings.map((b) => `${b.col},${b.row}`));
    expect(tiles.size).toBe(10_000);
    expect((out.map.cols - 3) * out.map.rows).toBeGreaterThanOrEqual(10_000);
  });

  it('does not mutate its input', () => {
    const input = v1Fixture(1);
    migrateSaveToLatest(input);
    expect(input).toEqual(v1Fixture(1));
  });
});

describe('migrateSaveToLatest (v2 -> v3)', () => {
  function v2Save(buildingCount = 2) {
    return {
      version: 2,
      tick: 40,
      lastRecruitTick: 10,
      stockpile: { wood: 12 },
      map: { cols: 24, rows: 16 },
      buildings: Array.from({ length: buildingCount }, (_, i) => ({
        id: i + 1, defId: 'forester', progress: 0, batchActive: false, col: 4 + 2 * i, row: 1,
      })),
      workers: [{ id: 100, hunger: 3, buildingId: null, toolTicks: 0 }],
      nextEntityId: 101,
    };
  }

  it('fills empty buffers and no haulers — what a v2 colony was', () => {
    const out = migrateSaveToLatest(v2Save())!;
    expect(out.version).toBe(7);
    expect(out.buildings.every((b) => Object.keys(b.buffer).length === 0)).toBe(true);
    expect(out.colonists.every((c) => c.hauling === false)).toBe(true);
  });

  it('leaves every other field of the v2 save exactly as it was', () => {
    const before = v2Save();
    const out = migrateSaveToLatest(before)!;
    expect(out.tick).toBe(40);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    expect(out.buildings.filter((b) => b.defId === 'forester').map((b) => `${b.col},${b.row}`)).toEqual(['4,1', '6,1']);
    // Deep, not just the buildings[0]/buffer spot-check: same standard as
    // the v1 "does not mutate its input" case above. A migrateV2toV3 that
    // mutated a worker in place (e.g. setting hauling = false instead of
    // spreading) would pass a narrower check but fails this one.
    expect(before).toEqual(v2Save());
  });

  it('migrates a v1 save all the way to the latest version in one call', () => {
    const v1 = {
      version: 1, tick: 5, lastRecruitTick: 0, stockpile: {},
      buildings: [{ id: 1, defId: 'forester', progress: 0, batchActive: false }],
      workers: [], nextEntityId: 2,
    };
    const out = migrateSaveToLatest(v1)!;
    expect(out.version).toBe(7);
    expect(out.buildings[0]).toMatchObject({ col: 4, row: 1, buffer: {}, relocatingTicks: 0 });
  });
});

describe('migrateSaveToLatest (v3 -> v4)', () => {
  it('v3 -> v4 gives every building a zero relocation countdown', () => {
    const v3 = {
      version: 3, tick: 5, lastRecruitTick: 0, stockpile: { wood: 10 },
      map: { cols: 24, rows: 16 }, nextEntityId: 3,
      buildings: [{ id: 1, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: { wood: 2 } }],
      workers: [{ id: 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false }],
    };
    const migrated = migrateSaveToLatest(v3) as SaveGameV7;
    expect(migrated.version).toBe(7);
    const forester = migrated.buildings.find((b) => b.id === 1)!;
    expect(forester.relocatingTicks).toBe(0);
    expect(forester.buffer).toEqual({ wood: 2 }); // everything else survives
    expect(v3.buildings[0]).not.toHaveProperty('relocatingTicks'); // input untouched
  });
});

/** A minimal, guard-valid v4 save: three workers, one forester, no houses. */
function v4WithThreeWorkers(): SaveGameV4 {
  return {
    version: 4,
    tick: 5000,
    lastRecruitTick: 4000,
    stockpile: { wood: 40, berries: 30 },
    map: { cols: 24, rows: 16 },
    buildings: [{
      id: 1, defId: 'forester', col: 4, row: 1,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    }],
    workers: [
      { id: 2, hunger: 10, buildingId: 1, toolTicks: 0, hauling: false },
      { id: 3, hunger: 20, buildingId: null, toolTicks: 0, hauling: false },
      { id: 4, hunger: 30, buildingId: null, toolTicks: 0, hauling: true },
    ],
    nextEntityId: 5,
  };
}

describe('migrateSaveToLatest (v4 -> v5)', () => {
  it('v4 -> v5: colonists become adults, a starter house appears, and its beds are already assigned', () => {
    const v5 = migrateSaveToLatest(v4WithThreeWorkers()) as SaveGameV7;
    expect(v5.version).toBe(7);

    // Adults, staggered — not all the same age, or they die together.
    const ages = v5.colonists.map((c) => c.ageTicks);
    expect(new Set(ages).size).toBeGreaterThan(1);
    for (const age of ages) expect(age).toBeGreaterThanOrEqual(BALANCE.lifeBands.matureTicks);

    // The house exists AND its residents are already written into the record.
    const house = v5.buildings.find((b) => b.defId === 'house');
    expect(house).toBeDefined();
    const homed = v5.colonists.filter((c) => c.homeId === house!.id);
    expect(homed).toHaveLength(3);

    expect(v5.lastBirthTick).toBe(-MIGRATION_CONSTANTS.birthCooldownTicks);
    expect(v5.colonists.every((c) => c.starvingTicks === 0)).toBe(true);
  });

  it('a migrated colony is housed in the SEEDED snapshot, before any tick runs', () => {
    // buildColonyPrepWorld seeds the initial snapshot straight from the save and
    // a restored engine starts paused, so relying on the homing phase would show
    // a wholly homeless colony at penalty work power until the player unpauses.
    const v5 = migrateSaveToLatest(v4WithThreeWorkers()) as SaveGameV7;
    const prep = buildColonyPrepWorld({ save: v5, systems: ALL_SYSTEMS });
    const seeded = getPrepResource(prep, SnapshotStore).latest!;
    expect(seeded.homeless).toBe(0);
  });

  it('fills houses the save already has instead of only the synthesized one', () => {
    // Not hypothetical: the house shipped while LATEST_SAVE_VERSION was still 4,
    // so every save written by a build between then and this one is a v4 save
    // that can already contain houses. Assigning only the synthesized house
    // would seed a well-housed colony as wholly homeless, at penalty work
    // power, for as long as the restored engine stays paused.
    const v4 = v4WithThreeWorkers();
    v4.buildings.push({
      id: 90, defId: 'house', col: 5, row: 3,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    });
    const v5 = migrateSaveToLatest(v4) as SaveGameV7;

    expect(v5.colonists.every((c) => c.homeId === 90)).toBe(true);
    // AND no starter house was gifted on top: a colony with shelter does not
    // need a free building, and this is what stops the assertion above passing
    // via a synthesized house that merely happens to be filled too.
    expect(v5.buildings.filter((b) => b.defId === 'house')).toHaveLength(1);
    expect(v5.map).toEqual(v4.map);   // and its map was not resized for a tile it never needed
  });

  it('does not seat anyone in a relocating house', () => {
    // rehome excludes relocating shelters, so a migration that included them
    // would seed an assignment the first homing pass immediately revokes —
    // exactly the seed-contradicts-engine defect this whole section exists to
    // prevent, just arriving from the other direction.
    const v4 = v4WithThreeWorkers();
    v4.buildings.push({
      id: 90, defId: 'house', col: 5, row: 3,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 6,
    });
    const v5 = migrateSaveToLatest(v4) as SaveGameV7;

    expect(v5.colonists.every((c) => c.homeId !== 90)).toBe(true);
    // The colony owns a house — mid-relocation, but a house all the same — so
    // it does NOT count as shelterless: no starter house is gifted on top, and
    // every colonist loads homeless until the relocation lands. See OBS-6-05.
    expect(v5.buildings.filter((b) => b.defId === 'house')).toHaveLength(1);
    expect(v5.colonists.every((c) => c.homeId === null)).toBe(true);
  });

  it('the homeless-until-it-lands seed matches what tick 1 produces (OBS-6-05)', async () => {
    // The property the migration exists to preserve, checked rather than
    // restated: restoredColonists' bed count (usableBeds) and rehome's
    // (freeBeds) both exclude a relocating shelter exactly as savedShelterIds
    // does, so the colony this migrates to should be homeless in the SEEDED
    // snapshot and stay exactly as homeless after the first real tick — the
    // same seed-equals-tick-1 property `tests/engine/world.test.ts` pins for
    // the load repair, applied here to the migration that feeds it.
    const v4 = v4WithThreeWorkers();
    v4.buildings.push({
      id: 90, defId: 'house', col: 5, row: 3,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 6,
    });
    const v5 = migrateSaveToLatest(v4) as SaveGameV7;

    const world = await createColonyWorld(v5);
    const seeded = world.getResource(SnapshotStore).latest!;
    expect(seeded.homeless).toBe(3); // no usable shelter at all: nobody seated
    expect(seeded.colonists.every((c) => c.homeId === null)).toBe(true);

    await stepTick(world);
    const ticked = world.getResource(SnapshotStore).latest!;
    expect(ticked.homeless).toBe(seeded.homeless);
    expect([...ticked.colonists].sort((a, b) => a.id - b.id).map((c) => c.homeId))
      .toEqual([...seeded.colonists].sort((a, b) => a.id - b.id).map((c) => c.homeId));
  });

  it('leaves the overflow homeless when the saved houses cannot hold everyone', () => {
    // Six adults, one four-bed house: two really are homeless, and the
    // migration's job is to reproduce what homing would do rather than to bail
    // the player out of a colony they under-built.
    const v4 = v4WithThreeWorkers();
    v4.workers = [1, 2, 3, 4, 5, 6].map((id) => ({ ...v4.workers[0], id }));
    v4.buildings.push({
      id: 90, defId: 'house', col: 5, row: 3,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    });
    const v5 = migrateSaveToLatest(v4) as SaveGameV7;

    expect(v5.colonists.filter((c) => c.homeId === 90)).toHaveLength(MIGRATION_CONSTANTS.houseBeds);
    expect(v5.colonists.filter((c) => c.homeId === null)).toHaveLength(6 - MIGRATION_CONSTANTS.houseBeds);
    // Ascending colonist id fills first — rehome's rule, so reload is stable.
    expect(v5.colonists.filter((c) => c.homeId === null).map((c) => c.id)).toEqual([5, 6]);
  });

  it('keeps an age and a starvation clock the v4 record already carried', () => {
    // Increment 6 wrote both onto the optional v4 record before v5 existed, so
    // a colony saved by any build after that holds real accumulated values.
    // Overwriting the age would postpone retirement and death by thousands of
    // ticks purely because the save was upgraded; zeroing the starvation clock
    // would cancel a penalty already incurred.
    const v4 = v4WithThreeWorkers();
    v4.workers[0] = { ...v4.workers[0], ageTicks: 5100, starvingTicks: 40 };
    const v5 = migrateSaveToLatest(v4) as SaveGameV7;

    const kept = v5.colonists.find((c) => c.id === v4.workers[0].id)!;
    expect(kept.ageTicks).toBe(5100);
    expect(kept.starvingTicks).toBe(40);
    // Discriminating: the colonists that carried neither still get synthesized
    // values, so this cannot pass with the synthesis deleted outright.
    const synthesized = v5.colonists.find((c) => c.id === 3)!;
    expect(synthesized.ageTicks).not.toBe(5100);
    expect(synthesized.starvingTicks).toBe(0);
  });

  it('a v4 save written before the cooldown elapsed can still give birth immediately', () => {
    const early = { ...v4WithThreeWorkers(), tick: 0, lastRecruitTick: 0 };
    const v5 = migrateSaveToLatest(early) as SaveGameV7;
    // Discriminating: 0 would block a tick-0 colony's first birth for 50 ticks
    // purely because the save was reopened.
    expect(v5.lastBirthTick).toBeLessThanOrEqual(-BALANCE.birthCooldownTicks);
  });

  it('grows the map when a full v4 colony leaves no room for the starter house', () => {
    // The no-house branch is the one that fails silently: every colonist would
    // load homeless, which is exactly what this migration exists to prevent.
    const full = { ...v4WithThreeWorkers(), map: { cols: 8, rows: 6 } };
    full.buildings = Array.from({ length: (8 - 3) * 6 }, (_, i) => ({
      id: 100 + i, defId: 'forester' as const,
      col: 3 + (i % 5), row: Math.floor(i / 5),
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    }));
    full.nextEntityId = 1000;
    const v5 = migrateSaveToLatest(full) as SaveGameV7;

    expect(v5).not.toBeNull();
    expect(v5.buildings.some((b) => b.defId === 'house')).toBe(true);
    expect(v5.colonists.some((c) => c.homeId !== null)).toBe(true);
  });

  it('grows a WIDE full map without stranding its buildings outside the new bounds', () => {
    // Discriminating: a 50-column colony. A count-derived shape would hand it a
    // 24-column map, put every building at column 24+ outside the persisted
    // bounds, and isPositionsValid would reject a perfectly valid save into the
    // corrupt-backup path. Existing dimensions are a floor, not a suggestion.
    const wide = { ...v4WithThreeWorkers(), map: { cols: 50, rows: 6 } };
    wide.buildings = Array.from({ length: (50 - 3) * 6 }, (_, i) => ({
      id: 100 + i, defId: 'forester' as const,
      col: 3 + (i % 47), row: Math.floor(i / 47),
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    }));
    wide.nextEntityId = 1000;
    const v5 = migrateSaveToLatest(wide) as SaveGameV7;

    expect(v5).not.toBeNull();               // NOT the corrupt-backup path
    expect(v5.map.cols).toBeGreaterThanOrEqual(50);
    for (const b of v5.buildings) {
      expect(b.col).toBeLessThan(v5.map.cols);
      expect(b.row).toBeLessThan(v5.map.rows);
    }
  });

  it('does not mutate the v4 save it was handed', () => {
    const input = v4WithThreeWorkers();
    migrateSaveToLatest(input);
    expect(input).toEqual(v4WithThreeWorkers());
  });
});


/**
 * A guard-valid v5 save with a PRODUCER in it, not shelters alone: `inputBuffer`
 * is a producing building's field, and a colony of houses could not tell an
 * empty in-tray from a missing one.
 *
 * Every quantity here is pairwise distinct — 37 wood, 11 planks, 5 buffered
 * flour, tick 800 — so no assertion below can read a neighbour's number and
 * pass. In particular 37 and 11 differ from each other and from every total
 * under test, which is what makes "the stockpile landed at the camp" fail on
 * the VALUE rather than on a total that happens to differ.
 */
function v5WithAMill(): SaveGameV5 {
  return {
    version: 5, tick: 800, lastRecruitTick: 700, lastBirthTick: 600,
    stockpile: { wood: 37, planks: 11 },
    map: { cols: 24, rows: 16 },
    buildings: [
      { id: 1, defId: 'house', col: 4, row: 1, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      { id: 2, defId: 'mill', col: 6, row: 1, progress: 0, batchActive: false, buffer: { flour: 5 }, relocatingTicks: 0 },
    ],
    colonists: [{
      id: 3, hunger: 0, buildingId: 2, toolTicks: 0, hauling: false,
      ageTicks: MIGRATION_CONSTANTS.startingAgeTicks, homeId: 1, starvingTicks: 0,
    }],
    nextEntityId: 4,
  };
}

describe('migrateSaveToLatest (v5 -> v6)', () => {
  it('a v5 colony loads as v6 with empty input buffers and its stockpile at the camp', async () => {
    const migrated = migrateSaveToLatest(v5WithAMill());
    expect(migrated?.version).toBe(7);
    const v6 = migrated!;

    for (const b of v6.buildings) {
      expect(b.inputBuffer, `building ${b.id} in-tray`).toEqual({});
      expect(b.stored, `building ${b.id} stored`).toEqual({});
    }
    // Nothing else moves: a v5 colony was already a v6 one with no storehouses
    // and every input paid.
    expect(v6.buildings.find((b) => b.id === 2)!.buffer).toEqual({ flour: 5 });
    expect(v6.stockpile).toEqual({ wood: 37, planks: 11 });

    // The half a shape check cannot see. v6 redefines `stockpile` as the CAMP's
    // contents, so the migration is a no-op only if the restored ledger puts
    // every unit there — and creates no site for a colony that has no store.
    const stockpile = (await createColonyWorld(v6)).getResource(Stockpile);
    expect(stockpile.siteJSON(CAMP_SITE_ID)).toEqual({ wood: 37, planks: 11 });
    expect(stockpile.siteIds()).toEqual([CAMP_SITE_ID]);
  });

  it('does not mutate the v5 save it was handed', () => {
    const input = v5WithAMill();
    migrateSaveToLatest(input);
    expect(input).toEqual(v5WithAMill());
  });
});


/**
 * A guard-valid v6 save with a MILL in it, carrying goods in all three of a v6
 * building's piles — and NOT ONE MENTION of `constructionTicks` anywhere. That
 * absence is the fixture's point: this is what a file written by the previous
 * build actually looks like, and the whole v6 freeze exists so it still reaches
 * the migration below.
 *
 * Every quantity is pairwise distinct (41 wood at the camp, 7 buffered flour,
 * 6 wheat in the in-tray, 9 planks stored, tick 900) so no assertion can pass
 * by reading a neighbour's number.
 */
function v6WithAMill(): SaveGameV6 {
  return {
    version: 6, tick: 900, lastRecruitTick: 800, lastBirthTick: 700,
    stockpile: { wood: 41 },
    map: { cols: 24, rows: 16 },
    buildings: [
      { id: 1, defId: 'house', col: 4, row: 1, progress: 0, batchActive: false, buffer: {}, inputBuffer: {}, stored: {}, relocatingTicks: 0 },
      {
        id: 2, defId: 'mill', col: 6, row: 1, progress: 0, batchActive: false,
        buffer: { flour: 7 }, inputBuffer: { wheat: 6 }, stored: { planks: 9 }, relocatingTicks: 0,
      },
    ],
    colonists: [{
      id: 3, hunger: 0, buildingId: 2, toolTicks: 0, hauling: false,
      ageTicks: MIGRATION_CONSTANTS.startingAgeTicks, homeId: 1, starvingTicks: 0,
    }],
    nextEntityId: 4,
  };
}

describe('migrateSaveToLatest (v6 -> v7)', () => {
  it('a v6 save loads with every building FINISHED, and nothing else moved', () => {
    // The migration is TOTAL: every building in a pre-v7 save is finished by
    // construction, because no build before v7 could write a site. So there is
    // no heuristic here to get wrong — only a zero to supply, and a v6 guard
    // that must not have learned about the field it supplies.
    expect(JSON.stringify(v6WithAMill()).includes('constructionTicks')).toBe(false);

    const migrated = migrateSaveToLatest(v6WithAMill());
    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(7);
    for (const b of migrated!.buildings) {
      expect(b.constructionTicks, `building ${b.id}`).toBe(0);
    }
    // Nothing else moves. Read off the mill specifically: a migration that
    // rebuilt the record rather than extending it would silently drop the
    // three piles v6 added.
    const mill = migrated!.buildings.find((b) => b.id === 2)!;
    expect(mill.buffer).toEqual({ flour: 7 });
    expect(mill.inputBuffer).toEqual({ wheat: 6 });
    expect(mill.stored).toEqual({ planks: 9 });
    expect(migrated!.stockpile).toEqual({ wood: 41 });
    expect(migrated!.tick).toBe(900);
  });

  it('the migrated v6 save survives the CONSUMER gate, not merely the migration', () => {
    // A test that stops at the migration's output never reaches the gate that
    // rejects it: `isLoadableSave` narrows to the CURRENT save type, and until
    // it and `prepareLoadedSave` move to v7 a correctly migrated save is
    // refused one call later — the corrupt-backup path, for a perfectly good
    // colony.
    const prepared = prepareLoadedSave(v6WithAMill());
    expect(prepared).not.toBeNull();
    expect(prepared!.version).toBe(7);
    expect(decideLoad(v6WithAMill()).kind).toBe('restore');
  });

  it('a migrated v6 colony restores with every building in service', async () => {
    // The migration's zero has to reach the live component, not just the
    // record: a building restored under construction provides nothing.
    const world = await createColonyWorld(prepareLoadedSave(v6WithAMill())!);
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building === undefined) continue;
      expect(entity.getComponent(Construction)!.ticksLeft, `building ${building.id}`).toBe(0);
    }
  });

  it('does not mutate the v6 save it was handed', () => {
    const input = v6WithAMill();
    migrateSaveToLatest(input);
    expect(input).toEqual(v6WithAMill());
  });
});
