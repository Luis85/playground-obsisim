import { describe, expect, it } from 'vitest';
import {
  autoPlacePosition, autoPlaceSequence, CAMP_COLS, DEFAULT_MAP, isTileBuildable, isUnderConstruction, mapThatFits, MAX_MAP, relocationTicks,
  type TileRef,
} from '../../src/shared/placement';

// The spatial law all three consumers share (spec §2.2): the engine's
// authoritative validation, the app's ghost pre-check, and the v1->v2
// migration's position synthesis.

// isRelocating's mirror (spec §4.1's "Construction as Work"): a construction
// site provides nothing while its countdown is still running. No production
// code calls this yet — Task 1 only lands the predicate the later tasks read
// — so this is its only exercise until then.
describe('isUnderConstruction', () => {
  it('is true while ticks remain and false once the countdown reaches zero', () => {
    expect(isUnderConstruction(1)).toBe(true);
    expect(isUnderConstruction(30)).toBe(true);
    expect(isUnderConstruction(0)).toBe(false);
  });
});

describe('isTileBuildable', () => {
  it('accepts a free in-bounds tile right of the camp band', () => {
    expect(isTileBuildable(DEFAULT_MAP, [], CAMP_COLS, 0)).toBe(true);
    expect(isTileBuildable(DEFAULT_MAP, [], DEFAULT_MAP.cols - 1, DEFAULT_MAP.rows - 1)).toBe(true);
  });

  it('rejects out-of-bounds and camp-band tiles', () => {
    expect(isTileBuildable(DEFAULT_MAP, [], -1, 0)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], DEFAULT_MAP.cols, 0)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, DEFAULT_MAP.rows)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, -1)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], CAMP_COLS - 1, 5)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 0, 0)).toBe(false);
  });

  it('rejects occupied tiles and non-integer coordinates', () => {
    expect(isTileBuildable(DEFAULT_MAP, [{ col: 5, row: 3 }], 5, 3)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [{ col: 5, row: 3 }], 5, 4)).toBe(true);
    expect(isTileBuildable(DEFAULT_MAP, [], 5.5, 3)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, Number.NaN)).toBe(false);
  });
});

describe('autoPlacePosition', () => {
  it("reproduces increment 2's derived plot geometry for the first 40 placements", () => {
    // The golden equivalence the migration stands on: derived-layout rank r
    // sat at col 4 + 2*(r % 5), row 1 + 2*floor(r / 5) (old layout.ts).
    const occupied: TileRef[] = [];
    for (let rank = 0; rank < 40; rank++) {
      const at = autoPlacePosition(DEFAULT_MAP, occupied)!;
      expect(at).toEqual({ col: 4 + 2 * (rank % 5), row: 1 + 2 * Math.floor(rank / 5) });
      occupied.push(at);
    }
  });

  it('skips occupied legacy plots', () => {
    expect(autoPlacePosition(DEFAULT_MAP, [{ col: 4, row: 1 }])).toEqual({ col: 6, row: 1 });
  });

  it('falls back to a row-major scan once the legacy sequence is exhausted', () => {
    const occupied: TileRef[] = [];
    for (let i = 0; i < 40; i++) occupied.push(autoPlacePosition(DEFAULT_MAP, occupied)!);
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toEqual({ col: CAMP_COLS, row: 0 });
  });

  it('returns null only when no buildable tile remains', () => {
    const occupied: TileRef[] = [];
    for (let row = 0; row < DEFAULT_MAP.rows; row++) {
      for (let col = CAMP_COLS; col < DEFAULT_MAP.cols; col++) occupied.push({ col, row });
    }
    expect(occupied).toHaveLength(336); // 21 x 16 buildable tiles
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toBeNull();
    expect(autoPlacePosition(DEFAULT_MAP, occupied.slice(0, -1))).toEqual({
      col: DEFAULT_MAP.cols - 1, row: DEFAULT_MAP.rows - 1,
    });
  });

  it('is deterministic', () => {
    const occupied: TileRef[] = [{ col: 4, row: 1 }, { col: 8, row: 3 }];
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toEqual(autoPlacePosition(DEFAULT_MAP, occupied));
  });
});

describe('mapThatFits', () => {
  it('returns the default map while the legacy pattern holds the colony', () => {
    expect(mapThatFits(0)).toEqual(DEFAULT_MAP);
    expect(mapThatFits(40)).toEqual(DEFAULT_MAP); // exactly the default's 40 plots
  });

  it('sizes rows for the legacy plot extent, keeping every increment-2 tile', () => {
    // building 41 sat at (4, 17) under increment 2's unbounded derived grid —
    // the map must be tall enough that the plot sequence itself reaches it
    expect(mapThatFits(41)).toEqual({ cols: DEFAULT_MAP.cols, rows: 18 });
    expect(mapThatFits(337)).toEqual({ cols: DEFAULT_MAP.cols, rows: 136 }); // 68 plot rows
  });

  it('falls back to capacity growth past the legacy band, covering the record cap', () => {
    const forTenThousand = mapThatFits(10_000);
    expect((forTenThousand.cols - CAMP_COLS) * forTenThousand.rows).toBeGreaterThanOrEqual(10_000);
    expect(forTenThousand.cols).toBeLessThanOrEqual(MAX_MAP.cols);
    expect(forTenThousand.rows).toBeLessThanOrEqual(MAX_MAP.rows);
  });
});

describe('autoPlaceSequence', () => {
  it('is exactly autoPlacePosition replayed over an empty map', () => {
    const occupied: TileRef[] = [];
    for (const tile of autoPlaceSequence(DEFAULT_MAP)) {
      expect(tile).toEqual(autoPlacePosition(DEFAULT_MAP, occupied));
      occupied.push(tile);
    }
    expect(occupied).toHaveLength(336); // every buildable tile, each exactly once
  });
});

describe('relocationTicks', () => {
  it('scales with distance moved', () => {
    expect(relocationTicks(10, 1)).toBe(10);
    expect(relocationTicks(10, 2)).toBe(5);
  });

  it('rounds up, so a partial tile still costs a whole tick', () => {
    expect(relocationTicks(7.21, 2)).toBe(4);
  });

  it('never returns zero — even a one-tile nudge costs something', () => {
    expect(relocationTicks(1, 100)).toBe(1);
    expect(relocationTicks(0, 1)).toBe(1);
  });
});
