# Increment 6 — Survival & Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn population from a button press into an output of the economy — colonists age through child → adult → elder, only adults work, everyone eats, and starvation or old age kills — with housing gating growth and its placement costing work time.

**Architecture:** A new `PopulationSystem` (third in the fixed order) owns aging, death, retirement, homing, and births, with its rules as pure functions in a new `src/shared/population.ts` mirroring what `haul.ts` does for logistics. Two new components (`Age`, `Home`) and one extended one (`Hunger.starvingTicks`) carry the state; a `house` building def with `recipe: null` and `beds` makes shelter a thing you build; a commute term folds into the existing `workerWorkPower` seam so the sim and the UI cannot report different numbers.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md`. Section references below (§2.4, §2.7, …) are to that document.

## Global Constraints

- **Every component must be attached in `buildingComponents`/`colonistComponents` in `src/engine/spawn.ts`** — the single shared list. Adding a component also means appending its type to `COMPONENT_TYPES` in `src/engine/world.ts` for save round-tripping. Forgetting this is silent and has bitten twice (OBS-4-02).
- **No vitest test may import `src/app/world/renderer.ts` or `src/app/world/graphics-cache.ts`.** Excalibur throws on import outside a browser. Their only coverage is `npm run smoke:world`.
- **Mutation-test every test:** break the feature, confirm the named test fails, restore. Fixture values must *discriminate* — if the wrong field holds the same value, the assertion proves nothing.
- **A mutation that makes a system THROW does not fail a test by default.** sim-ecs catches a system's exception and publishes it as a `SystemError` event rather than rejecting the tick, so the run completes, the assertion sees state from before the crash, and the mutation reads as "not discriminating" when in fact it detonated. Task 5 hit this: removing `ProductionSystem`'s recipe-null guard threw on the very first building and changed nothing observable. Any mutation whose effect is a crash rather than a wrong value therefore needs the test to assert on the error itself:

  ```ts
  const errors: unknown[] = [];
  world.eventBus.subscribe(SystemError, (e) => errors.push(e));
  // …step…
  expect(errors).toHaveLength(0);   // and the mutation makes this fail
  ```

  Ask of each mutation you write: *does this produce a wrong number, or an exception?* Only the first kind fails on its own.
- **Confirm every mutation actually applied before trusting its result.** `sed` exits 0 when its pattern matches nothing, so a stale pattern leaves the file untouched, the test passes against the *unmutated* implementation, and the mutation check reports the assertion as discriminating when nothing was ever tested. The patterns below are transcribed from code written in the same task and can drift from what you actually wrote. After each `sed`, verify the file changed — `git diff --quiet <file> && echo "MUTATION DID NOT APPLY"` — and fix the pattern rather than moving on. A mutation that silently no-ops is worse than skipping the check, because it produces false confidence.
- **Never `--update` a quality baseline to make a gate pass.** `check:quality --update` refuses a loosened value without `--allow-regression`, and refuses pinned-at-zero breaches outright.
- **Never pad comments to buy maintainability points.** Fallow's MI has no length term.
- **Commit by pathspec** (`git commit <path> -m …`), never `git add` + bare `git commit`. A new file needs one `git add` immediately before its commit.
- **Systems must be listed in `ALL_SYSTEMS` order** — `buildColonyPrepWorld` throws otherwise.
- `npm run check:all` must be green at the end of every task. Run `rm -rf coverage` first: `check:quality` hard-fails if `coverage/` exists.
- **Balance constants live only in `src/engine/content/balance.ts`.** Shared law takes rates and bands as parameters — `src/shared/**` may import nothing outside itself. This is why `stageOf` takes bands and `commuteFactor` takes rates, exactly as `haulTicks` takes `tilesPerTick`.
- **Everything age-shaped is in TICKS.** Years exist only where `BALANCE` declares them; the conversion happens there and nothing downstream sees a year (§2.8).
- **`src/app/world/renderer.ts` is at 419 non-blank lines against a hard 500 cap** with nothing baselined. Task 11 owns keeping it under. The baseline is not loosened.
- **A raw `await world.step()` does NOT refresh the snapshot's entity sections.** sim-ecs defers entity creation and removal to the post-step sync, which happens *after* `SnapshotSystem` has already run — so a colonist born, welcomed, or killed this tick is missing from (or stale in) `SnapshotStore.latest`. Production handles this in `GameEngine.runStep()`, which calls `refreshEntitySections(world)` when the id counter moved or `RemovalLedger.dirty` is set. **Increment 6 is the first increment whose tests assert on entities appearing and disappearing**, so every test that steps a world by hand and then reads colonist counts must do the same. Add this once to `tests/engine/fixtures.ts` and use it in Tasks 3, 4, 6, 8 and 12 rather than calling `world.step()` directly:

  ```ts
  /**
   * One tick, the way GameEngine drives one. `world.step()` alone leaves the
   * snapshot's entity sections stale for any birth, death or arrival that tick,
   * because sim-ecs syncs new and removed entities only after every system —
   * including SnapshotSystem — has run. Tests that assert on population
   * changing MUST go through this, or they read a snapshot taken before the
   * change and pass or fail for reasons unrelated to what they name.
   */
  export async function stepTick(world: IRuntimeWorld): Promise<void> {
    world.getResource(SimClock).tick++;
    await world.step();
    refreshEntitySections(world);
  }
  ```

---

### Task 1: Rename `Worker` → `Colonist`

A pure mechanical rename, no semantics, landed before any new behaviour so every later task writes the right word from the start (§2.1).

**Files:**
- Modify: `src/engine/components.ts`, `src/engine/spawn.ts`, `src/engine/world.ts`, `src/engine/snapshot-builder.ts`, `src/engine/content/balance.ts`, `src/engine/systems/*.ts`, `src/shared/snapshot.ts`, `src/shared/save.ts`, `src/app/**`, `tests/**`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `class Colonist { constructor(public id: number) {} }` (was `Worker`)
  - `interface ColonistSnapshot` (was `WorkerSnapshot`); `Snapshot.workers` → `Snapshot.colonists`
  - `interface SavedColonist` (was `SavedWorker`) — **the TypeScript name only**; `SaveGameV4.workers` keeps its JSON key until Task 9
  - `colonistComponents(spec: ColonistSpec)` (was `workerComponents`), `ColonistSpec` (was `WorkerSpec`)
  - `colonistFactsOf(...)`, `ColonistFacts`, `savedColonistOf(...)`
  - `colonistEfficiency(hunger: number): number` (was `workerEfficiency`)
  - `STARTING_COLONISTS` (was `STARTING_WORKERS`)
  - **Unchanged on purpose:** `WorkerSlots`, `BuildingDef.workerSlots`, `workerWorkPower`, `SavedWorkerV2`, and the `recruitWorker` / `assignWorker` / `unassignWorker` commands.

- [ ] **Step 1: Rename the engine-side symbols**

These are safe global renames. Run them from the repo root:

```bash
grep -rl --include=*.ts --include=*.vue 'Worker\|worker' src tests | sort > /tmp/rename-targets.txt
wc -l /tmp/rename-targets.txt   # for your own before/after sanity check
```

Apply, in this order (longest names first so no rename is swallowed by another):

```bash
FILES=$(cat /tmp/rename-targets.txt)
sed -i 's/\bWorkerSnapshot\b/ColonistSnapshot/g'   $FILES
sed -i 's/\bworkerComponents\b/colonistComponents/g' $FILES
sed -i 's/\bWorkerSpec\b/ColonistSpec/g'           $FILES
sed -i 's/\bworkerFactsOf\b/colonistFactsOf/g'     $FILES
sed -i 's/\bWorkerFacts\b/ColonistFacts/g'         $FILES
sed -i 's/\bsavedWorkerOf\b/savedColonistOf/g'     $FILES
sed -i 's/\bworkerEfficiency\b/colonistEfficiency/g' $FILES
sed -i 's/\bSTARTING_WORKERS\b/STARTING_COLONISTS/g' $FILES
sed -i 's/\bspawnWorker\b/spawnColonist/g'         $FILES
```

**`SavedWorker` and `Worker` need care — `SavedWorkerV2` and `WorkerSlots` must NOT move.**

The naive `s/\bSavedWorker\b/…/` does **not** work: `\b` matches between `r` and `V`, so it would rewrite `SavedWorkerV2` into `SavedColonistV2` and silently rename a frozen legacy shape. `\bWorker\b` is safe for the opposite reason — there is no word boundary between `Worker` and `Slots`, so `WorkerSlots` is untouched. Run exactly these two, then verify:

```bash
sed -i 's/\bSavedWorker\([^V]\)/SavedColonist\1/g; s/\bSavedWorker$/SavedColonist/g' $FILES
sed -i 's/\bWorker\b/Colonist/g' $FILES   # WorkerSlots has no \b after "Worker", so it is untouched
grep -rn 'SavedWorkerV2\|WorkerSlots\|workerSlots\|workerWorkPower' src tests | wc -l   # must be > 0
grep -rn '\bSavedColonistV2\|ColonistSlots' src tests | wc -l                            # must be 0
```

- [ ] **Step 2: Rename the snapshot's `workers` array to `colonists`**

This one is not a blanket sed — `Snapshot.workers` renames, but `BuildingSnapshot.workers` (the staffed count) must not. Edit by hand:

In `src/shared/snapshot.ts`, in `interface Snapshot` only:

```ts
  colonists: ColonistSnapshot[];
```

In `src/engine/snapshot-builder.ts`, `EntitySections`:

```ts
export interface EntitySections {
  colonists: ColonistSnapshot[];
  buildings: BuildingSnapshot[];
  population: number;
  idleWorkers: number;
}
```

Then let the compiler find every consumer.

- [ ] **Step 3: Let typecheck enumerate the rest**

Run: `npm run typecheck`
Fix each name the compiler reports. Do **not** hunt sites by hand — the compiler finds every one, and this rename's whole safety argument is that it is compiler-checked.

- [ ] **Step 4: Verify no behaviour changed**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — **466 tests**, the same count as before this task. A changed count means something other than a rename happened; find it before continuing.

- [ ] **Step 5: Confirm the deliberate non-renames survived**

```bash
grep -rn '\bWorkerSlots\b'   src | wc -l   # expect > 0
grep -rn '\bworkerWorkPower\b' src | wc -l # expect > 0
grep -rn '\bSavedWorkerV2\b' src | wc -l   # expect > 0
grep -rn "'recruitWorker'" src | wc -l     # expect > 0
grep -rn '\bWorker\b' src | wc -l          # expect 0 — the bare entity name is gone
```

- [ ] **Step 6: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "refactor: the entity is a Colonist, not a Worker

After increment 6 a four-year-old is a Worker — the same defect OBS-4-06
named when productionRate stopped meaning production, one layer down.
Pure mechanical rename, no semantics: 466 tests before and after.

WorkerSlots, workerWorkPower, SavedWorkerV2 and the recruit/assign command
names deliberately stay — they name employment or a frozen file format,
not the person."
```

---

### Task 2: The population law module

`src/shared/population.ts` in the same role `haul.ts` plays for logistics: pure rules, unit-testable, readable by engine and UI alike (§2.8).

**Files:**
- Create: `src/shared/population.ts`
- Modify: `src/engine/content/balance.ts`
- Test: `tests/shared/population.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 beyond the renamed world.
- Produces:
  - `type LifeStage = 'child' | 'adult' | 'elder'`
  - `interface LifeBands { matureTicks: number; retireTicks: number; lifespanTicks: number; spreadTicks: number }`
  - `const SALT: { lifespan: number; startingAge: number; arrivalAge: number }`
  - `spreadFor(id: number, range: number, salt: number): number`
  - `stageOf(ageTicks: number, bands: LifeBands): LifeStage`
  - `lifespanFor(id: number, bands: LifeBands): number` — **ticks**
  - `BALANCE.lifeBands: LifeBands`, plus `BALANCE.yearTicks`, `startingAgeTicks`, `nomadArrivalTicks`, `maxAgeTicks`

- [ ] **Step 1: Write the failing test**

Create `tests/shared/population.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lifespanFor, SALT, spreadFor, stageOf, type LifeBands } from '../../src/shared/population';

// Deliberately not BALANCE's real numbers: this module takes bands as
// parameters precisely so it can be tested independent of tuning.
const BANDS: LifeBands = { matureTicks: 1000, retireTicks: 5500, lifespanTicks: 6500, spreadTicks: 800 };

describe('stageOf', () => {
  it('bands an age into child, adult, elder at the boundaries', () => {
    expect(stageOf(0, BANDS)).toBe('child');
    expect(stageOf(999, BANDS)).toBe('child');
    expect(stageOf(1000, BANDS)).toBe('adult');    // matureTicks is the first adult tick
    expect(stageOf(5499, BANDS)).toBe('adult');
    expect(stageOf(5500, BANDS)).toBe('elder');    // retireTicks is the first elder tick
    expect(stageOf(99_000, BANDS)).toBe('elder');
  });
});

describe('spreadFor', () => {
  it('never leaves the range', () => {
    for (let id = 1; id <= 500; id++) {
      const value = spreadFor(id, 8, SALT.lifespan);
      expect(value).toBeGreaterThanOrEqual(-8);
      expect(value).toBeLessThanOrEqual(8);
    }
  });

  it('is stable: the same id always draws the same value', () => {
    // Ids are unique and persisted, so this is what makes the draw survive a
    // save/load round trip without a seed in the save.
    expect(spreadFor(42, 8, SALT.lifespan)).toBe(spreadFor(42, 8, SALT.lifespan));
    expect(spreadFor(42, 8, SALT.lifespan)).not.toBe(spreadFor(43, 8, SALT.lifespan));
  });

  it('spreads consecutive ids across the range instead of collapsing', () => {
    // The failure a weak hash produces — every id landing on one value, or
    // alternating between two — passes a range test happily.
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => spreadFor(i + 1, 8, SALT.lifespan)));
    expect(drawn.size).toBeGreaterThan(12); // 17 values available; a real hash hits most
  });

  it('decorrelates salts: the gap between two draws is not constant', () => {
    // THE reason the salt exists (spec 2.12). Founders draw both a starting
    // age and a lifespan from this primitive; with one shared draw `s` the
    // two cancel — (lifespan + s) - (startingAge + s) — and every founder has
    // an identical remaining life, so they still die together. Range,
    // stability and distribution tests all pass while that is true.
    const gaps = new Set(
      Array.from({ length: 200 }, (_, i) => spreadFor(i + 1, 8, SALT.lifespan) - spreadFor(i + 1, 8, SALT.startingAge)),
    );
    expect(gaps.size).toBeGreaterThan(10);
  });
});

describe('lifespanFor', () => {
  it('returns TICKS around the band, not years', () => {
    // Age is stored in ticks. A years-valued lifespan would kill colonists
    // around tick 65 — before maturity at 1000 — and both being `number`
    // means the compiler cannot catch it.
    for (let id = 1; id <= 100; id++) {
      const span = lifespanFor(id, BANDS);
      expect(span).toBeGreaterThanOrEqual(BANDS.lifespanTicks - BANDS.spreadTicks);
      expect(span).toBeLessThanOrEqual(BANDS.lifespanTicks + BANDS.spreadTicks);
      expect(span).toBeGreaterThan(BANDS.matureTicks);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/population.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/population`.

- [ ] **Step 3: Write the module**

Create `src/shared/population.ts`:

```ts
// The demographic law of the colony in one pure module: which life stage an
// age falls in, how long a given colonist lives, and the deterministic jitter
// that keeps those two from synchronising. Same role haul.ts plays for
// logistics — the engine enforces these rules and the UI previews them, and
// src/shared/ may import nothing outside itself, so bands and rates arrive as
// parameters rather than from BALANCE.
//
// EVERY age-shaped value here is in TICKS. Years exist only where BALANCE
// declares the bands; the conversion happens there and nothing downstream
// sees a year.

export type LifeStage = 'child' | 'adult' | 'elder';

/** The age bands, in ticks. Supplied by BALANCE.lifeBands. */
export interface LifeBands {
  /** First tick at which a colonist may be assigned to work. */
  matureTicks: number;
  /** First tick at which a colonist retires and stops being assignable. */
  retireTicks: number;
  /** Centre of the lifespan distribution. */
  lifespanTicks: number;
  /** Half-width of that distribution — see spreadFor. */
  spreadTicks: number;
}

/**
 * Per-call-site salts for spreadFor. NOT decoration: founders draw both a
 * starting age and a lifespan from the same primitive, and with one unsalted
 * draw `s` per id the two cancel exactly — every founder's remaining life is
 * `(lifespanTicks + s) - (startingAgeTicks + s)`, a constant — so they die on
 * the same tick anyway, which is the outcome staggered starting ages exist to
 * prevent. Distinct salts make the three draws independent.
 *
 * Values are arbitrary odd 32-bit constants; only their distinctness matters.
 */
export const SALT = {
  lifespan: 0x9e3779b1,
  startingAge: 0x85ebca6b,
  arrivalAge: 0xc2b2ae35,
} as const;

/**
 * Deterministic jitter in `[-range, +range]`, derived from an entity id.
 *
 * The project has no RNG and does not gain one here: a seeded generator would
 * have to be persisted and restored, while an id-derived hash is stable across
 * save/load for free (ids are already unique and persisted). Without any
 * jitter, a fixed lifespan makes every death an exact copy of a birth one
 * lifespan earlier — the founders die together, and a run of births spaced by
 * the birth cooldown produces deaths spaced identically.
 *
 * A bare multiplicative hash leaves consecutive ids in an arithmetic
 * progression for small inputs, so the two xorshift-multiply rounds below
 * (a standard 32-bit finaliser) are what actually scatter them.
 */
export function spreadFor(id: number, range: number, salt: number): number {
  if (range <= 0) return 0;
  let h = (Math.imul(id, 2654435761) ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % (2 * range + 1)) - range;
}

/**
 * The band an age falls in. Derived, never stored: a maturity flag beside an
 * age is a second source of truth that can disagree with it, and moving a band
 * would then need a save migration.
 */
export function stageOf(ageTicks: number, bands: LifeBands): LifeStage {
  if (ageTicks < bands.matureTicks) return 'child';
  return ageTicks < bands.retireTicks ? 'adult' : 'elder';
}

/** This colonist's lifespan, in ticks. */
export function lifespanFor(id: number, bands: LifeBands): number {
  return bands.lifespanTicks + spreadFor(id, bands.spreadTicks, SALT.lifespan);
}
```

- [ ] **Step 4: Add the bands to BALANCE**

In `src/engine/content/balance.ts`, above `export const BALANCE`:

```ts
/**
 * Ticks per game year. Years are an authoring and display unit only — this is
 * the one place the conversion happens, and nothing downstream of BALANCE ever
 * sees a year (spec 2.8). Matches statsWindowTicks and autosaveEveryTicks, and
 * makes tick->age arithmetic readable: tick 4,200 is year 42.
 */
const YEAR_TICKS = 100;

const years = (n: number): number => n * YEAR_TICKS;
```

Then inside the `BALANCE` object, after `relocationTilesPerTick`:

```ts
  yearTicks: YEAR_TICKS,
  /** Age bands in ticks (spec 2.2): child 0-9, adult 10-54, elder 55+,
   * dying at 65 +/- 8 years. */
  lifeBands: {
    matureTicks: years(10),
    retireTicks: years(55),
    lifespanTicks: years(65),
    spreadTicks: years(8),
  } as LifeBands,
  /** Founders' age, jittered per id under SALT.startingAge. */
  startingAgeTicks: years(25),
  /** A nomad arrives with most of a working life ahead — which is what makes
   * its higher food gate a fair price. */
  nomadArrivalTicks: years(20),
```

And after the `BALANCE` object:

```ts
/**
 * Clamp for a saved age (spec 2.10). The oldest a colonist can legally be is
 * the longest lifespan current balance can draw — one tick past that and the
 * next PopulationSystem tick kills them anyway, so a save written under a
 * longer lifespan loads with its colonists brought down to what this balance
 * allows rather than being rejected. Same principle as clampedProgress and
 * clampedRelocation.
 */
export const MAX_AGE_TICKS = BALANCE.lifeBands.lifespanTicks + BALANCE.lifeBands.spreadTicks;
```

Add the import at the top of the file:

```ts
import type { LifeBands } from '../../shared/population';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run tests/shared/population.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Mutation-test**

```bash
# Restore by copy, NOT `git checkout` — these mutations run BEFORE the
# task is committed, and `git checkout <file>` would revert to HEAD and
# destroy the implementation you just wrote.
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/shared/population.ts "$SP/population.ts"

# The salt must actually reach the hash — this is the decorrelation test's whole point
sed -i 's/(Math.imul(id, 2654435761) ^ salt)/(Math.imul(id, 2654435761))/' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "decorrelates"   # expect FAIL
cp "$SP/population.ts" src/shared/population.ts

# The finaliser must actually mix — without it consecutive ids collapse
sed -i 's|  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;||' src/shared/population.ts
sed -i 's|  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;||' src/shared/population.ts
sed -i 's|  h = (h ^ (h >>> 16)) >>> 0;||' src/shared/population.ts
npx vitest run tests/shared/population.test.ts   # expect FAIL (distribution and/or decorrelation)
cp "$SP/population.ts" src/shared/population.ts

# The elder boundary must be exclusive-below, not inclusive
sed -i 's/return ageTicks < bands.retireTicks/return ageTicks <= bands.retireTicks/' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "bands an age"   # expect FAIL
cp "$SP/population.ts" src/shared/population.ts
```

All three must fail. If any passes, the assertion does not discriminate — fix it before continuing.

- [ ] **Step 7: Commit**

```bash
rm -rf coverage && git add src/shared/population.ts tests/shared/population.test.ts && npm run check:all
git commit src/shared/population.ts src/engine/content/balance.ts tests/shared/population.test.ts -m "feat(shared): the population law — life stages and id-derived lifespan

Pure rules in src/shared/, the role haul.ts plays for logistics, so the
engine's enforcement and the UI's preview cannot diverge.

spreadFor takes a per-call-site salt. Without it a founder's starting-age
and lifespan jitters cancel exactly and the founders die together anyway —
the outcome staggered ages exist to prevent, and one that range, stability
and distribution tests all pass."
```

---

### Task 3: `Age`, and `PopulationSystem` — aging, retirement, old-age death

**Files:**
- Modify: `src/engine/components.ts` (add `Age`)
- Modify: `src/engine/spawn.ts` (`colonistComponents`, `clampedAge`)
- Modify: `src/engine/world.ts` (`COMPONENT_TYPES`, `ALL_SYSTEMS`)
- Create: `src/engine/systems/population-system.ts`
- Create: `src/engine/systems/population-handlers.ts`
- Modify: `src/engine/systems/command-handlers.ts` (`handleAssignWorker` rejects non-adults)
- Modify: `src/engine/snapshot-builder.ts` (`ageTicks`, `stage`; `idleWorkers` → `idleAdults`)
- Modify: `src/shared/snapshot.ts`
- Test: `tests/engine/systems/population-system.test.ts` (create)

