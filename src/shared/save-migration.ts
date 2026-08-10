import type {
  SaveGameV1, SaveGameV2, SaveGameV3, SaveGameV4, SaveGameV5, SaveGameV6, SavedColonist, SavedColonistV4,
} from './save';
import {
  isSaveGameV1, isSaveGameV2, isSaveGameV3, isSaveGameV4, isSaveGameV5, isSaveGameV6, LATEST_SAVE_VERSION, MAX_SAVED_ENTITIES,
} from './save';
import type { WorldMapSize } from './placement';
import { autoPlacePosition, autoPlaceSequence, CAMP_COLS, MAX_MAP, mapThatFits } from './placement';
import { SALT, spreadFor } from './population';

/**
 * One structural upgrade between ADJACENT save versions. Migrations know
 * shapes, never content: no catalog, no BALANCE, no clamping (load-time
 * clamping stays in spawnColonist/spawnBuilding, per spec 4.5). That is what
 * lets this file live in src/shared/, which may import nothing else.
 *
 * `migrate` MUST return a new object and never mutate its input: callers may
 * still hold a reference to the pre-migration value (e.g. backupCorruptSave()
 * re-reads data.json rather than reusing the in-memory object, but that only
 * stays safe as long as nothing upstream of it has mutated the original).
 */
export interface MigrationStep {
  from: number;
  to: number;
  migrate: (save: unknown) => unknown;
}

/**
 * Structural guard per known version. A version with no guard is unknown —
 * `Partial` so that absence types as `undefined` and every lookup (`guards[v]`)
 * is forced through `?.` rather than typing as a present function that just
 * happens to be missing at runtime.
 */
export type SaveGuards = Partial<Record<number, (data: unknown) => boolean>>;

const SAVE_GUARDS: SaveGuards = {
  1: isSaveGameV1, 2: isSaveGameV2, 3: isSaveGameV3, 4: isSaveGameV4, 5: isSaveGameV5, 6: isSaveGameV6,
};

/**
 * v1 -> v2: space arrives. Every building gets the position increment 2's
 * derived layout drew it at — autoPlaceSequence yields exactly the order
 * autoPlacePosition would consume an empty map (pinned by test), walked
 * once for an ascending-id pass, so migration is linear in the building
 * count (the structural guard admits 10,000 records; startup must not
 * stall). The save gains a map sized by mapThatFits: tall enough that the
 * legacy plot sequence itself holds the colony — every building keeps the
 * exact increment-2 tile, through 640 buildings — growing for raw capacity
 * only past that band (v1 had no building cap, so oversized colonies are
 * legal saves, never corrupt ones). Placement
 * geometry is structure, not content (no catalog, no BALANCE), so this
 * file's import discipline holds. The done-check is an unreachable
 * invariant guard — mapThatFits covers every guard-admissible count —
 * kept so a future geometry bug fails loudly into the corrupt-backup path
 * instead of writing garbage.
 */
const migrateV1toV2: MigrationStep = {
  from: 1,
  to: 2,
  migrate: (save) => {
    const v1 = save as SaveGameV1; // the runner guard-validated this shape
    const map = mapThatFits(v1.buildings.length);
    const spots = autoPlaceSequence(map);
    const buildings = [...v1.buildings].sort((a, b) => a.id - b.id).map((b) => {
      const at = spots.next();
      if (at.done) throw new Error('more buildings than the world has tiles');
      return { ...b, col: at.value.col, row: at.value.row };
    });
    return { ...v1, version: 2, map, buildings };
  },
};

/**
 * v2 -> v3: logistics arrives. A v2 colony is exactly a v3 colony whose
 * buildings hold nothing and whose workers all work rather than haul, so this
 * is a shape fill with no geometry and no content — the import discipline of
 * this file is untouched.
 */
const migrateV2toV3: MigrationStep = {
  from: 2,
  to: 3,
  migrate: (save) => {
    const v2 = save as SaveGameV2; // the runner guard-validated this shape
    return {
      ...v2,
      version: 3,
      buildings: v2.buildings.map((b) => ({ ...b, buffer: {} })),
      workers: v2.workers.map((w) => ({ ...w, hauling: false })),
    };
  },
};

