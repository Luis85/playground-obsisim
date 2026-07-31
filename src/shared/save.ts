import type { BuildingDefId, ResourceId } from './content-types';
import { MAX_MAP, MIN_MAP, type WorldMapSize } from './placement';

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
 * The version every save producer writes. Bump this together with adding a
 * MigrationStep to SAVE_MIGRATIONS and a guard to SAVE_GUARDS — the migration
 * runner refuses a chain that cannot reach this version from a save's own.
 *
 * Both producers (`buildSaveFromWorld`, `initialSave`) use this constant rather
 * than a literal, which makes the bump self-policing: because
 * `SaveGameV2.version` is the literal type `2`, raising this to 3 fails
 * typecheck AT those producers (`Type '3' is not assignable to type '2'`) until
 * the save type is updated too. That is deliberate — with hardcoded literals,
 * bumping the constant would have pointed the loader at v3 while autosaves and
 * fresh colonies kept claiming v2, and a v2-labelled save carrying v3 fields
 * would then be migrated a second time on load.
 */
export const LATEST_SAVE_VERSION = 2;

/** The v1 building record — frozen legacy shape, pre-spatial. */
export interface SavedBuildingV1 {
  id: number;
  defId: BuildingDefId;
  progress: number;
  batchActive: boolean;
}

/** The current building record: v1 plus the tile it stands on (save v2). */
export interface SavedBuilding extends SavedBuildingV1 {
  col: number;
  row: number;
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
  buildings: SavedBuildingV1[];
  workers: SavedWorker[];
  nextEntityId: number;
}

export interface SaveGameV2 {
  version: 2;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  /** World dimensions in tiles — persisted so a later increment can grow it. */
  map: WorldMapSize;
  buildings: SavedBuilding[];
  workers: SavedWorker[];
  nextEntityId: number;
}

function isSavedBuildingV1Shape(b: unknown): boolean {
  return (
    typeof b === 'object' && b !== null &&
    Number.isFinite((b as SavedBuildingV1).id) &&
    typeof (b as SavedBuildingV1).defId === 'string' &&
    Number.isFinite((b as SavedBuildingV1).progress) &&
    typeof (b as SavedBuildingV1).batchActive === 'boolean'
  );
}

function isSavedWorkerShape(w: unknown): boolean {
  return (
    typeof w === 'object' && w !== null &&
    Number.isFinite((w as SavedWorker).id) &&
    Number.isFinite((w as SavedWorker).hunger) &&
    Number.isFinite((w as SavedWorker).toolTicks) &&
    ((w as SavedWorker).buildingId === null || Number.isFinite((w as SavedWorker).buildingId))
  );
}

/** Validate stockpile structure: object (not array, not null). Number.isFinite
 * on amounts is checked per-record in isLoadableSave. */
function isValidStockpile(stockpile: unknown): boolean {
  return (
    typeof stockpile === 'object' && stockpile !== null &&
    !Array.isArray(stockpile) // an array passes typeof 'object' but would restore as an empty stockpile
  );
}

/** Validate bounded entity arrays with per-record checks for both collections. */
function isValidSaveArrays(save: Record<string, unknown>): boolean {
  return (
    Array.isArray(save.buildings) &&
    save.buildings.length <= MAX_SAVED_ENTITIES &&
    save.buildings.every(isSavedBuildingV1Shape) &&
    Array.isArray(save.workers) &&
    save.workers.length <= MAX_SAVED_ENTITIES &&
    save.workers.every(isSavedWorkerShape)
  );
}

/** The shape both versions share: counters, stockpile object, bounded entity
 * arrays with per-record checks. Number.isFinite, never typeof: NaN
 * and Infinity pass typeof === 'number' and would poison sim arithmetic. */
function isCommonSaveShape(save: Record<string, unknown>): boolean {
  return (
    Number.isFinite(save.tick) &&
    Number.isFinite(save.lastRecruitTick) &&
    Number.isFinite(save.nextEntityId) &&
    isValidStockpile(save.stockpile) &&
    isValidSaveArrays(save)
  );
}

export function isSaveGameV1(data: unknown): data is SaveGameV1 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return save.version === 1 && isCommonSaveShape(save);
}

function isMapShape(map: unknown): map is WorldMapSize {
  if (typeof map !== 'object' || map === null) return false;
  const { cols, rows } = map as WorldMapSize;
  return (
    Number.isSafeInteger(cols) && cols >= MIN_MAP.cols && cols <= MAX_MAP.cols &&
    Number.isSafeInteger(rows) && rows >= MIN_MAP.rows && rows <= MAX_MAP.rows
  );
}

function hasSavedPosition(b: unknown): boolean {
  return (
    Number.isSafeInteger((b as SavedBuilding).col) && (b as SavedBuilding).col >= 0 &&
    Number.isSafeInteger((b as SavedBuilding).row) && (b as SavedBuilding).row >= 0
  );
}

/** Structural v2 guard. Cross-field position truths (in the save's own map,
 * off the camp band, no two on one tile) live in isLoadableSave, like the
 * id checks — they need the whole save, not one record. */
export function isSaveGameV2(data: unknown): data is SaveGameV2 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 2 &&
    isCommonSaveShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every(hasSavedPosition)
  );
}
