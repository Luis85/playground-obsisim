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
 * Hard ceiling on distinct resources named in one building's output buffer,
 * checked BEFORE the per-amount walk for the same reason MAX_SAVED_ENTITIES is
 * checked before the per-record one: `Object.values` on an adversarially wide
 * object materializes every value before the first check could reject, and
 * MAX_SAVED_ENTITIES buildings multiply it.
 *
 * Deliberately generous rather than exact — the resource catalog lives in
 * engine content, which src/shared may not import, so the tight bound
 * (one key per catalog resource) belongs to isLoadableSave's isBuffersValid.
 * This one only has to be small enough to stop a flood and large enough that
 * no plausible catalog reaches it.
 */
const MAX_BUFFER_KEYS = 64;

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
 * `SaveGameV4.version` is the literal type `4`, raising this to 5 fails
 * typecheck AT those producers (`Type '5' is not assignable to type '4'`) until
 * the save type is updated too. That is deliberate — with hardcoded literals,
 * bumping the constant would have pointed the loader at v5 while autosaves and
 * fresh colonies kept claiming v4, and a v4-labelled save carrying v5 fields
 * would then be migrated a second time on load.
 */
export const LATEST_SAVE_VERSION = 4;

/** The v1 building record — frozen legacy shape, pre-spatial. */
export interface SavedBuildingV1 {
  id: number;
  defId: BuildingDefId;
  progress: number;
  batchActive: boolean;
}

/** The v2 building record — frozen legacy shape, pre-logistics. */
export interface SavedBuildingV2 extends SavedBuildingV1 {
  col: number;
  row: number;
}

/** The v3 building record — frozen legacy shape, pre-relocation. */
export interface SavedBuildingV3 extends SavedBuildingV2 {
  /** Output-buffer contents; `{}` when the building is empty. */
  buffer: Partial<Record<ResourceId, number>>;
}

/** The current building record: v3 plus the relocation countdown (save v4). */
export interface SavedBuilding extends SavedBuildingV3 {
  /** Ticks the building is still out of action after a move; 0 normally. */
  relocatingTicks: number;
}

/** The pre-v3 worker record — frozen legacy shape, before hauling existed. */
export interface SavedWorkerV2 {
  id: number;
  hunger: number;
  /** Building id this worker is assigned to, or null when idle. */
  buildingId: number | null;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
}

/**
 * The v3-and-v4 colonist record — frozen legacy shape.
 *
 * `ageTicks` and `starvingTicks` are OPTIONAL here, and that is not an
 * oversight: increment 6 added them to the live v4 record so an in-progress
 * lifespan or starvation would survive a save before v5 existed. A v4 file
 * written by any build from that point on therefore carries them, while one
 * written earlier does not — optional is exactly that shape. Declaring them
 * absent would also break the v4->v5 migration, which reads both to avoid
 * discarding them.
 */
export interface SavedColonistV4 {
  id: number;
  hunger: number;
  buildingId: number | null;
  toolTicks: number;
  /** True when this worker is assigned to hauling (save v3). */
  hauling: boolean;
  /** Ticks alive. */
  ageTicks?: number;
  /** Consecutive ticks pinned at max hunger. Saved for the same reason
   * `relocatingTicks` is (increment 5 §2.4): a penalty already incurred, and
   * omitting it would let save-and-reload cancel a starvation in progress. */
  starvingTicks?: number;
}

/**
 * The current colonist record (save v5): `homeId` is new, and the two
 * transitional fields above are promoted from optional to REQUIRED — v5 always
 * writes them, so nothing downstream needs a fallback.
 */
export interface SavedColonist extends Omit<SavedColonistV4, 'ageTicks' | 'starvingTicks'> {
  ageTicks: number;
  /** The house this colonist sleeps in, or null when homeless. */
  homeId: number | null;
  starvingTicks: number;
}

