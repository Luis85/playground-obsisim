import type { BuildingDefId, ResourceId } from './content-types';

export interface SavedBuilding {
  defId: BuildingDefId;
  progress: number;
  batchActive: boolean;
}

export interface SavedWorker {
  hunger: number;
  /** Index into SaveGameV1.buildings, or null when idle. */
  buildingIndex: number | null;
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
    typeof save.stockpile === 'object' && save.stockpile !== null &&
    Array.isArray(save.buildings) &&
    save.buildings.every((b: unknown) =>
      typeof b === 'object' && b !== null &&
      typeof (b as SavedBuilding).defId === 'string' &&
      Number.isFinite((b as SavedBuilding).progress) &&
      typeof (b as SavedBuilding).batchActive === 'boolean') &&
    Array.isArray(save.workers) &&
    save.workers.every((w: unknown) =>
      typeof w === 'object' && w !== null &&
      Number.isFinite((w as SavedWorker).hunger) &&
      Number.isFinite((w as SavedWorker).toolTicks) &&
      ((w as SavedWorker).buildingIndex === null || Number.isFinite((w as SavedWorker).buildingIndex)))
  );
}
