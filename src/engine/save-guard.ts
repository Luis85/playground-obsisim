import type { SaveGameV4 } from '../shared/save';
import { MAX_SAVED_COUNTER } from '../shared/save';
import { CAMP_COLS, isInsideMap } from '../shared/placement';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';

/**
 * Structural and referential validity predicates for a current-version save,
 * split out of world.ts. Each answers one question about a save record's shape
 * or its references into the content catalog; `isLoadableSave` (world.ts)
 * composes them.
 *
 * The split is mechanical — these were already private, pure, and free of
 * world-building concerns. It happened when world.ts approached the 500-line
 * cap, and it is only affordable because the maintainability gate now floors
 * the worst single file rather than a mean over all of them.
 */

// Object.hasOwn, never `in`: inherited keys like "toString" pass `in` and
// then indexing the catalog throws inside the guard.
// Safe-integer amounts only: organic stockpiles are integral, and an absurd
// magnitude (e.g. 1e308) would turn stock-value/wealth arithmetic infinite.
// The MAX_SAVED_COUNTER bound cannot ping-pong (accepted save -> one
// production tick, or a save banking a hauler's mid-trip load -> rejected
// save): Stockpile.add saturates at that same ceiling, and buildSaveFromWorld's
// deposit-on-save loop saturates identically, so the engine never banks an
// amount this guard would refuse.
export function isStockpileValid(stockpile: SaveGameV4['stockpile']): boolean {
  // Key-count cap FIRST (same principle as MAX_SAVED_ENTITIES): a valid
  // stockpile has at most one key per catalog resource, and Object.entries
  // on an adversarially huge object would materialize every entry before
  // the first per-entry check could reject.
  if (Object.keys(stockpile).length > RESOURCE_IDS.length) return false;
  return Object.entries(stockpile).every(
    ([id, amount]) =>
      Object.hasOwn(RESOURCES, id) &&
      Number.isSafeInteger(amount) &&
      (amount as number) >= 0 &&
      (amount as number) <= MAX_SAVED_COUNTER,
  );
}

export function isBuildingsValid(buildings: SaveGameV4['buildings']): boolean {
  return buildings.every((b) => {
    if (!Object.hasOwn(BUILDINGS, b.defId)) return false;
    if (b.batchActive) {
      // Upper bound intentionally NOT checked against the current recipe's
      // ticksPerBatch: a recipe retuned smaller after this save was written
      // would otherwise orphan it. Magnitude is irrelevant here because
      // spawnBuilding clamps active progress to the CURRENT batch size, so
      // the production loop never has a huge remainder to grind through.
      return b.progress >= 0 && Number.isFinite(b.progress);
    }
    return b.progress === 0; // stalled/idle buildings never bank progress (balance-independent engine invariant)
  });
}

function isWorkerRecordValid(w: SaveGameV4['workers'][number], buildingIds: ReadonlySet<number>): boolean {
  // Upper bounds intentionally NOT checked against current BALANCE.hungerMax /
  // toolDurationTicks: those are clamped to current balance at spawn instead
  // (see spawnWorker), so a save written under a higher balance value still loads.
  if (!(w.hunger >= 0 && Number.isFinite(w.hunger))) return false;
  if (!Number.isSafeInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > MAX_SAVED_COUNTER) return false;
  if (w.buildingId === null) return true;
  // A worker is staffed XOR hauling, never both — handleAssignWorker refuses to
  // poach a hauler and handleAssignHauler refuses to poach a staffed worker, so
  // no version of the engine could ever write both onto one record. That makes
  // this an identity violation like the membership check below (a record no
  // playthrough could produce), not a balance-coupled value to clamp: there is
  // no "current" amount of double-staffing to grandfather down to.
  if (w.hauling) return false;
  return buildingIds.has(w.buildingId);
}

export function isWorkersValid(data: SaveGameV4): boolean {
  const buildingIds = new Set(data.buildings.map((b) => b.id));
  return data.workers.every((w) => isWorkerRecordValid(w, buildingIds));
}

// Cross-array id validity: positive integers, unique across buildings AND
// workers combined (they share one id space), and nextEntityId strictly past
// every id already handed out so the restored IdCounter can never collide.
// The MAX_SAVED_COUNTER ceiling cannot ping-pong (accepted save -> play ->
// rejected save): IdCounter saturates at that same ceiling, refusing entity
// creation instead of writing a counter the guard would refuse to load.
export function isIdsValid(data: SaveGameV4): boolean {
  const allIds = [...data.buildings.map((b) => b.id), ...data.workers.map((w) => w.id)];
  // SAFE integers: past 2^53, ++ stops incrementing and ids would collide
  if (!allIds.every((id) => Number.isSafeInteger(id) && id > 0)) return false;
  if (new Set(allIds).size !== allIds.length) return false;
  if (
    !Number.isSafeInteger(data.nextEntityId) ||
    data.nextEntityId < 1 ||
    data.nextEntityId > MAX_SAVED_COUNTER
  ) return false;
  return allIds.every((id) => id < data.nextEntityId);
}

/**
 * Position invariants are cross-field truths — they need the save's own map
 * — so they live here beside the id checks, not in the structural guard.
 * Set-based, not isTileBuildable-per-record: that would be O(n^2) on a
 * 10,000-building hand-edited save (the flooded-save principle: cheap
 * checks before expensive walks).
 */
export function isPositionsValid(data: SaveGameV4): boolean {
  const tiles = new Set<string>();
  for (const b of data.buildings) {
    if (!isInsideMap(data.map, b.col, b.row) || b.col < CAMP_COLS) return false;
    const key = `${b.col},${b.row}`;
    if (tiles.has(key)) return false;
    tiles.add(key);
  }
  return true;
}

/**
 * Buffer contents are a cross-field truth like positions: catalog membership
 * needs the content catalog, which the structural guard in src/shared/ cannot
 * see. The cap is NOT checked here — see spawnBuilding, which clamps an
 * over-cap buffer at load exactly as it clamps saved batch progress.
 */
export function isBuffersValid(data: SaveGameV4): boolean {
  return data.buildings.every((b) => {
    const ids = Object.keys(b.buffer);
    // Key-count cap FIRST (same principle as isStockpileValid above): a valid
    // buffer has at most one key per catalog resource, and the membership walk
    // below would otherwise run once per key of an adversarially wide object —
    // multiplied by up to MAX_SAVED_ENTITIES buildings.
    if (ids.length > RESOURCE_IDS.length) return false;
    return ids.every((id) => Object.hasOwn(RESOURCES, id));
  });
}