export interface SaveGameV1 {
  version: 1;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  buildings: SavedBuildingV1[];
  workers: SavedWorkerV2[];
  nextEntityId: number;
}

export interface SaveGameV2 {
  version: 2;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  /** World dimensions in tiles — persisted so a later increment can grow it. */
  map: WorldMapSize;
  buildings: SavedBuildingV2[];
  workers: SavedWorkerV2[];
  nextEntityId: number;
}

export interface SaveGameV3 {
  version: 3;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  map: WorldMapSize;
  buildings: SavedBuildingV3[];
  workers: SavedColonistV4[];
  nextEntityId: number;
}

export interface SaveGameV4 {
  version: 4;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  map: WorldMapSize;
  buildings: SavedBuilding[];
  workers: SavedColonistV4[];
  nextEntityId: number;
}

/**
 * The current save (v5): demographics arrive. The roster is renamed from
 * `workers` to `colonists` — a v4 colony was a workforce, a v5 one is a
 * population that ages, sleeps somewhere and can starve — and the birth clock
 * joins the recruit clock as persisted state.
 */
export interface SaveGameV5 extends Omit<SaveGameV4, 'version' | 'workers'> {
  version: 5;
  /** Tick of the last birth — see SimClock.lastBirthTick. Persisted for the
   * reason lastRecruitTick is: a cooldown a reload could cancel is not a
   * cooldown. */
  lastBirthTick: number;
  colonists: SavedColonist[];
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
    Number.isFinite((w as SavedColonistV4).id) &&
    Number.isFinite((w as SavedColonistV4).hunger) &&
    Number.isFinite((w as SavedColonistV4).toolTicks) &&
    ((w as SavedColonistV4).buildingId === null || Number.isFinite((w as SavedColonistV4).buildingId))
  );
}

/**
 * A non-negative safe integer, the shape every tick counter a colonist carries
 * must have. NOT bounds-checked against current balance: magnitude is
 * balance-coupled and clamped at spawn (clampedAge / clampedStarving), so a
 * save written under a longer lifespan or starvation window still loads.
 *
 * The lower bound is what closes a NaN path with teeth: `clampedAge(NaN)` is
 * `Math.max(0, Math.min(NaN, MAX_AGE_TICKS))` — still NaN — and
 * `resolveOldAge`'s `age.ticks < lifespanFor(...)` guard is false either way
 * for NaN, so its `continue` never fires and the colonist is removed on the
 * first tick after load rather than the save taking the corrupt-backup path.
 */
