import type { SaveGameV6 } from '../shared/save';
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
export function isStockpileValid(stockpile: SaveGameV6['stockpile']): boolean {
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

export function isBuildingsValid(buildings: SaveGameV6['buildings']): boolean {
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

/**
 * The two kinds of building a colonist may point at, gathered once per save.
 *
 * You WORK at a producer and you SLEEP in a settled shelter, and neither
 * reference may name the other kind. Precomputed as sets rather than resolved
 * per record because the structural guard admits 10,000 buildings and 10,000
 * colonists, and a per-record scan over the building list would be O(n^2) on a
 * hand-edited save (the flooded-save principle: cheap checks before expensive
 * walks).
 *
 * A relocating shelter is deliberately absent from `shelters`: a house in
 * transit has no usable beds — `beds.total` excludes it and `rehome` evicts
 * its residents on sight — so a record pairing the two is one no engine
 * version could write. `handleMoveBuilding` sets the countdown and never
 * touches homes; eviction is `rehome`'s job, running later in the same tick
 * and before the end-of-tick autosave, so the pairing cannot reach a save
 * file. Note the asymmetry with the over-capacity case, which IS repaired at
 * load: over-capacity follows from retuning `houseBeds`, a balance value,
 * while nothing in BALANCE can turn an evicted resident back into a housed one.
 */
interface ColonistTargets {
  /** Buildings with a recipe: the only ones a job assignment may name. */
  workplaces: ReadonlySet<number>;
  /** Buildings with beds and no relocation in progress. */
  shelters: ReadonlySet<number>;
}

function colonistTargets(buildings: SaveGameV6['buildings']): ColonistTargets {
  const workplaces = new Set<number>();
  const shelters = new Set<number>();
  for (const b of buildings) {
    // isBuildingsValid has already refused an unknown defId by the time
    // isLoadableSave gets here; skipping rather than indexing keeps this
    // total if the composition order ever changes.
    if (!Object.hasOwn(BUILDINGS, b.defId)) continue;
    const def = BUILDINGS[b.defId];
    if (def.recipe !== null) workplaces.add(b.id);
    if (def.beds > 0 && b.relocatingTicks === 0) shelters.add(b.id);
  }
  return { workplaces, shelters };
}

// Upper bound intentionally NOT checked against current BALANCE.hungerMax:
// clamped to current balance at spawn instead (see spawnColonist), so a save
// written under a higher balance value still loads. Split out, alongside
// isValidToolTicks below, purely to keep isColonistRecordValid's own branch
// count (and CRAP score) down — same principle as isValidAgeTicks.
function isValidHunger(hunger: number): boolean {
  return hunger >= 0 && Number.isFinite(hunger);
}

// Upper bound intentionally NOT checked against current BALANCE.toolDurationTicks,
// same reasoning as isValidHunger above.
function isValidToolTicks(toolTicks: number): boolean {
  return Number.isSafeInteger(toolTicks) && toolTicks >= 0 && toolTicks <= MAX_SAVED_COUNTER;
}

function isColonistRecordValid(c: SaveGameV6['colonists'][number], targets: ColonistTargets): boolean {
  if (!isValidHunger(c.hunger)) return false;
  if (!isValidToolTicks(c.toolTicks)) return false;
  // Present, sheltering AND settled, all three in one membership test — see
  // ColonistTargets for why each is a record no engine version could write.
  // (ageTicks and starvingTicks are checked structurally by isSavedColonistShape
  // in src/shared/save.ts, which isLoadableSave runs first.)
  if (c.homeId !== null && !targets.shelters.has(c.homeId)) return false;
  if (c.buildingId === null) return true;
  // A worker is staffed XOR hauling, never both — handleAssignWorker refuses to
  // poach a hauler and handleAssignHauler refuses to poach a staffed worker, so
  // no version of the engine could ever write both onto one record. That makes
  // this an identity violation like the membership check below (a record no
  // playthrough could produce), not a balance-coupled value to clamp: there is
  // no "current" amount of double-staffing to grandfather down to.
  if (c.hauling) return false;
  // A PRODUCER, not merely a building that exists. A colonist assigned to a
  // house publishes as `1 / 0` workers on a zero-slot building, drops out of
  // idleAdults, and produces nothing forever — ProductionSystem skips
  // recipe-less buildings — and no command can create that assignment.
  return targets.workplaces.has(c.buildingId);
}

export function isColonistsValid(data: SaveGameV6): boolean {
  const targets = colonistTargets(data.buildings);
  return data.colonists.every((c) => isColonistRecordValid(c, targets));
}

// Cross-array id validity: positive integers, unique across buildings AND
// workers combined (they share one id space), and nextEntityId strictly past
// every id already handed out so the restored IdCounter can never collide.
// The MAX_SAVED_COUNTER ceiling cannot ping-pong (accepted save -> play ->
// rejected save): IdCounter saturates at that same ceiling, refusing entity
// creation instead of writing a counter the guard would refuse to load.
export function isIdsValid(data: SaveGameV6): boolean {
  const allIds = [...data.buildings.map((b) => b.id), ...data.colonists.map((c) => c.id)];
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
export function isPositionsValid(data: SaveGameV6): boolean {
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
 * One goods map naming only resources the catalog has. Written once and called
 * for all three of a building's maps rather than per field: they are the same
 * question about the same shape, and a per-field copy is how the newest map
 * ends up being the one nobody checks.
 */
function isCatalogBuffer(buffer: Partial<Record<string, number>>): boolean {
  const ids = Object.keys(buffer);
  // Key-count cap FIRST (same principle as isStockpileValid above): a valid
  // buffer has at most one key per catalog resource, and the membership walk
  // below would otherwise run once per key of an adversarially wide object —
  // multiplied by up to MAX_SAVED_ENTITIES buildings.
  if (ids.length > RESOURCE_IDS.length) return false;
  return ids.every((id) => Object.hasOwn(RESOURCES, id));
}

/**
 * Buffer contents are a cross-field truth like positions: catalog membership
 * needs the content catalog, which the structural guard in src/shared/ cannot
 * see. All THREE of a building's goods maps go through it — the out-tray, the
 * in-tray and its share of the ledger — because an unknown resource id is
 * equally unrestorable in each.
 *
 * The caps are NOT checked here: an over-cap buffer is clamped by spawnBuilding
 * and an over-capacity `stored` spills to the camp (restore.ts), exactly as
 * saved batch progress is clamped rather than rejected.
 */
export function isBuffersValid(data: SaveGameV6): boolean {
  return data.buildings.every(
    (b) => isCatalogBuffer(b.buffer) && isCatalogBuffer(b.inputBuffer) && isCatalogBuffer(b.stored),
  );
}
