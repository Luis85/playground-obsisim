# Increment 2 — Excalibur World View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the colony as a live 2D tile world (Excalibur) in a new read-only **World** tab of the existing Vue app, driven by the same snapshots the tables consume.

**Architecture:** All new code lives in the app zone: two pure modules (`layout.ts`, `theme.ts`) carry the logic and the tests; one thin adapter (`renderer.ts`) is the only module that imports `excalibur`; a provide/inject seam (`WORLD_RENDERER_KEY`) keeps Excalibur out of every test. The engine, shared contracts, and Obsidian shell are untouched (spec §2.5; keeps this increment conflict-free with PR #3).

**Tech Stack:** excalibur@0.32.0 (pinned, already in package.json), Vue 3 + Pinia + vue-router (existing), vitest + happy-dom (existing).

**Spec:** `docs/superpowers/specs/2026-07-30-increment-2-excalibur-world-view.md`

## Global Constraints

- `excalibur@0.32.0` pinned exact; imported **only** by `src/app/world/renderer.ts` (and transitively by `src/app/index.ts`). No test may import it, statically or transitively — it dies on import in plain Node (`window` at module scope) and costs ~5 s under happy-dom.
- No diffs under `src/engine/`, `src/shared/`, `src/view/`, or `src/main.ts`.
- Every new file < 500 nonblank lines (`check:loc`); no new `!important` (`check:css`); no new dead exports / clones / complex functions, maintainability floor 90.5 (`check:quality` — fallow counters are ratchets pinned at their current 0).
- `main.js` byte budget rises 1,500,000 → 5,000,000 in `scripts/check-artifacts.mjs` (measured: Excalibur takes the bundle from 1,491 kB to ~4,300 kB; recorded in spec §2.1). No other budget changes.
- Intermediate commits must keep `npm test`, `npm run lint`, `npm run typecheck` green. `check:quality`'s dead-export counter goes green when the consumption chain closes in Task 4; full `npm run check:all` must pass at Task 5 (CI gates the PR head, not each commit).
- Existing UI conventions: `data-test` attributes for interactive/asserted elements, Obsidian CSS variables in `styles.css`, `// @vitest-environment happy-dom` pragma on component tests.

## File Structure (final state)

```
src/app/world/layout.ts        # NEW pure: Snapshot -> tile-space placements
src/app/world/theme.ts         # NEW pure: CSS-var palette, glyphs, efficiency colors
src/app/world/renderer-key.ts  # NEW contract: WorldRenderer/-Factory types + InjectionKey
src/app/world/renderer.ts      # NEW the only excalibur import; factory for the adapter
src/app/views/WorldView.vue    # NEW kept-alive view hosting the canvas / fallback text
src/app/router.ts              # MODIFY add /world route
src/app/App.vue                # MODIFY add World tab; keep-alive around router-view
src/app/index.ts               # MODIFY provide the real renderer factory
eslint.config.js               # MODIFY excalibur restricted outside app; shell keeps sim-ecs ban
scripts/check-artifacts.mjs    # MODIFY main.js budget 1.5 MB -> 5 MB with reason comment
styles.css                     # MODIFY .obsisim-world-host / -fallback
README.md                      # MODIFY increment 2 section + spec/plan links
tests/app/world-layout.test.ts # NEW
tests/app/world-theme.test.ts  # NEW
tests/app/world-view.test.ts   # NEW (fake factory; no excalibur)
```

---

### Task 1: Pure layout module

**Files:**
- Create: `src/app/world/layout.ts`
- Test: `tests/app/world-layout.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `BuildingState` from `src/shared/snapshot.ts`; `BuildingDefId` from `src/shared/content-types.ts`.
- Produces (Tasks 3–4 rely on these exact names):

```ts
export const TILE = 48;
export interface PlacedBuilding {
  id: number; defId: BuildingDefId; col: number; row: number;
  state: BuildingState; progressPct: number; batchActive: boolean;
}
export interface PlacedWorker {
  /** Tile-space coordinates (fractional): px = x * TILE. */
  id: number; x: number; y: number; efficiency: number; tooled: boolean;
}
export interface WorldLayout {
  tile: number; cols: number; rows: number;
  buildings: PlacedBuilding[]; workers: PlacedWorker[];
}
export function layoutWorld(snapshot: Snapshot): WorldLayout;
```

- [ ] **Step 1: Write the failing tests**

`tests/app/world-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { layoutWorld, TILE } from '../../src/app/world/layout';
import { makeSnapshot } from './fixtures';
import type { BuildingSnapshot, WorkerSnapshot } from '../../src/shared/snapshot';

function building(id: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId: 'farm', workers: 0, workerSlots: 4, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0,
    ...overrides,
  };
}

function worker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return { id, hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0, ...overrides };
}