**Interfaces:**
- Consumes: `stageOf`, `lifespanFor`, `BALANCE.lifeBands`, `MAX_AGE_TICKS` (Task 2).
- Produces:
  - `class Age { constructor(public ticks = 0) {} }`
  - `clampedAge(ticks: number): number`
  - `PopulationSystem: TColonySystemFactory`
  - `interface PopulationContext` and the phase functions `ageEveryone`, `resolveOldAge`, `standDownNonAdults`
  - `ColonistSnapshot.ageTicks: number`, `ColonistSnapshot.stage: LifeStage`
  - `EntitySections.idleAdults` (was `idleWorkers`), `Snapshot.idleAdults`
  - `ColonistSpec.ageTicks?: number`

- [ ] **Step 1: Write the failing test**

Create `tests/engine/systems/population-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Age, Building, Colonist, JobAssignment } from '../../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore } from '../../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import { BALANCE } from '../../../src/engine/content/balance';
import { lifespanFor } from '../../../src/shared/population';

async function colonyWith(ages: { id: number; ageTicks: number; buildingId?: number | null }[]) {
  const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 3 });
  const buildingId = building.getComponent(Building)!.id;
  for (const spec of ages) {
    spawnColonist(prep, ids, { id: spec.id, ageTicks: spec.ageTicks, buildingId: spec.buildingId ?? null });
  }
  const world = await prep.prepareRun();
  return { world, buildingId };
}

describe('PopulationSystem — aging', () => {
  it('ages every colonist one tick per tick', async () => {
    const { world } = await colonyWith([{ id: 1, ageTicks: 0 }]);
    await stepTick(world);
    await stepTick(world);
    const me = world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;
    expect(me.ageTicks).toBe(2);
    expect(me.stage).toBe('child');
  });

  it('retires an adult who crosses the elder band, freeing its job slot', async () => {
    // One tick short of retirement, holding a job. Distinct from the death
    // case below: this colonist survives, it just stops working.
    const { world, buildingId } = await colonyWith([
      { id: 1, ageTicks: BALANCE.lifeBands.retireTicks - 1, buildingId: 1 },
    ]);
    // re-point the assignment at the real building id
    for (const entity of world.getEntities()) {
      const job = entity.getComponent(JobAssignment);
      if (job) job.buildingId = buildingId;
    }
    await stepTick(world);
    const me = world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;
    expect(me.stage).toBe('elder');
    expect(me.buildingId).toBeNull();       // unassigned by retirement
    const building = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === buildingId)!;
    expect(building.workers).toBe(0);        // and the slot is free
  });

  it('kills a colonist who reaches its own lifespan, not a shared one', async () => {
    // Two colonists of IDENTICAL age and different ids. They cannot be born
    // on the same tick (births are cooldown-gated colony-wide), so the test
    // seeds equal ages directly. If both die together the id-derived spread
    // is not reaching the comparison.
    const span1 = lifespanFor(1, BALANCE.lifeBands);
    const span2 = lifespanFor(2, BALANCE.lifeBands);
    expect(span1).not.toBe(span2); // fixture precondition, not the assertion
    const younger = Math.min(span1, span2);
    const { world } = await colonyWith([
      { id: 1, ageTicks: younger - 1 },
      { id: 2, ageTicks: younger - 1 },
    ]);
    await stepTick(world);
    const alive = world.getResource(SnapshotStore).latest!.colonists.map((c) => c.id);
    expect(alive).toHaveLength(1);
    expect(alive[0]).toBe(span1 < span2 ? 2 : 1); // the longer-lived one survives
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/population-system.test.ts`
Expected: FAIL — `Age` is not exported from `src/engine/components`.

- [ ] **Step 3: Add the `Age` component and its clamp**

In `src/engine/components.ts`, after `Hunger`:

```ts
/**
 * How long this colonist has been alive, in ticks. The single source of their
 * life stage — `stageOf` derives child/adult/elder from it, so there is no
 * maturity flag beside the age that could disagree with it, and moving a band
 * needs no migration.
 *
 * Saved (v5): plainly persistent state, not runtime scratch like HaulTrip.
 * Magnitude is clamped at load by `clampedAge` rather than bounds-checked in
 * the load guard, so a save written under a longer lifespan still opens.
 */
export class Age {
  constructor(public ticks = 0) {}
}
```

In `src/engine/spawn.ts`, beside the other clamps:

```ts
export function clampedAge(ticks: number): number {
  return Math.max(0, Math.min(ticks, MAX_AGE_TICKS));
}
```

**Then remove `MAX_AGE_TICKS` from `.fallowrc.json`'s `ignoreExports`.** Task 2 added it there because the constant had no consumer yet and tripped the dead-code ratchet (`deadCodeIssues: 0 → 1`), recording the entry as transitional in `docs/build-ci/quality-gates.md`. `clampedAge` is that consumer, so the entry has served its purpose — leaving it would permanently exempt a live export from the gate that exists to catch exactly this. Remove the note from the quality-gates doc too, and confirm `npm run check:quality` still reports `deadCodeIssues: 0` without it.

Import `MAX_AGE_TICKS` from `./content/balance`, add `ageTicks?: number` to `ColonistSpec`, and add to `colonistComponents`'s list:

```ts
    // NOT `?? 0`. This default is only reached by callers that pass no age —
    // and until Task 9 seeds `initialSave()`, that is every founder, plus
    // `handleRecruitWorker`, which calls `colonistComponents({ id })` with no
    // age at all. With `?? 0` all of them spawn as children, the adult-only
    // assign gate added in Step 7 below rejects every assign-worker and
    // assign-hauler flow for the next 1,000 ticks, and 28 pre-existing tests
    // fail. A birth still produces a child, because it passes `ageTicks: 0`
    // EXPLICITLY and `??` only fires on absence.
    new Age(clampedAge(spec.ageTicks ?? BALANCE.startingAgeTicks)),
```

In `src/engine/world.ts`, append `Age` to `COMPONENT_TYPES` and add it to the components import.

- [ ] **Step 4: Write the phase handlers**

Create `src/engine/systems/population-handlers.ts`:

```ts
import type { IEntity } from 'sim-ecs';
import { lifespanFor, stageOf } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { Age, Colonist, HaulTrip, Hunger, JobAssignment } from '../components';
import type { IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile } from '../resources';

// One small phase per rule, for the same reason command-handlers.ts exists:
// the complexity gate is why these are not inline in the system's run
// function. The system materialises query rows into a context and calls the
// phases in the order spec 2.9 fixes.

/** Live query rows, materialised once per tick. Component references stay
 * live, so writes (age.ticks, job.buildingId) hit the real world. */
export interface ColonistRow {
  entity: Readonly<IEntity>;
  colonist: Colonist;
  age: Age;
  hunger: Hunger;
  job: JobAssignment;
  trip: HaulTrip;
}

export interface PopulationContext {
  clock: SimClock;
  stockpile: Stockpile;
  ids: IdCounter;
  notices: NoticeBoard;
  removals: RemovalLedger;
  colonists: ColonistRow[];
  spawn: (...components: object[]) => void;
  remove: (entity: Readonly<IEntity>) => void;
  /** Colonists who died earlier in THIS tick. Removal is deferred to the
   * post-step sync, so queries still see them — every later phase must not. */
  deadIds: Set<number>;
}

/** Everyone still alive this tick, in ascending id: the deterministic order
 * every phase iterates, independent of entity iteration order. */
export function livingRows(ctx: PopulationContext): ColonistRow[] {
  return ctx.colonists
    .filter((row) => !ctx.deadIds.has(row.colonist.id))
    .sort((a, b) => a.colonist.id - b.colonist.id);
}

export function ageEveryone(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) row.age.ticks++;
}

/**
 * Strip a colonist of every job. Called on death as well as retirement,
 * because entity removal is DEFERRED to the post-step sync: a colonist killed
 * this tick is still visible to ProductionSystem and HaulSystem later in the
 * same tick, and would contribute one last tick of work from beyond the grave.
 * Anything in a hauler's hands goes to the store — those goods left a building
 * and must land somewhere, exactly as handleUnassignHauler banks them.
 */
function standDown(ctx: PopulationContext, row: ColonistRow): void {
  row.job.buildingId = null;
  row.job.hauling = false;
  if (row.trip.resource !== null && row.trip.amount > 0) ctx.stockpile.add(row.trip.resource, row.trip.amount);
  row.trip.reset();
}

export function resolveOldAge(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.age.ticks < lifespanFor(row.colonist.id, BALANCE.lifeBands)) continue;
    standDown(ctx, row);
    ctx.remove(row.entity);
    ctx.deadIds.add(row.colonist.id);
    ctx.removals.dirty = true;
    ctx.notices.succeed(`Colonist #${row.colonist.id} died of old age.`);
  }
}

export function standDownNonAdults(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    const stage = stageOf(row.age.ticks, BALANCE.lifeBands);
    // Every non-adult, not just elders. A save written before `matureTicks`
    // was raised can load with a staffed colonist whose age now falls in the
    // CHILD band — balance-retuned saves are accepted by policy, and the
    // assign command only gates future commands — so an elder-only check
    // would leave that child working until it matured all over again.
    if (stage === 'adult') continue;
    if (row.job.buildingId === null && !row.job.hauling) continue; // already stood down
    standDown(ctx, row);
    ctx.notices.succeed(`Colonist #${row.colonist.id} ${stage === 'elder' ? 'retired' : 'is too young to work'}.`);
  }
}
```

- [ ] **Step 5: Write the system**

Create `src/engine/systems/population-system.ts`:

```ts
import { Actions, createSystem, queryComponents, Read, ReadEntity, Write, WriteResource } from 'sim-ecs';
import { Age, Colonist, HaulTrip, Hunger, JobAssignment } from '../components';
import { IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile } from '../resources';
import { ageEveryone, resolveOldAge, standDownNonAdults, type PopulationContext } from './population-handlers';

/**
 * Spec 2.9 places this third, and both neighbours are load-bearing: AFTER
 * HungerSystem, so a starvation death reads this tick's hunger and a colonist
 * who found food this tick is spared; BEFORE EfficiencySystem and
 * ProductionSystem, so a colonist who retired or died this tick is unassigned
 * before work power is summed.
 *
 * Phase order within the tick is age -> deaths -> retirements, extended by
 * later tasks to -> homing -> births.
 */
export const PopulationSystem = () => createSystem({
  actions: Actions,
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  removals: WriteResource(RemovalLedger),
  colonists: queryComponents({
    entity: ReadEntity(), colonist: Read(Colonist), age: Write(Age), hunger: Read(Hunger),
    job: Write(JobAssignment), trip: Write(HaulTrip),
  }),
})
  .withName('PopulationSystem')
  .withRunFunction(({ actions, clock, stockpile, ids, notices, removals, colonists }) => {
    const ctx: PopulationContext = {
      clock, stockpile, ids, notices, removals,
      colonists: [...colonists.iter()].map(({ entity, colonist, age, hunger, job, trip }) =>
        ({ entity, colonist, age, hunger, job, trip })),
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      remove: (entity) => actions.commands.removeEntity(entity),
      deadIds: new Set<number>(),
    };
    ageEveryone(ctx);
    resolveOldAge(ctx);
    standDownNonAdults(ctx);
  })
  .build();
```

In `src/engine/world.ts`, import it and insert it into `ALL_SYSTEMS` **third**:

```ts
export const ALL_SYSTEMS: TColonySystemFactory[] = [
  CommandSystem,
  HungerSystem,
  PopulationSystem,
  EfficiencySystem,
  ProductionSystem,
  HaulSystem,
  StatsSystem,
  SnapshotSystem,
];
```

- [ ] **Step 6: Publish age and stage; only adults are idle**

In `src/shared/snapshot.ts`, add to `ColonistSnapshot`:

```ts
  /** Ticks alive. Years are a display unit only — divide by BALANCE.yearTicks. */
  ageTicks: number;
  /** Derived from ageTicks, never stored: only an adult can be assigned. */
  stage: LifeStage;
```

with `import type { LifeStage } from './population';` at the top, and rename `Snapshot.idleWorkers` → `idleAdults`.

In `src/engine/snapshot-builder.ts`: add `age: Age` to `colonistFactsOf`'s parameters and `ageTicks: age.ticks, stage: stageOf(age.ticks, BALANCE.lifeBands),` to what it returns; add `entity.getComponent(Age)!` to `gatherEntityFacts`'s colonist branch; rename the `EntitySections` field and change its count:

```ts
    // Children and elders are not idle, they are ineligible — counting them
    // here would advertise labour the assign command will refuse.
    idleAdults: colonistSnaps.filter((c) => c.stage === 'adult' && c.buildingId === null && !c.hauling).length,
```

**Persist `ageTicks` in this task — not in Task 9.** `stage` is derived from it every tick and must never be stored, but the age itself is the source `PopulationSystem` advances, so dropping it resets every colonist to the default starting age on each save/reload, silently undoing however much of a lifespan it had lived. Three edits, all needed before this task's own `npm run typecheck` and test run:

- `src/shared/save.ts` — add `ageTicks?: number` to the current colonist record. **Optional**, so saves written before this task still load.
- `src/engine/snapshot-builder.ts` — write it in `savedColonistOf`, and read it back through the spawn path.
- `tests/engine/world.test.ts` — add **`'stage'`, and only `'stage'`,** to the `DERIVED` list. That list names facts the projection recomputes and deliberately does not persist; putting `ageTicks` there too would tell the guard rail to ignore exactly the field this section exists to protect. The existing round-trip test will fail if `ageTicks` is not persisted — that failure is the guard working, not a reason to add it to `DERIVED`.

In `src/engine/world.ts`'s `buildInitialSnapshot`, add `ageTicks` and `stage` to each seeded fact and rename the destructured `idleWorkers`. Read the age as `clampedAge(saved.ageTicks ?? BALANCE.startingAgeTicks)` — **the same fallback as `colonistComponents`, for the same reason** (see Step 3). The two must move in lockstep: the seeded snapshot has to match the entities actually spawned, or a restored colony's stage counts disagree with its own roster before the first tick runs.

- [ ] **Step 7: Reject assigning a non-adult**

In `src/engine/systems/command-handlers.ts`, `handleAssignWorker`, the idle-selection loop becomes:

```ts
  let assigned = 0;
  let idle: JobAssignment | null = null;
  for (const { job, stage } of ctx.workers) {
    if (job.buildingId === command.buildingId) assigned++;
    // A hauler is staffed work, not spare capacity — never poach it. A child
    // or elder is not spare capacity either: they are ineligible.
    else if (stage === 'adult' && job.buildingId === null && !job.hauling && idle === null) idle = job;
  }
```

`WorkerRow` gains `stage: LifeStage`, populated in `command-system.ts` from an added `age: Read(Age)` on the colonists query:

```ts
      workers: [...workers.iter()].map(({ job, trip, age }) => ({ job, trip, stage: stageOf(age.ticks, BALANCE.lifeBands) })),
```

Apply the same `stage === 'adult'` guard in `handleAssignHauler`'s `find`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — the three new tests plus every existing one. Existing tests that composed system subsets by hand may need `PopulationSystem` added; `assertSystemOrder` will name any that are now out of order.

- [ ] **Step 9: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/engine/systems/population-handlers.ts "$SP/population-handlers.ts"

# Aging must actually happen
sed -i 's|  for (const row of livingRows(ctx)) row.age.ticks++;||' src/engine/systems/population-handlers.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "ages every colonist"   # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts

# Retirement must actually unassign
# `sed` is line-based: a pattern containing \n matches nothing and exits 0, so
# the earlier multiline form left the file untouched and the test "passed"
# against unmutated code. Target the ONE line that does the work instead, and
# check it applied.
perl -0pi -e 's/(export function standDownNonAdults[\s\S]*?)    standDown\(ctx, row\);/$1/' src/engine/systems/population-handlers.ts
git diff --quiet src/engine/systems/population-handlers.ts && { echo "MUTATION DID NOT APPLY"; exit 1; }
npx vitest run tests/engine/systems/population-system.test.ts -t "retires an adult"      # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts

# The lifespan must be PER COLONIST, not a shared constant
sed -i 's|lifespanFor(row.colonist.id, BALANCE.lifeBands)|BALANCE.lifeBands.lifespanTicks|' src/engine/systems/population-handlers.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "kills a colonist"      # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts
```

All three must fail.

- [ ] **Step 10: Commit**

```bash
rm -rf coverage && git add src/engine/systems/population-system.ts src/engine/systems/population-handlers.ts tests/engine/systems/population-system.test.ts && npm run check:all
git commit src tests .fallowrc.json docs/build-ci/quality-gates.md -m "feat(engine): colonists age, retire, and die of old age

PopulationSystem runs third: after HungerSystem so a death reads this
tick's hunger, before Efficiency/Production so a retiree or a corpse is
unassigned before work power is summed. Entity removal is deferred to the
post-step sync, so death also stands the colonist down explicitly.

idleWorkers becomes idleAdults and counts only adults — children and
elders are not idle, they are ineligible, and the assign command now
refuses them."
```

---

### Task 4: Starvation kills

**Files:**
- Modify: `src/engine/components.ts` (`Hunger.starvingTicks`)
- Modify: `src/engine/systems/hunger-system.ts` (the only writer)
- Modify: `src/engine/systems/population-handlers.ts` (`resolveStarvation`)
- Modify: `src/engine/systems/population-system.ts`
- Modify: `src/engine/spawn.ts`, `src/engine/snapshot-builder.ts`, `src/shared/snapshot.ts`
- Modify: `src/engine/content/balance.ts`
- Test: `tests/engine/systems/population-system.test.ts`

**Interfaces:**
- Consumes: `PopulationContext`, `livingRows`, `standDown` (Task 3).
- Produces: `Hunger { value, starvingTicks }`, `BALANCE.starvationDeathTicks`, `clampedStarving(ticks)`, `ColonistSnapshot.starvingTicks`, `resolveStarvation(ctx)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/systems/population-system.test.ts`:

```ts
describe('PopulationSystem — starvation', () => {
  it('kills a colonist pinned at max hunger, but not before the counter runs out', async () => {
    // Empty store: nothing to eat, ever. Fixture values discriminate — the
    // colonist starts BELOW hungerMax so the first ticks raise hunger without
    // touching the starvation clock, which is what separates "hungry" from
    // "starving".
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax - 2 });
    const world = await prep.prepareRun();

    const step = () => stepTick(world);
    const me = () => world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1);

    await step();
    expect(me()!.starvingTicks).toBe(0);          // hunger 99: hungry, not starving
    await step();
    expect(me()!.starvingTicks).toBe(1);          // pinned at the cap: the clock starts
    for (let i = 0; i < BALANCE.starvationDeathTicks - 2; i++) await step();
    expect(me()).toBeDefined();                    // still alive one tick short
    await step();
    expect(me()).toBeUndefined();                  // and now dead
  });

  it('resets the starvation clock the moment a colonist eats', async () => {
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const me = () => world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;

    await step();
    await step();
    expect(me().starvingTicks).toBe(2);
    world.getResource(Stockpile).add('bread', 1);
    await step();
    expect(me().starvingTicks).toBe(0);
    expect(me().hunger).toBe(0);
  });
});
```

Add `Stockpile` to the resources import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/population-system.test.ts -t "starvation"`
Expected: FAIL — `starvingTicks` is not on `ColonistSnapshot`.

- [ ] **Step 3: Extend `Hunger` and make `HungerSystem` its only writer**

In `src/engine/components.ts`:

```ts
export class Hunger {
  /**
   * `starvingTicks` counts consecutive ticks pinned at `hungerMax` with
   * nothing eaten. HungerSystem is its ONLY writer — it already owns this
   * component and is the one place that knows whether this colonist ate this
   * tick; PopulationSystem only reads it. Two systems writing one counter is
   * how a starvation clock ends up advancing twice on a tick where a colonist
   * both starved and was fed.
   *
   * Saved (v5) for the reason relocatingTicks is: it is a penalty already
   * incurred, and dropping it would let save-and-reload cancel a starvation
   * in progress.
   */
  constructor(public value = 0, public starvingTicks = 0) {}
}
```

Replace `src/engine/systems/hunger-system.ts`'s run function body:

```ts
    for (const { hunger } of colonists.iter()) {
      hunger.value = Math.min(BALANCE.hungerMax, hunger.value + BALANCE.hungerPerTick);
      if (hunger.value >= BALANCE.mealThreshold) {
        if (stockpile.take('bread', 1)) hunger.value = 0;
        else if (stockpile.take('berries', 1)) hunger.value = Math.max(0, hunger.value - BALANCE.berriesHungerRestore);
      }
      // Anything eaten drops hunger below the cap, so this one expression is
      // both the "still starving" increment and the "ate something" reset.
      hunger.starvingTicks = hunger.value >= BALANCE.hungerMax ? hunger.starvingTicks + 1 : 0;
    }
```

- [ ] **Step 4: Add the constant, the clamp, and the death phase**

In `src/engine/content/balance.ts`, inside `BALANCE`:

```ts
  /** Ticks pinned at hungerMax before a colonist dies — one year, so
   * starvation is a slow visible slide the player can still pull out of. */
  starvationDeathTicks: 100,
```

In `src/engine/spawn.ts`:

```ts
export function clampedStarving(ticks: number): number {
  return Math.max(0, Math.min(ticks, BALANCE.starvationDeathTicks));
}
```

Add `starvingTicks?: number` to `ColonistSpec` and pass it: `new Hunger(clampedHunger(spec.hunger ?? 0), clampedStarving(spec.starvingTicks ?? 0))`.

In `src/engine/systems/population-handlers.ts`, export `standDown` (it is now needed by two phases) and add:

```ts
export function resolveStarvation(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.hunger.starvingTicks < BALANCE.starvationDeathTicks) continue;
    standDown(ctx, row);
    ctx.remove(row.entity);
    ctx.deadIds.add(row.colonist.id);
    ctx.removals.dirty = true;
    ctx.notices.succeed(`Colonist #${row.colonist.id} starved.`);
  }
}
```

Call it in `population-system.ts` immediately after `resolveOldAge(ctx)`.

- [ ] **Step 5: Publish it**

Add `starvingTicks: number` to `ColonistSnapshot`, `starvingTicks: hunger.starvingTicks` to `colonistFactsOf`, and `starvingTicks: 0` to `buildInitialSnapshot`'s seeded facts (Task 9 reads it from the save).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/engine/systems/hunger-system.ts "$SP/hunger-system.ts"
cp src/engine/systems/population-handlers.ts "$SP/population-handlers.ts"

# The clock must reset on eating, not merely stop
sed -i 's|hunger.starvingTicks = hunger.value >= BALANCE.hungerMax ? hunger.starvingTicks + 1 : 0;|hunger.starvingTicks = hunger.value >= BALANCE.hungerMax ? hunger.starvingTicks + 1 : hunger.starvingTicks;|' src/engine/systems/hunger-system.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "resets the starvation clock"  # expect FAIL
cp "$SP/hunger-system.ts" src/engine/systems/hunger-system.ts

# Death must wait for the full counter, not fire at the cap
sed -i 's|if (row.hunger.starvingTicks < BALANCE.starvationDeathTicks) continue;|if (row.hunger.starvingTicks < 1) continue;|' src/engine/systems/population-handlers.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "pinned at max hunger"        # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts
```

Both must fail.

- [ ] **Step 8: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(engine): sustained starvation kills

