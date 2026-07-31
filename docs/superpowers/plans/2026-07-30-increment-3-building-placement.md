# Increment 3 — Player Building Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Building positions become sim truth the player controls — place new buildings on chosen tiles from the World canvas, move and demolish existing ones, with save v2 + migration and full table parity.

**Architecture:** One pure shared module (`src/shared/placement.ts`) owns the spatial law for three consumers that must never disagree: the engine's command handlers (authoritative), the app's ghost preview (cosmetic), and the v1→v2 save migration (position synthesis). The engine gains a `Position` component, `WorldMap`/`RemovalLedger` resources, and three command paths (construct-at, demolish, move) in a decomposed handler module. The renderer seam grows three drawing-only methods (`tileAt`, `setGhost`, `setSelection`); all mode logic lives in the Vue view, tested against fake renderers.

**Tech Stack:** sim-ecs 0.6.4, excalibur 0.32.0, Vue 3 + Pinia, vitest + happy-dom — all existing, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md`

## Global Constraints

- **No new dependencies.** Artifact byte budgets unchanged (`scripts/check-artifacts.mjs` untouched).
- **Boundary zones hold:** `src/shared/**` imports nothing outside `src/shared/` (`placement.ts` imports nothing at all); the app never imports `sim-ecs`; the engine/shared never import `vue`/`excalibur`/`obsidian`. `eslint.config.js` is untouched this increment.
- **Notice doctrine:** exactly one notice per drained command, success or rejection, emitted *after* the state change it describes. Every wording is pinned by a test. New wordings this increment: `Cannot build there.`, `No free tile left to build on.`, `Demolished the <name> — cost refunded.`, `Moved the <name>.`, `Cannot move there.`, `Building not found.` (reused).
- **Validation before payment:** a rejected position must leave the stockpile untouched (same ordering principle as the existing `ids.exhausted()` check).
- **Map constants:** `DEFAULT_MAP = { cols: 24, rows: 16 }`, `CAMP_COLS = 3` (left 3 columns are the camp band), legacy plot pattern = cols 4,6,8,10,12 × rows 1,3,5,… (40 slots on the default map), 336 buildable tiles.
- **Gates:** every commit keeps `npm run lint`, `npm run typecheck`, `npm test` green. `npm run check:quality` reaches full green when the consumption chain closes (new exports gain consumers within 1–2 tasks); full `npm run check:all` + `npm run test:coverage` must pass at Task 15 (CI gates the PR head, not each commit). Every file stays < 500 nonblank lines (`check:loc`), no new `!important` (`check:css`), fallow pinned-at-zero counters stay 0 (`complexFunctions`, `criticalComplexity`, `boundaryViolations`, cycles).
- **UI conventions:** `data-test` attributes on interactive/asserted elements; Obsidian CSS variables in `styles.css`; `// @vitest-environment happy-dom` pragma on component tests; render-function harnesses (no template compiler in vitest).
- **Coverage floors** (unchanged): `src/engine/**`, `src/shared/**`, `src/app/stores/**` at 90/85/90/90. Run `npm run test:coverage` only as a separate final step and delete `coverage/` before any later `check:quality` (see `docs/build-ci/quality-gates.md`, "The coverage/ gotcha").

## File Structure (final state)

```
src/shared/placement.ts               # NEW pure spatial law: DEFAULT_MAP, CAMP_COLS, isTileBuildable, autoPlacePosition
src/shared/save.ts                    # MOD v2: SavedBuildingV1 (frozen), SavedBuilding+col/row, SaveGameV2, isSaveGameV2, LATEST=2
src/shared/save-migration.ts          # MOD first real step v1→v2 + guards table entry
src/shared/snapshot.ts                # MOD BuildingSnapshot.col/row, Snapshot.map
src/shared/commands.ts                # MOD constructBuilding.at?, demolishBuilding, moveBuilding
src/engine/components.ts              # MOD Position component
src/engine/resources.ts               # MOD WorldMap, RemovalLedger resources
src/engine/world.ts                   # MOD v2 spawn/registration/validation/initial snapshot
src/engine/snapshot-builder.ts        # MOD facts carry col/row
src/engine/systems/snapshot-system.ts # MOD Position in query, map in snapshot
src/engine/systems/command-system.ts  # MOD slims to query materialization + drain dispatch
src/engine/systems/command-handlers.ts# NEW one small handler per command, on materialized rows
src/engine/game-engine.ts             # MOD SaveGameV2, removal-flag refresh, map in save
src/main.ts                           # MOD SaveGameV2 type renames only (3 sites)
src/app/world/layout.ts               # MOD buildings from snapshot positions; fixed dims; camp overflow; cell-exact pick
src/app/world/renderer-key.ts         # MOD GhostPreview + tileAt/setGhost/setSelection on the seam
src/app/world/renderer.ts             # MOD implement the three; 1-tile building visuals
src/app/world/theme.ts                # MOD accent + danger fields
src/app/views/WorldView.vue           # MOD mode machine, click routing, palette+panel hosting
src/app/components/BuildPalette.vue   # NEW canvas-side construct catalog
src/app/components/SelectionPanel.vue # NEW selected-building info + Move/Demolish
src/app/components/TwoStepButton.vue  # NEW shared click-to-confirm button (detail guard)
src/app/components/WorldLegend.vue    # MOD selected/ghost legend entries
src/app/views/BuildingsView.vue       # MOD Tile column, Demolish, affordableDefs/costLabel reuse
src/app/stores/game-store.ts          # MOD affordableDefs getter
src/app/labels.ts                     # MOD costLabel moves here (shared by table + palette)
styles.css                            # MOD palette/panel/ghost-chip classes
scripts/world-smoke-harness/main.ts   # MOD positioned fixtures + ghost/selection phases
scripts/world-smoke.mjs               # MOD ghost/selection assertions
README.md                             # MOD Increment 3 section
tests/shared/placement.test.ts        # NEW
tests/shared/save-migration.test.ts   # MOD real-chain v1→v2 describe
tests/engine/world.test.ts            # MOD v2 literals + position-validation cases
tests/engine/decide-load.test.ts      # MOD titles + genuine-v1 migration case
tests/engine/game-engine.test.ts      # MOD save literals + removal-refresh test
tests/engine/systems/command-system.test.ts # MOD construct-at/demolish/move cases
tests/app/fixtures.ts                 # MOD makeBuilding/makeWorker + map in makeSnapshot
tests/app/world-layout.test.ts        # MOD positions-from-snapshot rewrite
tests/app/world-view.test.ts          # MOD seam fakes + interaction describes
tests/app/build-palette.test.ts       # NEW
tests/app/selection-panel.test.ts     # NEW
tests/app/buildings-view.test.ts      # MOD tile column + demolish
tests/app/game-store.test.ts          # MOD affordableDefs cases
tests/app/world-theme.test.ts         # MOD accent/danger cases
```

Dependency spine: Task 1 (shared rules) → 2 (spatial snapshot plumbing) → 3 (save v2 + migration + auto-place) → 4 (handler extraction + chosen-tile construct) → 5 (demolish) → 6 (move) → 7 (layout) → 8 (theme/legend) → 9 (renderer seam) → 10 (store getter) → 11–12 (palette/panel components) → 13 (WorldView wiring) → 14 (tables) → 15 (docs + gates).

---

### Task 1: Shared placement rules

**Files:**
- Create: `src/shared/placement.ts`
- Test: `tests/shared/placement.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module, imports nothing — that is load-bearing for `save.ts`/`save-migration.ts` to import it cycle-free).
- Produces (Tasks 2–13 rely on these exact names):

```ts
export interface WorldMapSize { cols: number; rows: number }
export interface TileRef { col: number; row: number }
export const DEFAULT_MAP: WorldMapSize; // { cols: 24, rows: 16 }
export const MIN_MAP: WorldMapSize;     // { cols: 8, rows: 6 }
export const MAX_MAP: WorldMapSize;     // { cols: 256, rows: 256 }
export const CAMP_COLS = 3;
export function isInsideMap(map: WorldMapSize, col: number, row: number): boolean;
export function isTileBuildable(map: WorldMapSize, occupied: readonly TileRef[], col: number, row: number): boolean;
export function autoPlacePosition(map: WorldMapSize, occupied: readonly TileRef[]): TileRef | null;
export function mapThatFits(buildingCount: number): WorldMapSize; // DEFAULT_MAP grown until the count fits
export function autoPlaceSequence(map: WorldMapSize): Generator<TileRef>; // the empty-map placement order, linear
```

- [ ] **Step 1: Write the failing test**

Create `tests/shared/placement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  autoPlacePosition, CAMP_COLS, DEFAULT_MAP, isTileBuildable, type TileRef,
} from '../../src/shared/placement';

// The spatial law all three consumers share (spec §2.2): the engine's
// authoritative validation, the app's ghost pre-check, and the v1->v2
// migration's position synthesis.

describe('isTileBuildable', () => {
  it('accepts a free in-bounds tile right of the camp band', () => {
    expect(isTileBuildable(DEFAULT_MAP, [], CAMP_COLS, 0)).toBe(true);
    expect(isTileBuildable(DEFAULT_MAP, [], DEFAULT_MAP.cols - 1, DEFAULT_MAP.rows - 1)).toBe(true);
  });

  it('rejects out-of-bounds and camp-band tiles', () => {
    expect(isTileBuildable(DEFAULT_MAP, [], -1, 0)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], DEFAULT_MAP.cols, 0)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, DEFAULT_MAP.rows)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, -1)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], CAMP_COLS - 1, 5)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 0, 0)).toBe(false);
  });

  it('rejects occupied tiles and non-integer coordinates', () => {
    expect(isTileBuildable(DEFAULT_MAP, [{ col: 5, row: 3 }], 5, 3)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [{ col: 5, row: 3 }], 5, 4)).toBe(true);
    expect(isTileBuildable(DEFAULT_MAP, [], 5.5, 3)).toBe(false);
    expect(isTileBuildable(DEFAULT_MAP, [], 5, Number.NaN)).toBe(false);
  });
});

describe('autoPlacePosition', () => {
  it("reproduces increment 2's derived plot geometry for the first 40 placements", () => {
    // The golden equivalence the migration stands on: derived-layout rank r
    // sat at col 4 + 2*(r % 5), row 1 + 2*floor(r / 5) (old layout.ts).
    const occupied: TileRef[] = [];
    for (let rank = 0; rank < 40; rank++) {
      const at = autoPlacePosition(DEFAULT_MAP, occupied)!;
      expect(at).toEqual({ col: 4 + 2 * (rank % 5), row: 1 + 2 * Math.floor(rank / 5) });
      occupied.push(at);
    }
  });

  it('skips occupied legacy plots', () => {
    expect(autoPlacePosition(DEFAULT_MAP, [{ col: 4, row: 1 }])).toEqual({ col: 6, row: 1 });
  });

  it('falls back to a row-major scan once the legacy sequence is exhausted', () => {
    const occupied: TileRef[] = [];
    for (let i = 0; i < 40; i++) occupied.push(autoPlacePosition(DEFAULT_MAP, occupied)!);
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toEqual({ col: CAMP_COLS, row: 0 });
  });

  it('returns null only when no buildable tile remains', () => {
    const occupied: TileRef[] = [];
    for (let row = 0; row < DEFAULT_MAP.rows; row++) {
      for (let col = CAMP_COLS; col < DEFAULT_MAP.cols; col++) occupied.push({ col, row });
    }
    expect(occupied).toHaveLength(336); // 21 x 16 buildable tiles
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toBeNull();
    expect(autoPlacePosition(DEFAULT_MAP, occupied.slice(0, -1))).toEqual({
      col: DEFAULT_MAP.cols - 1, row: DEFAULT_MAP.rows - 1,
    });
  });

  it('is deterministic', () => {
    const occupied: TileRef[] = [{ col: 4, row: 1 }, { col: 8, row: 3 }];
    expect(autoPlacePosition(DEFAULT_MAP, occupied)).toEqual(autoPlacePosition(DEFAULT_MAP, occupied));
  });
});

describe('mapThatFits', () => {
  it('returns the default map whenever the colony fits it', () => {
    expect(mapThatFits(0)).toEqual(DEFAULT_MAP);
    expect(mapThatFits(336)).toEqual(DEFAULT_MAP); // exactly full
  });

  it('grows rows first, then columns, and covers the structural record cap', () => {
    expect(mapThatFits(337)).toEqual({ cols: DEFAULT_MAP.cols, rows: 17 }); // 21 x 17 = 357
    const forTenThousand = mapThatFits(10_000);
    expect((forTenThousand.cols - CAMP_COLS) * forTenThousand.rows).toBeGreaterThanOrEqual(10_000);
    expect(forTenThousand.cols).toBeLessThanOrEqual(MAX_MAP.cols);
    expect(forTenThousand.rows).toBeLessThanOrEqual(MAX_MAP.rows);
  });
});

describe('autoPlaceSequence', () => {
  it('is exactly autoPlacePosition replayed over an empty map', () => {
    const occupied: TileRef[] = [];
    for (const tile of autoPlaceSequence(DEFAULT_MAP)) {
      expect(tile).toEqual(autoPlacePosition(DEFAULT_MAP, occupied));
      occupied.push(tile);
    }
    expect(occupied).toHaveLength(336); // every buildable tile, each exactly once
  });
});
```

(`MAX_MAP`, `mapThatFits`, and `autoPlaceSequence` join the test file's placement import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/placement.test.ts`
Expected: FAIL — `Cannot find module '../../src/shared/placement'`

- [ ] **Step 3: Write the implementation**

Create `src/shared/placement.ts`:

```ts
// The spatial law of the colony in one pure module: which tiles exist, which
// are buildable, and where an unpositioned construction lands. Three
// consumers must never disagree — the engine's command handlers
// (authoritative validation), the app's ghost preview (cosmetic pre-check),
// and the v1->v2 save migration (position synthesis for pre-spatial saves).
// Imports nothing, so src/shared/ siblings (save.ts, save-migration.ts) can
// import from it without cycles.

/** Map dimensions in tiles. Persisted per colony since save v2. */
export interface WorldMapSize {
  cols: number;
  rows: number;
}

/** A tile position. SavedBuilding and BuildingSnapshot both satisfy it. */
export interface TileRef {
  col: number;
  row: number;
}

/** The fixed world size every new (and every migrated) colony starts with. */
export const DEFAULT_MAP: WorldMapSize = { cols: 24, rows: 16 };

/** Structural bounds for a persisted map size (isSaveGameV2). */
export const MIN_MAP: WorldMapSize = { cols: 8, rows: 6 };
export const MAX_MAP: WorldMapSize = { cols: 256, rows: 256 };

/**
 * The left CAMP_COLS columns are the idle-camp band — the tent and idle
 * workers live there, buildings never. Derived from the map by constant
 * rather than persisted: it has exactly one legal value per map today.
 */
export const CAMP_COLS = 3;

// Legacy plot pattern — increment 2's derived layout, frozen here so
// autoPlacePosition can replay it: 5 plots per row at cols 4,6,8,10,12,
// plot rows at 1,3,5,...
const PLOT_COL0 = 4;
const PLOTS_PER_ROW = 5;
const PLOT_ROW0 = 1;

