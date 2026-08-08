import type { ResourceId } from '../../shared/content-types';
import { MAX_MAP } from '../../shared/placement';
import type { LifeBands } from '../../shared/population';

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
  /** Units one hauler carries per trip: two trips clear a full buffer. */
  haulCarryCapacity: 6,
  /** Hauler walking speed. A building beside the camp is a 1-tick walk; the far
   * corner of the default map is 13, so distance is a real investment. */
  haulTilesPerTick: 2,
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
 * while tool coverage lasts. Lives here beside colonistEfficiency because two
 * callers derive it from different sources — ProductionSystem from live
 * components during a tick, buildEntitySections from ColonistFacts. While the
 * expression existed in both places they could drift, and the drift is invisible
 * on inspection: the UI would report a work power the simulation never used.
 */
export function workerWorkPower(efficiency: number, toolTicks: number): number {
  return efficiency * (toolTicks > 0 ? BALANCE.toolMultiplier : 1);
}

export const STARTING_STOCK: Partial<Record<ResourceId, number>> = {
  wood: 30,
  berries: 20,
};

export const STARTING_COLONISTS = 3;