Hunger gains starvingTicks, written ONLY by HungerSystem — the one place
that knows whether a colonist ate this tick. PopulationSystem reads it and
kills at starvationDeathTicks, a full year at the cap, so the slide is
visible and recoverable rather than a snap."
```

---

### Task 5: The `house` building

**Files:**
- Modify: `src/shared/content-types.ts` (`recipe: RecipeDef | null`, `beds`)
- Modify: `src/engine/content/buildings.ts` (the `house` def, `batchOutputUnits` guard)
- Modify: `src/engine/content/balance.ts` (`houseBeds`)
- Modify: `src/engine/spawn.ts` (`clampedProgress` null guard)
- Modify: `src/engine/systems/production-system.ts` (skip recipe-less buildings)
- Modify: `src/engine/snapshot-builder.ts` (`'housing'` state, `beds`)
- Modify: `src/shared/snapshot.ts`, `src/app/labels.ts`
- Modify: `tests/support/balance-harness.ts` (`SEEDED_RESOURCE_IDS` null guard)
- Test: `tests/engine/content.test.ts`, `tests/engine/systems/production-system.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `BuildingDef { …; recipe: RecipeDef | null; beds: number }` — `beds` is `0` for producers
  - `BuildingDefId` gains `'house'`
  - `BALANCE.houseBeds`
  - `BuildingState` gains `'housing'`
  - `BuildingSnapshot.beds: number`, `BuildingSnapshot.occupants: number` (occupants stays 0 until Task 6)

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/content.test.ts`:

```ts
it('every building def has exactly one of a recipe or beds', () => {
  // The rule that keeps `recipe: RecipeDef | null` honest: a def with neither
  // does nothing at all, and a def with both is two mechanics in one entry.
  for (const def of Object.values(BUILDINGS)) {
    const produces = def.recipe !== null;
    const shelters = def.beds > 0;
    expect(produces !== shelters, `${def.id} must produce or shelter, not neither or both`).toBe(true);
  }
});

it('the house shelters and never produces', () => {
  expect(BUILDINGS.house.recipe).toBeNull();
  expect(BUILDINGS.house.beds).toBe(BALANCE.houseBeds);
  expect(BUILDINGS.house.workerSlots).toBe(0);
  // Costs planks, which before this had no demand outside mill/bakery/workshop.
  expect(BUILDINGS.house.cost.planks).toBeGreaterThan(0);
});
```

Append to `tests/engine/systems/production-system.test.ts`:

```ts
it('a house never produces, even fully staffed', async () => {
  // Discriminating fixture: the same crew on a forester at the same tile DOES
  // produce, so a pass here cannot come from the crew being idle for some
  // unrelated reason.
  const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
  const houseId = house.getComponent(Building)!.id;
  spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, buildingId: houseId });
  const world = await prep.prepareRun();
  for (let i = 0; i < 20; i++) await stepTick(world);

  const snap = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === houseId)!;
  expect(snap.state).toBe('housing');
  expect(snap.buffered).toBe(0);
  expect(snap.progress).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/content.test.ts tests/engine/systems/production-system.test.ts`
Expected: FAIL — `BUILDINGS.house` does not exist; `beds` is not a property of `BuildingDef`.

- [ ] **Step 3: Make `recipe` nullable and add `beds`**

In `src/shared/content-types.ts`:

```ts
export type BuildingDefId =
  | 'gatherersHut'
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'forester'
  | 'sawmill'
  | 'workshop'
  | 'house';

export interface BuildingDef {
  id: BuildingDefId;
  name: string;
  cost: CostMap;
  workerSlots: number;
  /** Null for a building that shelters instead of producing. Exactly one of
   * `recipe` and `beds` is set — pinned by a content test. */
  recipe: RecipeDef | null;
  /** Sleeping places this building provides. 0 for a producer. */
  beds: number;
}
```

- [ ] **Step 4: Add the def and guard the recipe readers**

First add the constant this def reads — in `src/engine/content/balance.ts`, inside `BALANCE`:

```ts
  /** Sleeping places one house provides. Three founders plus one spare, so
   * the opening has a free bed and the second house is the first growth
   * decision the player makes. */
  houseBeds: 4,
```

Then in `src/engine/content/buildings.ts`, add `beds: 0` to all seven existing defs and append:

```ts
  house: {
    id: 'house', name: 'House', cost: { wood: 15, planks: 5 }, workerSlots: 0,
    recipe: null, beds: BALANCE.houseBeds,
  },
```

with `import { BALANCE } from './balance';`. Then:

```ts
/** Units one batch of a recipe adds to a building's output buffer. */
export function batchOutputUnits(recipe: RecipeDef | null): number {
  if (recipe === null) return 0;
  let units = 0;
  for (const amount of Object.values(recipe.outputs)) units += amount;
  return units;
}
```

In `src/engine/spawn.ts`:

```ts
export function clampedProgress(defId: BuildingDefId, progress: number): number {
  const { recipe } = BUILDINGS[defId];
  // A shelter has no batch to be part-way through; any saved progress on one
  // is meaningless and clamps to nothing rather than being rejected.
  return recipe === null ? 0 : Math.min(progress, recipe.ticksPerBatch);
}
```

In `src/engine/systems/production-system.ts`, inside the building loop, immediately after the relocation guard:

```ts
      // A shelter has no recipe. Skipped before work power is even looked up,
      // so a colonist mistakenly assigned to one can never bank anything.
      if (BUILDINGS[building.defId].recipe === null) continue;
```

and change `advanceBatches` to read `const recipe = BUILDINGS[building.defId].recipe!;` with a comment naming the guard above as what makes the assertion safe.

In `tests/support/balance-harness.ts`, `SEEDED_RESOURCE_IDS`:

```ts
  ...new Set<ResourceId>([
    'berries',
    ...Object.values(BUILDINGS).flatMap((def) => Object.keys(def.recipe?.inputs ?? {}) as ResourceId[]),
  ]),
```

and its `runScenario` tail:

```ts
  const recipe = BUILDINGS[defId].recipe;
  if (recipe === null) throw new Error(`Scenario building ${defId} has no recipe to measure`);
```

- [ ] **Step 5: Add the `housing` state**

In `src/shared/snapshot.ts`:

```ts
export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed' | 'outputFull' | 'relocating' | 'housing';
```

and add to `BuildingSnapshot`:

```ts
  /** Sleeping places this building provides (0 for a producer). */
  beds: number;
  /** Colonists currently homed here. Derived from who points at it, never
   * stored — so it cannot disagree with the colonists. */
  occupants: number;
```

In `src/engine/snapshot-builder.ts`'s `buildingSnaps` mapper, replace the state ladder:

```ts
      const def = BUILDINGS[b.defId];
      const staffed = staffCount.get(b.id) ?? 0;
      const outputBlocked = def.recipe !== null
        && BALANCE.outputBufferCap - b.buffered < batchOutputUnits(def.recipe);
      // Relocating first: it is the reason nothing is happening, and it is
      // also why a relocating house shelters nobody. A shelter has no other
      // state to be in — it is never unstaffed (no slots), never producing.
      const state: BuildingState = b.relocatingTicks > 0
        ? 'relocating'
        : def.recipe === null
          ? 'housing'
          : staffed === 0
            ? 'unstaffed'
            : outputBlocked ? 'outputFull' : b.batchActive ? 'producing' : 'waitingForInput';
```

and in the returned object:

```ts
        progressPct: def.recipe === null ? 0 : Math.min(100, Math.round((b.progress / def.recipe.ticksPerBatch) * 100)),
        beds: def.beds,
        occupants: 0, // Task 6 fills this from Home
```

In `src/engine/world.ts`'s `buildInitialSnapshot`, `BUILDINGS[saved.defId].workerSlots` already works; nothing else changes there.

In `src/app/labels.ts`:

```ts
  housing: 'Housing',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. `npm run balance:report` should still print the same distance/hauler sweep as before — check it by eye now, because Task 7 will need the comparison.

- [ ] **Step 7: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/engine/systems/production-system.ts "$SP/production-system.ts"
cp src/engine/content/buildings.ts "$SP/buildings.ts"

# The recipe-less skip must actually be there
sed -i 's|      if (BUILDINGS\[building.defId\].recipe === null) continue;||' src/engine/systems/production-system.ts
npx vitest run tests/engine/systems/production-system.test.ts -t "a house never produces"   # expect FAIL (or throw)
cp "$SP/production-system.ts" src/engine/systems/production-system.ts

# The exactly-one-of rule must be enforced, not merely stated
sed -i 's|recipe: null, beds: BALANCE.houseBeds,|recipe: null, beds: 0,|' src/engine/content/buildings.ts
npx vitest run tests/engine/content.test.ts -t "exactly one of"                              # expect FAIL
cp "$SP/buildings.ts" src/engine/content/buildings.ts
```

Both must fail.

- [ ] **Step 8: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(content): the house — a building that shelters instead of producing

BuildingDef.recipe becomes nullable and BuildingDef gains beds, with a
content test pinning that every def has exactly one of them. The house
costs planks, which until now had no demand outside mill/bakery/workshop.

A house produces nothing, so its output buffer stays empty and
nextHaulTarget already skips it: HaulSystem needs no change."
```

---

### Task 6: `Home`, homing, and the homeless penalty

**Files:**
- Modify: `src/engine/components.ts` (`Home`)
- Modify: `src/engine/spawn.ts`, `src/engine/world.ts` (`COMPONENT_TYPES`)
- Modify: `src/engine/systems/population-handlers.ts` (`rehome`)
- Modify: `src/engine/systems/population-system.ts` (buildings query)
- Modify: `src/engine/systems/command-handlers.ts` (demolish evicts)
- Modify: `src/engine/snapshot-builder.ts` (`homeId`, `occupants`, `homeless`)
- Modify: `src/shared/snapshot.ts`, `src/engine/content/balance.ts`
- Test: `tests/engine/systems/population-system.test.ts`

**Interfaces:**
- Consumes: `PopulationContext`, `livingRows` (Task 3); `BUILDINGS[...].beds` (Task 5).
- Produces:
  - `class Home { constructor(public buildingId: number | null = null) {} }`
  - `rehome(ctx: PopulationContext): void`
  - `PopulationContext.shelters: ShelterRow[]` where `ShelterRow { id: number; beds: number; col: number; row: number; relocating: boolean }`
  - `ColonistSnapshot.homeId: number | null`, `Snapshot.homeless: number`, `Snapshot.beds: { total: number; occupied: number }`
  - `BALANCE.homelessFactor`

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/systems/population-system.test.ts`:

```ts
describe('PopulationSystem — homing', () => {
  it('homes a homeless colonist into a free bed, and evicts when the house relocates', async () => {
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const snap = () => world.getResource(SnapshotStore).latest!;

    await step();
    expect(snap().colonists[0].homeId).toBe(houseId);
    expect(snap().homeless).toBe(0);
    expect(snap().beds).toEqual({ total: BALANCE.houseBeds, occupied: 1 });
    expect(snap().buildings.find((b) => b.id === houseId)!.occupants).toBe(1);

    // A house being carried shelters nobody — otherwise moving a house would
    // be the one free relocation in the game.
    enqueue(world, { type: 'moveBuilding', buildingId: houseId, to: { col: 15, row: 11 } });
    await step();
    expect(snap().colonists[0].homeId).toBeNull();
    expect(snap().homeless).toBe(1);
  });

  it('makes a demolished house homeless immediately, not next tick', async () => {
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    await step();
    expect(world.getResource(SnapshotStore).latest!.colonists[0].homeId).toBe(houseId);

    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await step();
    expect(world.getResource(SnapshotStore).latest!.colonists[0].homeId).toBeNull();
  });
});
```

Add `enqueue` to the imports from `../fixtures`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/systems/population-system.test.ts -t "homing"`
Expected: FAIL — `homeId` is not on `ColonistSnapshot`.

- [ ] **Step 3: Add the component**

**First, the `PendingChanges` resource** — Task 6 is where it is first needed, because demolition cannot evict without it.

In `src/engine/resources.ts`, beside `RemovalLedger`:

```ts
/**
 * Entity changes made this tick that no query can see yet. sim-ecs syncs
 * creations and removals only after every system has run, so within one tick a
 * spawned colonist is invisible and a demolished building is still present.
 * Both halves are the same question, so they share one answer and one clear
 * point — the same hazard, and the same remedy, as
 * CommandContext.claimedTiles.
 *
 * `demolished` is what makes handleDemolishBuilding's eviction stick: it nulls
 * its residents' homes, but the house stays in PopulationSystem's shelters
 * query for the rest of the tick, so rehome would put those same colonists
 * straight back into a building that no longer exists.
 *
 * `arrivals` is unused until Task 8 introduces births and nomads; it is
 * declared here so the two halves cannot drift apart, and so `clear()` has one
 * definition rather than growing a second field later.
 */
export class PendingChanges {
  /**
   * One entry per colonist spawned this tick, holding its LIVE `Home`
   * component — not a copied id.
   *
   * The component, because this tick may still need to change it. If
   * `recruitWorker` is queued before `demolishBuilding`, the nomad has already
   * spawned with a `homeId` pointing at that house, and
   * `handleDemolishBuilding` cannot reach it: its loop walks `ctx.workers`,
   * whose query will not see the new entity until the post-step sync. The
   * nomad would keep a reference to a building that no longer exists, the
   * autosave at the end of the tick would serialize it, and the v5 load guard
   * — which requires every `homeId` to name a real shelter — would send that
   * save down the corrupt-backup path. Holding the component lets the
   * demolition null it in place.
   */
  readonly arrivals: { home: Home }[] = [];
  /** Buildings demolished this tick. Still in every query until the sync. */
  readonly demolished = new Set<number>();

  clear(): void {
    this.arrivals.length = 0;
    this.demolished.clear();
  }
}
```

Register it in `buildColonyPrepWorld`'s `instances` array, add `pending: PendingChanges` to both `CommandContext` and `PopulationContext`, have `handleDemolishBuilding` record the id, and have `PopulationSystem` call `ctx.pending.clear()` at the end of its run — by the next tick the real entities are in the query, so counting them again would double the arrivals and keep a demolished house excluded forever.

Then in `src/engine/components.ts`:

```ts
/**
 * The house this colonist sleeps in, or null when homeless. Occupancy is read
 * from these references rather than counted on the building, so a house and
 * its residents cannot disagree about who lives there.
 *
 * Saved (v5): where a colonist lives is a decision, not derived state — the
 * homing phase would re-derive *a* valid assignment on load, but not
 * necessarily the same one, which would silently reshuffle commutes.
 */
export class Home {
  constructor(public buildingId: number | null = null) {}
}
```

Add `homeId?: number | null` to `ColonistSpec`, `new Home(spec.homeId ?? null)` to `colonistComponents`, and `Home` to `COMPONENT_TYPES`.

In `src/engine/content/balance.ts`, inside `BALANCE`:

```ts
  /** Work power multiplier for a colonist with nowhere to live. Equal to
   * commute.floor (spec 4): homelessness is exactly as bad as the worst
   * possible commute, so the player has one number to beat. Task 7 adds the
   * content test pinning the two together. */
  homelessFactor: 0.5,
```

(`houseBeds` already landed in Task 5, beside the def that reads it.)

- [ ] **Step 4: Write the homing phase**

In `src/engine/systems/population-handlers.ts`:

```ts
/** A building that can shelter, as the homing phase needs it. */
export interface ShelterRow {
  id: number;
  beds: number;
  col: number;
  row: number;
  /** A house in transit shelters nobody until it lands. */
  relocating: boolean;
}
```

Add `shelters: ShelterRow[]` to `PopulationContext`, and:

```ts
/**
 * Evict, then fill — the two halves spec 2.3 describes.
 *
 * Eviction covers a home that stopped sheltering: demolished (gone from
 * `shelters` entirely) or relocating. Filling is greedy in ascending colonist
 * id against shelters in ascending building id, which is what makes the
 * assignment reproducible rather than entity-iteration-ordered.
 *
 * Runs before births so that "a free bed exists" and "nobody is homeless" are
 * the same condition and the birth rule can test either.
 */
export function rehome(ctx: PopulationContext): void {
  const byId = new Map(ctx.shelters.map((shelter) => [shelter.id, shelter]));
  const rows = livingRows(ctx);
  const free = new Map<number, number>();
  for (const shelter of ctx.shelters) {
    // A house demolished earlier this tick is still in the query until the
    // post-step sync — see PendingChanges above. Counting its beds would let
    // homing put the residents handleDemolishBuilding just evicted straight
    // back into a building that no longer exists.
    if (shelter.relocating || ctx.pending.demolished.has(shelter.id)) continue;
    free.set(shelter.id, shelter.beds);
  }
  // Arrivals hold reserved beds too, but nothing creates one until Task 8, so
  // this loop is a no-op until then — written now because it belongs beside
  // the exclusion above, and both halves clear together.
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId !== null) free.set(home.buildingId, (free.get(home.buildingId) ?? 0) - 1);
  }

  for (const row of rows) {
    const homeId = row.home.buildingId;
    if (homeId === null) continue;
    const shelter = byId.get(homeId);
    if (shelter === undefined || shelter.relocating) {
      row.home.buildingId = null;
      continue;
    }
    // Over capacity evicts rather than overflowing. A save can legitimately
    // arrive this way — lowering houseBeds in a retune leaves every existing
    // house one resident over — and the load principle says clamp a
    // balance-coupled value, never reject the save for it. Ascending id means
    // the highest ids are the ones displaced, deterministically.
    const remaining = free.get(homeId) ?? 0;
    if (remaining <= 0) {
      row.home.buildingId = null;
      continue;
    }
    free.set(homeId, remaining - 1);
  }

  const openings = [...free.entries()].filter(([, beds]) => beds > 0).sort((a, b) => a[0] - b[0]);
  for (const row of rows) {
    if (row.home.buildingId !== null) continue;
    const opening = openings.find(([, beds]) => beds > 0);
    if (opening === undefined) return; // no beds left: the rest stay homeless
    row.home.buildingId = opening[0];
    opening[1]--;
  }
}
```

`ColonistRow` gains `home: Home`.

- [ ] **Step 5: Wire it into the system**

In `population-system.ts` add to the query:

```ts
  buildings: queryComponents({ building: Read(Building), position: Read(Position), relocation: Read(Relocation) }),
```

build the shelter rows in the context:

```ts
      shelters: [...buildings.iter()]
        .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
        .map(({ building, position, relocation }) => ({
          id: building.id,
          beds: BUILDINGS[building.defId].beds,
          col: position.col,
          row: position.row,
          // `> 0`: is this house in transit RIGHT NOW? A countdown of 1 means
          // it is still being carried this tick — ProductionSystem decrements
          // afterwards, and skips its work in the same pass — so it lands at
          // the END of this tick, not the start.
          //
          // `> 1` was tried and is wrong: it homes colonists into a house that
          // has not landed, and sumWorkPower then grants them the full housed
          // factor during a charged relocation tick, shortening every housing
          // penalty by one tick. The cost of `> 0` is milder and accepted: the
          // snapshot published at the end of the landing tick shows an empty
          // house with free beds while its former residents are still
          // homeless, until the next tick homes them. That reads oddly but is
          // ACCURATE at the instant it is published, and a mis-timed penalty
          // would not be.
          relocating: relocation.ticksLeft > 0,
        })),
```

and call `rehome(ctx)` after `standDownNonAdults(ctx)`. Add `home: Write(Home)` to the colonists query and thread it into the row mapping.

- [ ] **Step 6: Evict on demolition**

`rehome` already evicts a colonist whose house has vanished, but demolition removes the entity only at the post-step sync — so the house is still in `shelters` this tick and the eviction would wait a tick. Make it immediate in `src/engine/systems/command-handlers.ts`'s `handleDemolishBuilding`, inside the existing worker loop:

```ts
  for (const { job, trip, home } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
    // The house is gone now, not at the post-step sync — rehome would
    // otherwise leave its residents nominally housed for one more tick.
    if (home.buildingId === command.buildingId) home.buildingId = null;
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) trip.reset();
  }
  // Colonists spawned EARLIER THIS TICK are not in ctx.workers — the query
  // cannot see them until the post-step sync — so a nomad welcomed before
  // this demolition would keep a homeId pointing at the building being
  // removed. The autosave at the end of the tick would then serialize a
  // dangling reference, and the v5 load guard would refuse the save.
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId === command.buildingId) home.buildingId = null;
  }
  ctx.pending.demolished.add(command.buildingId);
```

`WorkerRow` gains `home: Home`, populated from a `home: Write(Home)` addition to `command-system.ts`'s colonists query. Extend the demolition notice when residents were displaced:

```ts
  const displaced = ctx.workers.filter(({ home }) => home.buildingId === command.buildingId).length;
```

read **before** the loop nulls them, and append ` — N colonist(s) now homeless.` to the notice when `displaced > 0`.

- [ ] **Step 7: Publish homing**

Add `homeId: number | null` to `ColonistSnapshot`, `homeId: home.buildingId` to `colonistFactsOf` (with `home: Home` as a parameter and `entity.getComponent(Home)!` in `gatherEntityFacts`).

In `buildEntitySections`, count occupancy and homelessness:

```ts
  const occupantsByHouse = new Map<number, number>();
  for (const c of colonists) {
    if (c.homeId !== null) occupantsByHouse.set(c.homeId, (occupantsByHouse.get(c.homeId) ?? 0) + 1);
  }
```

set `occupants: occupantsByHouse.get(b.id) ?? 0` on each building snapshot, and return two new sections:

```ts
    homeless: colonistSnaps.filter((c) => c.homeId === null).length,
    beds: {
      // Relocating houses are excluded, because homing and both admission
      // gates already exclude them. Counting their beds here would let the
      // Population view read "0 / 4 free" while the engine refuses a nomad
      // for want of a bed — the display contradicting the rule it exists to
      // explain. `total` therefore means beds you can actually sleep in
      // tonight, which is the only number a player can act on.
      total: buildingSnaps.filter((b) => b.state !== 'relocating').reduce((sum, b) => sum + b.beds, 0),
      occupied: buildingSnaps.reduce((sum, b) => sum + b.occupants, 0),
    },
    // Spec 2.13's stage counts. Aggregated here beside the other cross-entity
    // sections rather than recomputed in each view: the Population view and
    // the Dashboard both show them, and two independent reductions over the
    // roster are two chances to disagree about what a stage is.
    demographics: {
      children: colonistSnaps.filter((c) => c.stage === 'child').length,
      adults: colonistSnaps.filter((c) => c.stage === 'adult').length,
      elders: colonistSnaps.filter((c) => c.stage === 'elder').length,
    },
```

adding all three to `EntitySections` and to `Snapshot`. `demographics` is typed `{ children: number; adults: number; elders: number }`.

Because `buildEntitySections` is the shared aggregator, this reaches **both** snapshot paths at once — the live `SnapshotSystem` one and `buildInitialSnapshot`'s seeded one — which is the property that keeps a restored colony's headline numbers identical to a running one's.

- [ ] **Step 8: Apply the homeless penalty**

In `src/engine/content/balance.ts`, extend the shared work-power function:

```ts
export function workerWorkPower(efficiency: number, toolTicks: number, placementFactor = 1): number {
  return efficiency * (toolTicks > 0 ? BALANCE.toolMultiplier : 1) * placementFactor;
}
```