export function isInsideMap(map: WorldMapSize, col: number, row: number): boolean {
  return (
    Number.isSafeInteger(col) && Number.isSafeInteger(row) &&
    col >= 0 && col < map.cols && row >= 0 && row < map.rows
  );
}

/**
 * THE placement predicate: inside the map, off the camp band, not occupied.
 * `occupied` is whatever building list the caller holds — saved records,
 * live component rows, and snapshot buildings all carry col/row.
 */
export function isTileBuildable(map: WorldMapSize, occupied: readonly TileRef[], col: number, row: number): boolean {
  if (!isInsideMap(map, col, row) || col < CAMP_COLS) return false;
  return !occupied.some((tile) => tile.col === col && tile.row === row);
}

/**
 * Where a construction with no player-chosen tile lands: the first free tile
 * in the legacy plot sequence (so migrated and table-built colonies keep the
 * geometry increment 2 drew), then the first free buildable tile row-major,
 * then null (map full). Occupancy is a prebuilt Set, not per-candidate
 * `occupied.some()` — a table-build in a migrated colony near the guard's
 * 10,000-record cap would otherwise pay ~50M comparisons inside one tick.
 * O(occupied + tiles scanned).
 */
export function autoPlacePosition(map: WorldMapSize, occupied: readonly TileRef[]): TileRef | null {
  const taken = new Set(occupied.map((tile) => `${tile.col},${tile.row}`));
  const free = (col: number, row: number) =>
    isInsideMap(map, col, row) && col >= CAMP_COLS && !taken.has(`${col},${row}`);
  for (let row = PLOT_ROW0; row < map.rows; row += 2) {
    for (let plot = 0; plot < PLOTS_PER_ROW; plot++) {
      const col = PLOT_COL0 + 2 * plot;
      if (col < map.cols && free(col, row)) return { col, row };
    }
  }
  for (let row = 0; row < map.rows; row++) {
    for (let col = CAMP_COLS; col < map.cols; col++) {
      if (free(col, row)) return { col, row };
    }
  }
  return null;
}

/**
 * The map a colony of this size needs: DEFAULT_MAP unless the building count
 * outgrows its buildable tiles, in which case rows extend (then, only past
 * 256 rows, columns), capped at MAX_MAP. Exists for the v1→v2 migration: a
 * v1 save can legally hold far more buildings than the default map (v1 had
 * no spatial or count cap; the structural guard admits 10,000 records, and
 * MAX_MAP's 64,768 buildable tiles cover that), and migration must never
 * classify a valid oversized colony as corrupt.
 */
export function mapThatFits(buildingCount: number): WorldMapSize {
  const fits = (map: WorldMapSize) => (map.cols - CAMP_COLS) * map.rows >= buildingCount;
  const map = { ...DEFAULT_MAP };
  while (!fits(map) && map.rows < MAX_MAP.rows) map.rows += 1;
  while (!fits(map) && map.cols < MAX_MAP.cols) map.cols += 1;
  return map;
}

/**
 * The order auto-placement consumes an EMPTY map: the legacy plot pass, then
 * row-major over everything not already yielded. Exists for the migration,
 * which places every building of a save onto a fresh map — walking this
 * sequence is linear, where replaying autoPlacePosition against a growing
 * occupied-array is cubic in the building count (the structural guard admits
 * 10,000 records; a migration must not stall plugin startup). Equivalence
 * with autoPlacePosition-over-empty-map is pinned by a test.
 */
