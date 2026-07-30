import type { BuildingDefId, ResourceId } from './content-types';

/**
 * Hard ceiling per entity array in a save. Organic play cannot approach this
 * (recruiting is cooldown-gated), but a synced/hand-edited data.json with
 * millions of records would otherwise freeze the renderer during entity
 * spawning. Checked BEFORE any per-record validation walks the arrays.
 */
export const MAX_SAVED_ENTITIES = 10_000;

/**
 * Counters keep incrementing after load, so a save sitting AT the safe-integer
 * ceiling would stop advancing precisely on its next ++. Require generous
 * headroom: ~4 billion post-load increments (~17 years of play at 8 ticks/s).
 *
 * Clampable counters (ticks) are clamped to this on load. The id counter can
 * NEVER clamp (uniqueness), and no accept-bound alone can guarantee that a
 * save written from an accepted state is re-accepted — the state sitting
 * exactly at any bound writes bound+1. Instead the id counter SATURATES at
 * runtime: IdCounter.exhausted() gates entity creation, so the engine
 * physically cannot write a nextEntityId past this ceiling.
 */
export const MAX_SAVED_COUNTER = Number.MAX_SAFE_INTEGER - 2 ** 32;

/**
 * The version `serialize()` writes. Bump this together with adding a
 * MigrationStep to SAVE_MIGRATIONS and a guard to SAVE_GUARDS — the migration
 * runner refuses a chain that cannot reach this version from a save's own.
 */
export const LATEST_SAVE_VERSION = 1;

export interface SavedBuilding {
  id: number;
  defId: BuildingDefId;
  progress: number;
  batchActive: boolean;
}

export interface SavedWorker {
  id: number;
  hunger: number;
  /** Building id this worker is assigned to, or null when idle. */
  buildingId: number | null;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
}

export interface SaveGameV1 {
  version: 1;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  buildings: SavedBuilding[];
  workers: SavedWorker[];
  nextEntityId: number;
}

export function isSaveGameV1(data: unknown): data is SaveGameV1 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  // Number.isFinite, never typeof: NaN and Infinity pass typeof === 'number'
  // and would silently poison sim arithmetic instead of taking the backup path.
  return (
    save.version === 1 &&
    Number.isFinite(save.tick) &&
    Number.isFinite(save.lastRecruitTick) &&
    Number.isFinite(save.nextEntityId) &&
    typeof save.stockpile === 'object' && save.stockpile !== null &&
    !Array.isArray(save.stockpile) && // an array passes typeof 'object' but would restore as an empty stockpile
    Array.isArray(save.buildings) &&
    save.buildings.length <= MAX_SAVED_ENTITIES &&
    save.buildings.every((b: unknown) =>
      typeof b === 'object' && b !== null &&
      Number.isFinite((b as SavedBuilding).id) &&
      typeof (b as SavedBuilding).defId === 'string' &&
      Number.isFinite((b as SavedBuilding).progress) &&
      typeof (b as SavedBuilding).batchActive === 'boolean') &&
    Array.isArray(save.workers) &&
    save.workers.length <= MAX_SAVED_ENTITIES &&
    save.workers.every((w: unknown) =>
      typeof w === 'object' && w !== null &&
      Number.isFinite((w as SavedWorker).id) &&
      Number.isFinite((w as SavedWorker).hunger) &&
      Number.isFinite((w as SavedWorker).toolTicks) &&
      ((w as SavedWorker).buildingId === null || Number.isFinite((w as SavedWorker).buildingId)))
  );
}
