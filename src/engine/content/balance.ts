import type { ResourceId } from '../../shared/content-types';
import { MAX_MAP } from '../../shared/placement';
import type { CommuteRates, LifeBands } from '../../shared/population';

/** Building relocation speed — half the hauler rate, because carrying a
 * building is harder than carrying goods. Extracted so maxRelocationTicks
 * below can derive from it instead of repeating the magnitude by hand. */
const RELOCATION_TILES_PER_TICK = 1;

/**
 * Clamp for a saved relocation countdown (spec 2.4), derived from the
 * LARGEST legal map rather than the default one. `isMapShape`
 * (src/shared/save.ts) accepts a map up to MAX_MAP, and `mapThatFits`
 * (src/shared/placement.ts) grows a migrated v1 colony's map that large
 * automatically, so MAX_MAP is reachable in ordinary play, not just a
 * theoretical bound. A cap sized only for the default 24x16 map's ~28-tile
 * diagonal truncates a real relocation penalty on a larger map at load —
 * `clampedRelocation` (spawn.ts) would cancel downtime the engine genuinely
 * charged, contradicting spec §2.4's save-and-reload guarantee. Deriving
 * from MAX_MAP keeps this correct if MAX_MAP or the rate above ever change,
 * instead of needing a second by-hand update the way the stale "30" (a
 * comment about the 24x16 map, on a constant that has to cover every map
 * size a save can legally carry) did.
 */
const MAX_RELOCATION_TICKS = Math.ceil(Math.hypot(MAX_MAP.cols, MAX_MAP.rows) / RELOCATION_TILES_PER_TICK);

/**
 * Ticks per game year. Years are an authoring and display unit only — this is
 * the one place the conversion happens, and nothing downstream of BALANCE ever
 * sees a year (spec 2.8). Matches statsWindowTicks and autosaveEveryTicks, and
 * makes tick->age arithmetic readable: tick 4,200 is year 42.
 */
const YEAR_TICKS = 100;

const years = (n: number): number => n * YEAR_TICKS;

export const BALANCE = {
  hungerPerTick: 1,
  hungerMax: 100,
  mealThreshold: 50,
  berriesHungerRestore: 30,
  starvingEfficiency: 0.2,
  /** Ticks pinned at hungerMax before a colonist dies — one year, so
   * starvation is a slow visible slide the player can still pull out of. */
  starvationDeathTicks: 100,
  toolMultiplier: 1.5,
  toolDurationTicks: 300,
  recruitCooldownTicks: 30,
  autosaveEveryTicks: 100,
  baseTicksPerSecond: 2,
  statsWindowTicks: 100,
  /** Units a building may hold before it stalls (total across resources). */
  outputBufferCap: 12,
  /** Units a building may hold of its own recipe's inputs (total across
   * resources, like outputBufferCap). Mirrors the output cap so a building's
   * in-tray and out-tray are the same size and a hauler's round trip is
   * symmetric. At one input per batch this is 12 batches of runway — ~36 ticks
   * for a mill, comfortably longer than the 13-tick worst-case one-way walk. */
  inputBufferCap: 12,
  /** Units one hauler carries per trip: two trips clear a full buffer. */
  haulCarryCapacity: 6,
  /** Hauler walking speed. A building beside the camp is a 1-tick walk; the far
   * corner of the default map is 13, so distance is a real investment. */
  haulTilesPerTick: 2,
  /** Units a storehouse can hold. Five full output buffers, so one depot
   * serves a cluster of four or five producers for several trips before it
   * backs up. */
  storehouseCapacity: 60,
  /** The smallest supply delivery worth a trip — don't walk thirteen tiles to
   * deliver one unit. Low enough that a small colony is never locked out of
   * supply entirely, which a higher floor would do. */
  minSupplyUnits: 2,
  /**
   * Units of one input a site aims to hold for each staffed consuming building
   * it is the nearest store site to (spec §2.2). One in-tray's worth, chosen
   * because `inputBufferCap` is the only comparable quantity the game already
   * has — not because it was measured.
   *
   * UNMEASURED, spec §4's question: does staging more than an in-tray's worth
   * pay, or does it just move the stall from the building to the depot? The
   * whole point of a depot beside a consumer (§1.1) is to feed it without
   * occupying in-tray concurrency, so the answer decides whether this should
   * be one tray, several, or a fraction.
   */
  siteStagingTarget: 12,
  /**
   * The smallest transfer worth walking, and deliberately a SEPARATE and
   * larger constant than `minSupplyUnits` (spec §2.4) — on STAGING's argument
   * rather than transfer's as a whole: a supply trip serves a building that is
   * blocked right now, a staging transfer serves one that might be blocked
   * later, so the speculative job takes the stricter threshold. It does not
   * extend to a drain, which is offered ahead of collect precisely because
   * something IS waiting for it, and which is exempt from this threshold when
   * the surplus rather than the headroom is what binds it (`drainFrom`).
   *
   * UNMEASURED, spec §4's question: is 4 the right premium over
   * `minSupplyUnits: 2`? Too low and haulers walk the map for tails; too high
   * and a depot's dead band (`2 x minTransferUnits` wide) swallows the
   * restocking the feature exists to do.
   */
  minTransferUnits: 4,
  /**
   * Free space a bounded site tries to keep — the room a depot holds back for
   * the short-hop collect deposits that are its outbound value. Below it the
   * site drains its largest surplus to the camp, and staging may never eat
   * into it (spec §2.2's two bounds).
   *
   * UNMEASURED, spec §4's question: is buying room worth a walk at all? A
   * drain spends a whole round trip on room rather than on goods, so a floor
   * set too high pays that price constantly and one set to zero never pays it
   * — and never notices a depot silting up either.
   */
  storehouseFreeFloor: 12,
  relocationTilesPerTick: RELOCATION_TILES_PER_TICK,
  yearTicks: YEAR_TICKS,
  /** Age bands in ticks (spec 2.2): child 0-9, adult 10-54, elder 55+,
   * dying at 65 +/- 8 years. */
  lifeBands: {
    matureTicks: years(10),
    retireTicks: years(55),
    lifespanTicks: years(65),
    spreadTicks: years(8),
  } as LifeBands,
  /** Founders' age, jittered per id under SALT.startingAge. */
  startingAgeTicks: years(25),
  /** A nomad arrives with most of a working life ahead — which is what makes
   * its higher food gate a fair price. */
  nomadArrivalTicks: years(20),
  maxRelocationTicks: MAX_RELOCATION_TICKS,
  /** Sleeping places one house provides. Three founders plus one spare, so
   * the opening has a free bed and the second house is the first growth
   * decision the player makes. */
  houseBeds: 4,
  /**
   * Meals per head a colony must hold before a birth is allowed. Lower than the
   * nomad gate: your own child is cheaper to take on than a stranger. Twelve
   * meals is six years of food banked per mouth — a colonist eats one meal per
   * mealThreshold ticks, so yearTicks buys two.
   *
   * RETUNED from 6 by measurement (spec 4.1). This is a STOCK test, so what it
   * really sets is the reserve a colony still holds at the moment growth stops:
   * births halt while the store is worth perHead * (population + 1). That
   * reserve has to absorb the overshoot matureTicks guarantees — a child eats
   * from birth and works ten years later, and at one birth per
   * birthCooldownTicks the colony can commit to roughly twenty extra mouths
   * before the first of them pays anything back. Twenty is an ABSOLUTE number,
   * not a proportion, so six meals a head is ample at 120 colonists and far too
   * thin at 40: swept on 4.1's own scenario, 6 through 9 go extinct and 10
   * upward do not. 12 is the lowest round value clear of that cliff, and clear
   * of it under every hauler count and chain size measured. Not higher, because
   * a birth gate should be the weakest governor that does the job — 16 and 20
   * also hold a deliberately under-hauled colony together, which only hides a
   * logistics failure the player should be made to see.
   */
  birthFoodPerHead: 12,
  /** Meals per head before a nomad may join — the recovery valve's price, and
   * deliberately the higher of the two (spec 2.7). Moved with the birth gate,
   * keeping the 5:3 proportion the pair shipped with, so "a nomad costs more
   * than a birth" stays a relationship rather than becoming an accident of two
   * literals that were retuned one at a time: ten years of stored food a head
   * against the birth gate's six. Measured reachable — a colony below its food
   * chain's ceiling clears 20 for most of a run, one already at its ceiling
   * never does, which is exactly the trap spec 2.7 asks the valve to be. */
  nomadFoodPerHead: 20,
  /** Ticks between births, colony-wide. */
  birthCooldownTicks: 50,
  /** Work power multiplier for a colonist with nowhere to live. Equal to
   * commute.floor (spec 4): homelessness is exactly as bad as the worst
   * possible commute, so the player has one number to beat. The two cannot
   * reference each other inside one object literal, so a content test pins
   * them together instead. */
  homelessFactor: 0.5,
  /** Commute tuning (spec 2.4). freeTiles is what makes an adjacent home
   * genuinely free, which is what keeps increment 5's measurements intact. */
  commute: { freeTiles: 2, penaltyPerTile: 0.03, floor: 0.5 } as CommuteRates,
} as const;

