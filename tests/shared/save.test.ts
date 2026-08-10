import { describe, expect, it } from 'vitest';
import type { SaveGameV5, SaveGameV6, SavedColonist } from '../../src/shared/save';
import { isSaveGameV4, isSaveGameV5, isSaveGameV6 } from '../../src/shared/save';

/**
 * The structural v5 guard, probed directly rather than through
 * `isLoadableSave`: the catalog-aware checks in `src/engine/world.ts` run
 * AFTER this one and cannot distinguish "the shape is wrong" from "the
 * references are wrong". Every case below therefore starts from a save this
 * guard accepts and breaks exactly one thing.
 */
function v5Fixture(): SaveGameV5 {
  return {
    version: 5,
    tick: 100,
    lastRecruitTick: 50,
    lastBirthTick: 40,
    stockpile: { wood: 10 },
    map: { cols: 24, rows: 16 },
    buildings: [{
      id: 1, defId: 'house', col: 4, row: 1,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    }],
    colonists: [{
      id: 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false,
      ageTicks: 2500, homeId: 1, starvingTicks: 0,
    }],
    nextEntityId: 3,
  };
}

describe('isSaveGameV5', () => {
  it('accepts a well-formed v5 save', () => {
    expect(isSaveGameV5(v5Fixture())).toBe(true);
  });

  it('reads the roster from `colonists`, never from `workers`', () => {
    // THE failure this guard cannot be allowed to have. `isValidSaveArrays`
    // hard-coded the key `workers`, and a v5 guard that mirrored v4 would
    // therefore reject every v5 save ever written — including the v4->v5
    // migration's own output, sending every existing colony down the
    // corrupt-backup path with nothing downstream able to notice.
    const misnamed = { ...v5Fixture(), workers: v5Fixture().colonists } as unknown as Record<string, unknown>;
    delete misnamed.colonists;
    expect(isSaveGameV5(misnamed)).toBe(false);
  });

  it('rejects a v4-shaped roster: ageTicks, starvingTicks and homeId are REQUIRED at v5', () => {
    // The three fields v5 promotes from optional/absent to required. Each is
    // dropped on its own from an otherwise-identical control, so no single
    // missing check can satisfy all three.
    for (const key of ['ageTicks', 'starvingTicks', 'homeId'] as const) {
      const save = v5Fixture();
      const colonist = { ...save.colonists[0] } as Record<string, unknown>;
      delete colonist[key];
      save.colonists = [colonist as unknown as SavedColonist];
      expect(isSaveGameV5(save), `${key} must be required`).toBe(false);
    }
  });

  it('rejects a negative, fractional or non-numeric ageTicks / starvingTicks', () => {
    for (const key of ['ageTicks', 'starvingTicks'] as const) {
      for (const bad of [-1, 1.5, Number.NaN, 'abc']) {
        const save = v5Fixture();
        save.colonists = [{ ...save.colonists[0], [key]: bad as never }];
        expect(isSaveGameV5(save), `${key}=${String(bad)}`).toBe(false);
      }
    }
  });

  it('accepts a null homeId but not a non-numeric one', () => {
    const homeless = v5Fixture();
    homeless.colonists = [{ ...homeless.colonists[0], homeId: null }];
    expect(isSaveGameV5(homeless)).toBe(true);
    const nonsense = v5Fixture();
    nonsense.colonists = [{ ...nonsense.colonists[0], homeId: 'somewhere' as never }];
    expect(isSaveGameV5(nonsense)).toBe(false);
  });

  it('requires a finite lastBirthTick, exactly as lastRecruitTick is required', () => {
    const missing = v5Fixture() as Partial<SaveGameV5>;
    delete missing.lastBirthTick;
    expect(isSaveGameV5(missing)).toBe(false);
    const nan = v5Fixture();
    nan.lastBirthTick = Number.NaN;
    expect(isSaveGameV5(nan)).toBe(false);
  });

  it('rejects a v4 save, and isSaveGameV4 rejects a v5 one', () => {
    // The two guards must not overlap: the migration runner validates at every
    // hop, so a v4 that also passed the v5 guard (or vice versa) would let a
    // half-migrated record through as finished.
    const v4 = {
      version: 4, tick: 100, lastRecruitTick: 50, stockpile: { wood: 10 },
      map: { cols: 24, rows: 16 },
      buildings: v5Fixture().buildings,
      workers: [{ id: 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false }],
      nextEntityId: 3,
    };
    expect(isSaveGameV4(v4)).toBe(true);
    expect(isSaveGameV5(v4)).toBe(false);
    expect(isSaveGameV4(v5Fixture())).toBe(false);
  });
});