In `ProductionSystem`, pass `job.homeId === null ? BALANCE.homelessFactor : 1` — read from the `Home` component added to its colonists query. In `buildEntitySections`, pass `c.homeId === null ? BALANCE.homelessFactor : 1`. Task 7 replaces both with the full commute factor.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/engine/systems/population-handlers.ts "$SP/population-handlers.ts"
cp src/engine/systems/command-handlers.ts "$SP/command-handlers.ts"

# A relocating house must stop sheltering
# Two edits, because a relocating house is skipped in both halves of rehome.
# NOTE the second one uses `#` as the delimiter: inside a |-delimited s|||,
# GNU sed reads `\|` as ALTERNATION, not a literal pipe, so the obvious
# escaping of `||` silently matches nothing and exits 0.
# `#` as the delimiter throughout: inside a |-delimited s|||, GNU sed reads
# `\|` as ALTERNATION, so escaping the `||` in these guards matches nothing
# and exits 0.
sed -i 's#    if (shelter.relocating || ctx.pending.demolished.has(shelter.id)) continue;#    if (ctx.pending.demolished.has(shelter.id)) continue;#' src/engine/systems/population-handlers.ts
sed -i 's#    if (shelter === undefined || shelter.relocating) {#    if (shelter === undefined) {#' src/engine/systems/population-handlers.ts
# BOTH guards must go. Removing only one leaves the other still evicting the
# resident, so the test stays green and the mutation proves nothing. Exit
# nonzero rather than print — a warning scrolls past.
changed=$(git diff --numstat src/engine/systems/population-handlers.ts | awk '{print $1}')
[ "$changed" = "2" ] || { echo "MUTATION INCOMPLETE: $changed of 2 lines changed"; exit 1; }
npx vitest run tests/engine/systems/population-system.test.ts -t "evicts when the house relocates"  # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts

# Demolition must evict in the same tick
sed -i 's|    if (home.buildingId === command.buildingId) home.buildingId = null;||' src/engine/systems/command-handlers.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "demolished house homeless immediately"  # expect FAIL
cp "$SP/command-handlers.ts" src/engine/systems/command-handlers.ts
```

Both must fail.

- [ ] **Step 11: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(engine): colonists have homes, and homelessness costs work

Home points at a house; occupancy is read from those references rather
than counted on the building, so the two cannot disagree. PopulationSystem
evicts then fills, greedily and in id order, before births — which makes
'a free bed exists' and 'nobody is homeless' the same condition.

A relocating house shelters nobody: without that, moving a house would be
the one free relocation left in the game."
```

---

### Task 7: Commute

**Files:**
- Modify: `src/shared/population.ts` (`commuteFactor`)
- Modify: `src/engine/content/balance.ts` (`commuteFreeTiles`, `commutePenaltyPerTile`, `commuteFloor`)
- Modify: `src/engine/systems/production-system.ts`, `src/engine/snapshot-builder.ts`
- Modify: `src/engine/systems/haul-system.ts` (carry capacity)
- Modify: `src/shared/snapshot.ts`
- Modify: `tests/support/balance-harness.ts` (**house the crews**)
- Test: `tests/shared/population.test.ts`, `tests/engine/balance.test.ts`

**Interfaces:**
- Consumes: `Home` (Task 6), `CAMP_TILE` / `haulDistance` (`src/shared/haul.ts`).
- Produces:
  - `interface CommuteRates { freeTiles: number; penaltyPerTile: number; floor: number }`
  - `commuteFactor(tiles: number | null, rates: CommuteRates, homelessFactor: number): number`
  - `ColonistSnapshot.commuteTiles: number`, `ColonistSnapshot.commuteFactor: number`
  - `ColonistFacts = Omit<ColonistSnapshot, 'commuteTiles' | 'commuteFactor'> & { carryingResource }`
  - `Scenario.houseCrew?: boolean` (defaults true) on the balance harness

- [ ] **Step 1: Record the baseline you must not move**

Before changing anything:

```bash
npx vitest run tests/engine/balance.test.ts --testTimeout=120000 2>&1 | tee /tmp/balance-before.txt
BALANCE_REPORT=1 npx vitest run tests/engine/balance.test.ts --testTimeout=120000 2>&1 | tee /tmp/report-before.txt
```

Keep both. Step 8 diffs against them: spec §1.3 says a moved haul gradient is a bug in this increment, not a retune.

- [ ] **Step 2: Write the failing test**

Append to `tests/shared/population.test.ts`:

```ts
import { commuteFactor, type CommuteRates } from '../../src/shared/population';

const RATES: CommuteRates = { freeTiles: 2, penaltyPerTile: 0.03, floor: 0.5 };

describe('commuteFactor', () => {
  it('is free inside the free radius', () => {
    // THE property that keeps increment 5's measurements intact: the harness
    // houses its crews adjacent to their building, and adjacent must cost
    // nothing. ticksForDistance would have charged them — it floors at 1 by
    // design, so no haul is free — which is why this charges tiles instead.
    expect(commuteFactor(0, RATES, 0.5)).toBe(1);
    expect(commuteFactor(1, RATES, 0.5)).toBe(1);
    expect(commuteFactor(2, RATES, 0.5)).toBe(1);
  });

  it('charges only the tiles beyond the free radius', () => {
    expect(commuteFactor(3, RATES, 0.5)).toBeCloseTo(0.97, 5);
    expect(commuteFactor(10, RATES, 0.5)).toBeCloseTo(0.76, 5);
  });

  it('never falls below the floor', () => {
    expect(commuteFactor(100, RATES, 0.5)).toBe(0.5);
  });

  it('gives the homeless factor to a colonist with no home', () => {
    // Distinct from the floor on purpose in this fixture (0.4 vs 0.5) so the
    // assertion cannot pass by the two happening to be equal.
    expect(commuteFactor(null, RATES, 0.4)).toBe(0.4);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/shared/population.test.ts -t "commuteFactor"`
Expected: FAIL — `commuteFactor` is not exported.

- [ ] **Step 4: Write the law**

Append to `src/shared/population.ts`:

```ts
/** Commute tuning, supplied by BALANCE. */
export interface CommuteRates {
  /** Tiles between home and work that cost nothing. */
  freeTiles: number;
  /** Fraction of work power lost per charged tile. */
  penaltyPerTile: number;
  /** The worst a commute can make a colonist. */
  floor: number;
}

/**
 * How much of their work a colonist actually delivers, given the distance
 * between where they sleep and where they work. `tiles` is null for a colonist
 * with no home, who takes `homelessFactor` instead.
 *
 * Charges TILES, not `ticksForDistance`. Reusing that is the obvious move and
 * it is wrong here: it floors at 1 by design, so that no placement is free and
 * no haul costs nothing. Applied to a commute that floor charges every
 * colonist in the game permanently — including the balance harness's crews,
 * which would shift every number increment 5 measured for a reason unrelated
 * to hauling. A commute genuinely can be free: you live next door.
 */
export function commuteFactor(tiles: number | null, rates: CommuteRates, homelessFactor: number): number {
  if (tiles === null) return homelessFactor;
  const charged = Math.max(0, tiles - rates.freeTiles);
  return Math.max(rates.floor, 1 - charged * rates.penaltyPerTile);
}
```

In `src/engine/content/balance.ts`, inside `BALANCE`:

```ts
  /** Commute tuning (spec 2.4). freeTiles is what makes an adjacent home
   * genuinely free, which is what keeps increment 5's measurements intact. */
  commute: { freeTiles: 2, penaltyPerTile: 0.03, floor: 0.5 } as CommuteRates,
```

importing `CommuteRates` alongside `LifeBands`. Set `homelessFactor: 0.5` to equal `commute.floor` by reference is not possible inside one object literal — keep the literal and add a test in `tests/engine/content.test.ts`:

```ts
it('homelessness is exactly as bad as the worst commute', () => {
  // Spec 4: one number for the player to beat. A drift between these two
  // would make being homeless quietly better than living far away.
  expect(BALANCE.homelessFactor).toBe(BALANCE.commute.floor);
});
```

- [ ] **Step 5: Apply it in both readers**

The distance needs a home tile and a workplace tile, which is cross-entity — so it is computed where both are already in hand.

In `src/engine/snapshot-builder.ts`, change the facts type (the two commute fields are the only ones a single entity cannot supply):

```ts
/**
 * …existing doc… The two commute fields are the exception to "a colonist's
 * facts ARE its snapshot": they need the home's tile AND the workplace's,
 * so buildEntitySections computes them where both are in hand.
 */
export interface ColonistFacts extends Omit<ColonistSnapshot, 'commuteTiles' | 'commuteFactor'> {
  carryingResource: ResourceId | null;
}
```

and in `buildEntitySections`, before the aggregation loop:

```ts
  const tileById = new Map(buildings.map((b) => [b.id, { col: b.col, row: b.row }]));
  // A hauler's job begins and ends at the store, so that is the tile their
  // commute is measured to.
  const workTileOf = (c: ColonistFacts) =>
    c.hauling ? CAMP_TILE : (c.buildingId === null ? null : tileById.get(c.buildingId) ?? null);
  const commuteOf = (c: ColonistFacts): number | null => {
    const home = c.homeId === null ? null : tileById.get(c.homeId) ?? null;
    const work = workTileOf(c);
    if (home === null) return null;
    if (work === null) return 0; // housed but unassigned: no commute to pay
    return Math.hypot(home.col - work.col, home.row - work.row);
  };
```

Use `commuteFactor(commuteOf(c), BALANCE.commute, BALANCE.homelessFactor)` in the `powerByBuilding` accumulation and publish both fields on each colonist snapshot.

In `src/engine/systems/production-system.ts`, add `position: Read(Position)` to the buildings query and `home: Read(Home)` to the colonists query, build the same `tileById` map, and pass the factor into `workerWorkPower`. Extract the distance-to-factor step into a small local so the run function's complexity does not rise.

- [ ] **Step 6: A hauler's commute costs them carry, not work power**

`workerWorkPower` never touches a hauler — their throughput is trips, not batches — so without this a hauler's commute would be decorative.

**`BALANCE.haulCarryCapacity` appears at THREE sites in `src/engine/systems/haul-system.ts`, and all three must move together:** `buildClaimMap` (~line 21), the same-tick dispatch claim (~line 76), and the actual load (~line 88). Changing only the load leaves the two reservation sites claiming 6 for a hauler who will take 3 — so a building's `claimableAt` under-reports, other haulers are dispatched elsewhere, and output sits unclaimed. That is a scheduling penalty on top of the commute factor, which is not what this models.

Add one exported helper and use it at every site:

```ts
/**
 * What THIS hauler carries per trip. A hauler's output is goods moved, so
 * their commute costs them the same fraction of it that a worker's costs them
 * of production. Rounded, floored at 1: a hauler who shows up carries
 * something.
 *
 * Every site that reserves or takes capacity must call this — buildClaimMap,
 * the same-tick dispatch claim, and the load. A reservation computed from the
 * flat BALANCE.haulCarryCapacity while the load uses this would claim 6 for a
 * hauler taking 3, leaving goods unclaimed and other haulers sent away.
 */
export function haulerCapacity(homeTile: TileRef | null): number {
  const tiles = homeTile === null
    ? null
    : Math.hypot(homeTile.col - CAMP_TILE.col, homeTile.row - CAMP_TILE.row);
  const factor = commuteFactor(tiles, BALANCE.commute, BALANCE.homelessFactor);
  return Math.max(1, Math.round(BALANCE.haulCarryCapacity * factor));
}
```

`buildClaimMap` and the dispatch path need each hauler's home tile, so add `Home` to the system's colonists query and thread the tile through `WorkerRow`. Pin the consistency with a test:

```ts
it('reserves exactly what a reduced-capacity hauler will actually take', async () => {
  // A homeless hauler carries 3, not 6. If the claim map still reserves 6,
  // a second hauler is sent elsewhere while half the buffer sits unclaimed.
  const homeless = haulerCapacity(null);
  expect(homeless).toBeLessThan(BALANCE.haulCarryCapacity);
  // …run a two-hauler, one-full-buffer world and assert BOTH haulers are
  // dispatched to it, which only holds if the claim matches the load.
});
```

- [ ] **Step 7: House the harness's crews**

This is the change that keeps §1.3 true, and it is the same move as increment 5 seeding a berry stock so hunger is not a confound.

In `tests/support/balance-harness.ts`, add to `Scenario`:

```ts
  /**
   * House the crew beside their building and the haulers beside the camp, so
   * commute is held at its neutral value (1.0, inside commuteFreeTiles) and
   * this instrument keeps measuring logistics rather than housing. Same
   * principle as the FED berry stock holding hunger neutral. Defaults true;
   * a housing scenario sets it false deliberately.
   */
  houseCrew?: boolean;
  /**
   * Put the crew's house at THIS tile instead of beside their building — the
   * only way to vary commute while holding everything else fixed, which is
   * what the "a distant house costs delivered goods" measurement needs. Task
   * 12 depends on `runScenario` actually reading it; a `Scenario` field the
   * runner ignores makes the near and far worlds identical, so the test can
   * never fail and proves nothing.
   */
  crewHouseAt?: { col: number; row: number };
```

and in `runScenario`, after spawning the measured building:

**Relocation scenarios must opt OUT.** A `moveTo` scenario houses its crew beside the building's *starting* tile, and increment 5's relocation case moves from `(10,0)` to `(3,7)` — so after the move the crew carries a large commute penalty that neither stationary control pays. The existing assertion `moved.made < from.made` would then stay green **even if relocation downtime stopped reducing production at all**, which is worse than failing: a test that passes for the wrong reason is a test that has stopped protecting anything.

