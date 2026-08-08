import { describe, expect, it } from 'vitest';
import {
  commuteFactor, lifespanFor, SALT, spreadFor, stageOf, type CommuteRates, type LifeBands,
} from '../../src/shared/population';

// Deliberately not BALANCE's real numbers: this module takes bands as
// parameters precisely so it can be tested independent of tuning.
const BANDS: LifeBands = { matureTicks: 1000, retireTicks: 5500, lifespanTicks: 6500, spreadTicks: 800 };

describe('stageOf', () => {
  it('bands an age into child, adult, elder at the boundaries', () => {
    expect(stageOf(0, BANDS)).toBe('child');
    expect(stageOf(999, BANDS)).toBe('child');
    expect(stageOf(1000, BANDS)).toBe('adult');    // matureTicks is the first adult tick
    expect(stageOf(5499, BANDS)).toBe('adult');
    expect(stageOf(5500, BANDS)).toBe('elder');    // retireTicks is the first elder tick
    expect(stageOf(99_000, BANDS)).toBe('elder');
  });
});

describe('spreadFor', () => {
  it('never leaves the range', () => {
    for (let id = 1; id <= 500; id++) {
      const value = spreadFor(id, 8, SALT.lifespan);
      expect(value).toBeGreaterThanOrEqual(-8);
      expect(value).toBeLessThanOrEqual(8);
    }
  });

  it('is stable: the same id always draws the same value', () => {
    // Ids are unique and persisted, so this is what makes the draw survive a
    // save/load round trip without a seed in the save.
    expect(spreadFor(42, 8, SALT.lifespan)).toBe(spreadFor(42, 8, SALT.lifespan));
    expect(spreadFor(42, 8, SALT.lifespan)).not.toBe(spreadFor(43, 8, SALT.lifespan));
  });

  it('spreads consecutive ids across the range instead of collapsing', () => {
    // The failure a weak hash produces — every id landing on one value, or
    // alternating between two — passes a range test happily.
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => spreadFor(i + 1, 8, SALT.lifespan)));
    expect(drawn.size).toBeGreaterThan(12); // 17 values available; a real hash hits most
  });

  it('decorrelates salts: the gap between two draws is not constant', () => {
    // THE reason the salt exists (spec 2.12). Founders draw both a starting
    // age and a lifespan from this primitive; with one shared draw `s` the
    // two cancel — (lifespan + s) - (startingAge + s) — and every founder has
    // an identical remaining life, so they still die together. Range,
    // stability and distribution tests all pass while that is true.
    const gaps = new Set(
      Array.from({ length: 200 }, (_, i) => spreadFor(i + 1, 8, SALT.lifespan) - spreadFor(i + 1, 8, SALT.startingAge)),
    );
    expect(gaps.size).toBeGreaterThan(10);
  });

  it('breaks up the arithmetic progression a bare multiplicative hash leaves behind', () => {
    // A small range can't tell a real hash from a bare multiplicative one:
    // id*C wraps mod 2^32 every couple of ids, and that wrap alone already
    // scatters a 17-bucket range (the tests above use range 8) well enough
    // to pass regardless of whether the finaliser runs. A modulus close to
    // 2^32 removes that wrap-driven camouflage and shows what multiplication
    // alone produces: consecutive outputs marching by a near-constant step —
    // exactly the arithmetic progression the finaliser (the xorshift-multiply
    // rounds) exists to break up.
    const wide = Array.from({ length: 200 }, (_, i) => spreadFor(i + 1, 1_000_000, SALT.lifespan));
    const consecutiveGaps = new Set(wide.slice(1).map((v, i) => v - wide[i]));
    expect(consecutiveGaps.size).toBeGreaterThan(190); // 199 possible; a bare multiplicative hash collapses to ~150
  });
});

// Same principle as BANDS above: not BALANCE's real numbers, because the
// module takes its rates as a parameter precisely so the law can be tested
// independent of tuning.
const RATES: CommuteRates = { freeTiles: 2, penaltyPerTile: 0.03, floor: 0.5 };

describe('commuteFactor', () => {
  it('is free inside the free radius', () => {
    // THE property that keeps increment 5's measurements intact: the harness
    // houses its crews adjacent to their building, and adjacent must cost
    // nothing. ticksForDistance would have charged them — it floors at 1 by
    // design, so no haul is free — which is why this charges tiles instead.
    expect(commuteFactor(0, RATES, 0.5)).toBe(1);
    expect(commuteFactor(1, RATES, 0.5)).toBe(1);
    expect(commuteFactor(2, RATES, 0.5)).toBe(1);
  });

  it('charges only the tiles beyond the free radius', () => {
    expect(commuteFactor(3, RATES, 0.5)).toBeCloseTo(0.97, 5);
    expect(commuteFactor(10, RATES, 0.5)).toBeCloseTo(0.76, 5);
  });

  it('never falls below the floor', () => {
    expect(commuteFactor(100, RATES, 0.5)).toBe(0.5);
  });

  it('gives the homeless factor to a colonist with no home', () => {
    // Distinct from the floor on purpose in this fixture (0.4 vs 0.5) so the
    // assertion cannot pass by the two happening to be equal.
    expect(commuteFactor(null, RATES, 0.4)).toBe(0.4);
  });
});

describe('lifespanFor', () => {
  it('returns TICKS around the band, not years', () => {
    // Age is stored in ticks. A years-valued lifespan would kill colonists
    // around tick 65 — before maturity at 1000 — and both being `number`
    // means the compiler cannot catch it.
    for (let id = 1; id <= 100; id++) {
      const span = lifespanFor(id, BANDS);
      expect(span).toBeGreaterThanOrEqual(BANDS.lifespanTicks - BANDS.spreadTicks);
      expect(span).toBeLessThanOrEqual(BANDS.lifespanTicks + BANDS.spreadTicks);
      expect(span).toBeGreaterThan(BANDS.matureTicks);
    }
  });
});
