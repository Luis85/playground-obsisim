import { describe, expect, it } from 'vitest';
import type { SaveGameV5, SavedColonist } from '../../src/shared/save';
import { isSaveGameV4, isSaveGameV5 } from '../../src/shared/save';

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
