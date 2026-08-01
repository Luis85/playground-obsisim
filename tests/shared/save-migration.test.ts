import { describe, expect, it } from 'vitest';
import type { MigrationStep, SaveGuards } from '../../src/shared/save-migration';
import { migrateSaveToLatest, readSaveVersion } from '../../src/shared/save-migration';
import { initialSave } from '../../src/engine/world';
import type { SaveGameV4 } from '../../src/shared/save';

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
    const out = migrateSaveToLatest(v1Fixture(7)) as SaveGameV4;
    expect(out.version).toBe(4);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    expect(out.buildings.map((b) => ({ col: b.col, row: b.row }))).toEqual([
      { col: 4, row: 1 }, { col: 6, row: 1 }, { col: 8, row: 1 }, { col: 10, row: 1 }, { col: 12, row: 1 },
      { col: 4, row: 3 }, { col: 6, row: 3 },
    ]);
    expect(out.buildings.map((b) => b.id)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it('assigns positions in ascending id order regardless of array order', () => {
    const shuffled = v1Fixture(2);
    shuffled.buildings.reverse();
    const out = migrateSaveToLatest(shuffled) as SaveGameV4;
    expect(out.buildings.find((b) => b.id === 10)).toMatchObject({ col: 4, row: 1 });
    expect(out.buildings.find((b) => b.id === 11)).toMatchObject({ col: 6, row: 1 });
  });

  it('preserves a valid colony bigger than the default map by growing the map', () => {
    // v1 had no building cap: 337 buildings is a legal save, never a corrupt
    // one — the migration must not route it to the backup-and-start-fresh path
    const out = migrateSaveToLatest(v1Fixture(337)) as SaveGameV4;
    expect(out.version).toBe(4);
    expect(out.buildings).toHaveLength(337);
    expect(out.map.rows).toBeGreaterThan(16); // grown past the 336-tile default
    const tiles = new Set(out.buildings.map((b) => `${b.col},${b.row}`));
    expect(tiles.size).toBe(337); // every position distinct and on the map
    // legacy fidelity holds PAST the default map's 40 plots: the 41st
    // building (id 50 — fixture ids start at 10) keeps the exact tile
    // increment 2's derived grid drew it at, row 17 included
    expect(out.buildings.find((b) => b.id === 50)).toMatchObject({ col: 4, row: 17 });
  });

  it('migrates the guard-cap worst case (10,000 buildings) without stalling', () => {
    // the sequence walk is linear — this is a performance contract as much as
    // a correctness one (a save must never hang plugin startup); vitest's
    // default per-test timeout doubles as the stall detector
    const out = migrateSaveToLatest(v1Fixture(10_000)) as SaveGameV4;
    expect(out.buildings).toHaveLength(10_000);
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
    expect(out.version).toBe(4);
    expect(out.buildings.every((b) => Object.keys(b.buffer).length === 0)).toBe(true);
    expect(out.workers.every((w) => w.hauling === false)).toBe(true);
  });

  it('leaves every other field of the v2 save exactly as it was', () => {
    const before = v2Save();
    const out = migrateSaveToLatest(before)!;
    expect(out.tick).toBe(40);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    expect(out.buildings.map((b) => `${b.col},${b.row}`)).toEqual(['4,1', '6,1']);
    expect(before.buildings[0]).not.toHaveProperty('buffer'); // input untouched
  });

  it('migrates a v1 save all the way to v4 in one call', () => {
    const v1 = {
      version: 1, tick: 5, lastRecruitTick: 0, stockpile: {},
      buildings: [{ id: 1, defId: 'forester', progress: 0, batchActive: false }],
      workers: [], nextEntityId: 2,
    };
    const out = migrateSaveToLatest(v1)!;
    expect(out.version).toBe(4);
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
    const migrated = migrateSaveToLatest(v3) as SaveGameV4;
    expect(migrated.version).toBe(4);
    expect(migrated.buildings[0].relocatingTicks).toBe(0);
    expect(migrated.buildings[0].buffer).toEqual({ wood: 2 }); // everything else survives
  });
});