/**
 * v3 -> v4: relocation arrives. Every building starts settled — a save written
 * before moving cost anything cannot have been mid-move.
 */
const migrateV3toV4: MigrationStep = {
  from: 3,
  to: 4,
  migrate: (save) => {
    const v3 = save as SaveGameV3; // the runner guard-validated this shape
    return {
      ...v3,
      version: 4,
      buildings: v3.buildings.map((b) => ({ ...b, relocatingTicks: 0 })),
    };
  },
};

/**
 * BALANCE values the v4->v5 migration needs but cannot import — `src/shared/**`
 * may import nothing outside itself, and balance constants live only in
 * `src/engine/content/balance.ts`. The duplication is forced, so every one of
 * these is PINNED against its real counterpart by a content test rather than
 * trusted. An unpinned duplicate would drift silently and house or age a
 * migrated colony differently from a fresh one, for no stated reason.
 */
export const MIGRATION_CONSTANTS = {
  houseBeds: 4,           // BALANCE.houseBeds
  startingAgeTicks: 2500, // BALANCE.startingAgeTicks
  spreadTicks: 800,       // BALANCE.lifeBands.spreadTicks
  birthCooldownTicks: 50, // BALANCE.birthCooldownTicks
} as const;

/**
 * Starting-age jitter, decorrelated from the lifespan draw by its salt: with a
 * single unsalted draw per id the two cancel exactly and every founder still
 * dies on the same tick. `src/shared/population.ts` is importable from here
 * (both are src/shared), so the hash is imported rather than copied.
 */
const jitter = (id: number) => spreadFor(id, MIGRATION_CONSTANTS.spreadTicks, SALT.startingAge);

/**
 * Shelters the save ALREADY has, ascending by id.
 *
 * A v4 save written by any build after the house shipped can contain houses —
 * that was the repo's state for a whole increment, not a hypothetical — and
 * ignoring them would hand a well-housed colony a wholly-homeless seed at
 * penalty work power for as long as the player leaves the restored engine
 * paused. `defId === 'house'` rather than a catalog lookup because
 * `src/shared/**` cannot import BUILDINGS; pinned by a content test, like
 * every other duplicated fact here.
 *
 * Relocating houses are excluded for exactly the reason `rehome` excludes
 * them, and that agreement is the whole point: this must produce the
 * assignment the first homing pass would, or the seed contradicts the engine
 * the instant it runs.
 *
 * This answers the SEATING question only — where to put people. It is not the
 * question of whether the colony owns a shelter at all: `savedHasShelter`
 * below answers that one, deliberately without this filter. See
 * docs/issues/2026-08-09-migration-conflates-having-a-shelter-with-having-a-usable-one.md.
 */
function savedShelterIds(v4: SaveGameV4): number[] {
  return v4.buildings
    .filter((b) => b.defId === 'house' && b.relocatingTicks === 0)
    .map((b) => b.id)
    .sort((a, b) => a - b);
}

/**
 * Whether the save owns a house AT ALL, relocating or not — the ELIGIBILITY
 * question the starter-house gift needs, and a different question from
 * `savedShelterIds` above.
 *
 * Deliberately unfiltered. A house mid-relocation offers no bed today, but the
 * colony still demonstrably owns one, a relocation ends in a handful of
 * ticks, and a gifted house is permanent — so answering the gift question from
 * the seating list (which excludes it) conflated "has a shelter" with "has a
 * USABLE one": a v4 colony whose only house was mid-relocation at save time
 * read as shelterless and was handed a second, permanent house it kept
 * forever, on top of the one it already had.
 */
function savedHasShelter(v4: SaveGameV4): boolean {
  return v4.buildings.some((b) => b.defId === 'house');
}