/**
 * Clamp for a saved age (spec 2.10). The oldest a colonist can legally be is
 * the longest lifespan current balance can draw — one tick past that and the
 * next PopulationSystem tick kills them anyway, so a save written under a
 * longer lifespan loads with its colonists brought down to what this balance
 * allows rather than being rejected. Same principle as clampedProgress and
 * clampedRelocation.
 */
export const MAX_AGE_TICKS = BALANCE.lifeBands.lifespanTicks + BALANCE.lifeBands.spreadTicks;

/** Spec 3.5: fed = 1.0 up to the meal threshold, then linear down to 0.2 at max hunger. */
export function colonistEfficiency(hunger: number): number {
  if (hunger <= BALANCE.mealThreshold) return 1;
  const starvation = (hunger - BALANCE.mealThreshold) / (BALANCE.hungerMax - BALANCE.mealThreshold);
  return 1 - (1 - BALANCE.starvingEfficiency) * starvation;
}

/**
 * One worker's contribution to its building's work power: efficiency, multiplied
 * while tool coverage lasts, multiplied again by where the worker lives.
 * Lives here beside colonistEfficiency because two callers derive it from
 * different sources — ProductionSystem from live components during a tick,
 * buildEntitySections from ColonistFacts. While the expression existed in both
 * places they could drift, and the drift is invisible on inspection: the UI
 * would report a work power the simulation never used.
 *
 * `placementFactor` defaults to 1 (no penalty) rather than requiring every
 * caller to pass it: exactly two callers need anything other than 1
 * (ProductionSystem and buildEntitySections), and a default keeps every other
 * computation — and every fixture that builds a worker with no notion of
 * housing — unaffected. Both of those callers now pass the full commute factor
 * (`commuteFactor`, which collapses to BALANCE.homelessFactor for a worker with
 * no home), not the binary housed/homeless value they started out passing.
 */
export function workerWorkPower(efficiency: number, toolTicks: number, placementFactor = 1): number {
  return efficiency * (toolTicks > 0 ? BALANCE.toolMultiplier : 1) * placementFactor;
}

export const STARTING_STOCK: Partial<Record<ResourceId, number>> = {
  wood: 30,
  berries: 20,
};

export const STARTING_COLONISTS = 3;