export function* autoPlaceSequence(map: WorldMapSize): Generator<TileRef> {
  const yielded = new Set<string>();
  for (let row = PLOT_ROW0; row < map.rows; row += 2) {
    for (let plot = 0; plot < PLOTS_PER_ROW; plot++) {
      const col = PLOT_COL0 + 2 * plot;
      if (col < map.cols) {
        yielded.add(`${col},${row}`);
        yield { col, row };
      }
    }
  }
  for (let row = 0; row < map.rows; row++) {
    for (let col = CAMP_COLS; col < map.cols; col++) {
      if (!yielded.has(`${col},${row}`)) yield { col, row };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/placement.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Lint, typecheck, full test run**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green. (`check:quality` will flag the new exports as dead until Tasks 2–3 consume them — that is the documented intermediate state; do not run it as a gate here.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/placement.ts tests/shared/placement.test.ts
git commit -m "feat(shared): pure placement rules — buildable tiles and legacy-pattern auto-place"
```

---

### Task 2: Spatial snapshot plumbing (Position component, map in snapshots)

The snapshot and the live world learn about space, with transitional (0,0)
defaults — the save format itself moves in Task 3. After this task every
`BuildingSnapshot` carries `col`/`row` and every `Snapshot` carries `map`.

**Files:**
- Modify: `src/shared/snapshot.ts`
- Modify: `src/engine/components.ts`
- Modify: `src/engine/resources.ts`
- Modify: `src/engine/snapshot-builder.ts`
- Modify: `src/engine/systems/snapshot-system.ts`
- Modify: `src/engine/systems/command-system.ts` (construct gains a transitional `Position(0, 0)`)
- Modify: `src/engine/world.ts`
- Modify: `tests/app/fixtures.ts`
- Modify: `tests/app/world-layout.test.ts`, `tests/app/world-view.test.ts`, `tests/app/buildings-view.test.ts` (fixture switch)
- Test: `tests/engine/world.test.ts`

**Interfaces:**
- Consumes: `WorldMapSize`, `DEFAULT_MAP` from `src/shared/placement.ts` (Task 1).
- Produces:

```ts
// src/shared/snapshot.ts
export interface BuildingSnapshot { /* existing */ col: number; row: number }
export interface Snapshot { /* existing */ map: WorldMapSize }
// src/engine/components.ts
export class Position { constructor(public col: number, public row: number) {} }
// src/engine/resources.ts
export class WorldMap implements WorldMapSize { constructor(public cols: number, public rows: number) {} }
// tests/app/fixtures.ts
export function makeBuilding(id: number, overrides?: Partial<BuildingSnapshot>): BuildingSnapshot; // id-keyed default tile
export function makeWorker(id: number, overrides?: Partial<WorkerSnapshot>): WorkerSnapshot;
```

- [ ] **Step 1: Write the failing test**

In `tests/engine/world.test.ts`, add to the existing `describe` that contains `'seeds an initial snapshot so the UI never sees null'` (after that `it`):

```ts
  it('seeds the map dimensions into the snapshot', async () => {
    const world = await createColonyWorld();
    expect(world.getResource(SnapshotStore).latest!.map).toEqual({ cols: 24, rows: 16 });
  });

  it('carries building positions from components into snapshots', async () => {
    const save = initialSave();
    save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    const b = world.getResource(SnapshotStore).latest!.buildings[0];
    // transitional default — Task 3 (save v2) makes these the saved values
    expect(b).toMatchObject({ col: 0, row: 0 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/world.test.ts`
Expected: FAIL — `map` is `undefined` (property does not exist yet).

- [ ] **Step 3: Extend the shared snapshot types**

In `src/shared/snapshot.ts`, add the import at the top and the fields:

```ts
import type { WorldMapSize } from './placement';
```

In `BuildingSnapshot`, after `defId`:

```ts
  /** Tile position — sim truth since increment 3. */
  col: number;
  row: number;
```

In `Snapshot`, after `lastRecruitTick`:

```ts
  /** The colony's world dimensions in tiles. */
  map: WorldMapSize;
```

- [ ] **Step 4: Add the Position component and WorldMap resource**

`src/engine/components.ts` — append:

```ts
/** A building's tile on the world map. Workers have none: their spots stay
 * derived by the app-layer layout (spec §2.3). */
export class Position {
  constructor(public col: number, public row: number) {}
}
```

`src/engine/resources.ts` — add the import and the resource:

```ts
import type { WorldMapSize } from '../shared/placement';
```

```ts
/** The colony's world dimensions, restored from the save (v2). */
export class WorldMap implements WorldMapSize {
  constructor(public cols: number, public rows: number) {}
}
```

- [ ] **Step 5: Thread position and map through the snapshot builders**

`src/engine/snapshot-builder.ts`:

1. Add `Position` to the components import.
2. `BuildingFacts` gains, after `defId`:

```ts
  col: number;
  row: number;
```

3. `buildingFactsOf` gains a fourth parameter and copies it:

```ts
export function buildingFactsOf(building: Building, slots: WorkerSlots, production: Production, position: Position): BuildingFacts {
  return {
    id: building.id,
    defId: building.defId,
    col: position.col,
    row: position.row,
    workerSlots: slots.max,
    progress: production.progress,
    batchActive: production.batchActive,
  };
}
```

4. In `buildEntitySections`, the building snapshot literal gains `col: b.col, row: b.row,` after `defId: b.defId,`.
5. In `gatherEntityFacts`, the buildings push becomes:

```ts
      buildings.push(buildingFactsOf(building, entity.getComponent(WorkerSlots)!, entity.getComponent(Production)!, entity.getComponent(Position)!));
```

`src/engine/systems/snapshot-system.ts`:

1. Import `Position` (components) and `WorldMap` (resources), and `ReadResource` is already imported.
2. System args gain `map: ReadResource(WorldMap),` and the buildings query gains `position: Read(Position),`.
3. The buildings loop destructures and forwards it:

```ts
    for (const { building, slots, production, position } of buildings.iter()) {
      buildingFacts.push(buildingFactsOf(building, slots, production, position));
    }
```

4. `store.latest` gains, after `lastRecruitTick`:

```ts
      map: { cols: map.cols, rows: map.rows },
```

- [ ] **Step 6: Register the resource, spawn the component, seed the snapshot**

`src/engine/world.ts`:

1. Import `DEFAULT_MAP` from `../shared/placement`, add `Position` to the components import, add `WorldMap` to the resources import.
2. `COMPONENT_TYPES` gains `Position`.
3. `spawnBuilding` adds (transitional — Task 3 reads the saved position):

```ts
    .with(new Position(0, 0))
```

4. In `buildColonyPrepWorld`, the `instances` array gains:

```ts
    new WorldMap(DEFAULT_MAP.cols, DEFAULT_MAP.rows),
```

5. In `buildInitialSnapshot`, the building facts literal gains `col: 0, row: 0,` (transitional) and the returned snapshot gains, after `lastRecruitTick`:

```ts
    map: { ...DEFAULT_MAP },
```

`src/engine/systems/command-system.ts`: import `Position` and give `handleConstructBuilding`'s entity a transitional position — the `.with(new Production())` line becomes:

```ts
        .with(new Production())
        .with(new Position(0, 0))
```

(Task 3 replaces this with the auto-placed tile; without it, `gatherEntityFacts`'s `getComponent(Position)!` would hit `undefined` on the first constructed building.)

- [ ] **Step 7: Update the app-side fixtures (typecheck forces this now)**

`tests/app/fixtures.ts` — add imports and the two entity helpers, and give `makeSnapshot` a map:

```ts
import type { BuildingSnapshot, WorkerSnapshot } from '../../src/shared/snapshot';
```

```ts
/** A building snapshot on an id-keyed default tile (the legacy plot pattern,
 * unique per id < 41) so multi-building fixtures never stack. */
export function makeBuilding(id: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId: 'farm', col: 4 + 2 * ((id - 1) % 5), row: 1 + 2 * (Math.floor((id - 1) / 5) % 8),
    workers: 0, workerSlots: 4, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0,
    ...overrides,
  };
}

export function makeWorker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return { id, hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0, ...overrides };
}
```

In `makeSnapshot`, add `map: { cols: 24, rows: 16 },` after `lastRecruitTick: -30,`.

Then switch the literal fixtures over:

- `tests/app/world-layout.test.ts`: delete its local `building()`/`worker()` helpers and the now-unused `BuildingSnapshot`/`WorkerSnapshot` type import; import `makeBuilding, makeWorker` from `./fixtures`; rename every `building(` → `makeBuilding(` and `worker(` → `makeWorker(` (pure rename — the id-keyed default tile reproduces the old derived plots, so every geometric assertion still holds).
- `tests/app/world-view.test.ts`: import `makeBuilding, makeWorker` from `./fixtures`; replace the two inline `buildings: [{ id: 7, defId: 'bakery', ... }]` literals with `buildings: [makeBuilding(7, { defId: 'bakery', workers: 1, workerSlots: 2, state: 'producing', batchActive: true, progressPct: 55 })]` (and `progressPct` per call site — the second site is the `buildingAt(progressPct)` helper), and each inline `workers: [{ id: 3, ... }]` literal with `makeWorker(3, { ...overrides used there })`.
- `tests/app/buildings-view.test.ts`: in `mountView`, replace the building literal with `makeBuilding(7, { defId: 'forester', workers: 1, workerSlots: 2, state, progress: 1, batchActive: true, progressPct: 33, workPower: 1, col: 5, row: 2 })` (explicit tile — Task 14 asserts it) and import `makeBuilding` from `./fixtures`.

- [ ] **Step 8: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, including the two new world tests.

- [ ] **Step 9: Commit**

```bash
git add -A src tests
git commit -m "feat(engine,shared): buildings carry a Position; snapshots carry the world map"
```

---

### Task 3: Save v2 — positions and map persisted, v1 migrated on the legacy pattern

`LATEST_SAVE_VERSION` becomes 2. Constructed buildings auto-place via
`autoPlacePosition` (so every produced save is valid v2); the migration
chain gets its first real step; `isLoadableSave` learns position invariants.

**Files:**
- Modify: `src/shared/save.ts`
- Modify: `src/shared/save-migration.ts`
- Modify: `src/engine/world.ts`
- Modify: `src/engine/snapshot-builder.ts` (savedBuildingOf)
- Modify: `src/engine/game-engine.ts`
- Modify: `src/engine/systems/command-system.ts` (auto-place on construct)
- Modify: `src/main.ts` (type renames)
- Test: `tests/shared/save-migration.test.ts`, `tests/engine/world.test.ts`, `tests/engine/decide-load.test.ts`, `tests/engine/game-engine.test.ts`, `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: `autoPlacePosition`, `DEFAULT_MAP`, `MIN_MAP`, `MAX_MAP`, `CAMP_COLS`, `isInsideMap`, `WorldMapSize` (Task 1); `Position`, `WorldMap` (Task 2).
- Produces (Tasks 4–6 and the shell rely on these exact names):

```ts
// src/shared/save.ts
export const LATEST_SAVE_VERSION = 2;
export interface SavedBuildingV1 { id: number; defId: BuildingDefId; progress: number; batchActive: boolean }
export interface SavedBuilding extends SavedBuildingV1 { col: number; row: number }
export interface SaveGameV1 { version: 1; /* as before, buildings: SavedBuildingV1[] */ }
export interface SaveGameV2 {
  version: 2; tick: number; lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>; map: WorldMapSize;
  buildings: SavedBuilding[]; workers: SavedWorker[]; nextEntityId: number;
}
export function isSaveGameV1(data: unknown): data is SaveGameV1;
export function isSaveGameV2(data: unknown): data is SaveGameV2;
// src/shared/save-migration.ts — migrateSaveToLatest now returns SaveGameV2 | null
// src/engine/world.ts — initialSave(): SaveGameV2; isLoadableSave(data): data is SaveGameV2;
//   LoadDecision.restore carries SaveGameV2; spawnBuilding reads saved.col/saved.row
```

- [ ] **Step 1: Write the failing migration tests**

In `tests/shared/save-migration.test.ts`, add at the top of the file (after the imports) a v1 fixture builder, and a new `describe` after the existing `migrateSaveToLatest (real chain)` block. Also import the v2 type:

```ts
import type { SaveGameV2 } from '../../src/shared/save';
```

```ts
/** A structurally valid v1 save (pre-spatial: no map, no positions). */
function v1Fixture(buildingCount: number) {
  return {
    version: 1, tick: 5, lastRecruitTick: -30,
    stockpile: { wood: 10 },
    buildings: Array.from({ length: buildingCount }, (_, i) => ({
      id: i + 10, defId: 'forester', progress: 0, batchActive: false,
    })),
    workers: [{ id: 1, hunger: 0, buildingId: null, toolTicks: 0 }],
    nextEntityId: 1000,
  };
}

describe('migrateSaveToLatest (v1 -> v2)', () => {
  it('migrates v1 to v2 with legacy-pattern positions and the default map', () => {
    const out = migrateSaveToLatest(v1Fixture(7)) as SaveGameV2;
    expect(out.version).toBe(2);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    expect(out.buildings.map((b) => ({ col: b.col, row: b.row }))).toEqual([
      { col: 4, row: 1 }, { col: 6, row: 1 }, { col: 8, row: 1 }, { col: 10, row: 1 }, { col: 12, row: 1 },
      { col: 4, row: 3 }, { col: 6, row: 3 },
    ]);
    expect(out.buildings.map((b) => b.id)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it('assigns positions in ascending id order regardless of array order', () => {
    const shuffled = v1Fixture(2);
    shuffled.buildings.reverse();
    const out = migrateSaveToLatest(shuffled) as SaveGameV2;
    expect(out.buildings.find((b) => b.id === 10)).toMatchObject({ col: 4, row: 1 });
    expect(out.buildings.find((b) => b.id === 11)).toMatchObject({ col: 6, row: 1 });
  });

  it('preserves a valid colony bigger than the default map by growing the map', () => {
    // v1 had no building cap: 337 buildings is a legal save, never a corrupt
    // one — the migration must not route it to the backup-and-start-fresh path
    const out = migrateSaveToLatest(v1Fixture(337)) as SaveGameV2;
    expect(out.version).toBe(2);
    expect(out.buildings).toHaveLength(337);
    expect(out.map.rows).toBeGreaterThan(16); // grown past the 336-tile default
    const tiles = new Set(out.buildings.map((b) => `${b.col},${b.row}`));
    expect(tiles.size).toBe(337); // every position distinct and on the map
  });

  it('migrates the guard-cap worst case (10,000 buildings) without stalling', () => {
    // the sequence walk is linear — this is a performance contract as much as
    // a correctness one (a save must never hang plugin startup); vitest's
    // default per-test timeout doubles as the stall detector
    const out = migrateSaveToLatest(v1Fixture(10_000)) as SaveGameV2;
    expect(out.buildings).toHaveLength(10_000);
    const tiles = new Set(out.buildings.map((b) => `${b.col},${b.row}`));
    expect(tiles.size).toBe(10_000);
    expect((out.map.cols - 3) * out.map.rows).toBeGreaterThanOrEqual(10_000);
  });

  it('does not mutate its input', () => {
    const input = v1Fixture(1);
    migrateSaveToLatest(input);
    expect(input).toEqual(v1Fixture(1));
  });
});
```

Also update the two stale real-chain tests in the same file:
- `'passes a v1 save through unchanged'` → rename to `'passes a latest-version save through unchanged'` (body unchanged — `initialSave()` emits v2 after this task).
- The comment above `'has a guard registered for LATEST_SAVE_VERSION…'` stays valid verbatim.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/shared/save-migration.test.ts`
Expected: FAIL — v1 input passes through unmigrated (chain is empty), `out.version` is 1.

- [ ] **Step 3: Rewrite `src/shared/save.ts`'s types and guards**

1. Change the `LATEST_SAVE_VERSION` doc comment's second paragraph to name v2 (the self-policing mechanism text stays; replace "raising this to 2" with "raising this to 3" and "SaveGameV1.version is the literal type 1" with "SaveGameV2.version is the literal type 2"), and set:

```ts
export const LATEST_SAVE_VERSION = 2;
```

2. Add the import:

```ts
import { MAX_MAP, MIN_MAP, type WorldMapSize } from './placement';
```

3. Split the building record and add v2 types — replace the current `SavedBuilding` interface with:

```ts
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
```

4. `SaveGameV1.buildings` becomes `SavedBuildingV1[]` (the interface is otherwise frozen). Add after it:

```ts
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
```

5. Refactor the guard into shared shape helpers plus two versioned guards (this keeps the fallow clone/complexity counters flat — the v1 and v2 guards must not duplicate the record checks):

```ts
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

/** The shape both versions share: counters, stockpile object, bounded entity
 * arrays with per-record worker checks. Number.isFinite, never typeof: NaN
 * and Infinity pass typeof === 'number' and would poison sim arithmetic. */
function isCommonSaveShape(save: Record<string, unknown>): boolean {
  return (
    Number.isFinite(save.tick) &&
    Number.isFinite(save.lastRecruitTick) &&
    Number.isFinite(save.nextEntityId) &&
    typeof save.stockpile === 'object' && save.stockpile !== null &&
    !Array.isArray(save.stockpile) && // an array passes typeof 'object' but would restore as an empty stockpile
    Array.isArray(save.buildings) &&
    save.buildings.length <= MAX_SAVED_ENTITIES &&
    save.buildings.every(isSavedBuildingV1Shape) &&
    Array.isArray(save.workers) &&
    save.workers.length <= MAX_SAVED_ENTITIES &&
    save.workers.every(isSavedWorkerShape)
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
```

(The old inline `isSaveGameV1` body is replaced entirely by the composition above; its comments move onto the helpers as shown.)

- [ ] **Step 4: Register the first real migration step**

In `src/shared/save-migration.ts`:

1. Imports become:

```ts
import type { SaveGameV1, SaveGameV2 } from './save';
import { isSaveGameV1, isSaveGameV2, LATEST_SAVE_VERSION } from './save';
import { autoPlaceSequence, mapThatFits } from './placement';
```

2. `SAVE_GUARDS` becomes:

```ts
const SAVE_GUARDS: SaveGuards = { 1: isSaveGameV1, 2: isSaveGameV2 };
```

3. Replace the `SAVE_MIGRATIONS` const (and rewrite its "Empty by design" comment) with:

```ts
/**
 * v1 -> v2: space arrives. Every building gets the position increment 2's
 * derived layout drew it at — autoPlaceSequence yields exactly the order
 * autoPlacePosition would consume an empty map (pinned by test), walked
 * once for an ascending-id pass, so migration is linear in the building
 * count (the structural guard admits 10,000 records; startup must not
 * stall). The save gains a map that FITS: the default one, grown by
 * mapThatFits when a valid v1 colony outgrew it (v1 had no building cap,
 * so oversized colonies are legal saves, never corrupt ones). Placement
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

/** The registration tables this module owns, edited in place when a version
 * lands. Deliberately not exported: tests inject fakes through
 * migrateSaveToLatest's parameters instead. */
const SAVE_MIGRATIONS: readonly MigrationStep[] = [migrateV1toV2];
```

4. `migrateSaveToLatest`'s return type and final cast become `SaveGameV2 | null` / `as SaveGameV2`.

- [ ] **Step 5: Move the engine to v2**

`src/engine/world.ts`:

1. Imports: `isSaveGameV1` → `isSaveGameV2`; `SaveGameV1` type → `SaveGameV2` (every reference in the file: `initialSave`, the validators' parameter types, `isLoadableSave`, `prepareLoadedSave`, `LoadDecision`, `spawnBuilding`'s `SavedBuilding` stays, `buildColonyPrepWorld`, `buildInitialSnapshot`, `createColonyWorld`); add `CAMP_COLS, isInsideMap` to the placement import.
2. `initialSave()` gains `map: { ...DEFAULT_MAP },` after `stockpile` and its return type becomes `SaveGameV2`.
3. `isLoadableSave` — first line becomes `if (!isSaveGameV2(data)) return false;` and the function gains, after the `isIdsValid` check:

```ts
  if (!isPositionsValid(data)) return false;
```

with this new validator beside the others:

```ts
/**
 * Position invariants are cross-field truths — they need the save's own map
 * — so they live here beside the id checks, not in the structural guard.
 * Set-based, not isTileBuildable-per-record: that would be O(n^2) on a
 * 10,000-building hand-edited save (the flooded-save principle: cheap
 * checks before expensive walks).
 */
function isPositionsValid(data: SaveGameV2): boolean {
  const tiles = new Set<string>();
  for (const b of data.buildings) {
    if (!isInsideMap(data.map, b.col, b.row) || b.col < CAMP_COLS) return false;
    const key = `${b.col},${b.row}`;
    if (tiles.has(key)) return false;
    tiles.add(key);
  }
  return true;
}
```

4. `spawnBuilding`'s transitional `.with(new Position(0, 0))` becomes `.with(new Position(saved.col, saved.row))`.
5. `buildColonyPrepWorld`'s `new WorldMap(DEFAULT_MAP.cols, DEFAULT_MAP.rows)` becomes `new WorldMap(save.map.cols, save.map.rows)`.
6. `buildInitialSnapshot`: building facts `col: 0, row: 0,` becomes `col: saved.col, row: saved.row,`; the snapshot's `map: { ...DEFAULT_MAP }` becomes `map: { cols: save.map.cols, rows: save.map.rows }`.

`src/engine/snapshot-builder.ts` — `savedBuildingOf` becomes:

```ts
export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return { id: facts.id, defId: facts.defId, col: facts.col, row: facts.row, progress: facts.progress, batchActive: facts.batchActive };
}
```

`src/engine/game-engine.ts`:

1. `SaveGameV1` → `SaveGameV2` (import + all 5 usage sites); import `WorldMap` from `./resources`.
2. `buildSaveFromWorld` gains, after the `stockpile` line:

```ts
    map: { cols: world.getResource(WorldMap).cols, rows: world.getResource(WorldMap).rows },
```

`src/main.ts` — `SaveGameV1` → `SaveGameV2` (import + 2 usage sites).

- [ ] **Step 6: Auto-place on construct (every produced save is valid v2)**

In `src/engine/systems/command-system.ts`:

1. Imports: add `ReadResource` to the sim-ecs import; add `WorldMap` to the resources import; add:

```ts
import { autoPlacePosition } from '../../shared/placement';
```

2. System args gain `map: ReadResource(WorldMap),` and the buildings query gains `position: Read(Position),`; the run function's destructuring gains `map`.
3. In `handleConstructBuilding`, after the `def` lookup and before the `pay` check, insert (and change the transitional `.with(new Position(0, 0))` to use `at`):

```ts
      // Position resolves (and can refuse) BEFORE pay(), same principle as
      // the ids.exhausted check above: refusing after payment swallows cost.
      const occupied = [...buildings.iter()].map(({ position }) => ({ col: position.col, row: position.row }));
      const at = autoPlacePosition(map, occupied);
      if (at === null) {
        notices.reject('No free tile left to build on.');
        return;
      }
```

```ts
        .with(new Position(at.col, at.row))
```

(Player-chosen `at` and the same-tick claimed-tiles guard arrive with the
handler extraction in Task 4 — until then two same-tick constructions could
both auto-place onto one tile; Task 4's test pins the fix.)

- [ ] **Step 7: Update the engine tests that pin v1 shapes**

- `tests/engine/world.test.ts` — every saved-building literal gains `col: 4, row: 1,` (when a fixture pushes two buildings, give the second `col: 6, row: 1,`). Find them all with `grep -n "defId: 'forester'" tests/engine/world.test.ts` — the `buildings.push({ id: …, … })` calls plus the two `const building = { id: 4, defId: 'forester' as const, … }` literals; typecheck will refuse any site you miss.
- Same file: the Task 2 test `'carries building positions from components into snapshots'` — its pushed literal becomes `{ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 9, row: 7 }` and the assertion becomes `toMatchObject({ col: 9, row: 7 })` with the transitional comment removed.
- Same file: in `'rejects a version this build does not know'`, change `version: 2` to `version: 3` (v2 is now the known latest; spreading `initialSave()` with `version: 2` would be a *valid* save).
- Same file: the `prepareLoadedSave` describe's `'accepts a v1 save and returns it unchanged'` → rename to `'accepts a latest-version save and returns it unchanged'`.
- `tests/engine/game-engine.test.ts` — lines 90 and 139: the expected save literal becomes `[{ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 }]` (first auto-place lands on legacy plot 0).
- `tests/engine/decide-load.test.ts` — rename `'restores a valid v1 save'` → `'restores a valid latest-version save'`; add after it:

```ts
  it('restores a genuine v1 save by migrating it (positions on the legacy pattern)', () => {
    const v1 = {
      version: 1, tick: 10, lastRecruitTick: -30, stockpile: { wood: 5 },
      buildings: [
        { id: 4, defId: 'forester', progress: 0, batchActive: false },
        { id: 5, defId: 'farm', progress: 0, batchActive: false },
      ],
      workers: [{ id: 1, hunger: 0, buildingId: 4, toolTicks: 0 }],
      nextEntityId: 6,
    };
    const decision = decideLoad(v1);
    expect(decision.kind).toBe('restore');
    if (decision.kind !== 'restore') return;
    expect(decision.save.version).toBe(2);
    expect(decision.save.map).toEqual({ cols: 24, rows: 16 });
    expect(decision.save.buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });
```

- `tests/engine/systems/command-system.test.ts` — the `setup` helper's save parameter type `SaveGameV1` → `SaveGameV2` (import rename).

- [ ] **Step 8: Add loadable-save position rejection tests**

In `tests/engine/world.test.ts`, inside the `isLoadableSave` describe, add:

```ts
  it('rejects positions off the map, on the camp band, or stacked on one tile', () => {
    const outOfBounds = initialSave();
    outOfBounds.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 24, row: 1 });
    outOfBounds.nextEntityId = 5;
    expect(isLoadableSave(outOfBounds)).toBe(false);

    const onCamp = initialSave();
    onCamp.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 2, row: 1 });
    onCamp.nextEntityId = 5;
    expect(isLoadableSave(onCamp)).toBe(false);

    const stacked = initialSave();
    stacked.buildings.push(
      { id: 4, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 5 },
      { id: 5, defId: 'farm', progress: 0, batchActive: false, col: 5, row: 5 },
    );
    stacked.nextEntityId = 6;
    expect(isLoadableSave(stacked)).toBe(false);
  });

  it('rejects a map outside the structural bounds', () => {
    const tiny = initialSave();
    tiny.map = { cols: 4, rows: 4 };
    expect(isLoadableSave(tiny)).toBe(false);
  });
```

- [ ] **Step 9: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green — including migration, decide-load, world, game-engine, command-system.

- [ ] **Step 10: Commit**

```bash
git add -A src tests
git commit -m "feat(shared,engine): save v2 — persisted positions and map, v1 migrated on the legacy pattern"
```

---

### Task 4: Command handlers module + player-chosen construction tile

The run function decomposes: handlers move to `command-handlers.ts` as small
functions over materialized query rows (fallow's complexity gate is pinned
at zero — the old inline-closure style cannot absorb three more commands).
`constructBuilding` gains `at`, validated authoritatively, with a
claimed-tiles guard closing the same-tick double-construct hole.

**Files:**
- Modify: `src/shared/commands.ts`
- Create: `src/engine/systems/command-handlers.ts`
- Modify: `src/engine/systems/command-system.ts`
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: `isTileBuildable`, `autoPlacePosition`, `TileRef` (Task 1); `Position`, `WorldMap` (Task 2).
- Produces (Tasks 5–6 extend these exact names):

```ts
// src/shared/commands.ts
{ type: 'constructBuilding'; buildingDefId: BuildingDefId; at?: { col: number; row: number } }
// src/engine/systems/command-handlers.ts
export interface BuildingRow { entity: Readonly<IEntity>; building: Building; slots: WorkerSlots; position: Position }
export interface WorkerRow { job: JobAssignment }
export interface CommandContext {
  clock: SimClock; stockpile: Stockpile; ids: IdCounter; notices: NoticeBoard; map: WorldMap;
  buildings: BuildingRow[]; workers: WorkerRow[];
  spawn: (...components: object[]) => void;
  claimedTiles: TileRef[];
}
export function handleConstructBuilding(ctx, command): void;
export function handleRecruitWorker(ctx): void;
export function handleAssignWorker(ctx, command): void;
export function handleUnassignWorker(ctx, command): void;
```

- [ ] **Step 1: Write the failing tests**

Append to the `describe('CommandSystem')` block in `tests/engine/systems/command-system.test.ts`:

```ts
  it('constructs at a chosen buildable tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 7, row: 4 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Built a Forester.' }]);
    await tick();
    expect(snapshot().buildings[0]).toMatchObject({ defId: 'forester', col: 7, row: 4 });
  });

  it('auto-places table constructions on the legacy plot pattern', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await tick();
    expect(snapshot().buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });

  it('rejects out-of-bounds, camp-band, and occupied tiles without paying', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 0, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 24, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // nothing paid
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // only the forester paid
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick constructions cannot claim one tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester', at: { col: 6, row: 2 } },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 2 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('rejects construction once no buildable tile remains', async () => {
    const save = initialSave();
    let id = 10;
    for (let row = 0; row < 16; row++) {
      for (let col = 3; col < 24; col++) {
        save.buildings.push({ id: id++, defId: 'forester', progress: 0, batchActive: false, col, row });
      }
    }
    save.nextEntityId = id;
    save.stockpile = { wood: 100 };
    const { dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free tile left to build on.' }]);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: FAIL — `at` is not a known command field (typecheck) / chosen tile ignored.

- [ ] **Step 3: Extend the command contract**

`src/shared/commands.ts` — the construct member becomes:

```ts
  | { type: 'constructBuilding'; buildingDefId: BuildingDefId; at?: { col: number; row: number } }
```

- [ ] **Step 4: Create `src/engine/systems/command-handlers.ts`**

```ts
import type { IEntity } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import { autoPlacePosition, isTileBuildable, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import {
  Building, Efficiency, Hunger, JobAssignment, Position, Production, ToolCoverage, Worker, WorkerSlots,
} from '../components';
import type { IdCounter, NoticeBoard, SimClock, Stockpile, WorldMap } from '../resources';

// One small handler per command type (the complexity gate is why they live
// here and not inline in the system's run function). Notice doctrine:
// exactly one notice per command, emitted after the state change it
// describes — a notice never claims something that didn't happen.

/** Live query rows, materialized once per drain. Component references stay
 * live, so writes (job.buildingId, position.col) hit the real world. */
export interface BuildingRow {
  entity: Readonly<IEntity>;
  building: Building;
  slots: WorkerSlots;
  position: Position;
}

export interface WorkerRow {
  job: JobAssignment;
}

/**
 * Everything one drained command may read or write. `spawn` wraps sim-ecs's
 * deferred entity commands; `claimedTiles` bridges that deferral inside a
 * single drain — an entity built this tick is invisible to queries until the
 * post-step sync, but its tile must already count as occupied.
 */
export interface CommandContext {
  clock: SimClock;
  stockpile: Stockpile;
  ids: IdCounter;
  notices: NoticeBoard;
  map: WorldMap;
  buildings: BuildingRow[];
  workers: WorkerRow[];
  spawn: (...components: object[]) => void;
  claimedTiles: TileRef[];
}

/** Occupancy truth for this drain: live rows plus this drain's own claims. */
function occupiedTiles(ctx: CommandContext): TileRef[] {
  return [
    ...ctx.buildings.map((row) => ({ col: row.position.col, row: row.position.row })),
    ...ctx.claimedTiles,
  ];
}

function findBuilding(ctx: CommandContext, buildingId: number): BuildingRow | null {
  return ctx.buildings.find((row) => row.building.id === buildingId) ?? null;
}

// Only unassign needs to go from a bare id to a name without already holding
// a findBuilding() result. The 'building' fallback fires when a
// JobAssignment points at a building that no longer exists (reachable via
// spawnWorker fixtures; live in-game once demolition lands in Task 5).
function buildingName(ctx: CommandContext, buildingId: number): string {
  const found = findBuilding(ctx, buildingId);
  return found ? BUILDINGS[found.building.defId].name : 'building';
}

export function handleConstructBuilding(ctx: CommandContext, command: Extract<Command, { type: 'constructBuilding' }>): void {
  // Checked BEFORE pay(): refusing after payment would swallow the cost.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const def = BUILDINGS[command.buildingDefId];
  // Position resolves (and can refuse) BEFORE pay(), same principle as ids.
  const occupied = occupiedTiles(ctx);
  let at = command.at ?? null;
  if (at === null) {
    at = autoPlacePosition(ctx.map, occupied);
    if (at === null) {
      ctx.notices.reject('No free tile left to build on.');
      return;
    }
  } else if (!isTileBuildable(ctx.map, occupied, at.col, at.row)) {
    ctx.notices.reject('Cannot build there.');
    return;
  }
  if (!ctx.stockpile.pay(def.cost)) {
    ctx.notices.reject(`Cannot afford ${def.name}.`);
    return;
  }
  ctx.claimedTiles.push({ col: at.col, row: at.row });
  ctx.spawn(
    new Building(ctx.ids.take(), def.id),
    new WorkerSlots(def.workerSlots),
    new Production(),
    new Position(at.col, at.row),
  );
  ctx.notices.succeed(`Built a ${def.name}.`);
}

export function handleRecruitWorker(ctx: CommandContext): void {
  // Checked BEFORE the cooldown write: a refused recruit must not start it.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  if (ctx.clock.tick < ctx.clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
    ctx.notices.reject('Recruiting is still on cooldown.');
    return;
  }
  ctx.clock.lastRecruitTick = ctx.clock.tick;
  const id = ctx.ids.take();
  ctx.spawn(new Worker(id), new Hunger(), new JobAssignment(), new Efficiency(), new ToolCoverage());
  ctx.notices.succeed(`Recruited worker #${id}.`);
}

export function handleAssignWorker(ctx: CommandContext, command: Extract<Command, { type: 'assignWorker' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  let assigned = 0;
  let idle: JobAssignment | null = null;
  for (const { job } of ctx.workers) {
    if (job.buildingId === command.buildingId) assigned++;
    else if (job.buildingId === null && idle === null) idle = job;
  }
  if (assigned >= found.slots.max) {
    ctx.notices.reject('No free worker slots at this building.');
    return;
  }
  if (idle === null) {
    ctx.notices.reject('No idle workers available.');
    return;
  }
  idle.buildingId = command.buildingId;
  ctx.notices.succeed(`Assigned a worker to ${BUILDINGS[found.building.defId].name}.`);
}

export function handleUnassignWorker(ctx: CommandContext, command: Extract<Command, { type: 'unassignWorker' }>): void {
  let found = false;
  for (const { job } of ctx.workers) {
    if (job.buildingId === command.buildingId) {
      job.buildingId = null;
      found = true;
      break;
    }
  }
  if (!found) {
    ctx.notices.reject('No worker assigned to this building.');
    return;
  }
  ctx.notices.succeed(`Unassigned a worker from ${buildingName(ctx, command.buildingId)}.`);
}
```

- [ ] **Step 5: Slim `src/engine/systems/command-system.ts` to context + dispatch**

Replace the whole file with:

```ts
import { Actions, createSystem, queryComponents, Read, ReadEntity, ReadResource, Write, WriteResource } from 'sim-ecs';
import { Building, JobAssignment, Position, WorkerSlots } from '../components';
import { CommandQueue, IdCounter, NoticeBoard, SimClock, Stockpile, WorldMap } from '../resources';
import {
  type CommandContext,
  handleAssignWorker, handleConstructBuilding, handleRecruitWorker, handleUnassignWorker,
} from './command-handlers';

export const CommandSystem = () => createSystem({
  actions: Actions,
  queue: WriteResource(CommandQueue),
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  map: ReadResource(WorldMap),
  buildings: queryComponents({
    entity: ReadEntity(), building: Read(Building), slots: Read(WorkerSlots), position: Write(Position),
  }),
  // JobAssignment alone identifies a worker entity — the Worker component
  // added nothing the handlers read.
  workers: queryComponents({ job: Write(JobAssignment) }),
})
  .withName('CommandSystem')
  // Handlers live in command-handlers.ts, one small function per command
  // type; this run function only materializes the query rows into a context
  // and drains the queue through the dispatch switch.
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, map, buildings, workers }) => {
    const ctx: CommandContext = {
      clock, stockpile, ids, notices, map,
      buildings: [...buildings.iter()].map(({ entity, building, slots, position }) => ({ entity, building, slots, position })),
      workers: [...workers.iter()].map(({ job }) => ({ job })),
      spawn: (...components) => {
        let entity = actions.commands.buildEntity();
        for (const component of components) entity = entity.with(component);
        entity.build();
      },
      claimedTiles: [],
    };
    for (const command of queue.drain()) {
      switch (command.type) {
        case 'constructBuilding': handleConstructBuilding(ctx, command); break;
        case 'recruitWorker': handleRecruitWorker(ctx); break;
        case 'assignWorker': handleAssignWorker(ctx, command); break;
        case 'unassignWorker': handleUnassignWorker(ctx, command); break;
      }
    }
    const dropped = queue.takeDropped();
    if (dropped > 0) notices.reject(`${dropped} command(s) were dropped: the queue was full.`);
  })
  .build();
```

- [ ] **Step 6: Run the target file, then the full suite**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: PASS — all new placement cases plus every pre-existing case (identical notice wordings prove the extraction preserved behavior).

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/commands.ts src/engine/systems/command-handlers.ts src/engine/systems/command-system.ts tests/engine/systems/command-system.test.ts
git commit -m "feat(engine): player-chosen construction tiles; command handlers decomposed"
```

---

### Task 5: demolishBuilding

Entity removal arrives: refund, worker release, deferred removal, and the
`RemovalLedger` dirty flag that closes game-engine.ts's "INVARIANT for
increment 2" snapshot-refresh gap.

**Files:**
- Modify: `src/shared/commands.ts`
- Modify: `src/engine/resources.ts`
- Modify: `src/engine/world.ts` (register the resource)
- Modify: `src/engine/systems/command-handlers.ts`
- Modify: `src/engine/systems/command-system.ts`
- Modify: `src/engine/game-engine.ts`
- Test: `tests/engine/systems/command-system.test.ts`, `tests/engine/game-engine.test.ts`

**Interfaces:**
- Consumes: Task 4's `CommandContext` and dispatch shape.
- Produces:

```ts
// src/shared/commands.ts
{ type: 'demolishBuilding'; buildingId: number }
// src/engine/resources.ts
export class RemovalLedger { dirty = false }
// src/engine/systems/command-handlers.ts — CommandContext gains:
//   removals: RemovalLedger; remove: (entity: Readonly<IEntity>) => void; demolishedIds: Set<number>
export function handleDemolishBuilding(ctx, command): void;
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/systems/command-system.test.ts`:

```ts
  it('demolishes: refunds the cost, idles the workers, removes the entity', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // wood 30 -> 20
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // full refund
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().idleWorkers).toBe(3);
  });

  it('rejects demolishing a building that does not exist', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'demolishBuilding', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
  });

  it('a demolished id is dead within its own tick: later commands against it reject', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'assignWorker', buildingId },
      { type: 'unassignWorker', buildingId },
      { type: 'demolishBuilding', buildingId },
    );
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
    ]);
  });

  it('a tile freed by demolition is buildable again on the NEXT tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } },
    );
    expect(snapshot().notices[1]).toEqual({ kind: 'rejection', message: 'Cannot build there.' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: "Built a Gatherer's Hut." }]);
  });
```

Append to `tests/engine/game-engine.test.ts` (inside its top-level describe, using its existing `GameEngine.create()` style):

```ts
  it('a demolishing tick refreshes the published snapshot immediately', async () => {
    const engine = await GameEngine.create();
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    await engine.stepOnce();
    const buildingId = engine.snapshot!.buildings[0].id;
    engine.dispatch({ type: 'demolishBuilding', buildingId });
    // Removal consumes no id, so without the RemovalLedger flag the
    // id-delta-gated refresh would skip and the demolished building would
    // linger in the published snapshot until the next id-consuming tick.
    await engine.stepOnce();
    expect(engine.snapshot!.buildings).toHaveLength(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/command-system.test.ts tests/engine/game-engine.test.ts`
Expected: FAIL — `demolishBuilding` is not a known command type.

- [ ] **Step 3: Implement**

`src/shared/commands.ts` — add the union member:

```ts
  | { type: 'demolishBuilding'; buildingId: number }
```

`src/engine/resources.ts` — append:

```ts
/**
 * Entity removal consumes no id, so the id-counter delta that gates
 * GameEngine's post-step snapshot refresh cannot see it (the "INVARIANT for
 * increment 2" reserved in game-engine.ts). The demolish handler raises this
 * flag instead; runStep reads-and-clears it beside the id check.
 */
export class RemovalLedger {
  dirty = false;
}
```

`src/engine/world.ts` — add `RemovalLedger` to the resources import and to the `instances` array in `buildColonyPrepWorld`:

```ts
    new RemovalLedger(),
```

`src/engine/systems/command-handlers.ts`:

1. Add `RemovalLedger` to the resources type import, and add (the refund
   loop is this file's first `ResourceId` use):

```ts
import type { ResourceId } from '../../shared/content-types';
```

2. `CommandContext` gains:

```ts
  removals: RemovalLedger;
  remove: (entity: Readonly<IEntity>) => void;
  /** Buildings demolished earlier in this same drain: removal is deferred to
   * the post-step sync, so queries still see them — every lookup must not. */
  demolishedIds: Set<number>;
```

3. `findBuilding` gains the same-tick guard as its first line:

```ts
  if (ctx.demolishedIds.has(buildingId)) return null;
```

4. `handleUnassignWorker` gains ONLY the demolished-this-tick guard — not a
   full existence check. Demolition clears its workers' assignments, so
   without the guard a same-tick `unassignWorker` against the demolished id
   reports `No worker assigned to this building.` instead of the uniform
   `Building not found.`. But a worker whose assignment points at a
   long-gone building — the orphan the generic-name fallback exists for —
   must stay unassignable, so the handler must NOT consult `findBuilding`:
   the existing test `falls back to a generic name when the building an
   assignment points at is gone` keeps passing untouched. Its opening
   becomes:

```ts
export function handleUnassignWorker(ctx: CommandContext, command: Extract<Command, { type: 'unassignWorker' }>): void {
  if (ctx.demolishedIds.has(command.buildingId)) {
    ctx.notices.reject('Building not found.');
    return;
  }
  let found = false;
  // ... rest unchanged (orphaned assignments still clean up via the scan)
```

5. Append the handler:

```ts
export function handleDemolishBuilding(ctx: CommandContext, command: Extract<Command, { type: 'demolishBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const def = BUILDINGS[found.building.defId];
  // Full refund — flagged balance knob (increment 5 owns tuning). add() is
  // the one write path, so the refund shows in production stats; that is
  // deliberate visibility, not an accounting bug. Active batch progress is
  // simply lost with the entity.
  for (const [resource, amount] of Object.entries(def.cost)) {
    ctx.stockpile.add(resource as ResourceId, amount);
  }
  for (const { job } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
  }
  ctx.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.removals.dirty = true;
  ctx.notices.succeed(`Demolished the ${def.name} — cost refunded.`);
}
```

`src/engine/systems/command-system.ts`:

1. Add `RemovalLedger` to the resources import, `handleDemolishBuilding` to the handlers import.
2. System args gain `removals: WriteResource(RemovalLedger),`; the run destructuring gains `removals`.
3. The ctx literal gains:

```ts
      removals,
      remove: (entity) => actions.commands.removeEntity(entity),
      demolishedIds: new Set<number>(),
```

4. The switch gains:

```ts
        case 'demolishBuilding': handleDemolishBuilding(ctx, command); break;
```

`src/engine/game-engine.ts`:

1. Add `RemovalLedger` to the resources import.
2. In `runStep`, replace the refresh gate (and rewrite the `INVARIANT for increment 2` paragraph of the comment to record that RemovalLedger now closes it — removal consumes no id, so the demolish handler raises the flag and this gate consumes it):

```ts
      const removals = this.world.getResource(RemovalLedger);
      if (this.world.getResource(IdCounter).peek() !== idsBefore || removals.dirty) {
        removals.dirty = false;
        refreshEntitySections(this.world);
      }
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green — including the pinned `'Unassigned a worker from building.'` fallback test, now reachable in-game exactly as its comment predicted.

- [ ] **Step 5: Commit**

```bash
git add src/shared/commands.ts src/engine tests/engine
git commit -m "feat(engine): demolishBuilding — refund, worker release, removal-aware snapshot refresh"
```

---

### Task 6: moveBuilding

**Files:**
- Modify: `src/shared/commands.ts`
- Modify: `src/engine/systems/command-handlers.ts`
- Modify: `src/engine/systems/command-system.ts`
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: Task 4/5's `CommandContext`.
- Produces:

```ts
// src/shared/commands.ts
{ type: 'moveBuilding'; buildingId: number; to: { col: number; row: number } }
// src/engine/systems/command-handlers.ts
export function handleMoveBuilding(ctx, command): void;
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/systems/command-system.test.ts`:

```ts
  it('moves a building in place — same id, workers and batch intact, visible same tick', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Position is a component mutation, not a deferred entity command — the
    // same tick's snapshot already shows it.
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 9, row: 6, workers: 1 });
  });

  it('rejects moving to an occupied tile, its own tile, off-map, or a missing building', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 6, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 1, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId: 999, to: { col: 9, row: 9 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
    expect(snapshot().buildings[0]).toMatchObject({ col: 5, row: 5 }); // never moved
  });

  it('same-tick: a construction claims its tile before a later move can take it', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 7, row: 7 } },
      { type: 'moveBuilding', buildingId, to: { col: 7, row: 7 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: FAIL — `moveBuilding` is not a known command type.

- [ ] **Step 3: Implement**

`src/shared/commands.ts` — add:

```ts
  | { type: 'moveBuilding'; buildingId: number; to: { col: number; row: number } }
```

`src/engine/systems/command-handlers.ts` — append:

```ts
export function handleMoveBuilding(ctx: CommandContext, command: Extract<Command, { type: 'moveBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const { to } = command;
  // Own tile first: it IS occupied (by the mover), so isTileBuildable would
  // reject it anyway — the explicit check just makes the no-op reject
  // independent of that coincidence. occupiedTiles includes the mover's old
  // tile, which a move to any DIFFERENT tile never matches.
  const own = found.position.col === to.col && found.position.row === to.row;
  if (own || !isTileBuildable(ctx.map, occupiedTiles(ctx), to.col, to.row)) {
    ctx.notices.reject('Cannot move there.');
    return;
  }
  found.position.col = to.col;
  found.position.row = to.row;
  ctx.notices.succeed(`Moved the ${BUILDINGS[found.building.defId].name}.`);
}
```

`src/engine/systems/command-system.ts` — import `handleMoveBuilding`; the switch gains:

```ts
        case 'moveBuilding': handleMoveBuilding(ctx, command); break;
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/commands.ts src/engine/systems tests/engine/systems/command-system.test.ts
git commit -m "feat(engine): moveBuilding — relocate with workers, staffing, and batch intact"
```

---

### Task 7: Layout reads sim positions; fixed map; cell-exact pick

`layout.ts` stops deriving building positions (spec: "replacing the derived
layout"). Grid dims come from `snapshot.map`; the camp gains a contained
overflow band; `pickBuildingAt` becomes cell-exact (buildings become 1-tile
visuals in Task 9 — adjacency is legal now, so the old 1.5-tile hit box
would overlap neighbors). Worker slot machinery survives untouched.

**Files:**
- Modify: `src/app/world/layout.ts`
- Modify: `scripts/world-smoke-harness/main.ts` (fixtures gain positions + map)
- Test: `tests/app/world-layout.test.ts`

**Interfaces:**
- Consumes: `snapshot.map`, `BuildingSnapshot.col/row` (Task 2).
- Produces: `layoutWorld`, `pickBuildingAt`, `describePick`, `TILE`, `WorldLayout`, `PlacedBuilding`, `PlacedWorker`, `WorldPick` — signatures unchanged; only semantics move (Tasks 9 & 13 keep consuming them).

- [ ] **Step 1: Rewrite the derivation tests as position tests**

In `tests/app/world-layout.test.ts`:

1. DELETE these three tests (their subject — derived plot ranks — no longer exists): `'places buildings on distinct plots in id order, row-major'`, `'constructing a new building moves no existing placement'`, and the gutter clause of the pick test (step 3 below replaces it).
2. ADD:

```ts
  it('renders each building exactly at its snapshot tile', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 5, row: 2 }), makeBuilding(2, { col: 6, row: 2 })],
    }));
    expect(layout.buildings.map((b) => [b.id, b.col, b.row])).toEqual([[1, 5, 2], [2, 6, 2]]);
  });

  it('takes its dimensions from the snapshot map', () => {
    const layout = layoutWorld(makeSnapshot({ map: { cols: 30, rows: 20 } }));
    expect(layout.cols).toBe(30);
    expect(layout.rows).toBe(20);
  });

  it('a moved building takes its standing crew with it (same slots, new cell)', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 5, row: 3, workers: 2 })],
      workers: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 9, row: 7, workers: 2 })],
      workers: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }), before);
    for (const id of [10, 11]) {
      const was = before.workers.find((w) => w.id === id)!;
      const now = after.workers.find((w) => w.id === id)!;
      expect(now.slot).toBe(was.slot); // slot memory survives the move
      expect(now.x - was.x).toBeCloseTo(4); // 9 - 5
      expect(now.y - was.y).toBeCloseTo(4); // 7 - 3
    }
  });

  it('contains pathological idle crowds inside the camp band of the fixed map', () => {
    const crowd = Array.from({ length: 40 }, (_, i) => makeWorker(i + 1));
    const layout = layoutWorld(makeSnapshot({ workers: crowd }));
    const spots = new Set<string>();
    for (const w of layout.workers) {
      expect(w.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(3); // CAMP_COLS
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(layout.rows);
      spots.add(`${w.x},${w.y}`);
    }
    expect(spots.size).toBe(40);
  });
```

3. REPLACE the body of `'pickBuildingAt finds the tile under the cursor and nothing in the gutter'` (rename it to `'pickBuildingAt resolves the exact tile and nothing else'`):

```ts
    const layout = layoutWorld(makeSnapshot({ buildings: [makeBuilding(1, { col: 5, row: 2 })] }));
    expect(pickBuildingAt(layout, 5.5, 2.5)).toEqual({ kind: 'building', id: 1 });
    expect(pickBuildingAt(layout, 6.5, 2.5)).toBeNull();  // adjacent tile, no building
    expect(pickBuildingAt(layout, 4.99, 2.5)).toBeNull(); // one tile left
    expect(pickBuildingAt(layout, 5.5, layout.rows - 0.5)).toBeNull(); // empty grass
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/app/world-layout.test.ts`
Expected: FAIL — buildings land on derived plots, not their snapshot tiles; `cols` is 14, not 30.

- [ ] **Step 3: Rewrite the layout internals**

In `src/app/world/layout.ts`:

1. Replace the geography constant block (keep `TILE`; delete `PLOTS_PER_ROW`, `PLOT_COL0`, `PLOT_ROW0`, `MIN_ROWS`, `COLS`; keep `CAMP_COL0`, `CAMP_PER_ROW`) and update the header comment: geography is now sim truth (`snapshot.map`, `BuildingSnapshot.col/row`); only worker spots stay derived, id-keyed and slot-stable (spec §2.3 of increment 2 still governs them).
2. `placeBuildings` becomes a straight copy:

```ts
/** Buildings render exactly where the sim says they stand. */
function placeBuildings(snapshot: Snapshot): Map<number, PlacedBuilding> {
  const cellById = new Map<number, PlacedBuilding>();
  for (const b of snapshot.buildings) {
    cellById.set(b.id, {
      id: b.id, defId: b.defId, col: b.col, row: b.row,
      state: b.state, progressPct: b.progressPct, batchActive: b.batchActive,
    });
  }
  return cellById;
}
```

3. `campSpot` gains the fixed-map overflow band (and its callers pass `rows`):

```ts
/** Camp spots: two per row from the top of the band. Rosters past the
 * band's regular capacity take unique low-discrepancy spots on a bottom
 * shelf — even pathological idle crowds stay inside the fixed map. */
function campSpot(slot: number, rows: number): Spot {
  const capacity = CAMP_PER_ROW * (rows - 3);
  if (slot < capacity) {
    return { x: CAMP_COL0 + (slot % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(slot / CAMP_PER_ROW) };
  }
  return { x: CAMP_COL0 + 2 * vanDerCorput(slot - capacity + 1), y: rows - 0.75 };
}
```

4. `pickBuildingAt` becomes cell-exact (update its doc comment: buildings are 1-tile visuals now that adjacency is legal; workers are still hit-tested live by the renderer first):

```ts
export function pickBuildingAt(layout: WorldLayout, x: number, y: number): WorldPick | null {
  const col = Math.floor(x);
  const row = Math.floor(y);
  const b = layout.buildings.find((candidate) => candidate.col === col && candidate.row === row);
  return b ? { kind: 'building', id: b.id } : null;
}
```

5. In `layoutWorld`: destructure `const { cols, rows } = snapshot.map;` at the top; the camp placement line becomes `placements.set(id, { at: null, slot, spot: campSpot(slot, rows) });`; delete `maxCampSlot`, `plotRows`, `campRows` and the `rows` computation; the return becomes:

```ts
  return { tile: TILE, cols, rows, camp: CAMP_ANCHOR, buildings: [...cellById.values()], workers };
```

- [ ] **Step 4: Update the smoke-harness fixtures**

In `scripts/world-smoke-harness/main.ts` (not typechecked by `vue-tsc`, but the renderer now reads `snapshot.map` and `b.col` — stale fixtures would draw at NaN):

1. `building()` gains position parameters:

```ts
function building(id: number, defId: BuildingSnapshot['defId'], col: number, row: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId, col, row, workers: 0, workerSlots: 2, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0,
    ...overrides,
  };
}
```

2. `snap()` gains `map: { cols: 24, rows: 16 },` after `lastRecruitTick: -30,`.
3. Phase call sites: `building(1, 'forester', 4, 1, {...})`, `building(2, 'farm', 6, 1)` / `building(2, 'farm', 6, 1, {...})`, `building(3, 'sawmill', 8, 1)`.

- [ ] **Step 5: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green — every surviving slot-memory/overflow/camp test passes unchanged (worker machinery untouched), plus the new position tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/layout.ts scripts/world-smoke-harness/main.ts tests/app/world-layout.test.ts
git commit -m "feat(world): layout renders sim positions on the fixed map; cell-exact building pick"
```

---

### Task 8: Theme accent/danger + legend entries

**Files:**
- Modify: `src/app/world/theme.ts`
- Modify: `src/app/components/WorldLegend.vue`
- Modify: `styles.css`
- Test: `tests/app/world-theme.test.ts`, `tests/app/world-view.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WorldTheme.accent: string`, `WorldTheme.danger: string` (Task 9's renderer and the legend bind to them).

- [ ] **Step 1: Write the failing tests**

Append to the theme describe in `tests/app/world-theme.test.ts` (match its existing `resolveWorldTheme((name) => …)` reader style):

```ts
  it('resolves accent from --interactive-accent with a hex fallback', () => {
    const themed = resolveWorldTheme((name) => (name === '--interactive-accent' ? '#123abc' : ''));
    expect(themed.accent).toBe('#123abc');
    const fallback = resolveWorldTheme(() => '');
    expect(fallback.accent).toBe('#7c8cf0');
  });

  it('danger is the resolved red', () => {
    const themed = resolveWorldTheme((name) => (name === '--color-red' ? '#aa1122' : ''));
    expect(themed.danger).toBe('#aa1122');
    expect(themed.workerColors[0]).toBe('#aa1122'); // same source as starving-worker red
  });
```

In `tests/app/world-view.test.ts`, extend `'renders the encoding legend'`:

```ts
    expect(legend.text()).toContain('selected');
    expect(legend.text()).toContain('ghost: buildable');
    expect(legend.text()).toContain('ghost: blocked');
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/world-theme.test.ts tests/app/world-view.test.ts`
Expected: FAIL — `accent` is undefined; legend lacks the new entries.

- [ ] **Step 3: Implement**

`src/app/world/theme.ts`:

1. `WorldTheme` gains:

```ts
  /** Interactive accent — the selection ring and the valid-ghost tint. */
  accent: string;
  /** Danger — the blocked-ghost tint (the same resolved red the
   * starving-worker gradient starts from). */
  danger: string;
```

2. `resolveWorldTheme`'s returned object gains:

```ts
    accent: pick(read, '--interactive-accent', '#7c8cf0'),
    danger: red,
```

`src/app/components/WorldLegend.vue` — add before the `⛺ idle camp` span:

```html
      <span><i class="obsisim-chip" :style="{ borderColor: theme.accent }" /> selected</span>
      <span><i class="obsisim-chip is-ghost" :style="{ background: theme.accent }" /> ghost: buildable</span>
      <span><i class="obsisim-chip is-ghost" :style="{ background: theme.danger }" /> ghost: blocked</span>
```

`styles.css` — append beside the existing `.obsisim-chip` rules:

```css
.obsisim-chip.is-ghost {
  opacity: 0.55;
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/theme.ts src/app/components/WorldLegend.vue styles.css tests/app/world-theme.test.ts tests/app/world-view.test.ts
git commit -m "feat(world): accent/danger theme colors with legend entries for selection and ghost"
```

---

### Task 9: Renderer seam — tileAt, setGhost, setSelection

Three drawing-only additions to the seam; the adapter implements them and
building visuals shrink to one tile (adjacency is legal — the old 1.5-tile
rect would overlap neighbors). `renderer.ts` stays unit-test-exempt; the
Chromium smoke test gains ghost/selection phases.

**Files:**
- Modify: `src/app/world/renderer-key.ts`
- Modify: `src/app/world/renderer.ts`
- Modify: `tests/app/world-view.test.ts` (fake gains the three methods — typecheck)
- Modify: `scripts/world-smoke-harness/main.ts`, `scripts/world-smoke.mjs`

**Interfaces:**
- Consumes: `WorldTheme.accent/danger` (Task 8); `layout.cols/rows` (Task 7).
- Produces (Task 13 drives these exact signatures):

```ts
export interface GhostPreview { defId: BuildingDefId; col: number; row: number; valid: boolean }
interface WorldRenderer {
  // existing members unchanged, plus:
  tileAt(pageX: number, pageY: number): { col: number; row: number } | null;
  setGhost(ghost: GhostPreview | null): void;
  setSelection(buildingId: number | null): void;
}
```

- [ ] **Step 1: Extend the seam contract**

In `src/app/world/renderer-key.ts`, add the import and type, and the three members after `pick`:

```ts
import type { BuildingDefId } from '../../shared/content-types';
```

```ts
/** The translucent placement preview: a def's visual on a tile, tinted by
 * whether the placement would be accepted. */
export interface GhostPreview {
  defId: BuildingDefId;
  col: number;
  row: number;
  valid: boolean;
}
```

```ts
  /** The map tile under a pointer position (page coordinates), or null off-map. */
  tileAt(pageX: number, pageY: number): { col: number; row: number } | null;
  /** Show (or clear, with null) the placement preview. Drawing only — the
   * caller owns validity and mode logic. */
  setGhost(ghost: GhostPreview | null): void;
  /** Highlight a building (or clear, with null). The ring follows moves and
   * disappears with its building; the caller still owns selection state. */
  setSelection(buildingId: number | null): void;
```

- [ ] **Step 2: Update the fakes so typecheck stays green**

In `tests/app/world-view.test.ts`'s `makeFake`, the renderer literal gains:

```ts
    tileAt: vi.fn(() => null), setGhost: vi.fn(), setSelection: vi.fn(),
```

(Typecheck stays RED until Step 3 lands — `createExcaliburWorldRenderer` is
typed `WorldRendererFactory`, so the adapter must implement the members in
the same commit. Steps 1–3 are one red-green cycle.)

- [ ] **Step 3: Implement in the adapter**

In `src/app/world/renderer.ts`:

1. Visual constants — building visuals shrink to the cell (`BUILDING_SIZE` was `TILE * 1.5`; adjacency would overlap), progress bar fits inside:

```ts
const BUILDING_SIZE = TILE - 4;
const BAR_WIDTH = TILE * 0.8;
```

2. Import `GhostPreview` type from `./renderer-key`.
3. `WorldScene` gains ghost + selection state and methods (draw order note: ghost sits above buildings at z 4; the ring at z 2 above tiles/bars, below workers):

```ts
  private ghost: Actor | null = null;
  private ghostLooks = new Map<string, GraphicsGroup>();
  private selectionRing: Actor | null = null;
  private selectedId: number | null = null;
```

```ts
  setGhost(ghost: GhostPreview | null): void {
    if (ghost === null) {
      this.ghost?.kill();
      this.ghost = null;
      return;
    }
    if (this.ghost === null || this.ghost.isKilled()) {
      this.ghost = new Actor({ z: 4 });
      this.ghost.graphics.opacity = 0.55;
      this.engine.currentScene.add(this.ghost);
    }
    this.ghost.pos = vec((ghost.col + 0.5) * TILE, (ghost.row + 0.5) * TILE);
    this.ghost.graphics.use(this.ghostLook(ghost));
  }

  /** Ghost looks are cached per (def, validity), like building looks. */
  private ghostLook(ghost: GhostPreview): GraphicsGroup {
    const key = `${ghost.defId}/${ghost.valid}`;
    let group = this.ghostLooks.get(key);
    if (!group) {
      group = new GraphicsGroup({
        useAnchor: false,
        members: [
          {
            // Fill IS the feedback: accent when buildable, danger when not —
            // exactly the WorldLegend's ghost chips (spec: "accent-tinted
            // when valid"). The def's own color would read as an ordinary
            // translucent building; the glyph still says WHAT is placed.
            graphic: new Rectangle({
              width: BUILDING_SIZE, height: BUILDING_SIZE,
              color: Color.fromHex(ghost.valid ? this.theme.accent : this.theme.danger),
              strokeColor: Color.fromHex(ghost.valid ? this.theme.accent : this.theme.danger), lineWidth: 3,
            }),
            offset: vec(-BUILDING_SIZE / 2, -BUILDING_SIZE / 2),
          },
          {
            graphic: new Text({
              text: this.theme.buildingGlyph[ghost.defId],
              font: new Font({ family: 'sans-serif', size: 26, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
            }),
            offset: vec(0, 0),
            useBounds: false,
          },
        ],
      });
      this.ghostLooks.set(key, group);
    }
    return group;
  }

  setSelection(buildingId: number | null): void {
    this.selectedId = buildingId;
    this.applySelection();
  }

  /** Re-applied on every sync: the ring follows a moved building and dies
   * with a demolished one (the view also clears its own selection state). */
  private applySelection(): void {
    const cell = this.selectedId === null
      ? undefined
      : this.lastLayout?.buildings.find((b) => b.id === this.selectedId);
    if (!cell) {
      this.selectionRing?.kill();
      this.selectionRing = null;
      return;
    }
    if (this.selectionRing === null || this.selectionRing.isKilled()) {
      this.selectionRing = new Actor({ z: 2 });
      this.selectionRing.graphics.use(new Rectangle({
        width: TILE, height: TILE, color: Color.Transparent,
        strokeColor: Color.fromHex(this.theme.accent), lineWidth: 3,
      }));
      this.engine.currentScene.add(this.selectionRing);
    }
    this.selectionRing.pos = vec((cell.col + 0.5) * TILE, (cell.row + 0.5) * TILE);
  }
```

4. `upsertBuilding` gains a position update as its second line — buildings can
   MOVE now, and today's renderer assigns `root.pos` only in `spawnBuilding`,
   which would leave the actor drawn at the old tile while the snapshot,
   hit-testing, selection ring, and workers all move to the new one:

```ts
  private upsertBuilding(b: PlacedBuilding): void {
    const bundle = this.buildings.get(b.id) ?? this.spawnBuilding(b);
    bundle.root.pos = vec((b.col + 0.5) * TILE, (b.row + 0.5) * TILE); // moves snap to the new tile
    // ... rest unchanged
```

5. `sync()` gains `this.applySelection();` as its last line; `clear()` additionally kills ghost and ring (`this.setGhost(null); this.selectionRing?.kill(); this.selectionRing = null;` — selectedId survives; the view decides).
6. The factory's returned object gains:

```ts
    tileAt(pageX, pageY) {
      if (disposed || last === undefined) return null;
      const world = engine.screen.pageToWorldCoordinates(vec(pageX, pageY));
      const col = Math.floor(world.x / TILE);
      const row = Math.floor(world.y / TILE);
      return col >= 0 && col < last.cols && row >= 0 && row < last.rows ? { col, row } : null;
    },
    setGhost(ghost) {
      if (!disposed) scene.setGhost(ghost);
    },
    setSelection(buildingId) {
      if (!disposed) scene.setSelection(buildingId);
    },
```

- [ ] **Step 4: Extend the smoke test**

`scripts/world-smoke-harness/main.ts` — the harness helper is already
positional after Task 7 (`building(id, defId, col, row, overrides?)`, with
the grow-phase colony at forester 4,1 / farm 6,1 / sawmill 8,1); every
phase added here uses that exact signature — the harness is not
typechecked, so a mismatched call would surface only as NaN actor
positions at runtime. The phase array gains four entries before the reset
phases (final order: 0 first colony, 1 walk, 2 stop, 3 start, 4 grow,
**5 building moved, 6 ghost+selection on, 7 ghost invalid,
8 ghost+selection off**, 9 reset, 10 same-tick reset, 11 dispose):

```ts
  // the WORKERLESS sawmill moves from (8,1) to a fresh tile: with no worker
  // target changing, the only thing that may alter the frame is the building
  // actor itself — which is exactly what this phase exists to catch (its
  // position must be re-applied on every sync, not only at spawn)
  () => renderer.sync(snap(4,
    [building(1, 'forester', 4, 1, { workers: 2, state: 'producing', batchActive: true, progressPct: 90 }), building(2, 'farm', 6, 1, { workers: 1, state: 'producing', batchActive: true, progressPct: 10 }), building(3, 'sawmill', 14, 7)],
    [worker(10, { buildingId: 1, toolTicks: 100 }), worker(11, { buildingId: 1, efficiency: 0.3 }), worker(12, { buildingId: 2 }), worker(13)])),
  () => {
    renderer.setGhost({ defId: 'bakery', col: 10, row: 5, valid: true });
    renderer.setSelection(1);
  },
  () => renderer.setGhost({ defId: 'bakery', col: 10, row: 5, valid: false }),
  () => {
    renderer.setGhost(null);
    renderer.setSelection(null);
  },
```

`scripts/world-smoke.mjs` — after the `start() resumes` check, insert (and renumber the later `step(5)`/`step(6)`/`step(7)` calls to `step(9)`/`step(10)`/`step(11)`):

```js
await wait(400); // let the grow phase's frame settle first
const preMove = await shot();
await step(5); // the workerless sawmill moves to a fresh tile
await wait(300); // no walk to wait out — the building snaps
const moved = await shot();
check('a moved building is drawn at its new tile (no worker motion to hide behind)', !moved.equals(preMove));

const preGhost = await shot();
await step(6); // ghost + selection on
await wait(300);
const ghostOn = await shot();
check('setGhost + setSelection draw over the scene', !ghostOn.equals(preGhost));

await step(7); // same tile, invalid tint
await wait(300);
const ghostInvalid = await shot();
check('an invalid ghost reads differently from a valid one', !ghostInvalid.equals(ghostOn));

await step(8); // both cleared
await wait(300);
const ghostOff = await shot();
check('clearing ghost and selection restores the scene', ghostOff.equals(preGhost));
```

(The moved-building check is screenshot-based like its neighbors, and it
isolates the actor: the sawmill has no workers, so no worker target changes
in phase 5 and the settled frame can only differ if the building actor
itself moved. The phase's `snap(4, …)` follows the grow phase's
`snap(3, …)` — a normal next tick, safely clear of the same-or-earlier-tick
reset signal.)

- [ ] **Step 5: Run suite + optional smoke**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

Optional (needs Chromium + `npm i --no-save playwright-core`): `npm run smoke:world`
Expected: `world-smoke: all green` including the three new checks.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/renderer-key.ts src/app/world/renderer.ts tests/app/world-view.test.ts scripts/world-smoke-harness/main.ts scripts/world-smoke.mjs
git commit -m "feat(world): renderer seam gains tileAt/setGhost/setSelection; one-tile building visuals"
```

---

### Task 10: `affordableDefs` store getter; `costLabel` moves to labels

The palette (Task 11) needs both; duplicating them from `BuildingsView`
would trip fallow's clone gate. So they move to shared homes first and
`BuildingsView` consumes them — behavior identical.

**Files:**
- Modify: `src/app/stores/game-store.ts`
- Modify: `src/app/labels.ts`
- Modify: `src/app/views/BuildingsView.vue`
- Test: `tests/app/game-store.test.ts`

**Interfaces:**
- Produces:

```ts
// game-store getter
affordableDefs(state): Record<BuildingDefId, boolean>
// src/app/labels.ts
export function costLabel(cost: CostMap): string
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/game-store.test.ts` (inside its top-level describe, matching the file's existing store-creation + `ingest` pattern — reuse whatever pinia setup its sibling getter tests use):

```ts
  it('affordableDefs reflects the stockpile per def', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ stockpile: stockedWith({ wood: 10 }) }), { paused: true, speed: 1, error: null });
    expect(store.affordableDefs.forester).toBe(true);  // costs 10 wood
    expect(store.affordableDefs.farm).toBe(false);     // costs 20 wood
    expect(store.affordableDefs.workshop).toBe(false); // costs 20 planks
  });

  it('affordableDefs is all-false before the first snapshot', () => {
    expect(useGameStore().affordableDefs.forester).toBe(false);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/game-store.test.ts`
Expected: FAIL — `affordableDefs` is undefined.

- [ ] **Step 3: Implement**

`src/app/stores/game-store.ts` — add `BUILDINGS, BUILDING_IDS` to the existing `../../engine/content` import; add the getter (verbatim move of `BuildingsView`'s computed):

```ts
    /** One affordability flag per catalog def — the construct table and the
     * build palette bind to this, so the check exists exactly once. */
    affordableDefs(state): Record<BuildingDefId, boolean> {
      const snapshot = state.snapshot;
      return Object.fromEntries(
        BUILDING_IDS.map((id) => [
          id,
          snapshot !== null &&
            Object.entries(BUILDINGS[id].cost).every(
              ([res, amount]) => snapshot.stockpile[res as ResourceId].stock >= amount,
            ),
        ]),
      ) as Record<BuildingDefId, boolean>;
    },
```

`src/app/labels.ts` — add:

```ts
import { RESOURCES, type CostMap, type ResourceId } from '../engine/content';

/** "10 Wood, 5 Planks" — shared by the construct table and the build palette. */
export function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}
```

`src/app/views/BuildingsView.vue` — delete the local `costLabel` function and the `affordable` computed (and the now-unused `computed`, `RESOURCES`, `CostMap`, `ResourceId` imports); import `costLabel` beside `BUILDING_STATE_LABELS` from `../labels`; replace both `affordable[id]` template references with `store.affordableDefs[id]`.

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green — `buildings-view.test.ts`'s affordability cases pass unchanged against the getter.

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/game-store.ts src/app/labels.ts src/app/views/BuildingsView.vue tests/app/game-store.test.ts
git commit -m "refactor(app): affordability and cost labels move to shared homes for the palette"
```

---

### Task 11: TwoStepButton + BuildPalette components

**Files:**
- Create: `src/app/components/TwoStepButton.vue`
- Create: `src/app/components/BuildPalette.vue`
- Modify: `styles.css`
- Test: `tests/app/build-palette.test.ts` (covers both — the confirm button's own flows are pinned by SelectionPanel/BuildingsView tests where it's consumed)

**Interfaces:**
- Consumes: `affordableDefs`, `costLabel` (Task 10).
- Produces (Tasks 12–14 rely on these):

```ts
// TwoStepButton props: { label: string; confirmLabel: string; dataTest: string }, emits: confirm
// BuildPalette props: { armedDefId: BuildingDefId | null }, emits: arm(defId), disarm
```

- [ ] **Step 1: Write the failing tests**

Create `tests/app/build-palette.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildPalette from '../../src/app/components/BuildPalette.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot, stockedWith } from './fixtures';

function mountPalette(armedDefId: string | null = null, wood = 100) {
  const wrapper = mount(BuildPalette, {
    props: { armedDefId },
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().ingest(
    makeSnapshot({ stockpile: stockedWith({ wood }) }),
    { paused: true, speed: 1, error: null },
  );
  return wrapper;
}

describe('BuildPalette', () => {
  it('lists every def and emits arm with the clicked id', async () => {
    const wrapper = mountPalette();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    expect(wrapper.emitted('arm')).toEqual([['forester']]);
  });

  it('emits disarm when the armed def is clicked again, and marks it armed', async () => {
    const wrapper = mountPalette('forester');
    await wrapper.vm.$nextTick();
    const button = wrapper.find('[data-test="palette-forester"]');
    expect(button.classes()).toContain('is-armed');
    await button.trigger('click');
    expect(wrapper.emitted('disarm')).toHaveLength(1);
    expect(wrapper.emitted('arm')).toBeUndefined();
  });

  it('disables unaffordable defs (but never the armed one)', async () => {
    const wrapper = mountPalette(null, 0);
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="palette-forester"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/build-palette.test.ts`
Expected: FAIL — module `BuildPalette.vue` not found.

- [ ] **Step 3: Implement the components**

Create `src/app/components/TwoStepButton.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';

// A click-to-confirm button: first click arms ("Confirm …?"), second click
// emits. Shared by canvas demolish and table demolish so the guard exists
// once. MouseEvent.detail > 1 is the second click of a double-click — it
// must not fall through the arm step straight to confirm (the colony-reset
// guard, same reasoning). Blur disarms so a wandering click can't confirm
// something armed long ago.
defineProps<{ label: string; confirmLabel: string; dataTest: string }>();
const emit = defineEmits<{ confirm: [] }>();
const armed = ref(false);

function onClick(event: MouseEvent) {
  if (event.detail > 1) return;
  if (!armed.value) {
    armed.value = true;
    return;
  }
  armed.value = false;
  emit('confirm');
}
</script>

<template>
  <button :data-test="dataTest" :class="{ 'is-armed': armed }" @click="onClick" @blur="armed = false">
    {{ armed ? confirmLabel : label }}
  </button>
</template>
```

Create `src/app/components/BuildPalette.vue`:

```vue
<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS, type BuildingDefId } from '../../engine/content';
import { costLabel } from '../labels';
import { BUILDING_GLYPHS } from '../world/theme';

// The construct catalog as canvas-side buttons: click arms placement mode
// (the parent owns the mode), click again disarms. Arming is gated on
// affordability; STAYING armed is not — stock can drain under an armed
// palette, and the engine is the authority that rejects with a notice.
const props = defineProps<{ armedDefId: BuildingDefId | null }>();
const emit = defineEmits<{ arm: [defId: BuildingDefId]; disarm: [] }>();
const store = useGameStore();

function toggle(id: BuildingDefId) {
  if (props.armedDefId === id) emit('disarm');
  else emit('arm', id);
}
</script>

<template>
  <div class="obsisim-build-palette" data-test="build-palette">
    <button
      v-for="id in BUILDING_IDS"
      :key="id"
      :data-test="`palette-${id}`"
      :class="{ 'is-armed': armedDefId === id }"
      :disabled="armedDefId !== id && !store.affordableDefs[id]"
      @click="toggle(id)"
    >
      <span>{{ BUILDING_GLYPHS[id] }} {{ BUILDINGS[id].name }}</span>
      <span class="obsisim-palette-cost">{{ costLabel(BUILDINGS[id].cost) }}</span>
    </button>
  </div>
</template>
```

(The spec requires name, **glyph, and cost visible on the button** — a
hover-only `title` fails touch-oriented Obsidian, so the cost is a second
line and the `title` is dropped. `theme.ts` renames its private
`BUILDING_GLYPH` map to an exported `BUILDING_GLYPHS`, consumed by
`resolveWorldTheme` and the palette — one glyph source for canvas and DOM.)

`styles.css` — append:

```css
.obsisim-build-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.obsisim-build-palette button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.obsisim-palette-cost {
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}

.obsisim-build-palette .is-armed,
.obsisim-selection-panel .is-armed {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}

/* the armed/accent state must also recolor the cost line for contrast */
.obsisim-build-palette .is-armed .obsisim-palette-cost {
  color: var(--text-on-accent);
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green. (TwoStepButton is consumed in Tasks 12/14; if `check:quality` is probed between, its dead-export finding is the documented intermediate state.)

- [ ] **Step 5: Commit**

```bash
git add src/app/components/TwoStepButton.vue src/app/components/BuildPalette.vue styles.css tests/app/build-palette.test.ts
git commit -m "feat(app): build palette and shared two-step confirm button"
```

---

### Task 12: SelectionPanel component

**Files:**
- Create: `src/app/components/SelectionPanel.vue`
- Test: `tests/app/selection-panel.test.ts`

**Interfaces:**
- Consumes: `TwoStepButton` (Task 11); `BuildingSnapshot.col/row` (Task 2); `BUILDING_STATE_LABELS` (existing).
- Produces: props `{ buildingId: number }`, emits `move`, `demolish`, `close` (Task 13 wires them).

- [ ] **Step 1: Write the failing tests**

Create `tests/app/selection-panel.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import SelectionPanel from '../../src/app/components/SelectionPanel.vue';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeBuilding, makeSnapshot } from './fixtures';

function mountPanel(buildingId = 7) {
  const wrapper = mount(SelectionPanel, {
    props: { buildingId },
    global: { plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })] },
  });
  useGameStore().ingest(makeSnapshot({
    buildings: [makeBuilding(7, {
      defId: 'bakery', col: 6, row: 3, workers: 1, workerSlots: 2, state: 'producing',
    })],
  }), { paused: true, speed: 1, error: null });
  return wrapper;
}

describe('SelectionPanel', () => {
  it('shows the selected building: name, tile, staffing, state label', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    const panel = wrapper.find('[data-test="selection-panel"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('Bakery');
    expect(panel.text()).toContain('(6, 3)');
    expect(panel.text()).toContain('1/2 workers');
    expect(panel.text()).toContain('Producing');
  });

  it('emits move and close', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="selection-move"]').trigger('click');
    expect(wrapper.emitted('move')).toHaveLength(1);
    await wrapper.find('[data-test="selection-close"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('demolish emits only after the two-step confirm, and never on a double-click', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    const demolish = wrapper.find('[data-test="selection-demolish"]');
    await demolish.trigger('click');
    expect(wrapper.emitted('demolish')).toBeUndefined();
    expect(demolish.text()).toContain('Confirm');
    await demolish.trigger('click', { detail: 2 }); // double-click bypass attempt
    expect(wrapper.emitted('demolish')).toBeUndefined();
    await demolish.trigger('click');
    expect(wrapper.emitted('demolish')).toHaveLength(1);
  });

  it('renders nothing once the building has left the snapshot', async () => {
    const wrapper = mountPanel();
    await wrapper.vm.$nextTick();
    useGameStore().ingest(makeSnapshot({ buildings: [] }), { paused: true, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/selection-panel.test.ts`
Expected: FAIL — module `SelectionPanel.vue` not found.

- [ ] **Step 3: Implement**

Create `src/app/components/SelectionPanel.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS } from '../../engine/content';
import { BUILDING_STATE_LABELS } from '../labels';
import TwoStepButton from './TwoStepButton.vue';

// The selected building's live card, derived from the current snapshot by
// id — staffing, state, and tile stay fresh as ticks arrive, and the card
// vanishes by itself if the building does (the parent also clears its
// selection state reactively; both guards are cheap).
const props = defineProps<{ buildingId: number }>();
const emit = defineEmits<{ move: []; demolish: []; close: [] }>();
const store = useGameStore();

const building = computed(
  () => store.snapshot?.buildings.find((b) => b.id === props.buildingId) ?? null,
);
</script>

<template>
  <div v-if="building" class="obsisim-selection-panel" data-test="selection-panel">
    <strong>{{ BUILDINGS[building.defId].name }}</strong>
    <span>({{ building.col }}, {{ building.row }})</span>
    <span>{{ building.workers }}/{{ building.workerSlots }} workers — {{ BUILDING_STATE_LABELS[building.state] }}</span>
    <button data-test="selection-move" @click="emit('move')">Move</button>
    <TwoStepButton label="Demolish" confirm-label="Confirm demolish?" data-test="selection-demolish" @confirm="emit('demolish')" />
    <button data-test="selection-close" title="Deselect" @click="emit('close')">✕</button>
  </div>
</template>
```

`styles.css` — append:

```css
.obsisim-selection-panel {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/SelectionPanel.vue styles.css tests/app/selection-panel.test.ts
git commit -m "feat(app): selection panel with move and confirmed demolish"
```

---

### Task 13: WorldView interaction wiring (the mode machine)

The view owns all mode logic: `idle` / `place(defId)` / `move(buildingId)`.
The renderer only ever draws what it's told. This task rewrites
`WorldView.vue` in full — the file grows to ~230 lines (cap is 500).

**Files:**
- Modify: `src/app/views/WorldView.vue`
- Test: `tests/app/world-view.test.ts`

**Interfaces:**
- Consumes: `tileAt`/`setGhost`/`setSelection` (Task 9), `BuildPalette` (11), `SelectionPanel` (12), `isTileBuildable` (1), `affordableDefs` (10), `constructBuilding.at`/`moveBuilding`/`demolishBuilding` (4–6), `ENGINE_KEY` (existing).
- Produces: the user-facing feature; no new exports.

- [ ] **Step 1: Extend the test harness and write the failing interaction tests**

In `tests/app/world-view.test.ts`:

1. `mountHarness` gains an engine stub (WorldView now injects `ENGINE_KEY`), and imports it:

```ts
import { ENGINE_KEY } from '../../src/app/engine-key';
```

```ts
function mountHarness(factory: unknown) {
  const active = ref(true);
  const engine = { dispatch: vi.fn() };
  const Harness = defineComponent({
    setup: () => () => h(KeepAlive, null, [active.value ? h(WorldView) : null]),
  });
  const wrapper = mount(Harness, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: {
        [WORLD_RENDERER_KEY as symbol]: factory,
        [ENGINE_KEY as symbol]: engine,
      },
    },
  });
  return { wrapper, active, engine };
}
```

(The direct `mount(WorldView, …)` in `'syncs an already-present snapshot immediately on mount'` gains the same `[ENGINE_KEY as symbol]: { dispatch: vi.fn() }` provide entry.)

2. Add a snapshot helper + new describe at the end of the file:

```ts
describe('WorldView interaction', () => {
  const richSnapshot = (buildings = [makeBuilding(7, { defId: 'bakery', col: 6, row: 3 })]) =>
    makeSnapshot({ buildings, stockpile: stockedWith({ wood: 100, planks: 100 }) });

  function armedHarness(tile: { col: number; row: number } | null = { col: 8, row: 4 }) {
    const { renderer, factory } = makeFake();
    (renderer.tileAt as ReturnType<typeof vi.fn>).mockReturnValue(tile);
    const mounted = mountHarness(factory);
    useGameStore().ingest(richSnapshot(), { paused: false, speed: 1, error: null });
    return { renderer, ...mounted };
  }

  it('arms from the palette, previews the ghost, and constructs at the clicked tile — staying armed', async () => {
    const { renderer, wrapper, engine } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 8, row: 4, valid: true });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({
      type: 'constructBuilding', buildingDefId: 'forester', at: { col: 8, row: 4 },
    });
    expect(wrapper.find('[data-test="palette-forester"]').classes()).toContain('is-armed');
  });

  it('previews an invalid ghost on an occupied tile and dispatches nothing there', async () => {
    const { renderer, wrapper, engine } = armedHarness({ col: 6, row: 3 }); // the bakery's tile
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'forester', col: 6, row: 3, valid: false });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).not.toHaveBeenCalled();
  });

  it('suppresses hover tooltips while armed', async () => {
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="world-tooltip"]').exists()).toBe(false);
  });

  it('Escape and right-click both disarm and clear the ghost', async () => {
    const { renderer, wrapper } = armedHarness();
    await nextTick();
    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(wrapper.find('[data-test="palette-forester"]').classes()).not.toContain('is-armed');
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);

    await wrapper.find('[data-test="palette-forester"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('contextmenu');
    expect(wrapper.find('[data-test="palette-forester"]').classes()).not.toContain('is-armed');
  });

  it('clicking a building selects it; the panel demolishes after confirm', async () => {
    const { renderer, wrapper, engine } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(renderer.setSelection).toHaveBeenLastCalledWith(7);
    const demolish = wrapper.find('[data-test="selection-demolish"]');
    await demolish.trigger('click');
    await demolish.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
  });

  it('move flow: Move arms with the building def, a valid click dispatches and keeps the selection', async () => {
    const { renderer, wrapper, engine } = armedHarness({ col: 9, row: 6 });
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select
    await wrapper.find('[data-test="selection-move"]').trigger('click');
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    expect(renderer.setGhost).toHaveBeenLastCalledWith({ defId: 'bakery', col: 9, row: 6, valid: true });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'moveBuilding', buildingId: 7, to: { col: 9, row: 6 } });
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
  });

  it('selection clears reactively when its building vanishes', async () => {
    const { renderer, wrapper } = armedHarness();
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(true);
    useGameStore().ingest(makeSnapshot({ buildings: [], stockpile: stockedWith({ wood: 100 }) }), { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.setSelection).toHaveBeenLastCalledWith(null);
    expect(wrapper.find('[data-test="selection-panel"]').exists()).toBe(false);
  });

  it('closing the panel disarms an armed move — no ghost, no dispatch afterwards', async () => {
    // the armed move belongs to the selection it came from: without the
    // cancel, an invisible move keeps previewing and clicking the canvas
    // still dispatches moveBuilding for the deselected building
    const { renderer, wrapper, engine } = armedHarness({ col: 9, row: 6 });
    (renderer.pick as ReturnType<typeof vi.fn>).mockReturnValue({ kind: 'building', id: 7 });
    await nextTick();
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 }); // select
    await wrapper.find('[data-test="selection-move"]').trigger('click'); // arm move
    await wrapper.find('[data-test="selection-close"]').trigger('click');
    expect(renderer.setGhost).toHaveBeenLastCalledWith(null);
    (engine.dispatch as ReturnType<typeof vi.fn>).mockClear();
    await wrapper.find('[data-test="world-host"]').trigger('pointermove', { pageX: 40, pageY: 40 });
    await wrapper.find('[data-test="world-host"]').trigger('click', { pageX: 40, pageY: 40 });
    expect(engine.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'moveBuilding' }));
  });
});
```

(`stockedWith` joins the existing `makeSnapshot` import from `./fixtures`,
plus `makeBuilding` from Task 2.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/world-view.test.ts`
Expected: FAIL — no palette in the DOM (`palette-forester` not found).

- [ ] **Step 3: Rewrite `src/app/views/WorldView.vue`**

Replace the `<script setup>` block with:

```ts
import { computed, inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../stores/game-store';
import { ENGINE_KEY } from '../engine-key';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';
import { describePick, type WorldPick } from '../world/layout';
import { isTileBuildable } from '../../shared/placement';
import type { BuildingDefId } from '../../shared/content-types';
import WorldLegend from '../components/WorldLegend.vue';
import BuildPalette from '../components/BuildPalette.vue';
import SelectionPanel from '../components/SelectionPanel.vue';

// Lifecycle contract (increment 2 spec §2.2) unchanged: kept alive across
// tab switches, renderer created once per game-view open. NEW (increment 3
// spec §2.6): this view owns the interaction mode machine — idle / place /
// move — plus the selection; the renderer stays a dumb drawer behind the
// seam and the ENGINE stays the authority (a stale ghost just means the
// engine rejects with a notice).

defineOptions({ name: 'WorldView' }); // keep-alive include matches on this name
type Mode =
  | { kind: 'idle' }
  | { kind: 'place'; defId: BuildingDefId }
  | { kind: 'move'; buildingId: number };

const store = useGameStore();
const engine = inject(ENGINE_KEY)!;
const factory = inject(WORLD_RENDERER_KEY, null);
const host = ref<HTMLElement | null>(null);
const failure = ref<string | null>(null);
const hover = ref<{ x: number; y: number; pageX: number; pageY: number; pick: WorldPick } | null>(null);
const mode = ref<Mode>({ kind: 'idle' });
const selectedId = ref<number | null>(null);
/** Last tile the pointer hovered while a mode was armed — the ghost target. */
const lastTile = ref<{ col: number; row: number } | null>(null);
let renderer: WorldRenderer | null = null;
let hoverRecheck: ReturnType<typeof setTimeout> | null = null;

const armedDefId = computed(() => (mode.value.kind === 'place' ? mode.value.defId : null));

const hoverLines = computed(() => {
  if (!hover.value || !store.snapshot) return [];
  return describePick(store.snapshot, hover.value.pick);
});

/** The def a ghost previews: the armed def, or the moved building's own. */
function ghostDefId(m: Mode): BuildingDefId | null {
  if (m.kind === 'place') return m.defId;
  if (m.kind === 'move') {
    return store.snapshot?.buildings.find((b) => b.id === m.buildingId)?.defId ?? null;
  }
  return null;
}

// Cosmetic pre-validation only — the engine revalidates and rejects with a
// notice, so a ghost can be wrong for at most one tick. A move's own tile
// counts as occupied (by the mover), which matches the engine's reject.
function tileValid(m: Mode, col: number, row: number): boolean {
  const snapshot = store.snapshot;
  if (!snapshot) return false;
  if (!isTileBuildable(snapshot.map, snapshot.buildings, col, row)) return false;
  if (m.kind === 'place') return store.affordableDefs[m.defId];
  return true;
}

function refreshGhost() {
  if (!renderer) return;
  const m = mode.value;
  const defId = ghostDefId(m);
  if (m.kind === 'idle' || defId === null || lastTile.value === null) {
    renderer.setGhost(null);
    return;
  }
  const { col, row } = lastTile.value;
  renderer.setGhost({ defId, col, row, valid: tileValid(m, col, row) });
}

function cancelMode() {
  mode.value = { kind: 'idle' };
  lastTile.value = null;
  renderer?.setGhost(null);
}

function select(buildingId: number | null) {
  selectedId.value = buildingId;
  renderer?.setSelection(buildingId);
}

function closeSelection() {
  // An armed move belongs to the selection it came from: closing the panel
  // must disarm it, or an invisible move keeps previewing and a canvas
  // click still dispatches moveBuilding for the deselected building.
  if (mode.value.kind === 'move') cancelMode();
  select(null);
}

function armHoverRecheck() {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  hoverRecheck = setTimeout(() => revalidateHover(false), 2000);
}

function revalidateHover(scheduleTail: boolean) {
  if (!hover.value || !renderer) return;
  const fresh = renderer.pick(hover.value.pageX, hover.value.pageY);
  if (!fresh) {
    hover.value = null;
    return;
  }
  hover.value = { ...hover.value, pick: fresh };
  if (scheduleTail) armHoverRecheck();
}

function onPointerMove(event: MouseEvent) {
  if (mode.value.kind !== 'idle') {
    // armed: the ghost is the feedback — tooltips would fight it
    hover.value = null;
    lastTile.value = renderer?.tileAt(event.pageX, event.pageY) ?? null;
    refreshGhost();
    return;
  }
  const pick = renderer?.pick(event.pageX, event.pageY) ?? null;
  if (!pick || !host.value) {
    hover.value = null;
    return;
  }
  const rect = host.value.getBoundingClientRect();
  hover.value = {
    x: event.clientX - rect.left + 14,
    y: event.clientY - rect.top + 14,
    pageX: event.pageX,
    pageY: event.pageY,
    pick,
  };
  armHoverRecheck();
}

function onPointerLeave() {
  hover.value = null;
  // a ghost left floating at the last hovered tile would outlive the pointer
  lastTile.value = null;
  refreshGhost();
}

function onClick(event: MouseEvent) {
  if (!renderer) return;
  const m = mode.value;
  if (m.kind === 'place' || m.kind === 'move') {
    const tile = renderer.tileAt(event.pageX, event.pageY);
    if (!tile || !tileValid(m, tile.col, tile.row)) return;
    if (m.kind === 'place') {
      // stays armed — Banished-style repeat placement (Escape/right-click/
      // palette-toggle disarm)
      engine.dispatch({ type: 'constructBuilding', buildingDefId: m.defId, at: tile });
    } else {
      engine.dispatch({ type: 'moveBuilding', buildingId: m.buildingId, to: tile });
      cancelMode(); // back to idle; the selection stays on the moved building
    }
    return;
  }
  const pick = renderer.pick(event.pageX, event.pageY);
  select(pick?.kind === 'building' ? pick.id : null);
}

function onContextMenu(event: MouseEvent) {
  if (mode.value.kind === 'idle') return;
  event.preventDefault();
  cancelMode();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (mode.value.kind !== 'idle') cancelMode();
  else select(null);
}

// Window-level Escape, registered only while something is cancellable —
// Obsidian owns the key otherwise.
let escapeListening = false;
watch([mode, selectedId], () => {
  const needed = mode.value.kind !== 'idle' || selectedId.value !== null;
  if (needed && !escapeListening) window.addEventListener('keydown', onKeydown);
  if (!needed && escapeListening) window.removeEventListener('keydown', onKeydown);
  escapeListening = needed;
});

function onArm(defId: BuildingDefId) {
  mode.value = { kind: 'place', defId };
  select(null); // a selection under an armed palette would double-claim clicks
}

function onMoveRequest() {
  if (selectedId.value !== null) mode.value = { kind: 'move', buildingId: selectedId.value };
}

function onDemolish() {
  if (selectedId.value !== null) engine.dispatch({ type: 'demolishBuilding', buildingId: selectedId.value });
}

onMounted(() => {
  if (!factory) {
    failure.value = 'no renderer is registered';
    return;
  }
  try {
    const created = factory(host.value!);
    renderer = created;
    created.onFatal((message) => {
      failure.value = message;
      renderer = null;
    });
    watch(
      () => store.snapshot,
      (snapshot) => {
        if (snapshot) created.sync(snapshot);
        revalidateHover(true);
        // id-based, reactive lifecycles: selection and move-mode die with
        // their building (demolition, colony reset)
        const m = mode.value;
        if (selectedId.value !== null && !snapshot?.buildings.some((b) => b.id === selectedId.value)) {
          select(null);
        }
        if (m.kind === 'move' && !snapshot?.buildings.some((b) => b.id === m.buildingId)) {
          cancelMode();
        }
        refreshGhost(); // occupancy/affordability may have moved under a stationary pointer
      },
      { immediate: true },
    );
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
    renderer = null;
  }
});
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
onBeforeUnmount(() => {
  if (hoverRecheck !== null) clearTimeout(hoverRecheck);
  if (escapeListening) window.removeEventListener('keydown', onKeydown);
  renderer?.dispose();
  renderer = null;
});
```

(The original file's explanatory comments about keep-alive, the reactive
tooltip, and the stationary-hover recheck carry over verbatim where the
functions they describe survived — only `onPointerMove` gained the armed
branch.)

Replace the `<template>` with:

```html
<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). The table views keep working.
  </div>
  <div v-else class="obsisim-world">
    <BuildPalette :armed-def-id="armedDefId" @arm="onArm" @disarm="cancelMode" />
    <div
      ref="host"
      class="obsisim-world-host"
      data-test="world-host"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @click="onClick"
      @contextmenu="onContextMenu"
    />
    <div
      v-if="hover && hoverLines.length > 0"
      class="obsisim-world-tooltip"
      data-test="world-tooltip"
      :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
    >
      <div v-for="line in hoverLines" :key="line">{{ line }}</div>
    </div>
    <SelectionPanel
      v-if="selectedId !== null"
      :building-id="selectedId"
      @move="onMoveRequest"
      @demolish="onDemolish"
      @close="closeSelection"
    />
    <WorldLegend />
  </div>
</template>
```

- [ ] **Step 4: Run the target file, then the full suite**

Run: `npx vitest run tests/app/world-view.test.ts`
Expected: PASS — all pre-existing lifecycle/tooltip tests plus the new interaction describe.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/WorldView.vue tests/app/world-view.test.ts
git commit -m "feat(world): place, move, demolish from the canvas — mode machine, ghost, selection"
```

---

### Task 14: Buildings table parity — Tile column and Demolish

**Files:**
- Modify: `src/app/views/BuildingsView.vue`
- Test: `tests/app/buildings-view.test.ts`

**Interfaces:**
- Consumes: `TwoStepButton` (Task 11), `demolishBuilding` (Task 5), `BuildingSnapshot.col/row` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `tests/app/buildings-view.test.ts` (the Task 2 fixture switch already put the building at `col: 5, row: 2`), append:

```ts
  it('shows each building\'s tile and demolishes after the two-step confirm', async () => {
    const { engine, wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('(5, 2)');
    const demolish = wrapper.find('[data-test="demolish-7"]');
    await demolish.trigger('click');
    expect(engine.dispatch).not.toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
    await demolish.trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'demolishBuilding', buildingId: 7 });
  });
```

Also update the starter-hint assertion in the first test: `'td[colspan="6"]'` becomes `'td[colspan="8"]'` (two new columns).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/buildings-view.test.ts`
Expected: FAIL — no `(5, 2)` text, no demolish button, colspan still 6.

- [ ] **Step 3: Implement**

In `src/app/views/BuildingsView.vue`:

1. Import the confirm button:

```ts
import TwoStepButton from '../components/TwoStepButton.vue';
```

2. Buildings-table header row becomes (Tile after Building; trailing action column):

```html
        <tr><th>Building</th><th>Tile</th><th>Workers</th><th>State</th><th>Batch</th><th>Work power</th><th>Tools</th><th /></tr>
```

3. The building row gains, after the name cell:

```html
          <td>({{ b.col }}, {{ b.row }})</td>
```

and, as its last cell:

```html
          <td>
            <TwoStepButton
              label="Demolish" confirm-label="Confirm demolish?" :data-test="`demolish-${b.id}`"
              @confirm="engine.dispatch({ type: 'demolishBuilding', buildingId: b.id })"
            />
          </td>
```

4. The empty-colony row's `colspan="6"` becomes `colspan="8"`.
5. The Construct table's Build button title says how placement happens now:

```html
              :title="store.affordableDefs[id] ? 'Placed automatically — pick the tile yourself in the World tab' : 'Not enough resources'"
```

- [ ] **Step 4: Run the full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/BuildingsView.vue tests/app/buildings-view.test.ts
git commit -m "feat(app): buildings table shows tiles and demolishes — full no-WebGL parity"
```

---

### Task 15: README, full gates, coverage

**Files:**
- Modify: `README.md`
- Possibly modify: `scripts/quality-baseline.json` (only per the re-base rules)

- [ ] **Step 1: README**

In `README.md`:

1. Add after the Increment 2 section:

```markdown
## Increment 3 — Building Placement

- Build on the world: arm a building in the World tab's palette, a ghost
  preview follows the cursor (accent = buildable, red = blocked), click to
  place — placement stays armed for repeat building
- Select any building on the canvas: move it (workers walk after it, batch
  intact) or demolish it (confirmed, full cost refund, workers walk home)
- Positions are sim truth on a fixed 24×16 map (camp band on the left),
  persisted as save v2 — old saves migrate onto exactly the layout
  increment 2 drew derived
- Tables keep full economic parity: construct auto-places on the legacy
  pattern, a Tile column and Demolish per row — no-WebGL play stays whole
```

2. Update the Increment 2 section's last bullet ("Read-only: tables stay the interface for acting; positions are derived until Increment 3 makes placement player-driven") to past tense or drop its trailing clause:

```markdown
- Read-only in its day: Increment 3 has since made the canvas interactive
```

3. Documentation list gains:

```markdown
- Increment 3 spec: `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md`
- Increment 3 plan: `docs/superpowers/plans/2026-07-30-increment-3-building-placement.md`
```

4. The architecture paragraph's world sentence becomes: "`src/app/world/` renders the same snapshots as a 2D tile world via Excalibur, behind an injected renderer seam — and since Increment 3 sends place/move/demolish commands back through the `GameEngine` facade."

- [ ] **Step 2: Full gate run**

Run: `npm run check:all`
Expected: every gate green. If `check:quality` moves:
- `deadCodeIssues` > 0: a new export lost its consumer — fix the wiring, never baseline it.
- `complexFunctions`/`criticalComplexity` > 0: decompose the offender (these are pinned at zero — no baseline bump is legal).
- `maintainability` below floor: check whether it's the rounding artifact documented in `docs/build-ci/quality-gates.md` ("do not ratchet on noise") — re-base only per those rules, with a note there.
- `check:loc`: every file this increment stays well under 500; no baseline entries.

Run: `npm run test:coverage`
Expected: floors hold (new `src/shared/placement.ts` and `command-handlers.ts` are fully exercised by their suites). Then `rm -rf coverage` so a later `check:quality` isn't skewed.

- [ ] **Step 3: Manual pass (if an Obsidian vault is available)**

`npm run dev`, open `demo-vault/`: palette→ghost→click places; move walks workers; demolish refunds and frees next tick; tables show tiles and demolish; a pre-increment save loads with its old geometry. This is the spec's acceptance walk — optional in CI, mandatory before release.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README for increment 3 — player building placement"
```

---

## Plan self-review notes

- **Spec coverage:** §2.1 map/camp → Tasks 1, 7; §2.2 rule module → Task 1; §2.3 sim commands & same-tick semantics → Tasks 2–6; §2.4 save v2/migration → Task 3; §2.5 seam/layout → Tasks 7, 9; §2.6 interaction → Tasks 11–13; §2.7 tables/legend → Tasks 8, 10, 14; §2.8 testing/gates → per-task cycles + Task 15.
- **Deliberate deviations:** none from the spec's behavior. Two spec-silent
  implementation choices are recorded inline: building visuals shrink to one
  tile in Task 9 (adjacency is legal, 1.5-tile visuals would overlap), and
  `constructBuilding` auto-place lands in Task 3 rather than 4 so every
  intermediate commit produces valid v2 saves.
- **Type consistency spot-checks:** `GhostPreview` shape identical in Tasks 9/13; `CommandContext` fields accrete 4→5→6 with no renames; `makeBuilding`/`makeWorker` introduced in Task 2 and used in 7/12/13/14; notice wordings identical between handler code and every test.

