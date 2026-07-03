import type { ResourceId } from '../../shared/content-types';

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
} as const;

/** Spec 3.5: fed = 1.0 up to the meal threshold, then linear down to 0.2 at max hunger. */
export function workerEfficiency(hunger: number): number {
  if (hunger <= BALANCE.mealThreshold) return 1;
  const starvation = (hunger - BALANCE.mealThreshold) / (BALANCE.hungerMax - BALANCE.mealThreshold);
  return 1 - (1 - BALANCE.starvingEfficiency) * starvation;
}

export const STARTING_STOCK: Partial<Record<ResourceId, number>> = {
  wood: 30,
  berries: 20,
};

export const STARTING_WORKERS = 3;
