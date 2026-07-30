import { describe, expect, it } from 'vitest';
import type { MigrationStep, SaveGuards } from '../../src/shared/save-migration';
import { migrateSaveToLatest, readSaveVersion } from '../../src/shared/save-migration';
import { initialSave } from '../../src/engine/world';

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
  it('passes a v1 save through unchanged', () => {
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