So `runScenario` defaults `houseCrew` to `moveTo === undefined`: distance scenarios are housed and neutral (preserving increment 5's numbers exactly), relocation scenarios are unhoused so **every run in the comparison pays the same flat `homelessFactor`** and the only variable left between them is the downtime. Uniform scaling preserves the relational assertions those cases actually pin; it is neutrality of the *comparison*, which is what a control needs, rather than neutrality of the absolute number.

```ts
  // Default: housed for distance scenarios, unhoused for relocation ones —
  // see the note above. An explicit houseCrew always wins.
  const housed = scenario.houseCrew ?? (scenario.moveTo === undefined);
  let crewHomeId: number | null = null;
  let haulerHomeId: number | null = null;
  if (housed) {
    // Adjacent to the measured building, and adjacent to the camp. Both land
    // inside commuteFreeTiles, so commuteFactor is exactly 1 and every
    // increment-5 measurement is preserved by construction.
    // crewHouseAt wins when given; otherwise adjacent to the building, which
    // lands inside commuteFreeTiles and scores exactly 1.0.
    const crewTile = scenario.crewHouseAt ?? { col: adjacentCol(save.map, col), row };
    const crewHouse = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: crewTile.col, row: crewTile.row });
    crewHomeId = crewHouse.getComponent(Building)!.id;
    const haulerTile = campAdjacentFreeTile([{ col, row }, crewTile]);
    const haulerHouse = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: haulerTile.col, row: haulerTile.row });
    haulerHomeId = haulerHouse.getComponent(Building)!.id;
  }
  for (let i = 0; i < crew; i++) spawnColonist(prep, ids, { buildingId, homeId: crewHomeId, ageTicks: BALANCE.lifeBands.matureTicks });
  for (let i = 0; i < haulers; i++) spawnColonist(prep, ids, { hauling: true, homeId: haulerHomeId, ageTicks: BALANCE.lifeBands.matureTicks });
```

with this module-level helper beside `runScenario`:

```ts
/**
 * A commute-neutral tile for the hauler house that nothing else is standing on.
 *
 * Only THREE tiles are both buildable (col >= CAMP_COLS) and inside
 * `commuteFreeTiles` of the camp: (3,0), (3,1) and (4,0). Hardcoding (3,0) —
 * `CAMP_TILE.col + 1` — collides with the haul sweep's own nearest case,
 * `forester(3, 0, 1)`, and `spawnBuilding` writes tiles directly without
 * consulting `isTileBuildable`, so the two would silently stack. That would
 * put an unreachable layout inside the very measurements increment 5 pinned
 * as this increment's regression net.
 *
 * Throws rather than falling back to a distant tile: a hauler housed outside
 * the free radius pays a commute, which would move those numbers for a reason
 * having nothing to do with hauling.
 */
function campAdjacentFreeTile(taken: readonly TileRef[]): TileRef {
  const candidates: TileRef[] = [
    { col: CAMP_TILE.col + 1, row: CAMP_TILE.row },
    { col: CAMP_TILE.col + 1, row: CAMP_TILE.row + 1 },
    { col: CAMP_TILE.col + 2, row: CAMP_TILE.row },
  ];
  const free = candidates.find((t) => !taken.some((u) => u.col === t.col && u.row === t.row));
  if (free === undefined) throw new Error('No commute-neutral tile left for the hauler house');
  return free;
}

/**
 * A buildable tile adjacent to `col` — where the crew house goes. Adjacency is
 * the point: it lands inside BALANCE.commute.freeTiles, so commuteFactor is
 * exactly 1 and every increment-5 measurement is preserved by construction
 * rather than by luck.
 */
function adjacentCol(map: { cols: number }, col: number): number {
  return col + 1 < map.cols ? col + 1 : col - 1;
}
```

called as `adjacentCol(save.map, col)`. The crew house holds `houseBeds` = 4 and the largest crew is a farm's 4, so one house per group suffices; assert it rather than assume:

```ts
  if (housed && (crew > BALANCE.houseBeds || haulers > BALANCE.houseBeds)) {
    throw new Error('Scenario needs more beds than one house provides — add a second house before measuring');
  }
```

Also give the crews an adult age (above), or aging kills them mid-run and the measurement quietly changes.

- [ ] **Step 8: Verify the gradient did NOT move**

```bash
npx vitest run tests/engine/balance.test.ts --testTimeout=120000 2>&1 | tee /tmp/balance-after.txt
BALANCE_REPORT=1 npx vitest run tests/engine/balance.test.ts --testTimeout=120000 2>&1 | tee /tmp/report-after.txt
diff <(grep -E '^\s*\|' /tmp/report-before.txt) <(grep -E '^\s*\|' /tmp/report-after.txt)
```

Expected: **the sweep table is identical** and every increment-5 assertion passes. If a number moved, do not adjust the assertion — find out why. The two candidates are a crew house outside `commuteFreeTiles`, and a hauler house that is not adjacent to the camp.

- [ ] **Step 9: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/shared/population.ts "$SP/population.ts"

# The free radius must actually be subtracted
sed -i 's|const charged = Math.max(0, tiles - rates.freeTiles);|const charged = tiles;|' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "free inside the free radius"   # expect FAIL
cp "$SP/population.ts" src/shared/population.ts

# The floor must actually clamp
sed -i 's|return Math.max(rates.floor, 1 - charged \* rates.penaltyPerTile);|return 1 - charged * rates.penaltyPerTile;|' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "never falls below the floor"   # expect FAIL
cp "$SP/population.ts" src/shared/population.ts

# Homeless must take the homeless factor, not the floor
sed -i 's|if (tiles === null) return homelessFactor;|if (tiles === null) return rates.floor;|' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "homeless factor"               # expect FAIL
cp "$SP/population.ts" src/shared/population.ts
```

All three must fail.

- [ ] **Step 11: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(engine): a commute costs work, so where you house people matters

commuteFactor charges TILES beyond a free radius, not ticksForDistance:
that floors at 1 by design so no haul is free, and applied to a commute it
would charge every colonist permanently — including the balance harness's
crews, moving every increment-5 measurement for reasons unrelated to
hauling.

The harness now houses its crews (beside the building) and haulers (beside
the camp), holding commute at 1.0 the same way its berry stock holds
hunger neutral. The distance/hauler sweep is byte-identical before and
after.

A hauler's commute scales carry capacity, since their output is goods
moved rather than batches produced."
```

---

### Task 8: Meals, births, and the nomad gate

**Files:**
- Modify: `src/shared/population.ts` (`mealsInStore`, `mealsPerHead`, `birthBlocker`, `nomadBlocker`)
- Modify: `src/engine/resources.ts` (`SimClock.lastBirthTick`)
- Modify: `src/engine/systems/population-handlers.ts` (`tryBirth`)
- Modify: `src/engine/systems/command-handlers.ts` (`handleRecruitWorker`)
- Modify: `src/shared/snapshot.ts` (`mealsPerHead`, `lastBirthTick`)
- Modify: `src/engine/content/balance.ts`, `src/engine/content/resources.ts`
- Test: `tests/shared/population.test.ts`, `tests/engine/systems/population-system.test.ts`

**Interfaces:**
- Consumes: `stageOf` (Task 2), `Home` (Task 6).
- Produces:
  - `interface MealWeights { [id: string]: number }` — supplied by the caller from the catalog
  - `mealsInStore(stock, weights): number`
  - `mealsPerHead(stock, weights, population): number` — divides by `population + 1`
  - `type PopulationBlocker = 'noBed' | 'notEnoughFood' | 'cooldown' | 'noParents' | null`
  - `birthBlocker(...)`, `nomadBlocker(...)`
  - `BALANCE.birthFoodPerHead`, `nomadFoodPerHead`, `birthCooldownTicks`, `MEAL_WEIGHTS`
  - `SimClock.lastBirthTick`, `Snapshot.mealsPerHead`

- [ ] **Step 1: Write the failing test**

Append to `tests/shared/population.test.ts`:

```ts
import { birthBlocker, mealsInStore, mealsPerHead, nomadBlocker } from '../../src/shared/population';

const WEIGHTS = { bread: 1, berries: 0.6 };

describe('meals', () => {
  it('weights each edible by what it actually restores', () => {
    // Discriminating: 10 bread and 10 berries must NOT score the same, which
    // is the whole reason this is weighted rather than a unit count.
    expect(mealsInStore({ bread: 10 }, WEIGHTS)).toBe(10);
    expect(mealsInStore({ berries: 10 }, WEIGHTS)).toBe(6);
    expect(mealsInStore({ bread: 10, berries: 10, wood: 500 }, WEIGHTS)).toBe(16); // wood is not edible
  });

  it('divides by the population it would produce, never the current one', () => {
    // population + 1 is what removes the zero-population special case AND its
    // hole: dividing by the current population needs 0 treated as unbounded,
    // and unbounded satisfies any threshold, so an EMPTY store plus one bed
    // could admit a nomad.
    expect(mealsPerHead({ bread: 12 }, WEIGHTS, 3)).toBe(3);   // 12 / (3 + 1)
    expect(mealsPerHead({}, WEIGHTS, 0)).toBe(0);              // empty store, nobody: not unbounded
    expect(Number.isFinite(mealsPerHead({ bread: 5 }, WEIGHTS, 0))).toBe(true);
  });
});

describe('gates', () => {
  const plenty = { bread: 1000 };
  it('names the failed gate rather than returning a bare boolean', () => {
    expect(birthBlocker({ stock: plenty, weights: WEIGHTS, population: 4, adults: 2, freeBeds: 1, tick: 100, lastBirthTick: 0, cooldown: 50, perHead: 6 })).toBeNull();
    expect(birthBlocker({ stock: plenty, weights: WEIGHTS, population: 4, adults: 2, freeBeds: 0, tick: 100, lastBirthTick: 0, cooldown: 50, perHead: 6 })).toBe('noBed');
    expect(birthBlocker({ stock: plenty, weights: WEIGHTS, population: 4, adults: 1, freeBeds: 1, tick: 100, lastBirthTick: 0, cooldown: 50, perHead: 6 })).toBe('noParents');
    expect(birthBlocker({ stock: {}, weights: WEIGHTS, population: 4, adults: 2, freeBeds: 1, tick: 100, lastBirthTick: 0, cooldown: 50, perHead: 6 })).toBe('notEnoughFood');
    expect(birthBlocker({ stock: plenty, weights: WEIGHTS, population: 4, adults: 2, freeBeds: 1, tick: 10, lastBirthTick: 0, cooldown: 50, perHead: 6 })).toBe('cooldown');
  });

  it('refuses a nomad to a wiped-out colony with an empty store', () => {
    // Acceptance criterion 10. Beds standing, nobody alive, nothing to eat.
    expect(nomadBlocker({ stock: {}, weights: WEIGHTS, population: 0, freeBeds: 4, tick: 100, lastRecruitTick: 0, cooldown: 30, perHead: 10 })).toBe('notEnoughFood');
    expect(nomadBlocker({ stock: { bread: 50 }, weights: WEIGHTS, population: 0, freeBeds: 4, tick: 100, lastRecruitTick: 0, cooldown: 30, perHead: 10 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/population.test.ts -t "meals"`
Expected: FAIL — `mealsInStore` is not exported.

- [ ] **Step 3: Write the meal and gate law**

Append to `src/shared/population.ts`:

```ts
/** Meals per unit for each edible resource, supplied by the caller from the
 * content catalog (src/shared may not import it). */
export type MealWeights = Readonly<Record<string, number>>;

/** Total meals the store holds. */
export function mealsInStore(stock: Readonly<Record<string, number>>, weights: MealWeights): number {
  let meals = 0;
  for (const [id, weight] of Object.entries(weights)) meals += (stock[id] ?? 0) * weight;
  return meals;
}

/**
 * Meals per head, dividing by the population this gate would PRODUCE rather
 * than the current one — the honest question is "can the store feed them once
 * they are here?".
 *
 * It also removes a special case with a hole in it: dividing by the current
 * population needs `population === 0` treated as unbounded to dodge a division
 * by zero, and unbounded satisfies any threshold, so a colony with an empty
 * store and one standing bed could still welcome a nomad — contradicting the
 * claim that a foodless colony is unrecoverable.
 */
export function mealsPerHead(stock: Readonly<Record<string, number>>, weights: MealWeights, population: number): number {
  return mealsInStore(stock, weights) / (population + 1);
}

export type PopulationBlocker = 'noBed' | 'notEnoughFood' | 'cooldown' | 'noParents' | null;

export interface BirthGate {
  stock: Readonly<Record<string, number>>;
  weights: MealWeights;
  population: number;
  adults: number;
  freeBeds: number;
  tick: number;
  lastBirthTick: number;
  cooldown: number;
  perHead: number;
}

/** The gate a birth fails, or null when one may happen. Order is the order the
 * player can act on: shelter, then parents, then food, then patience. */
export function birthBlocker(gate: BirthGate): PopulationBlocker {
  if (gate.freeBeds <= 0) return 'noBed';
  if (gate.adults < 2) return 'noParents';
  if (mealsPerHead(gate.stock, gate.weights, gate.population) < gate.perHead) return 'notEnoughFood';
  if (gate.tick < gate.lastBirthTick + gate.cooldown) return 'cooldown';
  return null;
}

export type NomadGate = Omit<BirthGate, 'adults' | 'lastBirthTick'> & { lastRecruitTick: number };

/** The same shape for a nomad, minus the two-adult rule: a colony that has
 * died out entirely can still be restarted by someone walking in — provided
 * there is food, which `mealsPerHead`'s population + 1 guarantees it checks. */
export function nomadBlocker(gate: NomadGate): PopulationBlocker {
  if (gate.freeBeds <= 0) return 'noBed';
  if (mealsPerHead(gate.stock, gate.weights, gate.population) < gate.perHead) return 'notEnoughFood';
  if (gate.tick < gate.lastRecruitTick + gate.cooldown) return 'cooldown';
  return null;
}
```

- [ ] **Step 4: Add the constants and the meal weights**

In `src/engine/content/balance.ts`, inside `BALANCE`:

```ts
  birthFoodPerHead: 6,
  nomadFoodPerHead: 10,
  birthCooldownTicks: 50,
```

In `src/engine/content/resources.ts`, after `RESOURCES`:

```ts
/**
 * Meals per unit, derived from what each edible actually restores rather than
 * hand-written. One meal is `mealThreshold` hunger points — what a bread
 * delivers when eaten the moment a colonist becomes eligible — so berries at
 * `berriesHungerRestore` score 30/50 = 0.6. Derived so a hunger retune cannot
 * silently desync the Population view's headline number from what eating
 * actually does.
 */
export const MEAL_WEIGHTS: Readonly<Record<string, number>> = {
  bread: 1,
  berries: BALANCE.berriesHungerRestore / BALANCE.mealThreshold,
};
```

Add a content test pinning that every key of `MEAL_WEIGHTS` is an edible resource and every edible resource has a weight.

- [ ] **Step 5: Persist the birth cooldown**

In `src/engine/resources.ts`, add to `SimClock`:

```ts
  /** Tick of the last birth. Persisted for the reason lastRecruitTick is:
   * without it, reopening a save written just after a birth either grants a
   * free extra birth or blocks one that is due, so save-and-reload would
   * change population growth. */
  lastBirthTick = -BALANCE.birthCooldownTicks;
```

Add `lastBirthTick` to `Snapshot` beside `lastRecruitTick`, seeded in `buildInitialSnapshot`. Task 9 persists it.

- [ ] **Step 6: Write the birth phase**

In `src/engine/systems/population-handlers.ts`:

**`PendingChanges` already exists** — Task 6 introduced it, because demolition needed its `demolished` half to make eviction stick. Task 8 is where its `arrivals` half stops being a no-op: `CommandSystem` runs before `PopulationSystem`, and a nomad it spawns is invisible to queries until the post-step sync, so without recording it a nomad and a birth each take the *same* last bed and the tick ends over capacity.

`rehome` and both gates therefore skip any shelter in `ctx.pending.demolished`, exactly as they skip a relocating one:

```ts
  for (const shelter of ctx.shelters) {
    if (shelter.relocating || ctx.pending.demolished.has(shelter.id)) continue;
    free.set(shelter.id, shelter.beds);
  }
```

and `freeBeds` / `shelterWithRoom` take the same exclusion.

#### Read this before writing any of it: beds are fungible

Three separate defects were found in this one interaction while the plan was being reviewed, each in the fix for the last. All three shared a root cause: **a bed gate that asked "which houses have room right now?"** That question depends on how far the homing phase has got, and the two systems that create colonists sit on opposite sides of it — `CommandSystem` runs before homing, `tryBirth` runs after, and a spawned entity is invisible to every query until the post-step sync.

The fix is to stop asking it. Every living colonist needs exactly one bed and beds are interchangeable, so:

```
freeBeds = (beds in non-relocating houses) − population − pendingArrivals
```

This is **independent of homing state**, which is what makes it correct from either side of the phase. Both gates use it, and neither builds an occupancy map.

The bot-found scenario that broke the occupancy version: a house becomes visible with 4 beds and 4 already-homeless colonists. An occupancy view sees 4 empty beds and admits a nomad; `rehome` then houses all 4 homeless, and five colonists reference a four-bed house. Under the rule above, `4 − 4 − 0 = 0`, and the nomad is correctly refused.

Two places consume it:

```ts
/** Beds nobody living has a claim on. See the note above — this deliberately
 * does not ask which house has room, because that answer changes across the
 * homing phase and the two callers sit on opposite sides of it. */
export function freeBeds(
  shelters: readonly ShelterRow[],
  population: number,
  pending: PendingChanges,
): number {
  const total = shelters
    .filter((s) => !s.relocating && !pending.demolished.has(s.id))
    .reduce((sum, s) => sum + s.beds, 0);
  return total - population - pending.arrivals.length;
}

/** Which house an arrival moves into, given what is already spoken for.
 * Ascending id, like every other assignment order here, so it is
 * reproducible. Only ever called once `freeBeds` has confirmed one exists. */
export function shelterWithRoom(
  shelters: readonly ShelterRow[],
  claimed: ReadonlyMap<number, number>,
  pending: PendingChanges,
): number | null {
  // Fold pending arrivals in HERE rather than trusting each caller to merge
  // them. Two recruitWorker commands can drain in one tick, and
  // CommandContext.occupancy() cannot see the first nomad — so a caller
  // passing only visible occupancy would hand both the same lowest-id house
  // and overfill it while another still had room. Counting them in the one
  // place that answers "which house has room" means no caller can forget.
  const spokenFor = new Map(claimed);
  for (const { home } of pending.arrivals) {
    if (home.buildingId !== null) spokenFor.set(home.buildingId, (spokenFor.get(home.buildingId) ?? 0) + 1);
  }
  for (const shelter of [...shelters].sort((a, b) => a.id - b.id)) {
    // Both exclusions, or a nomad drained on the same tick as a demolition
    // gets a bed in a house that vanishes at the sync.
    if (shelter.relocating || pending.demolished.has(shelter.id)) continue;
    if ((spokenFor.get(shelter.id) ?? 0) < shelter.beds) return shelter.id;
  }
  return null;
}
```

Both helpers take `PendingChanges` rather than a bare count precisely so the demolition exclusion cannot be forgotten at one call site — the failure mode that produced this whole family of bugs.

**An arrival names its bed, and `rehome` must honour that.** Neither arrival is homed on its own tick — a nomad is invisible to `PopulationSystem`, a birth happens after homing — so each passes a `homeId` into `colonistComponents` and pushes `{ homeId }` onto the ledger. `rehome` then counts pending arrivals against their houses when computing per-shelter room, or it will fill the very bed an arrival reserved.

`PendingChanges` is already registered (Task 6). `CommandContext` gains two things `handleRecruitWorker` needs, both built in `command-system.ts` from query rows it already materialises: `shelters: ShelterRow[]` (the same shape `PopulationContext` uses) and `occupancy(): Map<number, number>`, counting colonists per `home.buildingId`. `nomadGate()` derives its `freeBeds` from the same `freeBeds(ctx.shelters, population, ctx.pending)` helper, so the gate and the bed it then picks cannot disagree.

**Pin the invariant, not just the three known cases.** All three defects violated one property, and a property test catches the next variant:

```ts
it('never ends a tick with more colonists housed than beds', async () => {
  // Property, not scenario. The three bugs found in review were all
  // different routes to the same broken state; a case-by-case test would
  // have caught whichever one it was written for.
  // Three houses, twelve beds, a well-fed roster, and cooldowns already
  // expired — so beds are the only thing arrivals can contend for, which is
  // what this property is about.
  const save = { ...initialSave(), workers: [], buildings: [], stockpile: { bread: 100_000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const spots = autoPlaceSequence(save.map);
  for (let i = 0; i < 3; i++) {
    const at = spots.next().value!;
    spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row });
  }
  for (let i = 0; i < 4; i++) spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks });
  const world = await prep.prepareRun();
  world.getResource(SimClock).tick = 1000;
  for (let t = 0; t < 600; t++) {
    if (t % 7 === 0) enqueue(world, { type: 'recruitWorker' });   // contend for beds
    await stepTick(world);   // refreshes entity sections — arrivals must be visible
    const snap = world.getResource(SnapshotStore).latest!;
    expect(snap.beds.occupied).toBeLessThanOrEqual(snap.beds.total);
    const perHouse = new Map<number, number>();
    for (const c of snap.colonists) {
      if (c.homeId !== null) perHouse.set(c.homeId, (perHouse.get(c.homeId) ?? 0) + 1);
    }
    for (const house of snap.buildings.filter((b) => b.beds > 0)) {
      expect(perHouse.get(house.id) ?? 0).toBeLessThanOrEqual(house.beds);
    }
  }
}, 60000);
```

Then:

```ts
export function tryBirth(ctx: PopulationContext): void {
  if (ctx.ids.exhausted()) return; // silent: this is not a player action to refuse
  const rows = livingRows(ctx);
  // A nomad welcomed earlier this tick holds a bed and eats, but is not in
  // `rows` yet — count them, or both arrivals take the same last bed.
  // Count only, and only for the population total — the bed maths below takes
  // the whole object.
  const pending = ctx.pending.arrivals.length;
  const blocker = birthBlocker({
    stock: ctx.stockpile.toJSON(),
    weights: MEAL_WEIGHTS,
    population: rows.length + pending,
    adults: rows.filter((row) => stageOf(row.age.ticks, BALANCE.lifeBands) === 'adult').length,
    // The OBJECT, not the count: freeBeds reads `.demolished` as well as
    // `.arrivals`, and passing the number back would silently drop the
    // demolition exclusion — the exact "changed at one site of N" failure
    // this helper's signature exists to prevent.
    freeBeds: freeBeds(ctx.shelters, rows.length, ctx.pending),
    tick: ctx.clock.tick,
    lastBirthTick: ctx.clock.lastBirthTick,
    cooldown: BALANCE.birthCooldownTicks,
    perHead: BALANCE.birthFoodPerHead,
  });
  if (blocker !== null) return;
  ctx.clock.lastBirthTick = ctx.clock.tick;
  const id = ctx.ids.take();
  // Born INTO a bed. The homing phase already ran this tick, so a child
  // spawned without a homeId would spend its first tick homeless while the
  // bed the gate just counted against still read free.
  const claimed = new Map<number, number>();
  for (const row of rows) {
    if (row.home.buildingId !== null) claimed.set(row.home.buildingId, (claimed.get(row.home.buildingId) ?? 0) + 1);
  }
  // No pending merge here: shelterWithRoom folds ctx.pending.arrivals in
  // itself, and doing it twice would double-count this tick's nomad.
  const homeId = shelterWithRoom(ctx.shelters, claimed, ctx.pending);
  const components = colonistComponents({ id, ageTicks: 0, homeId });
  ctx.spawn(...components);
  ctx.pending.arrivals.push({ home: components.find((c): c is Home => c instanceof Home)! });
  ctx.notices.succeed(`Colonist #${id} was born.`);
}
```

`PopulationSystem` calls `ctx.pending.clear()` after `tryBirth` — by the next tick the real entities are in the query, so counting them again would double the arrivals and keep a demolished house excluded forever — and `PopulationContext` gains `pending: PendingChanges`.

Pin the interaction — this is the whole reason the ledger exists:

```ts
it('a nomad welcomed before a demolition does not keep a home in the demolished house', async () => {
  // REVERSE command order from the test below, and the ordering is the whole
  // point: recruitWorker spawns a deferred colonist that CommandSystem's own
  // worker query cannot see, so the demolition drained moments later walks
  // right past it. Left unevicted, the tick's autosave writes a homeId naming
  // a building that no longer exists, and the v5 load guard refuses the save.
  const save = { ...initialSave(), workers: [], buildings: [], stockpile: { bread: 5000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
  const houseId = house.getComponent(Building)!.id;
  spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, homeId: houseId });
  const world = await prep.prepareRun();
  world.getResource(SimClock).tick = 1000;   // cooldowns long expired

  enqueue(world, { type: 'recruitWorker' }, { type: 'demolishBuilding', buildingId: houseId });
  await stepTick(world);

  const snap = world.getResource(SnapshotStore).latest!;
  expect(snap.buildings.find((b) => b.id === houseId)).toBeUndefined();  // the house really went
  expect(snap.colonists).toHaveLength(2);                                 // the nomad really arrived
  for (const c of snap.colonists) expect(c.homeId).toBeNull();            // and NOBODY points at it
  // The save the autosave would write must load, not take the backup path.
  expect(isLoadableSave(buildSaveFromWorld(world))).toBe(true);
});

