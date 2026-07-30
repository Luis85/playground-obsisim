# Quality gates and CI

Adapted from [Luis85/specorator](https://github.com/Luis85/specorator)'s
`docs/build-ci/quality-gates.md`, adopted **greenfield**: every ratchet
baseline in this repo starts empty or at zero — nothing is grandfathered.
Where specorator's guards assumed an established codebase with known debt,
ObsiSim's version assumes none exists yet, and locks the line at "none" the
day CI turns on.

## Gates

| Gate | Command | CI job | What it catches |
|---|---|---|---|
| Lint | `npm run lint` | `lint` | Style/correctness rules (`eslint`), plus the boundary-twin `no-restricted-imports` rules below |
| LOC ratchet | `npm run check:loc` | `lint` | Any `src/**/*.{ts,vue}` file growing past 500 nonblank lines without a justified, shrink-only baseline entry |
| CSS `!important` ratchet | `npm run check:css` | `lint` | New `!important` uses in `styles.css` without a justified, shrink-only baseline entry |
| Quality ratchet | `npm run check:quality` | `quality` | Dead code, circular/re-export cycles, architecture boundary violations, clone groups, complexity hotspots — via `fallow` |
| Typecheck | `npm run typecheck` | `typecheck` | Type errors across `.ts` and `.vue` (via `vue-tsc`, which also type-checks `<script setup>` blocks `tsc` alone cannot see) |
| Tests | `npm test` | `test` | Behavioral regressions (88+ unit/component tests) |
| Coverage floors | `npm run test:coverage` | `coverage` | Undertested engine/shared/store code — hard statement/branch/function/line floors |
| Build + artifact smoke | `npm run build && npm run check:artifacts` | `build` | Broken bundling, missing/empty/oversized plugin artifacts, `package.json`/`manifest.json` version desync, missing `minAppVersion` |

`npm run check:all` runs the local-equivalent chain in one pass: `lint` →
`check:loc` → `check:css` → `check:quality` → `typecheck` → `test` → `build`
→ `check:artifacts`. It deliberately excludes `test:coverage` — see
[The `coverage/` gotcha](#the-coverage-gotcha) below — so run
`npm run test:coverage` as a separate, final step.

## Lint severity policy

Every rule ships at `error`. The `warn` tier exists only to stage a future
rule against a nonzero backlog before promoting it to `error`; it is
currently **empty**, because CI does not pass `--max-warnings` to `eslint`
and a bare `warn` rule would never fail the build — a silent no-op gate is
worse than no gate.

Two purely-formatting Vue rules (`vue/max-attributes-per-line`,
`vue/singleline-html-element-content-newline`) are disabled outright in
`eslint.config.js` rather than left at `warn`: this project has no Prettier
wired in, and those two rules fought the SFC markup style used throughout
(long single-line attribute lists, inline element content) without adding
any correctness value. Disabling them, rather than leaving them as
toothless warnings, keeps `npm run lint` output at genuinely zero problems.

## Ratchet mechanics

The LOC, CSS, and quality gates share one shape: a JSON baseline file,
compared against a fresh measurement on every run.

- **Shrink-only counters** (LOC per file, `!important` count, fallow's
  `deadCodeIssues`/`cloneGroups`/`duplicatedLines`/`complexFunctions`) may
  only go down from their locked value. Growth fails the gate.
- **Pinned-at-zero counters** (fallow's `circularDependencies`,
  `reExportCycles`, `boundaryViolations`, `criticalComplexity`) must be
  exactly 0 on every run — there is no baseline value to bump; a nonzero
  reading always fails. Raising the cap is an architecture decision (ADR
  territory), not something a baseline file can authorize.
- **Floors** (fallow's `maintainability`) may only go up from their locked
  value.
- A stale baseline entry (one that's now unnecessary, or a file that no
  longer exists) fails the gate too — this keeps the baseline file itself
  from silently accumulating dead entries.

Update commands (only ever run deliberately, after inspecting *why* a
number moved):

```bash
npm run check:loc -- --update      # scripts/loc-baseline.json
npm run check:css -- --update      # scripts/css-important-baseline.json
npm run check:quality -- --update  # scripts/quality-baseline.json
```

### Locked baseline values (this repo, at Task 18 adoption)

```json
{
  "deadCodeIssues": 0,
  "circularDependencies": 0,
  "reExportCycles": 0,
  "boundaryViolations": 0,
  "cloneGroups": 0,
  "duplicatedLines": 0,
  "complexFunctions": 0,
  "criticalComplexity": 0,
  "maintainability": 90.4
}
```

`scripts/loc-baseline.json` and `scripts/css-important-baseline.json` are
both locked **empty** (`"files": {}`) — no file in the plan-mandated code
exceeded 500 nonblank lines, and `styles.css` uses zero `!important`.

### The `maintainability` floor is rounded — do not ratchet it on noise

`fallow` reports `maintainability` to one decimal, and the gate compares the
**rounded** value. During Increment 1.5 that turned a rounding artifact into a
false regression, and the sequence is worth knowing before touching this number:

1. Task 1 removed two unused exports, which nudged the true average from 90.545
   to 90.551. Both render as "90.5" and "90.6", so the gate reported an
   improvement and the baseline was locked at **90.6**.
2. A later task deleted several comments that stated falsehoods about the code.
   The true average moved 90.551 → 90.539 — about a hundredth of a point — and
   the gate failed with `maintainability: 90.6 -> 90.5`.

Nothing about the code got worse. `fallow`'s MI includes a comment-density
term, so **deleting a bad comment costs maintainability points** while deleting
the code it lied about costs none. The floor had also never really been 90.6; it
was 90.55 rounded up.

The floor was therefore re-based to the measured **90.5** rather than defending
the artifact by keeping false comments or by reducing complexity in unrelated
files to buy back a hundredth of a point. Both of those were considered and
rejected as metric-gaming.

Two rules follow:

- **Do not `--update` this number on a sub-0.1 "improvement".** If the reported
  value ticks up by one decimal place, check whether the true delta is real
  before locking it — a lock on rounding noise leaves the next task with zero
  headroom.
- **A comment-accuracy pass will trip this gate again.** That is the formula
  penalising the right change. Re-base the floor and note it here; do not pad
  comments to compensate.

Getting `complexFunctions` and `criticalComplexity` to 0 required real
refactoring, not tuning: `CommandSystem`'s run function (cognitive
complexity 44), `ProductionSystem` and `SnapshotSystem`'s run functions,
`isLoadableSave`'s validation chain, `main.ts`'s `loadSave`, and two Vue
templates (`PopulationView.vue`, `App.vue`) were all split into smaller,
single-purpose functions/components with identical runtime behavior (all
92 tests passed unchanged before and after each split). `App.vue`'s notice
banner became a standalone `NoticeBanner.vue` component for the same
reason. See the diff for Task 18 for the specifics; no balance constants,
public API surface, or user-visible behavior changed.

### Fallow tuning applied (and why it isn't gaming the ratchet)

`.fallowrc.json`'s `ignoreExports` and `usedClassMembers` suppress three
findings that are real absences of *fallow-visible* consumers, not real
dead code:

- `buildSaveFromWorld` (`src/engine/game-engine.ts`) and `ALL_SYSTEMS`
  (`src/engine/world.ts`) are documented public seams of the engine module
  (see the increment plan: `buildSaveFromWorld` is "exported for tests",
  `ALL_SYSTEMS` is the canonical fixed system order from spec §4.4) that
  happen to have no current external importer. They're kept exported —
  deleting the `export` keyword would be removing intentional public API
  to chase a metric, which the task's ground rules explicitly forbid.
- `GameEngine.setSpeed` **is** called in production, from
  `TopBar.vue`'s `@click="engine.setSpeed(s)"` — but `engine` there is the
  return value of Vue's `inject()`, and fallow's static analysis cannot
  trace a method call off an injected, interface-typed value back to the
  class that implements it. This is a genuine false positive from the
  Vue-injection boundary, not a config workaround for dead code.

`NoticeEntry` (`src/app/stores/game-store.ts`) was a *fourth* finding of
the same shape (a type exported but never imported by name — Pinia infers
component-side types from `useGameStore()` without it) — but unlike the
three above, nothing referenced it as intentional public API, so it was
simply un-exported rather than tuned around.

## Boundary zones (`.fallowrc.json`)

Machine-checked version of the plan's §2.1 one-way layer dependencies.
Each zone is a set of file globs; each rule says which zones a zone's
files may import from.

| Zone | Patterns | May import from |
|---|---|---|
| `shared` | `src/shared/**` | *(nothing — the leaf layer)* |
| `engine-content` | `src/engine/content/**` | `shared` |
| `engine` | `src/engine/systems/**`, `src/engine/*.ts` | `shared`, `engine-content` |
| `app` | `src/app/**` | `shared`, `engine`, `engine-content` |
| `obsidian-shell` | `src/main.ts`, `src/view/**` | `shared`, `engine`, `engine-content`, `app` |

`engine`'s patterns are listed explicitly (`src/engine/systems/**` +
`src/engine/*.ts`, not `src/engine/**`) so the zone doesn't swallow
`engine-content`, which has its own, narrower rule.

Two `eslint.config.js` rules are the lint-time twins of these zones — they
catch what a boundary-graph check cannot, because they fire on the
specific *package* being imported rather than the *file* doing the
importing:

- `src/app/**`, `src/view/**`, `src/main.ts` may not import `sim-ecs`
  directly — the UI and shell must go through the `GameEngine` facade and
  `shared` types.
- `src/engine/**`, `src/shared/**` may not import `vue`, `pinia`,
  `vue-router`, or `obsidian` — the engine and shared contracts stay UI-
  and Obsidian-agnostic.

## The `coverage/` gotcha

`check:quality` hard-fails if a `coverage/` directory exists. Fallow
switches its health-score coverage model from `static_estimated` to real
istanbul coverage the moment `coverage/` is present, and that switch skews
CRAP-based complexity counts relative to the locked baseline (this bit
specorator during its own campaign run 9 — see its quality-gates doc). The
ordering that avoids it: `check:quality` runs before any coverage-producing
step, and `check:all` never runs `test:coverage` at all. Run
`npm run test:coverage` as a separate, final step, and delete `coverage/`
(or just don't re-run `check:quality`) before the next `check:all`.

## Coverage floors

| Glob | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `src/engine/**` | 90% | 85% | 90% | 90% |
| `src/shared/**` | 90% | 85% | 90% | 90% |
| `src/app/stores/**` | 90% | 85% | 90% | 90% |

The sim is the product, so it's gated hard. Views (`src/app/views/**`,
`src/app/components/**`) are not yet coverage-gated; they're covered
indirectly by the LOC guard and `BuildingsView`'s interaction tests. See
[Next slices](#next-slices).

At lock-in (Task 18), all three floors pass:

- `src/engine/**`: 99.17% stmts / 92.52% branches / 98.48% funcs / 99.17% lines
- `src/shared/**`: 100% / 87.5% / 100% / 100%
- `src/app/stores/**`: 100% / 100% / 100% / 100%

One test was added to close a real gap the floor calculation surfaced:
`GameEngine`'s `runStep` error-pause path (a thrown `world.step()` records
`this.error` and pauses) had no test — `tests/engine/game-engine.test.ts`
now stubs `world.step()` to reject and asserts the engine surfaces the
error and pauses instead of crashing the caller. `src/app/stores/game-store.ts`'s
`lowFood`/`recruitCooldownRemaining` getters' pre-first-snapshot branch
(`state.snapshot` still `null`) similarly had no direct test; one was added
in `tests/app/game-store.test.ts`. Both were small, honest additions —
real untested behavior, not coverage-gaming. Everything else left
uncovered (e.g. `src/app/index.ts`, `src/app/router.ts`, most of
`src/app/views/**`) sits outside the three gated globs and did not require
new tests to pass the gate.

## `vue-tsc` fix

`vue-tsc --noEmit` (and, it turns out, plain `tsc --noEmit` too — the
mismatch is a real type error, not a vue-tsc quirk) failed on
`src/engine/world.ts`'s `createColonyWorld`: sim-ecs 0.6.4 types
`executionFunction` as `TExecutionFunction = ((callback: Function) => any) |
typeof setTimeout | typeof requestAnimationFrame` (loose, to also accept
`setTimeout`/`requestAnimationFrame` directly), but the file's
`runSynchronously` helper was typed `(callback: () => void) => void` —
narrower than `Function`, and not assignable to it under strict function
parameter variance. The fix widens `runSynchronously`'s parameter to
`Function` (matching the library's declared type exactly) and casts to
`() => void` at the single call site, justified by reading sim-ecs 0.6.4's
compiled runtime — `executionFunction` is always invoked with exactly one
zero-argument callback, never with extra arguments the way `setTimeout`
would supply. The cast is scoped to one line, has an inline comment
recording the verification, and changes no runtime behavior (confirmed by
the full test suite passing unchanged before and after).

## Next slices

Deferred deliberately, not forgotten:

- **Perf scaling guards.** specorator gates hot-path scaling behavior;
  ObsiSim doesn't have one yet — the determinism and save/restore
  round-trip tests already pin exact simulation behavior, and there's no
  unbounded-input hot path to regress. Add a guard once one exists.
- **Windows test job.** `test` runs on `ubuntu-latest` only for now. Revisit
  once there's a concrete cross-platform risk (e.g. path handling in the
  Obsidian shell) worth the CI minutes.
- **Per-view coverage floors.** `src/app/views/**` and
  `src/app/components/**` aren't coverage-gated yet; they're covered
  indirectly via the LOC guard and targeted interaction tests
  (`BuildingsView`, `TopBar`). Add floors once the view layer's test
  strategy is settled.
