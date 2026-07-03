import type { BuildingDefId, ResourceId } from './content-types';

/**
 * Hard ceiling per entity array in a save. Organic play cannot approach this
 * (recruiting is cooldown-gated), but a synced/hand-edited data.json with
 * millions of records would otherwise freeze the renderer during entity
 * spawning. Checked BEFORE any per-record validation walks the arrays.
 */
export const MAX_SAVED_ENTITIES = 10_000;

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
