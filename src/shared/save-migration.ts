import type { SaveGameV1, SaveGameV2, SaveGameV3, SaveGameV4 } from './save';
import { isSaveGameV1, isSaveGameV2, isSaveGameV3, isSaveGameV4, LATEST_SAVE_VERSION } from './save';
import { autoPlaceSequence, mapThatFits } from './placement';

/**
 * One structural upgrade between ADJACENT save versions. Migrations know
 * shapes, never content: no catalog, no BALANCE, no clamping (load-time
 * clamping stays in spawnWorker/spawnBuilding, per spec 4.5). That is what
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

const SAVE_GUARDS: SaveGuards = { 1: isSaveGameV1, 2: isSaveGameV2, 3: isSaveGameV3, 4: isSaveGameV4 };

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

/** The registration tables this module owns, edited in place when a version
 * lands. Deliberately not exported: tests inject fakes through
 * migrateSaveToLatest's parameters instead. */
const SAVE_MIGRATIONS: readonly MigrationStep[] = [migrateV1toV2, migrateV2toV3, migrateV3toV4];

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
): SaveGameV4 | null {
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
  return migrated as SaveGameV4;
}
