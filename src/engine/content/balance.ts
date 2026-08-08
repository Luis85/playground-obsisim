import type { ResourceId } from '../../shared/content-types';
import { MAX_MAP } from '../../shared/placement';

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

export const BALANCE = {
  hungerPerTick: 1,
  hungerMax: 100,
  mealThreshold: 50,
  berriesHungerRestore: 30,
  starvingEfficiency: 0.2,
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
  maxRelocationTicks: MAX_RELOCATION_TICKS,
} as const;

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