/**
 * The map grown far enough that one more building fits. Without this, a v4
 * save with every buildable tile occupied silently gets NO starter house and
 * every colonist loads homeless — the precise outcome this migration exists to
 * prevent, reached through the one branch that quietly does nothing.
 *
 * Grown FROM the save's own map, never from `mapThatFits(count)`: that helper
 * derives a shape from DEFAULT_MAP and would hand a full 50x6 colony a
 * 24-column map, stranding every building at column 24+ outside the persisted
 * bounds — isPositionsValid then rejects the migration and a valid save takes
 * the corrupt-backup path. Existing dimensions are a floor, never a starting
 * point to be replaced.
 *
 * The `break` is unreachable and kept as total-function hygiene: the
 * structural guard admits at most MAX_SAVED_ENTITIES (10,000) buildings, while
 * MAX_MAP minus the camp band is (256 - 3) * 256 = 64,768 buildable tiles, so
 * the loop always exits on its own condition. Retune either bound and the arm
 * becomes live — at which point loading homeless with a grown map is still
 * correct, because the alternative is demolishing the player's buildings to
 * make room for a house they did not ask for.
 */
function grownMap(from: WorldMapSize, buildingCount: number): WorldMapSize {
  const map = { ...from };
  while (buildingCount >= (map.cols - CAMP_COLS) * map.rows) {
    if (map.rows < MAX_MAP.rows) map.rows += 1;
    else if (map.cols < MAX_MAP.cols) map.cols += 1;
    else break;
  }
  return map;
}

/**
 * The smallest unused positive id, NOT max + 1. A guard-valid v4 save may sit
 * at nextEntityId === MAX_SAVED_COUNTER — IdCounter.exhausted() exists
 * precisely to keep such a save playable — and max + 1 would push nextEntityId
 * past the ceiling, so isIdsValid would reject a previously valid save
 * straight into the corrupt-backup path. The arrays hold at most 20,000
 * records, so a gap below the ceiling always exists.
 */