/**
 * The v6 fixture: a v5 one whose single building carries the two maps v6 adds,
 * each holding a DIFFERENT resource at a DIFFERENT amount (3 wheat in the
 * in-tray, 8 planks stored, 10 wood at the camp). No subset of those coincides,
 * so a guard that checked one map twice — or checked the wrong one — cannot
 * pass by reading a neighbour's value.
 */
function v6Fixture(): SaveGameV6 {
  return {
    ...v5Fixture(),
    version: 6,
    buildings: [{
      id: 1, defId: 'house', col: 4, row: 1,
      progress: 0, batchActive: false, buffer: {},
      inputBuffer: { wheat: 3 }, stored: { planks: 8 }, relocatingTicks: 0,
    }],
  };
}

/** The two maps v6 adds, walked by every case below so neither can be the one
 * nobody checks. */
const NEW_MAPS = ['inputBuffer', 'stored'] as const;

describe('isSaveGameV6', () => {
  it('accepts a well-formed v6 save', () => {
    expect(isSaveGameV6(v6Fixture())).toBe(true);
  });

  it('requires both new maps on every building record', () => {
    // Uniform shape, `{}` when empty: each is dropped on its own from an
    // otherwise-identical control, so no single missing check satisfies both.
    for (const key of NEW_MAPS) {
      const save = v6Fixture();
      const building = { ...save.buildings[0] } as Record<string, unknown>;
      delete building[key];
      save.buildings = [building as unknown as SaveGameV6['buildings'][number]];
      expect(isSaveGameV6(save), `${key} must be required`).toBe(false);
    }
  });

  it('rejects a negative, fractional, non-numeric or array-shaped amount map', () => {
    for (const key of NEW_MAPS) {
      for (const bad of [{ wood: -1 }, { wood: 1.5 }, { wood: Number.NaN }, { wood: 'x' }, [], null]) {
        const save = v6Fixture();
        save.buildings = [{ ...save.buildings[0], [key]: bad as never }];
        expect(isSaveGameV6(save), `${key}=${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });

  it('rejects either new map naming absurdly many resources, before walking the amounts', () => {
    // The flooded-save principle: the key-count cap is checked BEFORE the
    // per-amount walk, so a hand-edited save cannot make the guard materialize
    // an adversarially wide object — multiplied by MAX_SAVED_ENTITIES buildings.
    const wide = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, 1]));
    for (const key of NEW_MAPS) {
      const save = v6Fixture();
      save.buildings = [{ ...save.buildings[0], [key]: wide as never }];
      expect(isSaveGameV6(save), key).toBe(false);
    }
  });

  it('rejects a v5 save, and isSaveGameV5 rejects a v6 one', () => {
    // Same non-overlap rule the v4/v5 pair above states: the runner validates
    // at every hop, so a v5 that also passed the v6 guard would let a
    // half-migrated record through as finished — with every storehouse's
    // contents and every in-tray silently absent.
    expect(isSaveGameV5(v5Fixture())).toBe(true);
    expect(isSaveGameV6(v5Fixture())).toBe(false);
    expect(isSaveGameV5(v6Fixture())).toBe(false);
  });
});