function isTickCounter(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The v5 colonist record: everything a v4 one needed, plus the three fields v5
 * promotes to required. `homeId` is a reference, so only its SHAPE is checked
 * here — that it names a real, sheltering, settled building is a cross-field
 * truth and lives in `isLoadableSave` beside the id and position checks.
 */
function isSavedColonistShape(w: unknown): boolean {
  if (!isSavedWorkerShape(w)) return false;
  const colonist = w as SavedColonist;
  return (
    isTickCounter(colonist.ageTicks) &&
    isTickCounter(colonist.starvingTicks) &&
    (colonist.homeId === null || Number.isFinite(colonist.homeId))
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

/**
 * Validate bounded entity arrays with per-record checks for both collections.
 *
 * The roster key is a PARAMETER, not the literal `workers`, because v5 renamed
 * it to `colonists`. Hard-coding it here — with `isCommonSaveShape` calling
 * this for every version guard — is what would make a mirrored v5 guard reject
 * every v5 save ever written, including the v4->v5 migration's own output:
 * the migration would run, its result would fail `guards[5]`, and
 * `migrateSaveToLatest` would return null, sending every existing colony down
 * the corrupt-save backup path with nothing downstream able to notice.
 */
function isValidSaveArrays(
  save: Record<string, unknown>, rosterKey: 'workers' | 'colonists', isRecord: (r: unknown) => boolean,
): boolean {
  const roster = save[rosterKey];
  return (
    Array.isArray(save.buildings) &&
    save.buildings.length <= MAX_SAVED_ENTITIES &&
    save.buildings.every(isSavedBuildingV1Shape) &&
    Array.isArray(roster) &&
    roster.length <= MAX_SAVED_ENTITIES &&
    roster.every(isRecord)
  );
}

/** The shape every version shares: counters, stockpile object, bounded entity
 * arrays with per-record checks. Number.isFinite, never typeof: NaN
 * and Infinity pass typeof === 'number' and would poison sim arithmetic. */
function isCommonSaveShape(
  save: Record<string, unknown>, rosterKey: 'workers' | 'colonists', isRecord: (r: unknown) => boolean,
): boolean {
  return (
    Number.isFinite(save.tick) &&
    Number.isFinite(save.lastRecruitTick) &&
    Number.isFinite(save.nextEntityId) &&
    isValidStockpile(save.stockpile) &&
    isValidSaveArrays(save, rosterKey, isRecord)
  );
}

/** What v1 through v4 pass: the legacy roster key and the legacy record. */
function isLegacyShape(save: Record<string, unknown>): boolean {
  return isCommonSaveShape(save, 'workers', isSavedWorkerShape);
}

export function isSaveGameV1(data: unknown): data is SaveGameV1 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return save.version === 1 && isLegacyShape(save);
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
    isLegacyShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every(hasSavedPosition)
  );
}

function isBufferShape(buffer: unknown): boolean {
  if (typeof buffer !== 'object' || buffer === null || Array.isArray(buffer)) return false;
  // Key-count cap FIRST (same principle as MAX_SAVED_ENTITIES): a valid buffer
  // names at most one resource per catalog entry, and Object.values on an
  // adversarially wide object would materialize every value before the
  // per-amount check below could reject.
  if (Object.keys(buffer).length > MAX_BUFFER_KEYS) return false;
  // Structural only: catalog membership and the cap are cross-field truths
  // that live in isLoadableSave, beside the id and position checks.
  return Object.values(buffer).every((amount) => Number.isSafeInteger(amount) && (amount as number) >= 0);
}

/** Every record in `roster` declares whether it hauls — the save-v3 addition. */
function everyRecordHauls(roster: unknown): boolean {
  return (roster as unknown[]).every((w) => typeof (w as SavedColonistV4).hauling === 'boolean');
}

/** The v4-and-later building record: positioned, buffered, and carrying a
 * relocation countdown. Shared by both guards rather than repeated, so the two
 * cannot drift about what a current building record is. */
function isSavedBuildingV4Shape(b: unknown): boolean {
  return (
    hasSavedPosition(b) &&
    isBufferShape((b as SavedBuilding).buffer) &&
    Number.isFinite((b as SavedBuilding).relocatingTicks)
  );
}

export function isSaveGameV3(data: unknown): data is SaveGameV3 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 3 &&
    isLegacyShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every((b) => hasSavedPosition(b) && isBufferShape((b as SavedBuildingV3).buffer)) &&
    everyRecordHauls(save.workers)
  );
}

export function isSaveGameV4(data: unknown): data is SaveGameV4 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 4 &&
    isLegacyShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every(isSavedBuildingV4Shape) &&
    everyRecordHauls(save.workers)
  );
}

/**
 * The current structural guard. Same building rules as v4; the roster moves to
 * `colonists` and carries the three fields v5 requires, and `lastBirthTick`
 * gets exactly the treatment `lastRecruitTick` gets (finite here, safe-integer
 * and not-ahead-of-`tick` in isLoadableSave, which can see the whole save).
 */
export function isSaveGameV5(data: unknown): data is SaveGameV5 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 5 &&
    isCommonSaveShape(save, 'colonists', isSavedColonistShape) &&
    Number.isFinite(save.lastBirthTick) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every(isSavedBuildingV4Shape) &&
    everyRecordHauls(save.colonists)
  );
}
