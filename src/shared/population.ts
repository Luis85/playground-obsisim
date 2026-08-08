// The demographic law of the colony in one pure module: which life stage an
// age falls in, how long a given colonist lives, and the deterministic jitter
// that keeps those two from synchronising. Same role haul.ts plays for
// logistics — the engine enforces these rules and the UI previews them, and
// src/shared/ may import nothing outside itself, so bands and rates arrive as
// parameters rather than from BALANCE.
//
// EVERY age-shaped value here is in TICKS. Years exist only where BALANCE
// declares the bands; the conversion happens there and nothing downstream
// sees a year.

export type LifeStage = 'child' | 'adult' | 'elder';

/** The age bands, in ticks. Supplied by BALANCE.lifeBands. */
export interface LifeBands {
  /** First tick at which a colonist may be assigned to work. */
  matureTicks: number;
  /** First tick at which a colonist retires and stops being assignable. */
  retireTicks: number;
  /** Centre of the lifespan distribution. */
  lifespanTicks: number;
  /** Half-width of that distribution — see spreadFor. */
  spreadTicks: number;
}

/**
 * Per-call-site salts for spreadFor. NOT decoration: founders draw both a
 * starting age and a lifespan from the same primitive, and with one unsalted
 * draw `s` per id the two cancel exactly — every founder's remaining life is
 * `(lifespanTicks + s) - (startingAgeTicks + s)`, a constant — so they die on
 * the same tick anyway, which is the outcome staggered starting ages exist to
 * prevent. Distinct salts make the three draws independent.
 *
 * Values are arbitrary odd 32-bit constants; only their distinctness matters.
 */
export const SALT = {
  lifespan: 0x9e3779b1,
  startingAge: 0x85ebca6b,
  arrivalAge: 0xc2b2ae35,
} as const;

/**
 * Deterministic jitter in `[-range, +range]`, derived from an entity id.
 *
 * The project has no RNG and does not gain one here: a seeded generator would
 * have to be persisted and restored, while an id-derived hash is stable across
 * save/load for free (ids are already unique and persisted). Without any
 * jitter, a fixed lifespan makes every death an exact copy of a birth one
 * lifespan earlier — the founders die together, and a run of births spaced by
 * the birth cooldown produces deaths spaced identically.
 *
 * A bare multiplicative hash leaves consecutive ids in an arithmetic
 * progression for small inputs, so the two xorshift-multiply rounds below
 * (a standard 32-bit finaliser) are what actually scatter them.
 */
export function spreadFor(id: number, range: number, salt: number): number {
  if (range <= 0) return 0;
  let h = (Math.imul(id, 2654435761) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % (2 * range + 1)) - range;
}

/**
 * The band an age falls in. Derived, never stored: a maturity flag beside an
 * age is a second source of truth that can disagree with it, and moving a band
 * would then need a save migration.
 */
export function stageOf(ageTicks: number, bands: LifeBands): LifeStage {
  if (ageTicks < bands.matureTicks) return 'child';
  return ageTicks < bands.retireTicks ? 'adult' : 'elder';
}

/** This colonist's lifespan, in ticks. */
export function lifespanFor(id: number, bands: LifeBands): number {
  return bands.lifespanTicks + spreadFor(id, bands.spreadTicks, SALT.lifespan);
}