function smallestFreeId(v4: SaveGameV4): number {
  const used = new Set([...v4.buildings.map((b) => b.id), ...v4.workers.map((w) => w.id)]);
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

/**
 * Greedy fill: colonists ascending by id into shelters ascending by building
 * id, houseBeds each — `rehome`'s own documented rule, so the seeded
 * assignment IS the one the first homing pass produces. Colonists past the
 * last bed get null, which is the truth about that colony rather than a
 * failure: a save with one house and ten adults really does have six homeless,
 * and the migration's job is to reproduce homing, not to bail the player out
 * of it.
 *
 * `ageTicks` and `starvingTicks` are KEPT when the record already carries
 * them. Increment 6 wrote both onto the optional v4 record before v5 existed,
 * so a colony saved by any build after that holds real accumulated values:
 * overwriting the age would postpone retirement and death by thousands of
 * ticks purely because the save was upgraded, and zeroing the starvation clock
 * would cancel up to 99 ticks of incurred starvation for the same reason. The
 * `??` fallbacks cover only genuinely legacy records that never had the field.
 */
function housedColonists(workers: readonly SavedColonistV4[], shelterIds: readonly number[]): SavedColonist[] {
  return [...workers].sort((a, b) => a.id - b.id).map((w, index) => ({
    ...w,
    ageTicks: w.ageTicks ?? MIGRATION_CONSTANTS.startingAgeTicks + jitter(w.id),
    homeId: shelterIds[Math.floor(index / MIGRATION_CONSTANTS.houseBeds)] ?? null,
    starvingTicks: w.starvingTicks ?? 0,
  }));
}

/**
 * v4 -> v5: demographics arrive. A v4 colony is a colony of adults who have
 * never had anywhere to live, so this synthesises the state the new mechanic
 * needs rather than deferring it — exactly as v1 -> v2 synthesised positions.
 *
 * The starter house and its assignments are written HERE, not left to the
 * homing phase, because buildColonyPrepWorld seeds the initial snapshot
 * straight from the save and a restored engine starts paused: an all-null
 * homeId would present a wholly homeless colony at penalty work power for as
 * long as the player leaves it paused.
 *
 * The house is synthesised ONLY for a colony with no shelter at all, and only
 * while the entity cap leaves room for it. Its justification is "a v4 colony
 * has never had anywhere to live"; a colony that demonstrably has houses does
 * not need a free one, and a colony already AT MAX_SAVED_ENTITIES cannot gain
 * a building without failing the very guard that has to accept the output.
 * Map growth is gated on the same question — a save that needs no tile must
 * not have its persisted map resized as a side effect.
 */
const migrateV4toV5: MigrationStep = {
  from: 4,
  to: 5,
  migrate: (save) => {
    const v4 = save as SaveGameV4; // the runner guard-validated this shape
    const shelterIds = savedShelterIds(v4);
    const wantsStarterHouse = !savedHasShelter(v4) && v4.buildings.length < MAX_SAVED_ENTITIES;
    const map = wantsStarterHouse ? grownMap(v4.map, v4.buildings.length) : { ...v4.map };
    // Null is unreachable given the capacity argument on grownMap, and is kept
    // for the same reason its `break` is. Never invent a tile as a fallback: a
    // house at col < CAMP_COLS fails isPositionsValid and sends the whole save
    // down the corrupt-backup path, which is strictly worse than loading
    // homeless — and homeless is recoverable by demolishing one building.
    const at = wantsStarterHouse ? autoPlacePosition(map, v4.buildings) : null;
    const houseId = smallestFreeId(v4);
    const house = at === null ? null : {
      id: houseId, defId: 'house' as const, col: at.col, row: at.row,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    };
    if (house !== null) shelterIds.push(houseId);
    // Written out field by field rather than spread-minus-`workers`: v4 is a
    // frozen shape, and naming each carried field is what makes the ONE
    // dropped key (`workers`, renamed to `colonists`) visible at a glance.
    return {
      version: 5,
      tick: v4.tick,
      lastRecruitTick: v4.lastRecruitTick,
      stockpile: v4.stockpile,
      // The sentinel, not 0. "Any migrated colony is already past the
      // cooldown" is false for a v4 save written before tick 50 — a tick-0
      // colony would have its first otherwise-eligible birth blocked purely
      // because it was reopened, which is the save-alters-growth defect
      // lastBirthTick exists to prevent.
      lastBirthTick: -MIGRATION_CONSTANTS.birthCooldownTicks,
      map,
      buildings: house === null ? v4.buildings : [...v4.buildings, house],
      colonists: housedColonists(v4.workers, shelterIds),
      // Never lowered, and safe: houseId fills a GAP below the ceiling, so
      // with at most 20,000 records the smallest unused id is at most 20,001
      // and this can never push the counter near MAX_SAVED_COUNTER.
      nextEntityId: Math.max(v4.nextEntityId, houseId + 1),
    };
  },
};

/**
 * v5 -> v6: goods gain places to be. A v5 colony was exactly a v6 colony with
 * no storehouses and every recipe input already paid out of the flat ledger, so
 * every building starts with an empty in-tray and stores nothing — and
 * `stockpile`, which v6 redefines as the camp's contents, needs no touch at
 * all, because the camp is the only place a v5 colony could keep anything.
 */
const migrateV5toV6: MigrationStep = {
  from: 5,
  to: 6,
  migrate: (save) => {
    const v5 = save as SaveGameV5; // the runner guard-validated this shape
    return {
      ...v5,
      version: 6,
      buildings: v5.buildings.map((b) => ({ ...b, inputBuffer: {}, stored: {} })),
    };
  },
};

/** The registration tables this module owns, edited in place when a version
 * lands. Deliberately not exported: tests inject fakes through
 * migrateSaveToLatest's parameters instead. */
const SAVE_MIGRATIONS: readonly MigrationStep[] = [
  migrateV1toV2, migrateV2toV3, migrateV3toV4, migrateV4toV5, migrateV5toV6,
];

export function readSaveVersion(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const { version } = data as { version?: unknown };
  return Number.isSafeInteger(version) && (version as number) >= 1 ? (version as number) : null;
}

/**
 * Run a version guard, treating a THROW exactly as a rejection. A guard is
 * hand-written code inspecting old, real save data — the same risk class as a
 * migration step, and so it gets the same protection for the same reason: an
 * escaping exception travels migrateSaveToLatest -> prepareLoadedSave ->
 * loadSave() into GameView.onOpen's catch, where the view fails to open AND the
 * corrupt-backup/fresh-colony path (spec 7.2) never runs. Protecting the step
 * but not the guards would leave that hole open at three call sites.
 *
 * A MISSING guard (unknown version) is a rejection too — `?? false` keeps that
 * behaviour identical to the `!guards[v]?.(data)` checks this replaced.
 */
function passesGuard(guard: ((data: unknown) => boolean) | undefined, data: unknown): boolean {
  try {
    return guard?.(data) ?? false;
  } catch {
    return false;
  }
}

function runSteps(
  data: unknown,
  from: number,
  target: number,
  steps: readonly MigrationStep[],
  guards: SaveGuards,
): unknown | null {
  let current = data;
  let at = from;
  while (at < target) {
    // filter, not find: two steps sharing a `from` is a configuration mistake
    // whose outcome would otherwise depend on array order, and both variants
    // can emit guard-valid output with different defaults, so no guard can
    // catch "the wrong migration ran". Ambiguity is refused, not resolved.
    const candidates = steps.filter((candidate) => candidate.from === at);
    if (candidates.length !== 1) return null;
    const [step] = candidates;
    // Adjacency is MACHINE-CHECKED, not just documented: a step declaring
    // { from: 1, to: 3 } would otherwise be applied and land on a passing v3
    // guard while v2's transformation never ran and v2's guard never checked.
    // A combined multi-version step is a configuration mistake, so refuse it
    // rather than silently skipping transformations.
    if (step.to !== at + 1) return null;
    // A THROWING step is an unloadable save, not a crash. Without this catch the
    // exception escapes migrateSaveToLatest -> prepareLoadedSave -> loadSave(),
    // whose rejection lands in GameView.onOpen's catch: the view fails to open
    // AND the corrupt-backup/fresh-colony path (spec 7.2) never runs, so the
    // player is left with a save that cannot load and a plugin that will not
    // start. Migrations are hand-written code touching old, real save data — a
    // faulty one must degrade to "start fresh", never to "cannot open".
    try {
      current = step.migrate(current);
    } catch {
      return null;
    }
    at = step.to;
    // Validate at EVERY hop, not only at the target: a buggy step is reported
    // where it happened instead of surviving to the end of the chain.
    if (!passesGuard(guards[at], current)) return null;
  }
  return current;
}

/**
 * Migrate any known save version up to the latest, or return null so the
 * caller takes the corrupt-backup path (spec 7.2). The guards/steps/target
 * parameters are injectable so the runner itself is testable while the real
 * chain is empty; production callers pass none.
 */
export function migrateSaveToLatest(
  data: unknown,
  guards: SaveGuards = SAVE_GUARDS,
  steps: readonly MigrationStep[] = SAVE_MIGRATIONS,
  target: number = LATEST_SAVE_VERSION,
): SaveGameV6 | null {
  const version = readSaveVersion(data);
  if (version === null || version > target) return null; // a save from a NEWER build is not downgradable
  if (!passesGuard(guards[version], data)) return null;  // validate at the version it claims
  const migrated = runSteps(data, version, target, steps, guards);
  // Defence-in-depth, not a live rejector: given the `version > target` early
  // return above, no input reaches this line able to fail it. Zero-hop
  // (version === target): the source-guard line above already validated this
  // same object with this same guard. N-hop: runSteps already validated the
  // final hop with guards[at], which at the last hop IS guards[target] on the
  // same value. Kept so a future change to runSteps or to the early-return
  // above doesn't silently stop being caught here.
  if (migrated === null || !passesGuard(guards[target], migrated)) return null;
  return migrated as SaveGameV6;
}