it('a nomad and a birth cannot take the same last bed', async () => {
  // One house, 4 beds, 3 colonists: exactly one bed free, and the food and
  // cooldown gates are both clear so ONLY the bed is in contention.
  // `workers: []`, not `colonists: []` — the save is still v4 at this task and
  // its roster key is `workers`. Setting the wrong key leaves initialSave()'s
  // three founders in place, so this "3 colonists, 4 beds" colony would
  // actually start with 6 (ids 1-3 duplicated) and already over capacity,
  // rejecting the nomad for a reason the test does not name. Task 9 renames
  // the key; until then every pre-v5 fixture here clears `workers`.
  const save = { ...initialSave(), workers: [], buildings: [], stockpile: { bread: 5000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
  const houseId = house.getComponent(Building)!.id;
  for (const id of [1, 2, 3]) spawnColonist(prep, ids, { id, ageTicks: BALANCE.lifeBands.matureTicks, homeId: houseId });
  const world = await prep.prepareRun();
  world.getResource(SimClock).tick = 1000;   // both cooldowns long expired

  enqueue(world, { type: 'recruitWorker' });
  await stepTick(world);

  const snap = world.getResource(SnapshotStore).latest!;
  expect(snap.colonists).toHaveLength(4);          // the nomad, and NOT also a child
  expect(snap.homeless).toBe(0);                    // nobody ended the tick over capacity
  expect(snap.beds.occupied).toBeLessThanOrEqual(snap.beds.total);
});
```

`ctx.stockpile.toJSON()` already returns `Partial<Record<ResourceId, number>>` — use it rather than adding a second accessor. Import `MEAL_WEIGHTS` from `../content/resources` and `birthBlocker`/`stageOf` from `../../shared/population`. Call `tryBirth(ctx)` last in `population-system.ts`.

- [ ] **Step 7: Re-gate recruiting as a nomad arrival**

Replace the body of `handleRecruitWorker` in `src/engine/systems/command-handlers.ts`:

```ts
export function handleRecruitWorker(ctx: CommandContext): void {
  // Checked BEFORE the cooldown write: a refused recruit must not start it.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const blocker = nomadBlocker(ctx.nomadGate());
  if (blocker !== null) {
    ctx.notices.reject(NOMAD_REJECTIONS[blocker]);
    return;
  }
  ctx.clock.lastRecruitTick = ctx.clock.tick;
  const id = ctx.ids.take();
  // Take the bed AND record the arrival. Both matter, for the same reason:
  // this entity does not exist to any query until the post-step sync, so
  // PopulationSystem — which runs later this very tick — would otherwise see
  // the bed as free and let tryBirth hand it to a child as well. The tick
  // would end with five colonists in four beds and the nomad homeless.
  const homeId = shelterWithRoom(ctx.shelters, ctx.occupancy(), ctx.pending);
  const components = colonistComponents({
    id,
    homeId,
    ageTicks: BALANCE.nomadArrivalTicks + spreadFor(id, BALANCE.lifeBands.spreadTicks, SALT.arrivalAge),
  });
  ctx.spawn(...components);
  // The live Home, so a demolition LATER IN THIS TICK can still evict it.
  ctx.pending.arrivals.push({ home: components.find((c): c is Home => c instanceof Home)! });
  ctx.notices.succeed(`Colonist #${id} joined the colony.`);
}

/** One message per gate, so the rejection the engine emits and the reason the
 * button shows come from the same enumeration. */
const NOMAD_REJECTIONS: Record<Exclude<PopulationBlocker, null>, string> = {
  noBed: 'No free bed: build a house first.',
  notEnoughFood: 'Not enough food stored to feed another colonist.',
  cooldown: 'No one is passing through just yet.',
  noParents: 'No one is passing through just yet.', // unreachable: nomadBlocker never returns it
};
```

`CommandContext` gains `nomadGate: () => NomadGate`, built in `command-system.ts` from the same query rows.

- [ ] **Step 8: Publish `mealsPerHead`**

Add `mealsPerHead: number` to `Snapshot` — and compute it **inside `buildEntitySections`**, not in `SnapshotSystem`.

That placement is the whole point. `SnapshotSystem` runs before the post-step sync, so on any tick with a birth, a nomad, or a death, `refreshEntitySections` afterwards replaces the population sections while leaving a separately-computed `mealsPerHead` holding the *old* denominator. A paused manual step would then display the new population against the previous tick's ratio indefinitely, and Task 12's samples would record a food ratio for a colony size that no longer exists. Computing it beside `population`, `demographics` and `beds` — the other cross-entity aggregates — means it is refreshed by the same pass that changes what it divides by.

`buildEntitySections` therefore takes the stockpile as a third argument: `SnapshotSystem` and `refreshEntitySections` pass `stockpile.toJSON()`, `buildInitialSnapshot` passes `save.stockpile`. Keeping the value and its denominator in one function is what stops them disagreeing.

- [ ] **Step 9: Write the engine-level birth test**

Append to `tests/engine/systems/population-system.test.ts`:

```ts
it('births a child when fed and housed, then holds off for the cooldown', async () => {
  const save = { ...initialSave(), workers: [], stockpile: { bread: 1000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3 });
  spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
  spawnColonist(prep, ids, { id: 2, ageTicks: BALANCE.lifeBands.matureTicks });
  const world = await prep.prepareRun();
  const step = () => stepTick(world);
  const count = () => world.getResource(SnapshotStore).latest!.colonists.length;

  await step();  // tick 1: homing runs, then a birth
  expect(count()).toBe(3);
  for (let i = 0; i < BALANCE.birthCooldownTicks - 1; i++) await step();
  expect(count()).toBe(3);   // still on cooldown, and the 4th bed is free
  await step();
  expect(count()).toBe(4);   // cooldown expired, bed still free
  await step();
  expect(count()).toBe(4);   // beds full now: noBed, not cooldown
});
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 11: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/shared/population.ts "$SP/population.ts"
cp src/engine/systems/population-handlers.ts "$SP/population-handlers.ts"

# population + 1 is what closes the empty-store hole
sed -i 's|return mealsInStore(stock, weights) / (population + 1);|return population === 0 ? Number.POSITIVE_INFINITY : mealsInStore(stock, weights) / population;|' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "wiped-out colony with an empty store"   # expect FAIL
cp "$SP/population.ts" src/shared/population.ts

# The weights must actually differ per resource
sed -i 's|meals += (stock\[id\] ?? 0) \* weight;|meals += (stock[id] ?? 0);|' src/shared/population.ts
npx vitest run tests/shared/population.test.ts -t "weights each edible"                    # expect FAIL
cp "$SP/population.ts" src/shared/population.ts

# The birth cooldown must be written when a birth happens
sed -i 's|  ctx.clock.lastBirthTick = ctx.clock.tick;||' src/engine/systems/population-handlers.ts
npx vitest run tests/engine/systems/population-system.test.ts -t "holds off for the cooldown"  # expect FAIL
cp "$SP/population-handlers.ts" src/engine/systems/population-handlers.ts
```

All three must fail.

- [ ] **Step 12: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(engine): births, and the recruit button becomes a nomad gate

Food is measured in meals — weights derived from what each edible actually
restores, so a hunger retune cannot desync them — and both gates divide by
population + 1. That is the honest question ('can the store feed them once
they are here?') and it removes a special case with a hole in it: dividing
by the current population needs zero treated as unbounded, and unbounded
lets an EMPTY store admit a nomad.

SimClock gains lastBirthTick, persisted in Task 9 for the reason
lastRecruitTick is: without it a reload changes population growth."
```

---

### Task 9: Save v5

**Files:**
- Modify: `src/shared/save.ts` (`SavedColonistV4`, `SavedColonist`, `SaveGameV5`, `isSaveGameV5`, `LATEST_SAVE_VERSION`)
- Modify: `src/shared/save-migration.ts` (`migrateV4toV5`)
- Modify: `src/engine/world.ts` (`initialSave` + the starter house, guards, `buildInitialSnapshot`)
- Modify: `src/engine/save-guard.ts`, `src/engine/snapshot-builder.ts` (`savedColonistOf`)
- Modify: `src/engine/game-engine.ts` — **the serializer and its whole API surface**
- Test: `tests/shared/save-migration.test.ts`, `tests/engine/save.test.ts`

**`game-engine.ts` is not optional and is easy to miss.** Six declarations there name `SaveGameV4`: `buildSaveFromWorld`'s return type, `serialize()`, `autosaveListener`, `onAutosave`, `GameEngine.create`'s parameter, and the import. The serializer also emits a `workers` key. Leave them and the v5 object stops satisfying its own declared return type, the round-trip test cannot read `round.colonists` or `round.lastBirthTick`, and autosave keeps writing v4 records. Retype all six to the current save type, emit `colonists`, and persist `lastBirthTick`. Check the Obsidian storage path in `src/main.ts` and `src/view/` for the same annotation.

**Interfaces:**
- Consumes: everything from Tasks 3, 4, 6, 8.
- Produces:
  - `SavedColonistV4` (frozen: the v3-and-v4 record shape), `SavedColonist` (v5: adds `ageTicks`, `homeId`, `starvingTicks`)
  - `SaveGameV5 { version: 5; …; lastBirthTick: number; colonists: SavedColonist[] }`
  - `LATEST_SAVE_VERSION = 5`
  - `STARTER_HOUSE` placement in `initialSave()`

- [ ] **Step 1: Write the failing test**

Append to `tests/shared/save-migration.test.ts`:

```ts
/** A minimal, guard-valid v4 save: three workers, one forester, no houses. */
function v4WithThreeWorkers(): SaveGameV4 {
  return {
    version: 4,
    tick: 5000,
    lastRecruitTick: 4000,
    stockpile: { wood: 40, berries: 30 },
    map: { cols: 24, rows: 16 },
    buildings: [{
      id: 1, defId: 'forester', col: 4, row: 1,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    }],
    workers: [
      { id: 2, hunger: 10, buildingId: 1, toolTicks: 0, hauling: false },
      { id: 3, hunger: 20, buildingId: null, toolTicks: 0, hauling: false },
      { id: 4, hunger: 30, buildingId: null, toolTicks: 0, hauling: true },
    ],
    nextEntityId: 5,
  };
}

it('v4 -> v5: colonists become adults, a starter house appears, and its beds are already assigned', () => {
  const v5 = migrateSaveToLatest(v4WithThreeWorkers()) as SaveGameV5;
  expect(v5.version).toBe(5);

  // Adults, staggered — not all the same age, or they die together.
  const ages = v5.colonists.map((c) => c.ageTicks);
  expect(new Set(ages).size).toBeGreaterThan(1);
  for (const age of ages) expect(age).toBeGreaterThanOrEqual(BALANCE.lifeBands.matureTicks);

  // The house exists AND its residents are already written into the record.
  const house = v5.buildings.find((b) => b.defId === 'house');
  expect(house).toBeDefined();
  const homed = v5.colonists.filter((c) => c.homeId === house!.id);
  expect(homed).toHaveLength(3);

  expect(v5.lastBirthTick).toBe(-MIGRATION_CONSTANTS.birthCooldownTicks);
  expect(v5.colonists.every((c) => c.starvingTicks === 0)).toBe(true);
});

it('a migrated colony is housed in the SEEDED snapshot, before any tick runs', () => {
  // buildColonyPrepWorld seeds the initial snapshot straight from the save and
  // a restored engine starts paused, so relying on the homing phase would show
  // a wholly homeless colony at penalty work power until the player unpauses.
  const v5 = migrateSaveToLatest(v4WithThreeWorkers()) as SaveGameV5;
  const prep = buildColonyPrepWorld({ save: v5, systems: ALL_SYSTEMS });
  const seeded = getPrepResource(prep, SnapshotStore).latest!;
  expect(seeded.homeless).toBe(0);
});
```

Append to `tests/engine/save.test.ts`:

```ts
it('round-trips a mid-starvation, mid-cooldown colony', async () => {
  // Both are penalties already incurred: dropping either would let
  // save-and-reload cancel it.
  const save: SaveGameV5 = { ...initialSave(), tick: 910, lastBirthTick: 900 };
  save.colonists = save.colonists.map((c, i) => (i === 0 ? { ...c, starvingTicks: 40 } : c));
  const world = await createColonyWorld(save);
  const round = buildSaveFromWorld(world);

  expect(round.colonists.find((c) => c.id === save.colonists[0].id)!.starvingTicks).toBe(40);
  expect(round.lastBirthTick).toBe(900);
  // Discriminating: a second colonist's clock must NOT have picked up the 40,
  // or this would pass with starvingTicks written from a single shared value.
  expect(round.colonists.find((c) => c.id === save.colonists[1].id)!.starvingTicks).toBe(0);
});
```

`buildSaveFromWorld` and `createColonyWorld` are already imported by that file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared/save-migration.test.ts tests/engine/save.test.ts`
Expected: FAIL — `LATEST_SAVE_VERSION` is 4 and `SaveGameV5` does not exist.

- [ ] **Step 3: Add the v5 shapes**

In `src/shared/save.ts`:

```ts
/**
 * The v3-and-v4 colonist record.
 *
 * `ageTicks` and `starvingTicks` are OPTIONAL here, and that is not an
 * oversight: Tasks 3 and 4 added them to the live v4 record so an in-progress
 * lifespan or starvation would survive a save before v5 existed. A v4 file
 * written by any build from Task 3 onward therefore carries them, while one
 * written earlier does not — optional is exactly that shape. Declaring them
 * absent would also break the v4->v5 migration below, which reads both to
 * avoid discarding them.
 */
export interface SavedColonistV4 {
  id: number;
  hunger: number;
  buildingId: number | null;
  toolTicks: number;
  hauling: boolean;
  ageTicks?: number;
  starvingTicks?: number;
}

/**
 * The current record (save v5): `homeId` is new, and the two transitional
 * fields above are promoted from optional to REQUIRED — v5 always writes
 * them, so nothing downstream needs a fallback.
 */
export interface SavedColonist extends Omit<SavedColonistV4, 'ageTicks' | 'starvingTicks'> {
  ageTicks: number;
  homeId: number | null;
  starvingTicks: number;
}

export interface SaveGameV5 extends Omit<SaveGameV4, 'version' | 'workers'> {
  version: 5;
  /** Tick of the last birth — see SimClock.lastBirthTick. */
  lastBirthTick: number;
  colonists: SavedColonist[];
}

export const LATEST_SAVE_VERSION = 5;
```

Change `SaveGameV4.workers` to `SavedColonistV4[]`.

**`isSaveGameV5` cannot simply mirror `isSaveGameV4` — the shared guard hard-codes the roster key.** `isValidSaveArrays` (`src/shared/save.ts:176`) checks `save.workers` by name, and `isCommonSaveShape` calls it for **every** version guard. A v5 save has `colonists` and no `workers` at all, so a mirrored guard would reject every v5 save ever written, *including `migrateV4toV5`'s own output* — the migration would run, its result would fail `guards[5]`, and `migrateSaveToLatest` would return null, sending every existing colony to the corrupt-save backup path. Nothing downstream would catch this: the failure is total and silent.

Parameterise the key instead of duplicating the guard:

```ts
function isValidSaveArrays(save: Record<string, unknown>, rosterKey: 'workers' | 'colonists', isRecord: (r: unknown) => boolean): boolean {
  const roster = save[rosterKey];
  return (
    Array.isArray(save.buildings) &&
    save.buildings.length <= MAX_SAVED_ENTITIES &&
    Array.isArray(roster) &&
    roster.length <= MAX_SAVED_ENTITIES &&
    roster.every(isRecord)
  );
}
```

`isCommonSaveShape` takes and forwards both. v1–v4 pass `'workers'` and the existing record predicate; v5 passes `'colonists'` and a new `isSavedColonistShape` that additionally requires `ageTicks` and `starvingTicks` to be safe non-negative integers and `homeId` to be `number | null`. Then add `lastBirthTick` to `isSaveGameV5` with the same treatment `lastRecruitTick` gets (safe integer, not ahead of `tick`).

**A `homeId` must name a shelter, and a `buildingId` must name a producer.** Add both to `isLoadableSave`, because they are one rule seen from two sides — a colonist lives in a house and works at a workshop, and neither reference may point at the other kind.

- Every non-null `homeId` names a building present in the save **whose def has `beds > 0`**. A `homeId` pointing at a forester is a record no engine version could write.
- Every non-null `buildingId` names a building **whose def has a `recipe`**. Today the guard only checks the id exists, so a save assigning a colonist to a house is accepted — and the result is permanent and silent: the colonist publishes as `1 / 0` workers on a zero-slot building, drops out of `idleAdults`, and produces nothing forever, because `ProductionSystem` skips recipe-less buildings. No command can create that assignment, which is exactly what makes it structural rather than balance-coupled.

Both are the guard's stated criterion — reject only what no engine version could have written — as distinct from the over-capacity case below, which a retune *can* produce legitimately and so is repaired instead.

**But over-capacity is NOT rejected — it is repaired, at load.** The repair belongs in the shared spawn/seed path (`colonistComponents` and `buildInitialSnapshot`), not only in `rehome`: a restored engine is paused until the player advances it, so a repair that waits for the first tick leaves the seeded snapshot advertising a state the engine will immediately revoke.

The rule itself: A save with five colonists in a four-bed house is exactly what a `houseBeds` retune from 5 to 4 produces, and rejecting it would orphan a save for a balance change, which this project's load principle forbids ("balance-coupled values are clamped or grandfathered on load"). So `rehome` **evicts the excess** instead: when a house's occupancy exceeds its beds, the highest colonist ids lose their home and re-enter the homeless pool for reassignment. Deterministic, and it repairs both the retune case and any hand-edited save through the same path.

```ts
it('evicts down to capacity when a save puts more colonists in a house than it has beds', async () => {
  // What a houseBeds retune from 5 to 4 produces. Rejecting would orphan the
  // save for a balance change; the load principle says clamp, not refuse.
  const save = saveWithColonistsInOneHouse({ beds: BALANCE.houseBeds, colonists: BALANCE.houseBeds + 1 });
  const world = await createColonyWorld(save);

  // BEFORE any tick. A restored engine starts paused, and the initial
  // snapshot is seeded straight from the save — so leaving the repair to
  // rehome would display five residents in a four-bed house, zero homeless,
  // and work power based on assignments the engine is about to revoke, for as
  // long as the player leaves it paused. Normalize at load, exactly as the v5
  // migration writes its home assignments rather than deferring them.
  const seeded = world.getResource(SnapshotStore).latest!;
  const seededHouse = seeded.buildings.find((b) => b.beds > 0)!;
  expect(seededHouse.occupants).toBe(BALANCE.houseBeds);
  expect(seeded.homeless).toBe(1);

  await stepTick(world);
  const snap = world.getResource(SnapshotStore).latest!;
  const house = snap.buildings.find((b) => b.beds > 0)!;
  expect(house.occupants).toBe(BALANCE.houseBeds);
  expect(snap.homeless).toBe(1);              // the surplus, not silently over capacity
});
```

**A non-adult holding a job is the SAME repair, at the same place, for the
same reason.** Over-capacity housing is not the only balance-coupled state a
save can arrive in. Raise `matureTicks` in a retune and an existing save
restores a colonist who is now a child but still carries a `buildingId`;
lower `retireTicks`, or clamp an over-long `ageTicks` down to
`MAX_AGE_TICKS`, and it restores an elder holding one. `standDownNonAdults`
repairs it — but only on the first tick, and `buildInitialSnapshot` copies
`buildingId` and `hauling` straight from the record while computing `stage`
right beside them without consulting it (`src/engine/world.ts`, the
`workerFacts` map). Paused, the seeded snapshot therefore shows a child
staffing a building, counted in `workers` and contributing to `workPower`,
for as long as the player leaves it there.

Clear `buildingId` and `hauling` for any colonist whose `stageOf(ageTicks,
BALANCE.lifeBands)` is not `'adult'`, in `colonistComponents` **and** in
`buildInitialSnapshot` — the same two places the over-capacity repair lands,
so the seed keeps matching the entity `buildColonyPrepWorld` actually spawns.
Repaired, not rejected: only a retune produces it, and the load principle
clamps balance-coupled values rather than orphaning the save. Contrast the
two structural rules above, which no engine version could have written.

Note what this must NOT do to the existing tests. Nothing in the suite
currently spawns a pre-invalid child-with-a-job — `population-system.test.ts`
builds its stand-down case honestly, spawning an adult at
`retireTicks - 1` **with** a job and aging them across the boundary during
the run. Keep it that way. A test that spawned a non-adult already holding a
job to prove `standDownNonAdults` clears it would become vacuous the moment
this repair lands, and would then pass forever without exercising anything.

```ts
it('a retune that raises matureTicks does not seed a child as staff', async () => {
  // Only a retune can produce this record, so it is repaired rather than
  // rejected. Asserted BEFORE any tick: standDownNonAdults would fix it on
  // tick 1, and a paused engine never reaches tick 1.
  const save = saveWithColonist({ ageTicks: BALANCE.lifeBands.matureTicks - 1, buildingId: FORESTER_ID });
  const world = await createColonyWorld(save);

  const seeded = world.getResource(SnapshotStore).latest!;
  expect(seeded.colonists[0].buildingId).toBeNull();
  expect(seeded.buildings.find((b) => b.id === FORESTER_ID)!.workers).toBe(0);
  expect(seeded.buildings.find((b) => b.id === FORESTER_ID)!.workPower).toBe(0);
});
```

- [ ] **Step 4: Write the migration**

In `src/shared/save-migration.ts`:

```ts
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
 * Ages are staggered by id under a salt distinct from the lifespan draw's, or
 * the two jitters cancel and every founder dies on the same tick anyway.
 * BALANCE is not importable here, so the numbers arrive as literals matching
 * spec 4 — a divergence would only make migrated colonies slightly older or
 * younger, never unloadable, and the guard catches anything structural.
 */
const migrateV4toV5: MigrationStep = {
  from: 4,
  to: 5,
  migrate: (save) => {
    const v4 = save as SaveGameV4;
    const occupied = v4.buildings.map((b) => ({ col: b.col, row: b.row }));
    // Grow the map if the colony has filled it. Without this, a v4 save with
    // every buildable tile occupied silently gets NO starter house and every
    // colonist loads homeless — the precise outcome this migration exists to
    // prevent, reached through the one branch that quietly does nothing.
    //
    // Grown from v4.map, NOT from mapThatFits(count): that helper derives a
    // shape from DEFAULT_MAP and would hand a full 50x6 colony a 24-column
    // map, stranding every building at column 24+ outside the persisted
    // bounds — isPositionsValid then rejects the migration and a valid save
    // takes the corrupt-backup path. Existing dimensions are a floor, never
    // a starting point to be replaced.
    const map = { ...v4.map };
    while (v4.buildings.length >= (map.cols - CAMP_COLS) * map.rows) {
      if (map.rows < MAX_MAP.rows) map.rows += 1;
      else if (map.cols < MAX_MAP.cols) map.cols += 1;
      else break; // unreachable — see the capacity proof below the loop
    }
    const at = autoPlacePosition(map, occupied);
    // The smallest unused positive id, NOT max + 1. A guard-valid v4 save may
    // sit at nextEntityId === MAX_SAVED_COUNTER — IdCounter.exhausted() exists
    // precisely to keep such a save playable — and max + 1 would push
    // nextEntityId past the ceiling, so isIdsValid would reject a previously
    // valid save straight into the corrupt-backup path. The arrays hold at
    // most 20,000 records, so a gap below the ceiling always exists.
    const used = new Set([...v4.buildings.map((b) => b.id), ...v4.workers.map((w) => w.id)]);
    let houseId = 1;
    while (used.has(houseId)) houseId++;
    const house = at === null ? null : {
      id: houseId, defId: 'house' as const, col: at.col, row: at.row,
      progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
    };
    const colonists = [...v4.workers].sort((a, b) => a.id - b.id).map((w, index) => ({
      ...w,
      // Keep an age the save already carries. Task 3 made `savedColonistOf`
      // write the optional `ageTicks` onto v4 records, so a colony saved by
      // any build after that point holds real accumulated ages — and
      // overwriting them would hand every colonist a fresh founder age,
      // postponing retirement and death by thousands of ticks purely because
      // the save was upgraded. Synthesize only for genuinely legacy records
      // that never had the field.
      ageTicks: w.ageTicks ?? MIGRATION_CONSTANTS.startingAgeTicks + jitter(w.id),
      homeId: house !== null && index < MIGRATION_CONSTANTS.houseBeds ? houseId : null,
      // Preserved for the same reason as `ageTicks` above, and it became true
      // for the same reason: Task 4's fix pass made `savedColonistOf` write
      // the optional `starvingTicks` onto v4 records too. Zeroing it here
      // would cancel up to 99 ticks of incurred starvation purely because the
      // save crossed a version boundary — the exact defect persisting the
      // field was meant to close. `?? 0` still covers genuinely legacy
      // records that never carried it.
      starvingTicks: w.starvingTicks ?? 0,
    }));
**Why `break` and `at === null` are both unreachable, and why the code keeps
them anyway.** A reviewer has twice read the no-house path as a live
regression — a migrated colony loading wholly homeless with no tile left to
build on. It cannot happen, and the arithmetic is worth writing down once so
the next reader does not have to re-derive it:

- `MAX_SAVED_ENTITIES` is 10,000 (`src/shared/save.ts`), and the structural
  guard rejects any save whose `buildings` array exceeds it. So a
  guard-valid v4 save holds at most 10,000 buildings.
- `MAX_MAP` is 256×256, and the camp band costs three columns, so the
  buildable area tops out at `(256 - 3) * 256 = 64,768` tiles.
- The growth loop therefore exits on its condition — 10,000 is never `>=`
  64,768 — with at least 54,768 free tiles in the worst admissible case.
  The `break` arm never runs.
- `isPositionsValid` already guarantees every saved building sits in bounds,
  at `col >= CAMP_COLS`, on a tile no other building shares. Occupied tiles
  are thus a subset of buildable ones, so free tiles are exactly
  `buildable - buildings.length`, and `autoPlacePosition`'s row-major
  fallback scan sweeps the whole `col >= CAMP_COLS` region. It cannot return
  null when free tiles exist.

Keep both branches regardless: they are total-function hygiene, not dead
weight, and the bound they depend on lives in a different file from the
loop that relies on it. Retune `MAX_SAVED_ENTITIES` upward or `MAX_MAP`
downward and the arm becomes live — at which point loading homeless with a
grown map is still the correct outcome, because the alternative is a
migration that demolishes the player's buildings to make room for a house
they did not ask for. Do NOT add a fallback that invents a tile: a house
placed at `col < CAMP_COLS` fails `isPositionsValid` and sends the whole
save down the corrupt-backup path, which is strictly worse than loading it
homeless. And homeless is recoverable by the player — demolishing one
building frees a tile and the next homing pass rehouses everyone, which is
precisely the decision this increment is about.

    const { workers: _dropped, ...rest } = v4;
    return {
      ...rest,
      version: 5,
      // The sentinel, not 0. "Any migrated colony is already past the
      // cooldown" is false for a v4 save written before tick 50 — a tick-0
      // colony would have its first otherwise-eligible birth blocked purely
      // because it was reopened, which is the save-alters-growth defect
      // lastBirthTick exists to prevent.
      lastBirthTick: -MIGRATION_CONSTANTS.birthCooldownTicks,
      map,
      buildings: house === null ? v4.buildings : [...v4.buildings, house],
      colonists,
      // Never raised past what the save already claims: houseId fills a GAP
      // below the ceiling, so the counter does not need to move at all.
      // Safe now that houseId fills a gap: with at most 20,000 records the
      // smallest unused id is at most 20,001, so this can never push the
      // counter near MAX_SAVED_COUNTER.
      nextEntityId: Math.max(v4.nextEntityId, houseId + 1),
    };
  },
};

/**
 * BALANCE values this migration needs but cannot import — `src/shared/**` may
 * import nothing outside itself, and the plan's own Global Constraints say
 * balance constants live only in `src/engine/content/balance.ts`. The
 * duplication is forced, so every one of these is PINNED against its real
 * counterpart by a content test rather than trusted. An unpinned duplicate
 * would drift silently and house or age a migrated colony differently from a
 * fresh one, for no stated reason.
 */
export const MIGRATION_CONSTANTS = {
  houseBeds: 4,           // BALANCE.houseBeds
  startingAgeTicks: 2500, // BALANCE.startingAgeTicks
  spreadTicks: 800,       // BALANCE.lifeBands.spreadTicks
  birthCooldownTicks: 50, // BALANCE.birthCooldownTicks
} as const;

/** Starting-age jitter, decorrelated from the lifespan draw by its salt.
 * src/shared/population.ts is importable from here (both are src/shared), so
 * the hash is imported rather than copied. */
const jitter = (id: number) => spreadFor(id, MIGRATION_CONSTANTS.spreadTicks, SALT.startingAge);
```

Import `spreadFor` and `SALT` from `./population`, and `autoPlacePosition`, `CAMP_COLS` and `MAX_MAP` from `./placement`, register `migrateV4toV5` in `SAVE_MIGRATIONS`, and add `5: isSaveGameV5` to `SAVE_GUARDS`.

Pin every duplicated constant against its real counterpart in `tests/engine/content.test.ts` — the test file that CAN import both sides:

```ts
it('the migration constants match the balance they duplicate', () => {
  // The duplication is forced — src/shared/save-migration.ts may not import
  // BALANCE — so each one is pinned instead of trusted. Drift here would age
  // or house a migrated colony differently from a fresh one, silently.
  expect(MIGRATION_CONSTANTS.houseBeds).toBe(BALANCE.houseBeds);
  expect(MIGRATION_CONSTANTS.startingAgeTicks).toBe(BALANCE.startingAgeTicks);
  expect(MIGRATION_CONSTANTS.spreadTicks).toBe(BALANCE.lifeBands.spreadTicks);
  expect(MIGRATION_CONSTANTS.birthCooldownTicks).toBe(BALANCE.birthCooldownTicks);
});
```

and add a migration test for the early-save case:

```ts
it('a v4 save written before the cooldown elapsed can still give birth immediately', () => {
  const early = { ...v4WithThreeWorkers(), tick: 0, lastRecruitTick: 0 };
  const v5 = migrateSaveToLatest(early) as SaveGameV5;
  // Discriminating: 0 would block a tick-0 colony's first birth for 50 ticks
  // purely because the save was reopened.
  expect(v5.lastBirthTick).toBeLessThanOrEqual(-BALANCE.birthCooldownTicks);
});

it('grows the map when a full v4 colony leaves no room for the starter house', () => {
  // The no-house branch is the one that fails silently: every colonist would
  // load homeless, which is exactly what this migration exists to prevent.
  const full = { ...v4WithThreeWorkers(), map: { cols: 8, rows: 6 } };
  full.buildings = Array.from({ length: (8 - 3) * 6 }, (_, i) => ({
    id: 100 + i, defId: 'forester' as const,
    col: 3 + (i % 5), row: Math.floor(i / 5),
    progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
  }));
  full.nextEntityId = 1000;
  const v5 = migrateSaveToLatest(full) as SaveGameV5;

  expect(v5).not.toBeNull();
  expect(v5.buildings.some((b) => b.defId === 'house')).toBe(true);
  expect(v5.colonists.some((c) => c.homeId !== null)).toBe(true);
});

it('grows a WIDE full map without stranding its buildings outside the new bounds', () => {
  // Discriminating: a 50-column colony. A count-derived shape would hand it a
  // 24-column map, put every building at column 24+ outside the persisted
  // bounds, and isPositionsValid would reject a perfectly valid save into the
  // corrupt-backup path. Existing dimensions are a floor, not a suggestion.
  const wide = { ...v4WithThreeWorkers(), map: { cols: 50, rows: 6 } };
  wide.buildings = Array.from({ length: (50 - 3) * 6 }, (_, i) => ({
    id: 100 + i, defId: 'forester' as const,
    col: 3 + (i % 47), row: Math.floor(i / 47),
    progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
  }));
  wide.nextEntityId = 1000;
  const v5 = migrateSaveToLatest(wide) as SaveGameV5;

  expect(v5).not.toBeNull();               // NOT the corrupt-backup path
  expect(v5.map.cols).toBeGreaterThanOrEqual(50);
  for (const b of v5.buildings) {
    expect(b.col).toBeLessThan(v5.map.cols);
    expect(b.row).toBeLessThan(v5.map.rows);
  }
});
```

- [ ] **Step 5: The starter house in a fresh colony**

In `src/engine/world.ts`'s `initialSave`, replace `buildings: []`:

```ts
  // The first pre-placed building in the game's history, and worth the
  // exception: a house costs planks, planks need a sawmill, and a colony that
  // opens with 30 wood cannot build one for a long time — so without this the
  // whole opening is spent at homelessFactor for reasons the player cannot act
  // on. With it, the pressure starts legibly: you are housed, you have one
  // spare bed, and the fourth colonist is the first thing you must build for.
  buildings: [{
    id: 1, defId: 'house', ...autoPlacePosition(DEFAULT_MAP, [])!,
    progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
  }],
  colonists: Array.from({ length: STARTING_COLONISTS }, (_, index) => ({
    id: index + 2,
    hunger: 0,
    buildingId: null,
    toolTicks: 0,
    hauling: false,
    ageTicks: BALANCE.startingAgeTicks + spreadFor(index + 2, BALANCE.lifeBands.spreadTicks, SALT.startingAge),
    homeId: 1,
    starvingTicks: 0,
  })),
  nextEntityId: STARTING_COLONISTS + 2,
  lastBirthTick: -BALANCE.birthCooldownTicks,
```

- [ ] **Step 6: Guards, clamps, and the seeded snapshot**

- `isLoadableSave`: add `lastBirthTick` to the same safe-integer / not-ahead-of-`tick` check `lastRecruitTick` gets; add a structural check that every `homeId` names a building present in the save (a dangling reference is a record no engine could write); reject negative or fractional `ageTicks` / `starvingTicks`.
- `buildColonyPrepWorld`: pass `ageTicks`, `homeId`, `starvingTicks` through to `spawnColonist`, and set `clock.lastBirthTick`.
- `buildInitialSnapshot`: read all three from the save through `clampedAge` / `clampedStarving`, and derive `stage`, `homeless`, `beds`, and `mealsPerHead` through `buildEntitySections` as the live path does.
- `savedColonistOf`: add the three fields.

**`runScenario` must stop inheriting `initialSave()`'s buildings.** Its fixture (`tests/support/balance-harness.ts:139-144`) spreads `initialSave()`, clears the roster and stockpile, and resets `nextEntityId` to 1 — but leaves `buildings` alone. That is harmless today because a fresh colony has none. The moment this task puts a starter house in `initialSave()`, two things break at once, silently:

- **Duplicate ids.** `nextEntityId: 1` means the harness's first `spawnBuilding` mints id 1, which the saved house already holds.
- **Stacked tiles.** `campAdjacentFreeTile` only avoids the tiles the harness itself placed, so it can put the hauler house directly on the saved starter house.

Either one corrupts the distance and relocation sweeps and Task 12's commute measurements — the numbers increment 5 pinned as this increment's regression net. Fix it in the same edit that adds the starter house, not afterwards:

```ts
  const save: SaveGameV5 = {
    ...initialSave(),
    // Both, and for different reasons. `colonists` because v5 renamed the
    // roster key — clearing `workers` would leave the real array untouched.
    // `buildings` because initialSave() now ships a starter house, whose id
    // and tile would collide with the ones this harness mints below.
    colonists: [],
    buildings: [],
    stockpile: seededStockpile as Partial<Record<ResourceId, number>>,
    nextEntityId: 1,
  };
```

Every other pre-v5 fixture in the suite that clears `workers: []` needs the same rename — `npm run typecheck` will not catch it, because an extra property on an object literal spread into a typed value is only an error when the literal is *directly* assigned. Grep for `workers: []` and convert each one.

**One transitional exemption comes due here.** It was added because an export had no cross-file consumer yet; this task is that consumer, so leaving it would permanently exempt live code from the gate that exists to catch it:

- `.fallowrc.json` — remove the `clampedStarving` entry from `ignoreExports`, and its note in `docs/build-ci/quality-gates.md`. Confirm `npm run check:quality` still reports `deadCodeIssues: 0` without it.

*(Task 4's fix pass already retired the other one: `ageTicks` and `starvingTicks` are both persisted on the optional v4 record and covered by the "live-world projections agree" guard, so there is no opt-out left to remove. v5 promotes both to required, which is a type change rather than new persistence.)*

**Commit both files by pathspec** — `.fallowrc.json` and `docs/build-ci/quality-gates.md` are outside `src`/`tests`, so a `git commit src tests` pathspec silently leaves them behind and the exemptions survive in the repo.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, including the existing v1→v4 chain tests now running v1→v5.

- [ ] **Step 8: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/shared/save-migration.ts "$SP/save-migration.ts"

# The migration must assign homes, not leave them to the first tick
sed -i 's|homeId: house !== null \&\& index < MIGRATION_CONSTANTS.houseBeds ? houseId : null,|homeId: null,|' src/shared/save-migration.ts
grep -q 'homeId: null,' src/shared/save-migration.ts || { echo "MUTATION DID NOT APPLY — fix the pattern"; exit 1; }
npx vitest run tests/shared/save-migration.test.ts -t "SEEDED snapshot"        # expect FAIL
cp "$SP/save-migration.ts" src/shared/save-migration.ts

# Ages must be staggered, not uniform
sed -i 's|ageTicks: w.ageTicks ?? MIGRATION_CONSTANTS.startingAgeTicks + jitter(w.id),|ageTicks: w.ageTicks ?? MIGRATION_CONSTANTS.startingAgeTicks,|' src/shared/save-migration.ts
git diff --quiet src/shared/save-migration.ts && { echo 'MUTATION DID NOT APPLY'; exit 1; }
npx vitest run tests/shared/save-migration.test.ts -t "v4 -> v5"                # expect FAIL
cp "$SP/save-migration.ts" src/shared/save-migration.ts
```

Both must fail.

- [ ] **Step 9: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src tests .fallowrc.json docs/build-ci/quality-gates.md -m "feat(save): v5 — age, home, starvation clock, and a starter house

The v4 migration synthesises the state the new mechanic needs rather than
deferring it, as v1->v2 did for positions: it places the same starter house
a fresh colony gets and writes its residents into the record. Leaving
homeId null and relying on the homing phase would show a wholly homeless
colony at penalty work power for as long as a restored (paused) engine
sits unadvanced.

lastBirthTick is persisted for the reason lastRecruitTick is."
```

---

### Task 10: The Population view earns its route

**Files:**
- Modify: `src/app/views/PopulationView.vue`, `src/app/views/DashboardView.vue`, `src/app/views/BuildingsView.vue`
- Modify: `src/app/components/BuildPalette.vue`, `src/app/labels.ts`, `src/app/stores/game-store.ts`
- Test: `tests/app/population-view.test.ts`, `tests/app/dashboard-view.test.ts`

**Interfaces:**
- Consumes: every snapshot field from Tasks 3–9.
- Produces: `stageLabel(stage)`, `commuteLabel(tiles, factor)`, `starvingLabel(ticks)` in `labels.ts`; store getters `nomadBlocker`, `bedsFree`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/population-view.test.ts`, following the mounting pattern the existing `tests/app/*.test.ts` files use:

```ts
import { describe, expect, it } from 'vitest';
import { mountView, snapshotWith, colonist } from './helpers';   // same helpers the other app tests use
import PopulationView from '../../src/app/views/PopulationView.vue';
import { BALANCE } from '../../src/engine/content';

// Fixture values DISCRIMINATE: every count is different (1 child, 2 adults,
// 1 elder), so a cell bound to the wrong stage changes the rendered number.
// Beds 3-of-8 differs from every stage count for the same reason.
const ROSTER = snapshotWith({
  colonists: [
    colonist({ id: 1, ageTicks: 400,   stage: 'child', homeId: 9, commuteTiles: 1, commuteFactor: 1 }),
    colonist({ id: 2, ageTicks: 2500,  stage: 'adult', homeId: 9, commuteTiles: 12, commuteFactor: 0.7 }),
    colonist({ id: 3, ageTicks: 3000,  stage: 'adult', homeId: null, commuteTiles: 0, commuteFactor: 0.5, starvingTicks: 37 }),
    colonist({ id: 4, ageTicks: 5800,  stage: 'elder', homeId: 9, commuteTiles: 2, commuteFactor: 1 }),
  ],
  demographics: { children: 1, adults: 2, elders: 1 },
  beds: { total: 8, occupied: 3 },
  homeless: 1,
  mealsPerHead: 4.5,
});

describe('PopulationView', () => {
  it('renders each stage count separately', () => {
    const view = mountView(PopulationView, ROSTER);
    expect(view.get('[data-test="stage-children"]').text()).toBe('1');
    expect(view.get('[data-test="stage-adults"]').text()).toBe('2');
    expect(view.get('[data-test="stage-elders"]').text()).toBe('1');
    expect(view.get('[data-test="beds"]').text()).toContain('3 / 8');
  });

  it('shows age in years and the commute cost per colonist', () => {
    const view = mountView(PopulationView, ROSTER);
    expect(view.get('[data-test="age-2"]').text()).toBe('25y');       // 2500 ticks / 100
    expect(view.get('[data-test="commute-2"]').text()).toContain('70%');
    expect(view.get('[data-test="commute-3"]').text()).toBe('Homeless');
  });

  it('flags a starving colonist with a countdown, and leaves the others alone', () => {
    const view = mountView(PopulationView, ROSTER);
    expect(view.get('[data-test="starving-3"]').text()).toBe(`${BALANCE.starvationDeathTicks - 37}t`);
    expect(view.get('[data-test="starving-3"]').classes()).toContain('obsisim-negative');
    expect(view.get('[data-test="starving-2"]').text()).toBe('—');
    expect(view.get('[data-test="starving-2"]').classes()).not.toContain('obsisim-negative');
  });

  it('disables the nomad button with the reason the engine would reject with', () => {
    // mealsPerHead 4.5 is below nomadFoodPerHead, so the gate is food — NOT
    // beds (5 free) and NOT cooldown. A button that merely read the cooldown,
    // as it did before this increment, would render enabled here.
    const view = mountView(PopulationView, ROSTER);
    const button = view.get('[data-test="recruit"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(view.get('[data-test="recruit-reason"]').text()).toContain('food');
  });

  it('enables the nomad button when every gate is clear', () => {
    // Seed the STOCKPILE, not mealsPerHead. The store getter calls the shared
    // nomadBlocker, which recomputes the ratio from stock and population —
    // mealsPerHead is a published output of that calculation, not an input to
    // it, so overriding the number alone leaves the gate reading an empty
    // store and the button stays disabled for a reason the test never names.
    const view = mountView(PopulationView, snapshotWith({
      ...ROSTER,
      stockpile: { ...ROSTER.stockpile, bread: { ...ROSTER.stockpile.bread, stock: 5000 } },
      mealsPerHead: 1000,
      homeless: 0,
      beds: { total: 12, occupied: 4 },
    }));
    expect(view.get('[data-test="recruit"]').attributes('disabled')).toBeUndefined();
  });
});
```

If `tests/app/helpers.ts` does not already export `mountView` / `snapshotWith` / `colonist`, build the fixture inline the way the neighbouring app tests do — do not invent a helper module this increment does not otherwise need.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/population-view.test.ts`
Expected: FAIL — the view renders no stage counts.

- [ ] **Step 3: Add the labels**

In `src/app/labels.ts`:

```ts
export const LIFE_STAGE_LABELS: Record<LifeStage, string> = {
  child: 'Child', adult: 'Adult', elder: 'Elder',
};

/** "24y" — ages read in years even though the sim counts ticks. */
export function ageLabel(ageTicks: number): string {
  return `${Math.floor(ageTicks / BALANCE.yearTicks)}y`;
}

/** "House #3 (4 tiles, 94%)", or "Homeless" — the commute cost stated where
 * the player can act on it. */
export function commuteLabel(homeId: number | null, tiles: number, factor: number): string {
  if (homeId === null) return 'Homeless';
  return `#${homeId} · ${tiles.toFixed(1)} tiles · ${(factor * 100).toFixed(0)}%`;
}

/** Blank until the starvation clock starts, then a countdown to death. */
export function starvingLabel(starvingTicks: number): string {
  return starvingTicks > 0 ? `${BALANCE.starvationDeathTicks - starvingTicks}t` : '—';
}
```

Add `nomadBlocker` and `bedsFree` getters to `src/app/stores/game-store.ts`, both reading the **shared predicate** so the button's reason and the engine's rejection cannot disagree.

The button binds to that getter exactly — this markup is what Step 7's mutation targets, so it must appear verbatim:

```html
      <button
        data-test="recruit"
        :disabled="store.nomadBlocker !== null"
        @click="engine.dispatch({ type: 'recruitWorker' })"
      >
        Welcome a nomad
      </button>
      <span v-if="store.nomadBlocker" data-test="recruit-reason">{{ NOMAD_REASONS[store.nomadBlocker] }}</span>
```

`NOMAD_REASONS` is the view-side counterpart of the engine's `NOMAD_REJECTIONS` (Task 8), keyed by the same `PopulationBlocker` union so the compiler catches a gate the UI forgot to explain.

- [ ] **Step 4: Rebuild the view**

Replace `PopulationView.vue`'s headline with stage counts, `beds.occupied / beds.total`, `mealsPerHead` against `BALANCE.birthFoodPerHead`, and the nomad button bound to `store.nomadBlocker`; extend the table with Age, Stage, Home, and Starving columns. Keep every branch in a helper, not the template, matching the file's existing convention.

- [ ] **Step 5: Dashboard, Buildings, palette**

Dashboard gains population-by-stage, beds, and meals-per-head. `BuildingsView` shows `occupants / beds` for a house where a producer shows batch progress. `BuildPalette` needs no change beyond the new def appearing — verify it renders and is gated on cost.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Mutation-test**

```bash
SP=/tmp/obsisim-mutation && mkdir -p $SP
cp src/app/views/PopulationView.vue "$SP/PopulationView.vue"
# The button must read the shared blocker, not just the cooldown
sed -i 's/:disabled="store.nomadBlocker !== null"/:disabled="false"/' src/app/views/PopulationView.vue
npx vitest run tests/app/population-view.test.ts -t "nomad"   # expect FAIL
cp "$SP/PopulationView.vue" src/app/views/PopulationView.vue
```

- [ ] **Step 8: Commit**

```bash
rm -rf coverage && git add tests/app/population-view.test.ts && npm run check:all
git commit src tests -m "feat(app): the Population view becomes the survival screen

Stage counts, beds, meals per head against the birth threshold, and a
nomad button whose disabled reason reads the same shared predicate the
engine rejects with — so the two cannot disagree."
```

---

### Task 11: The world view, and the renderer's line budget

**Files:**
- Modify: `src/app/world/renderer.ts`, `src/app/world/layout.ts`, `src/app/world/theme.ts`
- Modify: `src/app/components/WorldLegend.vue`
- Modify: `scripts/world-smoke.mjs`
- Test: `tests/app/world-theme.test.ts`, `tests/app/world-view.test.ts`, `npm run smoke:world`

**Interfaces:**
- Consumes: `ColonistSnapshot.stage`, `homeId`; `BuildingSnapshot.beds`, `occupants`, `state === 'housing'`.
- Produces: theme tokens `house`, `colonistChild`, `colonistElder`, `homelessMark`; a `drawColonists`/`drawBuildings` split of `renderer.ts` if the cap demands it.

- [ ] **Step 0: Finish Task 1's rename in this subsystem**

Task 1 renamed the entity `Worker` → `Colonist` everywhere its word-boundary sed could reach. The world layer was structurally out of reach — every name here embeds `Worker` without a boundary — so this subsystem still calls the person a worker while the rest of the codebase does not. It is deferred to this task, not forgotten: this task already rewrites these files for the house glyph and the stage marks, and already has to split the renderer for the LOC gate, so the rename costs one pass here instead of a second pass over the same files.

Rename, in `renderer.ts`, `layout.ts`, `theme.ts`, `graphics-cache.ts` and `WorldLegend.vue`:

`WorkerBundle` → `ColonistBundle` · `PlacedWorker` → `PlacedColonist` · `WorldLayout.workers` → `.colonists` · `workerColors` → `colonistColors` · `WORKER_RADIUS` / `WORKER_BUCKETS` / `WORKER_SPEED` → `COLONIST_*` · `workerAt()` → `colonistAt()` · `upsertWorker()` → `upsertColonist()` · `walkWorker()` → `walkColonist()`

**`workerToolRing` keeps its name** — a tool ring marks someone who is working, which is employment, the same line Task 1 drew for `workerSlots` and `workerWorkPower`.

Land this as its own commit before the feature work, exactly as Task 1 did, so the diff a reviewer reads for houses and stages is not buried in a rename. `npx vitest run` must report the same count before and after.

- [ ] **Step 1: Check the budget before writing anything**

```bash
grep -cve '^\s*$' src/app/world/renderer.ts   # 419 at the start of this task; cap is 500
```

Write the feature first; split only if the count crosses 500. **Do not baseline the file** — `scripts/loc-baseline.json` stays `{"maxLoc": 500, "files": {}}`.

- [ ] **Step 2: Write the failing theme test**

Append to `tests/app/world-theme.test.ts`:

```ts
it('resolves the demographic tokens to concrete colours', () => {
  const theme = resolveWorldTheme(() => '');   // no vault variables: fallbacks
  expect(theme.buildingGlyph.house).toBe('🏠');
  expect(theme.homelessMark).toMatch(/^#[0-9a-f]{6}$/i);
  expect(theme.stageMark.child).toMatch(/^#[0-9a-f]{6}$/i);
  expect(theme.stageMark.elder).toMatch(/^#[0-9a-f]{6}$/i);
  // Discriminating: the two stage marks must differ from each other AND from
  // the hues already spoken for, or the canvas says two things with one colour.
  const claimed = [theme.workerToolRing, theme.progressFill, theme.carriedLoad, theme.accent, theme.danger];
  expect(theme.stageMark.child).not.toBe(theme.stageMark.elder);
  expect(claimed).not.toContain(theme.stageMark.child);
  expect(claimed).not.toContain(theme.stageMark.elder);
  expect(claimed).not.toContain(theme.homelessMark);
});
```

State rings own red/orange/green, `outputFull` owns purple, tools and progress own cream, accent owns blue-violet, and carried load and `relocating` share cyan (deliberately — see `theme.ts`'s own comment). Pick from what is left, via the file's existing `pick(read, '--color-…', '#…')` pattern.

- [ ] **Step 3: Render houses and stages**

Add to `WorldTheme`:

```ts
  /** Life-stage marks. Adults carry none — they are the baseline the other
   * two are read against, and a mark on every colonist would be noise. */
  stageMark: Record<'child' | 'elder', string>;
  /** A colonist with nowhere to live. */
  homelessMark: string;
```

In `renderer.ts`, draw a house from `buildingGlyph.house` with its `occupants / beds` in the hover text, and draw a colonist with its stage mark and, when `homeId === null`, the homeless mark. Add one legend entry per encoding in `WorldLegend.vue`, matching the existing shape exactly — the label goes **outside** the chip:

```html
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.housing }" /> housing</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.child }" /> child</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.stageMark.elder }" /> elder</span>
      <span><i class="obsisim-chip is-round" :style="{ background: theme.homelessMark }" /> homeless</span>
```

Putting the label *inside* the chip is what rendered two increment-4 entries as a 12×12 box with overflowing text and no swatch at all, while the legend's text-only test passed happily. `tests/app/world-view.test.ts` already has a check that each entry owns its chip class — extend its expected count.

- [ ] **Step 4: Add smoke phases, one change each**

Add four fixture phases to the `phases` table in `scripts/world-smoke-harness/main.ts`, and four checks to the runner in `scripts/world-smoke.mjs`. Each phase changes **exactly one** thing.

**Insert them immediately BEFORE the final `renderer.dispose()` phase, and renumber dispose.** The table holds 17 entries, 0–16, and **index 16 is `dispose()`** — so appending to the end would put every demographic phase after the renderer has been destroyed, and they would draw nothing. The four new phases therefore take 16–19 and `dispose()` moves to 20.

Do NOT reuse indices 9–12: those are the carrying marker, relocation state, ghost activation and ghost tint. Pointing the new checks at them would compare unrelated existing transitions, so all four would pass with demographic rendering entirely removed — the precise failure one-change-per-phase exists to prevent.

Confirm the table's real shape before renumbering, rather than trusting these numbers:

```bash
start=$(grep -n '^const phases' scripts/world-smoke-harness/main.ts | cut -d: -f1)
awk -v s="$start" 'NR>s && /^\];/{exit} NR>s && /^  \(\) =>/{printf "index %d: %.60s\n", i++, $0}' scripts/world-smoke-harness/main.ts
```

```js
await step(16);  // a house appears — nothing else moves
const withHouse = await shot();
check('a house is drawn on the canvas', !withHouse.equals(preHouse));

await step(17); // ONE colonist's stage becomes 'child'
const withChild = await shot();
check('a child is drawn differently from an adult', !withChild.equals(withHouse));

await step(18); // that SAME colonist becomes 'elder' — one field, one frame
const withElder = await shot();
check('an elder is drawn differently from a child', !withElder.equals(withChild));

await step(19); // that same colonist's homeId becomes null
const homeless = await shot();
check('a homeless colonist carries its mark', !homeless.equals(withElder));
```

Nearly every check here is `!after.equals(before)`, so a phase that moves several things at once keeps the comparison true for reasons unrelated to its name — which is exactly how the increment-4 check named "the hauler returns to camp carrying its load" stayed green with the load marker entirely absent (OBS-4-04). One change per phase is what makes these checks mean what they say.

- [ ] **Step 5: Run the smoke suite**

Run: `npm i --no-save playwright-core && npm run smoke:world`
Expected: every check passes, including the four new ones.

- [ ] **Step 6: Mutation-test the smoke checks**

Disable each new feature in `renderer.ts` or `layout.ts` one at a time and confirm the **named** check — and only that check — goes red. A check that stays green with its feature removed is not a check.

- [ ] **Step 7: Confirm the LOC gate**

```bash
grep -cve '^\s*$' src/app/world/renderer.ts
npm run check:loc
```

Expected: under 500, gate green, no baseline entry.

- [ ] **Step 8: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src scripts tests -m "feat(world): houses, life stages, and the homeless mark on the canvas

Four new smoke phases, each changing exactly one thing — the shape OBS-4-04
required after a phase that moved five things kept its check green with the
feature entirely absent."
```

---

### Task 12: Measure the population curve

**Files:**
- Modify: `tests/support/balance-harness.ts` (`runPopulationScenario`)
- Modify: `tests/engine/balance.test.ts`
- Modify: `package.json` (if the report script needs a second entry point)

**Interfaces:**
- Consumes: the whole increment.
- Produces:
  - `interface PopulationScenario { houses: number; startingAdults: number; foodPerTick: number | 'chain'; ticks: number; sampleEvery: number }`
  - `interface PopulationResult { samples: { tick: number; children: number; adults: number; elders: number; mealsPerHead: number }[]; births: number; deathsByOldAge: number; deathsByStarvation: number; dependencyRatio: number }`
  - `runPopulationScenario(s): Promise<PopulationResult>`

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/balance.test.ts`:

```ts
describe('population balance', () => {
  it('a colony feeding ITSELF grows when it has beds, and plateaus when it does not', async () => {
    // 'chain', not a drip: spec section 4's first question is about a working
    // food chain, and a drip supplies food regardless of how many adults are
    // alive — holding constant the exact feedback loop under test.
    // 12,000 ticks and generous housing, so FOOD and demographics — not bed
    // count — decide the curve. This is the minimum that answers the question,
    // not a round number: founders start at age 1,000 and die between 5,700
    // and 7,300, so this spans their whole life plus enough of the next
    // generation to tell an oscillation from a plateau. The original 4,000
    // ticks with 4 houses could only ever show a bed-capped ramp — no
    // retirement wave falls inside that window, leaving "stable"
    // indistinguishable from "still climbing".
    const chain = { startingAdults: 4, foodPerTick: 'chain' as const, huts: 4, haulers: 2, ticks: 12000, sampleEvery: 200 };
    const ROOMY_HOUSES = 12;
    const roomy = await runPopulationScenario({ ...chain, houses: ROOMY_HOUSES });
    const capped = await runPopulationScenario({ ...chain, houses: 1 });

    // The roomy run is only a control if BEDS never bind. 12 houses is 48
    // beds, and one birth per 50 ticks fills the 44 openings in ~2,200 of
    // 12,000 — so if food turns out to sustain that many, this "roomy" curve
    // is a housing plateau wearing a demographic disguise, and Task 13 cannot
    // tell stability from a cap. Whether food binds first is precisely what
    // this experiment measures, so it cannot be assumed: assert it instead.
    // If this fails, the answer is more houses, never a weaker assertion.
    const peak = Math.max(...roomy.samples.map((s) => s.children + s.adults + s.elders));
    expect(peak).toBeLessThan(ROOMY_HOUSES * BALANCE.houseBeds);
    const finalOf = (r: PopulationResult) => r.samples.at(-1)!;
    expect(finalOf(roomy).adults + finalOf(roomy).children).toBeGreaterThan(4);
    expect(capped.births).toBeLessThan(roomy.births);
    // The cap is BEDS, not food: the capped run must not simply have starved.
    expect(capped.deathsByStarvation).toBe(0);
  }, 300000);   // two 12,000-tick chain runs against a growing colony: the slowest test in the suite, and the comment above says why it cannot be shorter

  it('the starvation countdown is visible for a real interval before the first death', async () => {
    const starved = await runPopulationScenario({ houses: 2, startingAdults: 3, foodPerTick: 0, ticks: 400, sampleEvery: 10 });
    const firstDeath = starved.samples.findIndex((s) => s.adults + s.children + s.elders < 3);
    // Measured from starvingTicks CLIMBING, not from the store emptying. With
    // foodPerTick 0 the store is empty from the first sample, so mealsPerHead
    // would report a warning ~100 ticks before anyone is even at max hunger —
    // inflating the window and letting this pass while the countdown the
    // player actually sees is far too short.
    const firstStarving = starved.samples.findIndex((s) => s.starving > 0);
    expect(firstStarving).toBeGreaterThanOrEqual(0);
    expect(firstDeath).toBeGreaterThan(firstStarving);
    const warningTicks = (firstDeath - firstStarving) * 10;
    expect(warningTicks).toBeGreaterThanOrEqual(BALANCE.autosaveEveryTicks);
  }, 120000);

  it('a birth burst becomes a retirement bulge one generation later', async () => {
    const long = await runPopulationScenario({ houses: 6, startingAdults: 2, foodPerTick: 8, ticks: 9000, sampleEvery: 100 });
    const peakChildren = long.samples.reduce((best, s, i) => (s.children > long.samples[best].children ? i : best), 0);
    const peakElders = long.samples.reduce((best, s, i) => (s.elders > long.samples[best].elders ? i : best), 0);

    // Non-vacuity FIRST. With no births at all, every sample ties at
    // children === 0, peakChildren stays pinned at index 0, and the two
    // FOUNDERS becoming elders around tick 4,500 clears the gap threshold on
    // their own — so the test would pass without a single birth cohort ever
    // reaching old age, which is the entire behaviour its name claims.
    expect(long.births).toBeGreaterThan(0);
    expect(long.samples[peakChildren].children).toBeGreaterThan(0);
    // And the elder peak must belong to that cohort, not to the founders:
    // it has to arrive at least a maturity-to-retirement span after the
    // children peaked, and outnumber the founders who were alive at tick 0.
    expect(long.samples[peakElders].elders).toBeGreaterThan(2);
    const gapTicks = (peakElders - peakChildren) * 100;
    expect(gapTicks).toBeGreaterThan(BALANCE.lifeBands.retireTicks * 0.6);
  }, 180000);

  it('a colonist housed far from their job delivers less than a colocated one', async () => {
    // The commute term must show up in GOODS, not only in a unit test of
    // commuteFactor. Same building, same tile, same crew — only the house moves.
    const near = await runScenario({ defId: 'forester', col: 6, row: 5, crew: 2, haulers: 3, ticks: 400, resource: 'wood' });
    const far = await runScenario({
      defId: 'forester', col: 6, row: 5, crew: 2, haulers: 3, ticks: 400, resource: 'wood',
      crewHouseAt: { col: 22, row: 15 },
    });
    expect(far.delivered).toBeLessThan(near.delivered);
  }, 120000);

  it('housing beside a distant producer beats housing at the camp — so clustering is not always right', async () => {
    // The OTHER half of spec section 4's commute question. The test above
    // shows only that distance costs output, which on its own argues for
    // putting everything at the camp; the haul sweep favours camp-adjacent
    // producers too, so nothing yet contradicts "cluster everything". Task 13
    // cannot sign the penalty off as well-sized without one configuration
    // where spreading out wins.
    //
    // Same producer, same tile, same crew, same haulers. The ONLY difference
    // is where the crew sleeps.
    const far = { defId: 'forester' as const, col: 20, row: 13, crew: 2, haulers: 3, ticks: 600, resource: 'wood' as const };
    const housedOnSite = await runScenario(far);
    // col + 2, NOT col + 1: the harness already puts the HAULER house on
    // col + 1, and `spawnBuilding` writes a tile directly without going
    // through `isTileBuildable`, so reusing it would stack two houses on one
    // plot. That layout is unreachable in play — it wins eight camp-adjacent
    // beds from a single contested tile — so a result measured on it could
    // not say anything about whether clustering is a real strategy.
    // col + 2 is still inside commuteFreeTiles of the camp, so "housed at the
    // camp" stays exactly as neutral as intended for the haulers.
    const housedAtCamp = await runScenario({ ...far, crewHouseAt: { col: CAMP_TILE.col + 2, row: CAMP_TILE.row } });

    expect(housedOnSite.delivered).toBeGreaterThan(housedAtCamp.delivered);
    // And by a margin a player would act on — a 1% edge is noise, not a
    // tradeoff, and would not make "do not cluster" a real decision.
    expect(housedOnSite.delivered / housedAtCamp.delivered).toBeGreaterThan(1.05);
  }, 120000);
});
```

`Scenario` gains an optional `crewHouseAt` for that last case.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/engine/balance.test.ts -t "population balance" --testTimeout=180000`
Expected: FAIL — `runPopulationScenario` is not exported.

- [ ] **Step 3: Write the scenario runner**

Append to `tests/support/balance-harness.ts`:

```ts
export interface PopulationScenario {
  houses: number;
  startingAdults: number;
  /**
   * `number` drips that much bread into the store each tick — an exogenous
   * supply, useful for isolating one variable (0 starves the colony
   * deliberately). `'chain'` instead builds gatherers' huts and haulers and
   * lets the colony **feed itself**.
   *
   * The distinction is not cosmetic. Spec section 4's first question is
   * whether a colony with a working food chain stabilises or oscillates, and
   * a drip cannot answer it: food arrives regardless of how many adults are
   * alive, so the dependency ratio never feeds back on supply and the loop
   * being tuned is precisely the one held constant. Use `'chain'` for the
   * stability measurement and a number only where the point is to hold food
   * fixed.
   */
  foodPerTick: number | 'chain';
  /** Gatherers' huts to build when `foodPerTick` is `'chain'`. */
  huts?: number;
  /** Haulers to staff when `foodPerTick` is `'chain'`. */
  haulers?: number;
  ticks: number;
  sampleEvery: number;
}

export interface PopulationSample {
  tick: number;
  children: number;
  adults: number;
  elders: number;
  mealsPerHead: number;
  /** Colonists whose starvation countdown is running. This, not an empty
   * store, is when the player's warning actually begins: spec section 4 asks
   * for the interval from starvingTicks climbing to the first death. */
  starving: number;
}

export interface PopulationResult {
  samples: PopulationSample[];
  births: number;
  deathsByOldAge: number;
  deathsByStarvation: number;
  /** (children + elders) / adults at the end: the share being carried. */
  dependencyRatio: number;
}

/**
 * A food drip, spliced in before StatsSystem exactly as captureDeliveredSystem
 * is. `refund`, not `add`: this is not a hauler delivery and must not inflate
 * deliveredRate for bread.
 */
function foodDripSystem(perTick: number): TColonySystemFactory {
  return () => createSystem({ stockpile: WriteResource(Stockpile) })
    .withName('FoodDrip')
    .withRunFunction(({ stockpile }) => {
      if (perTick > 0) stockpile.refund('bread', perTick);
    })
    .build();
}

/**
 * Stands in for the player under `'chain'`: every tick, put any idle adult to
 * work in a hut with a free slot.
 *
 * The instrument needs this because nothing in the engine assigns anyone —
 * colonists are born unassigned and the player staffs them. Without a stand-in
 * the chain would be worked only by the founders, every child would grow up
 * idle, and the run would measure a colony that starves as it grows, which is
 * an artefact of the harness rather than a property of the balance. Stated
 * here as a limitation, in the same spirit as the FED berry stock: this models
 * an *attentive* player, so it measures the best case the balance allows.
 */
function autoStaffSystem(targetHaulers: number): TColonySystemFactory {
  return () => createSystem({
    colonists: queryComponents({ age: Read(Age), job: Write(JobAssignment) }),
    buildings: queryComponents({ building: Read(Building), slots: Read(WorkerSlots) }),
  })
    .withName('AutoStaff')
    .withRunFunction(({ colonists, buildings }) => {
      const staffed = new Map<number, number>();
      const rows = [...colonists.iter()];
      for (const { job } of rows) {
        if (job.buildingId !== null) staffed.set(job.buildingId, (staffed.get(job.buildingId) ?? 0) + 1);
      }

      // HAULERS FIRST, and topped back up as they retire. The founding
      // haulers all start at matureTicks, so they are stood down together
      // about 4,500 ticks in; if nobody replaces them, delivery stops for the
      // remaining two-thirds of a 12,000-tick run and the colony starves
      // because of the harness rather than the balance under measurement.
      const isAdult = (age: Age) => stageOf(age.ticks, BALANCE.lifeBands) === 'adult';
      let haulers = rows.filter(({ age, job }) => job.hauling && isAdult(age)).length;
      for (const { age, job } of rows) {
        if (haulers >= targetHaulers) break;
        if (job.hauling || job.buildingId !== null || !isAdult(age)) continue;
        job.hauling = true;
        haulers++;
      }
      const openings = [...buildings.iter()]
        .filter(({ building, slots }) => (staffed.get(building.id) ?? 0) < slots.max)
        .sort((a, b) => a.building.id - b.building.id);
      for (const { age, job } of rows) {
        if (job.buildingId !== null || job.hauling) continue;
        if (stageOf(age.ticks, BALANCE.lifeBands) !== 'adult') continue;
        const opening = openings.find(({ building, slots }) => (staffed.get(building.id) ?? 0) < slots.max);
        if (opening === undefined) return;
        job.buildingId = opening.building.id;
        staffed.set(opening.building.id, (staffed.get(opening.building.id) ?? 0) + 1);
      }
    })
    .build();
}

export async function runPopulationScenario(scenario: PopulationScenario): Promise<PopulationResult> {
  const { houses, startingAdults, foodPerTick, ticks, sampleEvery } = scenario;
  const save: SaveGameV5 = { ...initialSave(), buildings: [], colonists: [], stockpile: {}, nextEntityId: 1 };

  const chain = foodPerTick === 'chain';
  const statsIndex = ALL_SYSTEMS.indexOf(StatsSystem);
  const systems: TColonySystemFactory[] = [
    ...ALL_SYSTEMS.slice(0, statsIndex),
    ...(chain ? [autoStaffSystem(scenario.haulers ?? 2)] : [foodDripSystem(foodPerTick)]),
    ...ALL_SYSTEMS.slice(statsIndex),
  ];
  const prep = buildColonyPrepWorld({ save, systems });
  const ids = getPrepResource(prep, IdCounter);

  const spots = autoPlaceSequence(save.map);
  const houseIds: number[] = [];
  for (let i = 0; i < houses; i++) {
    const at = spots.next().value!;
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row });
    houseIds.push(house.getComponent(Building)!.id);
  }
  // Under 'chain' the colony feeds itself: gatherers' huts (berries need no
  // input, so this is the shortest real production loop) plus haulers to carry
  // the berries to the store. autoStaffSystem crews them as adults mature.
  if (chain) {
    for (let i = 0; i < (scenario.huts ?? 2); i++) {
      const at = spots.next().value!;
      spawnBuilding(prep, ids, { defId: 'gatherersHut', progress: 0, batchActive: false, col: at.col, row: at.row });
    }
  }
  // Haulers come OUT OF startingAdults, they are not extra. Spawning them on
  // top meant `startingAdults: 2` really began with four adults, four mouths
  // and four beds taken — so "no births in the one-house control" was a
  // fixture artefact rather than a measurement, and every reported population
  // and dependency figure described a different colony than the one requested.
  const haulerCount = chain ? (scenario.haulers ?? 2) : 0;
  if (haulerCount > startingAdults) {
    throw new Error(`Scenario asks for ${haulerCount} haulers out of only ${startingAdults} adults`);
  }
  for (let i = 0; i < haulerCount; i++) {
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks, hauling: true, homeId: houseIds[0] ?? null });
  }
  for (let i = 0; i < startingAdults - haulerCount; i++) {
    // Adults, homed into the first house so the run does not open on a
    // homelessness penalty it never meant to measure.
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks, homeId: houseIds[0] ?? null });
  }
  const world = await prep.prepareRun();

  const samples: PopulationSample[] = [];
  let births = 0;
  let deathsByOldAge = 0;
  let deathsByStarvation = 0;

  for (let t = 0; t < ticks; t++) {
    await stepTick(world);
    // Notices are the engine's own account of what happened, and they are
    // cleared each snapshot — so they are counted here, per tick, not summed
    // at the end.
    for (const notice of world.getResource(SnapshotStore).latest!.notices) {
      if (notice.message.includes('was born')) births++;
      else if (notice.message.includes('died of old age')) deathsByOldAge++;
      else if (notice.message.includes('starved')) deathsByStarvation++;
    }
    if ((t + 1) % sampleEvery !== 0) continue;
    const snapshot = world.getResource(SnapshotStore).latest!;
    samples.push({
      tick: t + 1,
      children: snapshot.colonists.filter((c) => c.stage === 'child').length,
      adults: snapshot.colonists.filter((c) => c.stage === 'adult').length,
      elders: snapshot.colonists.filter((c) => c.stage === 'elder').length,
      mealsPerHead: snapshot.mealsPerHead,
      starving: snapshot.colonists.filter((c) => c.starvingTicks > 0).length,
    });
  }

  const last = samples.at(-1) ?? { children: 0, adults: 0, elders: 0 };
  return {
    samples,
    births,
    deathsByOldAge,
    deathsByStarvation,
    dependencyRatio: last.adults === 0 ? Infinity : (last.children + last.elders) / last.adults,
  };
}
```

The runner uses more than the file currently imports. `balance-harness.ts` today pulls only `createSystem` and `ReadResource` from `sim-ecs`, `Building` from components, and `SaveGameV4` — so add every one of these or the task cannot reach its own typecheck:

```ts
import { createSystem, queryComponents, Read, ReadResource, Write, WriteResource } from 'sim-ecs';
import { Age, Building, JobAssignment, WorkerSlots } from '../../src/engine/components';
import { stageOf } from '../../src/shared/population';
import { autoPlaceSequence } from '../../src/shared/placement';
import type { SaveGameV5 } from '../../src/shared/save';
```

`SaveGameV4` stays only if something in the file still references it after Task 9's rename; typecheck will say.

**`tests/engine/balance.test.ts` needs its own imports too** — it currently pulls only `BALANCE` and `runScenario`, while the new block uses the runner, its result type, and the camp tile:

```ts
import { runPopulationScenario, runScenario, type PopulationResult } from '../support/balance-harness';
import { CAMP_TILE } from '../../src/shared/haul';
```

- [ ] **Step 4: Print it in the report**

Extend the `BALANCE_REPORT=1` branch to print the population curve beside the distance/hauler sweep.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/engine/balance.test.ts --testTimeout=180000`
Expected: PASS — the new tests **and** every increment-5 assertion, unchanged.

If a pinned relationship does not hold, that is the instrument doing its job. **Do not adjust the assertion to match.** Report the measurement, and change the constants in `BALANCE` — §4 of the spec exists to record what was measured.

- [ ] **Step 6: Commit**

```bash
rm -rf coverage && npm run check:all
git commit tests -m "test(balance): pin the population curve as relationships, not counts

A fed colony grows and a bed-capped one plateaus; food loss is visible
before it is fatal; a birth burst becomes a retirement bulge a generation
later; and a distant house costs delivered goods, not just a unit-test
number."
```

---

### Task 13: Measure, document, close out

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` (§4)
- Modify: `README.md`
- Modify: `docs/issues/README.md` (any findings carried forward)

- [ ] **Step 1: Run the report and read it**

```bash
rm -rf coverage
BALANCE_REPORT=1 npx vitest run tests/engine/balance.test.ts --testTimeout=180000 2>&1 | tee /tmp/increment-6-report.txt
```

- [ ] **Step 2: Answer §4's three questions in writing**

Rewrite spec §4 with what the harness measured, replacing the "reasoning to be checked" column with a "measured" one. Answer, with numbers from `/tmp/increment-6-report.txt`:

1. Does a colony left alone with a working food chain reach a stable population, or oscillate? An oscillation near `lifespanYears` is the demographic wave working; an unbounded ramp means `birthFoodPerHead` is too low.
2. How many ticks of warning between the first `starvingTicks` climbing and the first death, at a realistic colony size? Under one autosave interval is too few.
3. Is the commute penalty large enough to change a placement decision, and small enough that clustering at the camp is not simply always correct?

**"Validated, unchanged" is a legitimate answer** to any of them. A constant that moves must move because of a number in that file, and the number goes in the table.

- [ ] **Step 3: README**

Add an Increment 6 section in the voice of the existing five — what a *player* can now do, not what was implemented. Update the Documentation list with the new spec and plan paths.

- [ ] **Step 4: Final gates**

```bash
rm -rf coverage && npm run check:all && npx vitest run && npm run smoke:world
grep -cve '^\s*$' src/app/world/renderer.ts   # under 500
git diff --stat scripts/loc-baseline.json scripts/quality-baseline.json   # expect NO changes
```

The last line is the important one: if a baseline moved, find out why before shipping.

- [ ] **Step 5: Commit**

```bash
git commit docs README.md -m "docs: increment 6 measured, README, spec section 4

Section 4 now records what the harness measured rather than what the spec
hoped, per increment 5's thesis that a constant justified by prose is a
guess."
```

---

## Notes for the implementer

- **Push back rather than guess.** Roughly half of increment 4's task briefs contained an error — a helper that did not exist, a wrong expected value, a parameter that would have corrupted eight call sites. Implementers caught them only because they were told to. **If a brief here disagrees with the code, the code wins: say so.**
- **Task 1's rename has the widest blast radius of anything here.** Let `npm run typecheck` enumerate the sites; do not hunt them by hand. The two `sed` traps are real: `\b` matches inside `SavedWorkerV2`, and `WorkerSlots` is protected only because there is no word boundary after `Worker`. Verify both with the greps in Step 5 before committing.
- **Task 7 Step 1 is not optional.** The baseline capture is what makes "the gradient did not move" a measurement rather than a hope, and Step 8 cannot be done without it.
- **Timeouts:** population scenarios run thousands of ticks through the full system set. The explicit `120000` / `180000` timeouts in Tasks 7 and 12 are required — vitest's 5s default will fail them.
- **`recipe: RecipeDef | null` (Task 5) touches more call sites than it looks.** `clampedProgress`, `batchOutputUnits`, `buildEntitySections`'s `progressPct`, the harness's `SEEDED_RESOURCE_IDS`, and `runScenario`'s ceiling all read `.recipe` today. Typecheck finds all of them; the non-null assertion in `ProductionSystem` is safe **only** because of the `continue` guard directly above it — keep them adjacent.
- **Entity removal is deferred to the post-step sync.** A colonist killed in `PopulationSystem` is still visible to `ProductionSystem` and `HaulSystem` later in the same tick, which is why `standDown` exists. Deleting it would silently give every corpse one last tick of work.
- **`Snapshot` is growing.** If a view needs a derived number, prefer a store getter over a new snapshot field, and prefer a shared-law function over either when the engine needs the same rule.
