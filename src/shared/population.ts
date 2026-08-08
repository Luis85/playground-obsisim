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

/** Commute tuning, supplied by BALANCE. */
export interface CommuteRates {
  /** Tiles between home and work that cost nothing. */
  freeTiles: number;
  /** Fraction of work power lost per charged tile. */
  penaltyPerTile: number;
  /** The worst a commute can make a colonist. */
  floor: number;
}

/**
 * How much of their work a colonist actually delivers, given the distance
 * between where they sleep and where they work. `tiles` is null for a colonist
 * with no home, who takes `homelessFactor` instead.
 *
 * Charges TILES, not `ticksForDistance`. Reusing that is the obvious move and
 * it is wrong here: it floors at 1 by design, so that no placement is free and
 * no haul costs nothing. Applied to a commute that floor charges every
 * colonist in the game permanently — including the balance harness's crews,
 * which would shift every number increment 5 measured for a reason unrelated
 * to hauling. A commute genuinely can be free: you live next door.
 */
export function commuteFactor(tiles: number | null, rates: CommuteRates, homelessFactor: number): number {
  if (tiles === null) return homelessFactor;
  const charged = Math.max(0, tiles - rates.freeTiles);
  return Math.max(rates.floor, 1 - charged * rates.penaltyPerTile);
}

/** Meals per unit for each edible resource, supplied by the caller from the
 * content catalog (src/shared may not import it). */
export type MealWeights = Readonly<Record<string, number>>;

/** Total meals the store holds. */
export function mealsInStore(stock: Readonly<Record<string, number>>, weights: MealWeights): number {
  let meals = 0;
  for (const [id, weight] of Object.entries(weights)) meals += (stock[id] ?? 0) * weight;
  return meals;
}

/**
 * Meals per head, dividing by the population this gate would PRODUCE rather
 * than the current one — the honest question is "can the store feed them once
 * they are here?".
 *
 * It also removes a special case with a hole in it: dividing by the current
 * population needs `population === 0` treated as unbounded to dodge a division
 * by zero, and unbounded satisfies any threshold, so a colony with an empty
 * store and one standing bed could still welcome a nomad — contradicting the
 * claim that a foodless colony is unrecoverable.
 */
export function mealsPerHead(stock: Readonly<Record<string, number>>, weights: MealWeights, population: number): number {
  return mealsInStore(stock, weights) / (population + 1);
}

export type PopulationBlocker = 'noBed' | 'notEnoughFood' | 'cooldown' | 'noParents' | null;

/**
 * What to tell the player about each gate a nomad can fail on.
 *
 * ONE list, beside the union it is total over, deliberately. The engine emits
 * these as rejection notices when a recruitWorker command is refused, and the
 * Population view shows the same sentence beside the disabled button BEFORE
 * the click — two audiences for one fact. A second copy on the view side,
 * keyed by this same union, would still satisfy the compiler while drifting in
 * wording the first time either half was reworded, and the sharp edge is that
 * nothing would fail: the player would simply be promised one thing and told
 * another. Living here (rather than in the engine or in app/labels.ts) is what
 * lets both sides read it — src/shared imports nothing and both layers may
 * import it.
 *
 * The Record is keyed by the union with `null` excluded, so a gate added to
 * `PopulationBlocker` is a compile error here rather than an unexplained
 * disabled button.
 */
export const NOMAD_REJECTIONS: Record<Exclude<PopulationBlocker, null>, string> = {
  noBed: 'No free bed: build a house first.',
  notEnoughFood: 'Not enough food stored to feed another colonist.',
  cooldown: 'No one is passing through just yet.',
  noParents: 'No one is passing through just yet.', // unreachable: nomadBlocker never returns it
};

export interface BirthGate {
  stock: Readonly<Record<string, number>>;
  weights: MealWeights;
  population: number;
  adults: number;
  freeBeds: number;
  tick: number;
  lastBirthTick: number;
  cooldown: number;
  perHead: number;
}

/** The gate a birth fails, or null when one may happen. Order is the order the
 * player can act on: shelter, then parents, then food, then patience. */
export function birthBlocker(gate: BirthGate): PopulationBlocker {
  if (gate.freeBeds <= 0) return 'noBed';
  if (gate.adults < 2) return 'noParents';
  if (mealsPerHead(gate.stock, gate.weights, gate.population) < gate.perHead) return 'notEnoughFood';
  if (gate.tick < gate.lastBirthTick + gate.cooldown) return 'cooldown';
  return null;
}

export type NomadGate = Omit<BirthGate, 'adults' | 'lastBirthTick'> & { lastRecruitTick: number };

/** The same shape for a nomad, minus the two-adult rule: a colony that has
 * died out entirely can still be restarted by someone walking in — provided
 * there is food, which `mealsPerHead`'s population + 1 guarantees it checks. */
export function nomadBlocker(gate: NomadGate): PopulationBlocker {
  if (gate.freeBeds <= 0) return 'noBed';
  if (mealsPerHead(gate.stock, gate.weights, gate.population) < gate.perHead) return 'notEnoughFood';
  if (gate.tick < gate.lastRecruitTick + gate.cooldown) return 'cooldown';
  return null;
}