describe('layoutWorld', () => {
  it('is deterministic: same snapshot -> deep-equal layout', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1), building(4, { defId: 'mill' })],
      workers: [worker(2, { buildingId: 1 }), worker(3)],
    });
    expect(layoutWorld(snapshot)).toEqual(layoutWorld(snapshot));
  });

  it('places buildings on distinct plots in id order, row-major', () => {
    const buildings = [1, 2, 3, 4, 5, 6].map((id) => building(id));
    const { buildings: placed, rows } = layoutWorld(makeSnapshot({ buildings }));
    const cells = placed.map((b) => `${b.col},${b.row}`);
    expect(new Set(cells).size).toBe(6);
    // 5 plots per row: sixth building starts the second plot row
    expect(placed[5].row).toBe(placed[0].row + 2);
    expect(placed[5].col).toBe(placed[0].col);
    expect(rows).toBeGreaterThanOrEqual(placed[5].row + 2);
  });

  it('constructing a new building moves no existing placement', () => {
    const base = makeSnapshot({ buildings: [building(1), building(2)] });
    const grown = makeSnapshot({ buildings: [building(1), building(2), building(9)] });
    const before = layoutWorld(base).buildings;
    const after = layoutWorld(grown).buildings;
    for (const b of before) {
      expect(after.find((a) => a.id === b.id)).toMatchObject({ col: b.col, row: b.row });
    }
  });

  it('clusters assigned workers inside their building cell, by slot capacity', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    });
    const layout = layoutWorld(snapshot);
    const cell = layout.buildings[0];
    for (const w of layout.workers) {
      expect(w.x).toBeGreaterThan(cell.col);
      expect(w.x).toBeLessThan(cell.col + 1);
      expect(w.y).toBeGreaterThan(cell.row);
      expect(w.y).toBeLessThan(cell.row + 1);
    }
    expect(layout.workers[0].x).not.toBe(layout.workers[1].x);
  });

  it('staffing another slot never moves the workers already there', () => {
    const two = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    });
    const three = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 3 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { buildingId: 1 })],
    });
    const before = layoutWorld(two).workers;
    const after = layoutWorld(three).workers;
    for (const w of before) {
      expect(after.find((a) => a.id === w.id)).toMatchObject({ x: w.x, y: w.y });
    }
  });

  it('parks idle workers at the camp, left of the plots', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1)],
      workers: [worker(10), worker(11), worker(12)],
    });
    const layout = layoutWorld(snapshot);
    const minPlotCol = Math.min(...layout.buildings.map((b) => b.col));
    const spots = layout.workers.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(3);
    for (const w of layout.workers) {
      expect(w.x).toBeLessThan(minPlotCol);
    }
  });

  it('carries state, progress, efficiency and tool coverage through', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { state: 'producing', progressPct: 40, batchActive: true })],
      workers: [worker(10, { buildingId: 1, efficiency: 0.5, toolTicks: 7 })],
    });
    const layout = layoutWorld(snapshot);
    expect(layout.buildings[0]).toMatchObject({ state: 'producing', progressPct: 40, batchActive: true });
    expect(layout.workers[0]).toMatchObject({ efficiency: 0.5, tooled: true });
    expect(layout.tile).toBe(TILE);
  });

  it('keeps every placement inside the reported grid', () => {
    const snapshot = makeSnapshot({
      buildings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => building(id)),
      workers: [10, 11, 12, 13, 14, 15, 16, 17].map((id) => worker(id)),
    });
    const layout = layoutWorld(snapshot);
    for (const b of layout.buildings) {
      expect(b.col).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeLessThan(layout.cols);
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.row).toBeLessThan(layout.rows);
    }
    for (const w of layout.workers) {
      expect(w.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(layout.cols);
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(layout.rows);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/app/world-layout.test.ts`
Expected: FAIL — cannot resolve `../../src/app/world/layout`.

- [ ] **Step 3: Implement `src/app/world/layout.ts`**

```ts
import type { Snapshot, BuildingState, WorkerSnapshot } from '../../shared/snapshot';
import type { BuildingDefId } from '../../shared/content-types';

export const TILE = 48;

// Fixed geography (tile coords): idle camp on the left, building plots to the
// right of it, one-tile gutters between plots. Placement depends only on ids,
// so the world never reshuffles under the player (spec §2.3).
const PLOTS_PER_ROW = 5;
const PLOT_COL0 = 4;
const PLOT_ROW0 = 1;
const CAMP_COL0 = 1;
const CAMP_PER_ROW = 2;
const MIN_ROWS = 7;
const COLS = PLOT_COL0 + PLOTS_PER_ROW * 2;

export interface PlacedBuilding {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  state: BuildingState;
  progressPct: number;
  batchActive: boolean;
}

export interface PlacedWorker {
  id: number;
  /** Tile-space coordinates (fractional): px = x * TILE. */
  x: number;
  y: number;
  efficiency: number;
  tooled: boolean;
}

export interface WorldLayout {
  tile: number;
  cols: number;
  rows: number;
  buildings: PlacedBuilding[];
  workers: PlacedWorker[];
}

function placeBuildings(snapshot: Snapshot): { placed: PlacedBuilding[]; cellById: Map<number, PlacedBuilding> } {
  const placed: PlacedBuilding[] = [];
  const cellById = new Map<number, PlacedBuilding>();
  const byId = [...snapshot.buildings].sort((a, b) => a.id - b.id);
  byId.forEach((b, rank) => {
    const cell: PlacedBuilding = {
      id: b.id,
      defId: b.defId,
      col: PLOT_COL0 + 2 * (rank % PLOTS_PER_ROW),
      row: PLOT_ROW0 + 2 * Math.floor(rank / PLOTS_PER_ROW),
      state: b.state,
      progressPct: b.progressPct,
      batchActive: b.batchActive,
    };
    placed.push(cell);
    cellById.set(b.id, cell);
  });
  return { placed, cellById };
}

function placeWorker(w: WorkerSnapshot, snapshot: Snapshot, cellById: Map<number, PlacedBuilding>, idleRank: number): PlacedWorker {
  const base = { id: w.id, efficiency: w.efficiency, tooled: w.toolTicks > 0 };
  const cell = w.buildingId === null ? undefined : cellById.get(w.buildingId);
  if (cell === undefined) {
    return { ...base, x: CAMP_COL0 + (idleRank % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(idleRank / CAMP_PER_ROW) };
  }
  const building = snapshot.buildings.find((b) => b.id === cell.id)!;
  const mates = snapshot.workers
    .filter((other) => other.buildingId === cell.id)
    .sort((a, b) => a.id - b.id);
  const slot = mates.findIndex((other) => other.id === w.id);
  return { ...base, x: cell.col + (slot + 1) / (building.workerSlots + 1), y: cell.row + 0.85 };
}

export function layoutWorld(snapshot: Snapshot): WorldLayout {
  const { placed, cellById } = placeBuildings(snapshot);
  let idleRank = 0;
  const workers = [...snapshot.workers]
    .sort((a, b) => a.id - b.id)
    .map((w) => {
      const isIdle = w.buildingId === null || !cellById.has(w.buildingId);
      return placeWorker(w, snapshot, cellById, isIdle ? idleRank++ : 0);
    });
  const plotRows = Math.ceil(placed.length / PLOTS_PER_ROW);
  const campRows = Math.ceil(idleRank / CAMP_PER_ROW);
  const rows = Math.max(MIN_ROWS, PLOT_ROW0 + 2 * plotRows + 1, campRows + 3);
  return { tile: TILE, cols: COLS, rows, buildings: placed, workers };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app/world-layout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/world/layout.ts tests/app/world-layout.test.ts
git commit -m "feat(world): pure deterministic tile layout from snapshots"
```

---

### Task 2: Pure theme module

**Files:**
- Create: `src/app/world/theme.ts`
- Test: `tests/app/world-theme.test.ts`

**Interfaces:**
- Consumes: `BUILDING_IDS` from `src/engine/content/buildings.ts` (app → engine-content is an allowed zone edge, same as BuildingsView); `BuildingDefId` from shared.
- Produces (Task 4 relies on these exact names):

```ts
export type VarReader = (name: string) => string;
export interface WorldTheme {
  background: string;
  ground: [string, string];
  buildingFill: Record<BuildingDefId, string>;
  buildingGlyph: Record<BuildingDefId, string>;
  stateRing: Record<BuildingState, string>;
  workerColors: string[];      // one hex per efficiency bucket, red -> green
  workerToolRing: string;
}
export function resolveWorldTheme(read: VarReader): WorldTheme;
export function efficiencyBucket(efficiency: number): number;  // 0..workerColors.length-1
```

- [ ] **Step 1: Write the failing tests**

`tests/app/world-theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { efficiencyBucket, resolveWorldTheme } from '../../src/app/world/theme';
import { BUILDING_IDS } from '../../src/engine/content/buildings';

const HEX = /^#[0-9a-f]{6}$/i;
const none = () => '';

describe('resolveWorldTheme', () => {
  it('uses a CSS variable when it resolves to a hex color', () => {
    const theme = resolveWorldTheme((name) => (name === '--color-green' ? ' #11aa55 ' : ''));
    expect(theme.stateRing.producing).toBe('#11aa55');
  });

  it('falls back to a built-in hex when the variable is missing or not hex', () => {
    const missing = resolveWorldTheme(none);
    const garbage = resolveWorldTheme(() => 'hsl(120, 50%, 50%)');
    expect(missing.stateRing.producing).toMatch(HEX);
    expect(garbage.stateRing.producing).toBe(missing.stateRing.producing);
  });

  it('defines a fill and a glyph for every building def', () => {
    const theme = resolveWorldTheme(none);
    for (const id of BUILDING_IDS) {
      expect(theme.buildingFill[id]).toMatch(HEX);
      expect(theme.buildingGlyph[id].length).toBeGreaterThan(0);
    }
  });

  it('defines a ring color for every building state and every worker bucket', () => {
    const theme = resolveWorldTheme(none);
    expect(theme.stateRing.producing).toMatch(HEX);
    expect(theme.stateRing.waitingForInput).toMatch(HEX);
    expect(theme.stateRing.unstaffed).toMatch(HEX);
    for (const color of theme.workerColors) expect(color).toMatch(HEX);
    expect(theme.workerToolRing).toMatch(HEX);
    expect(theme.ground[0]).toMatch(HEX);
    expect(theme.ground[1]).toMatch(HEX);
    expect(theme.background).toMatch(HEX);
  });
});

describe('efficiencyBucket', () => {
  it('maps starving to the first bucket and healthy to the last', () => {
    const theme = resolveWorldTheme(none);
    expect(efficiencyBucket(0.2)).toBe(0);
    expect(efficiencyBucket(1.5)).toBe(theme.workerColors.length - 1);
  });

  it('is monotonic in efficiency', () => {
    let last = -1;
    for (const eff of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      const bucket = efficiencyBucket(eff);
      expect(bucket).toBeGreaterThanOrEqual(last);
      last = bucket;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/app/world-theme.test.ts`
Expected: FAIL — cannot resolve `../../src/app/world/theme`.

- [ ] **Step 3: Implement `src/app/world/theme.ts`**

```ts
import type { BuildingDefId } from '../../shared/content-types';
import type { BuildingState } from '../../shared/snapshot';

export type VarReader = (name: string) => string;

export interface WorldTheme {
  background: string;
  ground: [string, string];
  buildingFill: Record<BuildingDefId, string>;
  buildingGlyph: Record<BuildingDefId, string>;
  stateRing: Record<BuildingState, string>;
  workerColors: string[];
  workerToolRing: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

// Obsidian themes expose their palette as CSS variables; anything that is not
// a plain 6-digit hex (hsl(), rgb(), empty) falls back so ex.Color.fromHex
// always gets input it can parse.
function pick(read: VarReader, name: string, fallback: string): string {
  const value = read(name).trim();
  return HEX.test(value) ? value : fallback;
}

const BUILDING_FILL: Record<BuildingDefId, string> = {
  gatherersHut: '#7d9464', farm: '#b0913f', mill: '#a2793d', bakery: '#b06a4e',
  forester: '#4e7a52', sawmill: '#8a6a49', workshop: '#6f6f85',
};

const BUILDING_GLYPH: Record<BuildingDefId, string> = {
  gatherersHut: '🧺', farm: '🌾', mill: '⚙️', bakery: '🍞',
  forester: '🌲', sawmill: '🪚', workshop: '🔨',
};

function mixHex(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const lerp = (i: number) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t);
  return `#${[0, 1, 2].map((i) => lerp(i).toString(16).padStart(2, '0')).join('')}`;
}

const WORKER_BUCKETS = 5;
const BUCKET_CEILINGS = [0.35, 0.55, 0.75, 0.95];

export function efficiencyBucket(efficiency: number): number {
  const index = BUCKET_CEILINGS.findIndex((ceiling) => efficiency < ceiling);
  return index === -1 ? WORKER_BUCKETS - 1 : index;
}

export function resolveWorldTheme(read: VarReader): WorldTheme {
  const red = pick(read, '--color-red', '#e0533d');
  const green = pick(read, '--color-green', '#3cb46e');
  return {
    background: pick(read, '--background-primary', '#20242b'),
    ground: ['#55714a', '#4d6743'],
    buildingFill: BUILDING_FILL,
    buildingGlyph: BUILDING_GLYPH,
    stateRing: {
      producing: green,
      waitingForInput: pick(read, '--color-orange', '#e5a63a'),
      unstaffed: '#8f8f8f',
    },
    workerColors: Array.from({ length: WORKER_BUCKETS }, (_, i) => mixHex(red, green, i / (WORKER_BUCKETS - 1))),
    workerToolRing: '#f2ecdd',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/app/world-theme.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/world/theme.ts tests/app/world-theme.test.ts
git commit -m "feat(world): theme palette from Obsidian CSS variables with hex fallbacks"
```

---

### Task 3: Renderer contract, WorldView, route, tab, styles

**Files:**
- Create: `src/app/world/renderer-key.ts`
- Create: `src/app/views/WorldView.vue`
- Modify: `src/app/router.ts`
- Modify: `src/app/App.vue`
- Modify: `styles.css`
- Test: `tests/app/world-view.test.ts`

**Interfaces:**
- Consumes: `Snapshot` from shared; `useGameStore`; existing router/App structure.
- Produces: `WORLD_RENDERER_KEY: InjectionKey<WorldRendererFactory>`, `interface WorldRenderer { sync(snapshot: Snapshot): void; start(): void; stop(): void; dispose(): void }`, `type WorldRendererFactory = (host: HTMLElement) => WorldRenderer` — Task 4's adapter implements this and `src/app/index.ts` provides it.
- Note: `WorldView` injects with a `null` default and shows the fallback when no factory is provided, so this task is shippable before Task 4 wires the real one.

- [ ] **Step 1: Write `src/app/world/renderer-key.ts`** (contract only — no excalibur import here, ever; tests and `WorldView` must stay excalibur-free)

```ts
import type { InjectionKey } from 'vue';
import type { Snapshot } from '../../shared/snapshot';

export interface WorldRenderer {
  sync(snapshot: Snapshot): void;
  /** Resume the render clock (tab shown). */
  start(): void;
  /** Halt the render clock (tab hidden). */
  stop(): void;
  /** Tear down the engine and canvas (view closed). */
  dispose(): void;
}

export type WorldRendererFactory = (host: HTMLElement) => WorldRenderer;

export const WORLD_RENDERER_KEY: InjectionKey<WorldRendererFactory> = Symbol('obsisim-world-renderer');
```

- [ ] **Step 2: Write the failing component tests**

`tests/app/world-view.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import WorldView from '../../src/app/views/WorldView.vue';
import { WORLD_RENDERER_KEY } from '../../src/app/world/renderer-key';
import type { WorldRenderer } from '../../src/app/world/renderer-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './fixtures';

function makeFake() {
  const renderer: WorldRenderer = { sync: vi.fn(), start: vi.fn(), stop: vi.fn(), dispose: vi.fn() };
  const factory = vi.fn((host: HTMLElement) => {
    void host;
    return renderer;
  });
  return { renderer, factory };
}

// h()/KeepAlive render function, not a `template:` string — vitest resolves
// `vue` to the runtime-only build, which cannot compile templates.
function mountHarness(factory: unknown) {
  const active = ref(true);
  const Harness = defineComponent({
    setup: () => () => h(KeepAlive, null, [active.value ? h(WorldView) : null]),
  });
  const wrapper = mount(Harness, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [WORLD_RENDERER_KEY as symbol]: factory },
    },
  });
  return { wrapper, active };
}

describe('WorldView', () => {
  it('creates the renderer on the host element and syncs snapshots from the store', async () => {
    const { renderer, factory } = makeFake();
    mountHarness(factory);
    expect(factory).toHaveBeenCalledOnce();
    expect((factory.mock.calls[0][0] as HTMLElement).classList.contains('obsisim-world-host')).toBe(true);
    const snapshot = makeSnapshot({ tick: 5 });
    useGameStore().ingest(snapshot, { paused: false, speed: 1, error: null });
    await nextTick();
    expect(renderer.sync).toHaveBeenCalledWith(snapshot);
  });

  it('syncs an already-present snapshot immediately on mount', () => {
    const { renderer, factory } = makeFake();
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
    useGameStore(pinia).ingest(makeSnapshot({ tick: 9 }), { paused: true, speed: 1, error: null });
    mount(WorldView, { global: { plugins: [pinia], provide: { [WORLD_RENDERER_KEY as symbol]: factory } } });
    expect(renderer.sync).toHaveBeenCalledWith(expect.objectContaining({ tick: 9 }));
  });

  it('stops on deactivate, restarts on activate, disposes on unmount', async () => {
    const { renderer } = makeFake();
    const { wrapper, active } = mountHarness(vi.fn(() => renderer));
    active.value = false;
    await nextTick();
    expect(renderer.stop).toHaveBeenCalledOnce();
    expect(renderer.dispose).not.toHaveBeenCalled();
    active.value = true;
    await nextTick();
    expect(renderer.start).toHaveBeenCalledTimes(2); // initial activate + reactivate
    wrapper.unmount();
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it('renders the text fallback when the factory throws and never syncs', async () => {
    const factory = vi.fn(() => {
      throw new Error('no WebGL');
    });
    const { wrapper } = mountHarness(factory);
    await nextTick();
    const fallback = wrapper.find('[data-test="world-fallback"]');
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain('no WebGL');
    useGameStore().ingest(makeSnapshot(), { paused: false, speed: 1, error: null });
    await nextTick(); // must not throw — no renderer to sync
  });

  it('renders the fallback when no factory is provided', () => {
    const { wrapper } = mountHarness(undefined);
    expect(wrapper.find('[data-test="world-fallback"]').exists()).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/app/world-view.test.ts`
Expected: FAIL — cannot resolve `../../src/app/views/WorldView.vue`.

- [ ] **Step 4: Implement `src/app/views/WorldView.vue`**

```vue
<script setup lang="ts">
import { inject, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../stores/game-store';
import { WORLD_RENDERER_KEY } from '../world/renderer-key';
import type { WorldRenderer } from '../world/renderer-key';

defineOptions({ name: 'WorldView' }); // keep-alive include matches on this name
const store = useGameStore();
const factory = inject(WORLD_RENDERER_KEY, null);
const host = ref<HTMLElement | null>(null);
const failure = ref<string | null>(null);
let renderer: WorldRenderer | null = null;

onMounted(() => {
  if (!factory) {
    failure.value = 'no renderer is registered';
    return;
  }
  try {
    renderer = factory(host.value!);
    if (store.snapshot) renderer.sync(store.snapshot);
  } catch (error) {
    // A rendering failure must never take the tables down (spec §2.2).
    failure.value = error instanceof Error ? error.message : String(error);
    renderer = null;
  }
});
watch(
  () => store.snapshot,
  (snapshot) => {
    if (snapshot && renderer) renderer.sync(snapshot);
  },
);
onActivated(() => renderer?.start());
onDeactivated(() => renderer?.stop());
onBeforeUnmount(() => {
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <div v-if="failure" class="obsisim-world-fallback" data-test="world-fallback">
    World view unavailable ({{ failure }}). The table views keep working.
  </div>
  <div v-else ref="host" class="obsisim-world-host" data-test="world-host" />
</template>
```

- [ ] **Step 5: Wire route and tab**

`src/app/router.ts` — add the import and the route between dashboard and buildings:

```ts
import WorldView from './views/WorldView.vue';
// routes:
      { path: '/world', name: 'world', component: WorldView },
```

`src/app/App.vue` — add the tab and keep `WorldView` alive across tab switches (the Excalibur engine must boot once per view open, not once per visit — spec §2.2):

```ts
const tabs = [
  { to: '/', label: 'Dashboard' },
  { to: '/world', label: 'World' },
  { to: '/buildings', label: 'Buildings' },
  { to: '/population', label: 'Population' },
  { to: '/economy', label: 'Economy' },
];
```

```vue
    <main v-if="store.snapshot">
      <router-view v-slot="{ Component }">
        <keep-alive include="WorldView">
          <component :is="Component" />
        </keep-alive>
      </router-view>
    </main>
```

- [ ] **Step 6: Styles** — append to `styles.css` (Obsidian variables only, no `!important`):

```css
.obsisim-world-host {
  height: clamp(320px, 65vh, 720px);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  overflow: hidden;
}

.obsisim-world-fallback {
  padding: var(--size-4-4);
  color: var(--text-muted);
}
```

- [ ] **Step 7: Run the suite**

Run: `npx vitest run tests/app/ && npm run lint && npm run typecheck`
Expected: all green (existing tests untouched; new world-view tests pass).

- [ ] **Step 8: Commit**

```bash
git add src/app/world/renderer-key.ts src/app/views/WorldView.vue src/app/router.ts src/app/App.vue styles.css tests/app/world-view.test.ts
git commit -m "feat(world): World tab with injected renderer seam, kept alive across tabs"
```

---

### Task 4: Excalibur adapter, DI wiring, lint fences, artifact budget

**Files:**
- Create: `src/app/world/renderer.ts`
- Modify: `src/app/index.ts`
- Modify: `eslint.config.js`
- Modify: `scripts/check-artifacts.mjs`

**Interfaces:**
- Consumes: `layoutWorld`, `TILE`, `PlacedBuilding`, `PlacedWorker`, `WorldLayout` (Task 1); `resolveWorldTheme`, `efficiencyBucket`, `WorldTheme` (Task 2); `WorldRenderer`, `WorldRendererFactory`, `WORLD_RENDERER_KEY` (Task 3).
- Produces: `createExcaliburWorldRenderer: WorldRendererFactory` — the only export, consumed by `src/app/index.ts`.
- **No unit tests for this file** (spec §2.6): it needs a real WebGL/canvas runtime; the logic lives in the tested pure modules. Verification here is `typecheck`, `build`, gates, and a manual pass in Obsidian.

- [ ] **Step 1: Implement `src/app/world/renderer.ts`**

```ts
import {
  Actor, BaseAlign, Circle, Color, DisplayMode, Engine, Font, GraphicsGroup,
  Rectangle, Text, TextAlign, TileMap, vec,
} from 'excalibur';
import type { Snapshot } from '../../shared/snapshot';
import type { WorldRenderer, WorldRendererFactory } from './renderer-key';
import { layoutWorld, TILE, type PlacedBuilding, type PlacedWorker, type WorldLayout } from './layout';
import { efficiencyBucket, resolveWorldTheme, type WorldTheme } from './theme';

const WORKER_RADIUS = 7;
const WORKER_SPEED = 90; // px/s walk speed toward a new post
const BUILDING_SIZE = TILE * 1.5;
const BAR_WIDTH = TILE * 1.2;
const BAR_HEIGHT = 5;

interface BuildingBundle { root: Actor; bar: Actor; state: string; }
interface WorkerBundle { actor: Actor; bucket: number; tooled: boolean; target: { x: number; y: number }; }

/** Building look per (def, state) — shared graphics, built lazily once. */
class GraphicCache {
  private buildings = new Map<string, GraphicsGroup>();
  private workers = new Map<string, Circle>();

  constructor(private theme: WorldTheme) {}

  building(b: PlacedBuilding): GraphicsGroup {
    const key = `${b.defId}/${b.state}`;
    let group = this.buildings.get(key);
    if (!group) {
      // useAnchor: false — members are placed by explicit offset from the
      // actor position; negative offsets center the rect, the glyph's own
      // Center/Middle alignment centers it, and useBounds keeps the text's
      // odd glyph bounds out of the group's bounding box (culling).
      group = new GraphicsGroup({
        useAnchor: false,
        members: [
          {
            graphic: new Rectangle({
              width: BUILDING_SIZE, height: BUILDING_SIZE,
              color: Color.fromHex(this.theme.buildingFill[b.defId]),
              strokeColor: Color.fromHex(this.theme.stateRing[b.state]), lineWidth: 3,
            }),
            offset: vec(-BUILDING_SIZE / 2, -BUILDING_SIZE / 2),
          },
          {
            graphic: new Text({
              text: this.theme.buildingGlyph[b.defId],
              font: new Font({ family: 'sans-serif', size: 26, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
            }),
            offset: vec(0, 0),
            useBounds: false,
          },
        ],
      });
      this.buildings.set(key, group);
    }
    return group;
  }

  worker(bucket: number, tooled: boolean): Circle {
    const key = `${bucket}/${tooled}`;
    let circle = this.workers.get(key);
    if (!circle) {
      circle = new Circle({
        radius: WORKER_RADIUS,
        color: Color.fromHex(this.theme.workerColors[bucket]),
        strokeColor: tooled ? Color.fromHex(this.theme.workerToolRing) : undefined,
        lineWidth: tooled ? 2 : 0,
      });
      this.workers.set(key, circle);
    }
    return circle;
  }
}

class ExcaliburWorldRenderer implements WorldRenderer {
  private engine: Engine;
  private cache: GraphicCache;
  private theme: WorldTheme;
  private ground: TileMap | null = null;
  private groundKey = '';
  private buildings = new Map<number, BuildingBundle>();
  private workers = new Map<number, WorkerBundle>();
  private running = true;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.theme = resolveWorldTheme((name) => getComputedStyle(host).getPropertyValue(name));
    this.cache = new GraphicCache(this.theme);
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    this.engine = new Engine({
      canvasElement: canvas,
      displayMode: DisplayMode.FillContainer,
      backgroundColor: Color.fromHex(this.theme.background),
      suppressConsoleBootMessage: true,
      suppressPlayButton: true,
    });
    void this.engine.start();
  }

  sync(snapshot: Snapshot): void {
    if (this.disposed) return;
    const layout = layoutWorld(snapshot);
    this.syncGround(layout);
    this.syncBuildings(layout.buildings);
    this.syncWorkers(layout.workers);
    this.fitCamera(layout);
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    void this.engine.start();
  }

  stop(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.engine.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stop();
    this.engine.dispose();
  }

  private syncGround(layout: WorldLayout): void {
    const key = `${layout.cols}x${layout.rows}`;
    if (key === this.groundKey) return;
    this.groundKey = key;
    this.ground?.kill();
    this.ground = new TileMap({ tileWidth: TILE, tileHeight: TILE, columns: layout.cols, rows: layout.rows });
    const tints = this.theme.ground.map((hex) => new Rectangle({ width: TILE, height: TILE, color: Color.fromHex(hex) }));
    for (const tile of this.ground.tiles) {
      tile.addGraphic(tints[(tile.x + tile.y) % 2]);
    }
    this.engine.currentScene.add(this.ground);
  }

  private syncBuildings(placed: PlacedBuilding[]): void {
    const seen = new Set<number>();
    for (const b of placed) {
      seen.add(b.id);
      let bundle = this.buildings.get(b.id);
      if (!bundle) {
        bundle = this.spawnBuilding(b);
        this.buildings.set(b.id, bundle);
      }
      if (bundle.state !== b.state) {
        bundle.state = b.state;
        bundle.root.graphics.use(this.cache.building(b));
      }
      bundle.bar.graphics.isVisible = b.batchActive;
      bundle.bar.scale = vec(Math.max(b.progressPct / 100, 0.001), 1);
    }
    this.removeAbsent(this.buildings, seen, (bundle) => bundle.root.kill());
  }

  private spawnBuilding(b: PlacedBuilding): BuildingBundle {
    const root = new Actor({ pos: vec((b.col + 0.5) * TILE, (b.row + 0.5) * TILE), z: 1 });
    root.graphics.use(this.cache.building(b));
    const bar = new Actor({
      pos: vec(-BAR_WIDTH / 2, BUILDING_SIZE / 2 - BAR_HEIGHT),
      anchor: vec(0, 0.5), width: BAR_WIDTH, height: BAR_HEIGHT,
      color: Color.fromHex(this.theme.stateRing.producing), z: 2,
    });
    root.addChild(bar);
    this.engine.currentScene.add(root);
    return { root, bar, state: b.state };
  }

  private syncWorkers(placed: PlacedWorker[]): void {
    const seen = new Set<number>();
    for (const w of placed) {
      seen.add(w.id);
      const target = { x: w.x * TILE, y: w.y * TILE };
      const bucket = efficiencyBucket(w.efficiency);
      let bundle = this.workers.get(w.id);
      if (!bundle) {
        const actor = new Actor({ pos: vec(target.x, target.y), z: 3 });
        actor.graphics.use(this.cache.worker(bucket, w.tooled));
        this.engine.currentScene.add(actor);
        bundle = { actor, bucket, tooled: w.tooled, target };
        this.workers.set(w.id, bundle);
        continue;
      }
      if (bundle.bucket !== bucket || bundle.tooled !== w.tooled) {
        bundle.bucket = bucket;
        bundle.tooled = w.tooled;
        bundle.actor.graphics.use(this.cache.worker(bucket, w.tooled));
      }
      if (bundle.target.x !== target.x || bundle.target.y !== target.y) {
        bundle.target = target;
        bundle.actor.actions.clearActions();
        bundle.actor.actions.moveTo(vec(target.x, target.y), WORKER_SPEED);
      }
    }
    this.removeAbsent(this.workers, seen, (bundle) => bundle.actor.kill());
  }

  private removeAbsent<T>(map: Map<number, T>, seen: Set<number>, kill: (bundle: T) => void): void {
    for (const [id, bundle] of map) {
      if (!seen.has(id)) {
        kill(bundle);
        map.delete(id);
      }
    }
  }

  private fitCamera(layout: WorldLayout): void {
    const worldW = layout.cols * TILE;
    const worldH = layout.rows * TILE;
    const camera = this.engine.currentScene.camera;
    camera.pos = vec(worldW / 2, worldH / 2);
    camera.zoom = Math.min(this.engine.drawWidth / worldW, this.engine.drawHeight / worldH) * 0.95;
  }
}

export const createExcaliburWorldRenderer: WorldRendererFactory = (host) => new ExcaliburWorldRenderer(host);
```

- [ ] **Step 2: Provide the real factory** — `src/app/index.ts`:

```ts
import { WORLD_RENDERER_KEY } from './world/renderer-key';
import { createExcaliburWorldRenderer } from './world/renderer';
// inside createGameApp, next to the ENGINE_KEY provide:
  app.provide(WORLD_RENDERER_KEY, createExcaliburWorldRenderer);
```

- [ ] **Step 3: Lint fences** — `eslint.config.js`. Split the existing UI restriction block so the shell keeps its `sim-ecs` ban *and* gains an `excalibur` ban, while `src/app/**` (legitimately importing excalibur in `world/renderer.ts`) keeps only the `sim-ecs` ban. `no-restricted-imports` does not merge across config entries — the last match wins — so both paths must appear in the shell block:

```js
  {
    files: ['src/app/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'sim-ecs', message: 'UI and shell talk to the engine only through the GameEngine facade and shared types.' }],
      }],
    },
  },
  {
    files: ['src/view/**', 'src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'sim-ecs', message: 'UI and shell talk to the engine only through the GameEngine facade and shared types.' },
          { name: 'excalibur', message: 'The Obsidian shell talks to rendering only through createGameApp.' },
        ],
      }],
    },
  },
```

and in the engine/shared block, add:

```js
          { name: 'excalibur', message: 'The engine and shared contracts must stay renderer-agnostic.' },
```

- [ ] **Step 4: Artifact budget** — `scripts/check-artifacts.mjs`, with the reason on the line:

```js
// main.js: 5 MB — excalibur@0.32 adds ~2.8 MB (code + inline sourcemap) to a
// 1.5 MB bundle; measured in spec 2026-07-30-increment-2 §2.1.
const BUDGETS = { 'main.js': 5_000_000, 'styles.css': 50_000, 'manifest.json': 10_000 };
```

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm test && npm run build && npm run check:artifacts`
Expected: all green; build reports `main.js` ≈ 4.3 MB, under the new budget. Fix any type mismatches against the real excalibur API before committing (the adapter is the only file allowed to change in response).

- [ ] **Step 6: Commit**

```bash
git add src/app/world/renderer.ts src/app/index.ts eslint.config.js scripts/check-artifacts.mjs
git commit -m "feat(world): Excalibur adapter behind the renderer seam; lint fences; 5 MB artifact budget"
```

---

### Task 5: Docs, full gate pass, manual acceptance

**Files:**
- Modify: `README.md`
- Possibly modify: `scripts/quality-baseline.json` (only via `--update`, only for *improvements* fallow unlocks)

- [ ] **Step 1: README** — extend the increment list and docs section:

```markdown
## Increment 2 — World View

- The colony rendered as a live 2D tile world (Excalibur) in a new **World** tab
- Buildings with state rings and batch progress, workers colored by efficiency
  (tool coverage shown as a ring) walking between posts
- Read-only: tables stay the interface for acting; positions are derived until
  Increment 3 makes placement player-driven
```

and under Documentation:

```markdown
- Increment 2 spec: `docs/superpowers/specs/2026-07-30-increment-2-excalibur-world-view.md`
- Increment 2 plan: `docs/superpowers/plans/2026-07-30-increment-2-excalibur-world-view.md`
```

Also update the architecture paragraph's first sentence to mention the world renderer, e.g. append: `src/app/world/` renders the same snapshots as a 2D tile world via Excalibur, behind an injected renderer seam.

- [ ] **Step 2: Full gates**

Run: `npm run check:all`
Expected: every gate green. If `check:quality` reports *unlocked improvements* (counters shrank), lock them with `npm run check:quality -- --update` and include the baseline change in the commit. If it reports failures, fix the code — do not bump ratchets.

- [ ] **Step 3: Manual acceptance in Obsidian** (spec §3.2–3.4) — requires a human with Obsidian; in a headless environment, note it as pending in the PR instead:

Run: `npm run dev`, open `demo-vault/` in Obsidian, enable ObsiSim.
Check: World tab shows ground grid, buildings with glyph/ring/progress, workers at posts and camp; construct/assign/recruit from tables appears next tick; tab switches and view close/reopen leak nothing; sim identical.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README section for increment 2 (Excalibur world view)"
```

---

## Execution Notes

- **Task order is load-bearing:** the pure modules (1–2) land with their tests before anything imports excalibur; the seam (3) proves the view against fakes; only then does excalibur enter the dependency graph (4). Never import `renderer.ts` from a test or from `renderer-key.ts`.
- **fallow dead-export ratchet:** exports of Tasks 1–2 are consumed in Task 4; `check:quality` is expected green from Task 4 on (and at the PR head), not necessarily between.
- **If the excalibur typecheck fights back** in Task 4 (API drift vs the d.ts): adjust the adapter, not the contract — `WorldRenderer` is what the tested code depends on.
