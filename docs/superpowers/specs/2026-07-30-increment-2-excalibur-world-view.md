# Spec: Increment 2 — Excalibur World View

**Date:** 2026-07-30
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 1 (Economy Core, PR #2) and Increment 1.5 (hardening & polish, PR #3, in flight)

---

## 1. Why this increment exists

The product direction is now explicitly spatial: the next gameplay increment
is *"build houses in a 2D grid world, assign workers, have logistics and a
running economy"* — buildings with positions, goods that move, workers that
walk. None of that is designable, reviewable, or debuggable in tables alone.

This increment brings in **[Excalibur](https://github.com/excaliburjs/Excalibur)**
as the visual game engine alongside sim-ecs and displays the colony in a
dedicated **World** view: a 2D tile grid showing every building and worker,
live, driven by the same immutable snapshots the tables already consume. It
is deliberately **read-only** — no gameplay changes, no sim changes — so the
entire risk of the increment is concentrated in one place: the rendering
stack and its integration with the Vue app, the Obsidian lifecycle, and the
build pipeline.

### 1.1 Roadmap change

The PRD's roadmap put "Map & graphics" last (increment 6). That ordering is
now obsolete by explicit product decision: the visual foundation moves to
increment 2, because increment 3 (grid building, logistics) builds *on* it.
The PRD's increment 2 (Survival & Population) and later entries shift back;
their content is unchanged. Tables remain a first-class interface — the
World view joins them, it does not replace them.

### 1.2 Explicitly out of scope

Everything interactive or sim-visible, in particular:

- **Player-driven placement.** Buildings get *derived* positions (§2.3); the
  sim still has no notion of space. Real, player-chosen, persisted grid
  positions are increment 3's first task, replacing the derived layout.
- Canvas interactivity of any kind: selection, tooltips, pan/zoom, build
  cursor. The camera frames the whole colony; that is all.
- Sprites/asset pipeline. Increment 2 renders with shapes, emoji glyphs, and
  theme colors — no image loading, no Excalibur `Loader`, no splash screen.
- Any change under `src/engine/` or `src/shared/` (also keeps this increment
  conflict-free with PR #3, which lives almost entirely in those trees).
- Logistics, housing, economy mechanics — that is increment 3, on top of
  this view.

---

## 2. Requirements

### 2.1 Dependency and artifact budget

- `excalibur@0.32.0` (current stable), pinned exactly like `sim-ecs@0.6.4`.
- Measured on this repo (vite lib build, inline sourcemap): `main.js` grows
  from **1,491 kB (gzip 435 kB)** to **~4,300 kB (gzip ~1,138 kB)** the
  moment Excalibur is imported. The `check:artifacts` budget for `main.js`
  rises **1,500,000 → 5,000,000 bytes** — a deliberate bump with this
  paragraph as its recorded reason, per the gate's own policy. The styles
  and manifest budgets are untouched.
- Excalibur is bundled into `main.js` exactly once, reachable only from the
  app layer (§2.5). Nothing is loaded at Obsidian startup beyond what
  already loads today (the plugin bundle itself).

### 2.2 The World tab

- New route `/world` (name `world`), rendered by `WorldView.vue`, with a
  **World** tab in the nav between Dashboard and Buildings.
- The view hosts one Excalibur canvas filling a fixed-height host element
  styled with Obsidian CSS variables, plus nothing else — all numbers stay
  in the existing tables and top bar.
- **Lifecycle.** `WorldView` is kept alive across tab switches
  (`<keep-alive>` around the router outlet, scoped to `WorldView`): the
  Excalibur engine boots once per game-view open, stops its clock when the
  tab is hidden (`onDeactivated`), resumes on return (`onActivated`), and is
  disposed when the Obsidian view closes (component unmount). A WebGL
  context is therefore created once, not once per tab visit.
- **Failure containment.** If renderer construction throws (no WebGL, etc.)
  the tab shows a plain-text fallback (`data-test="world-fallback"`) naming
  the error; the rest of the app is unaffected. A renderer failure must
  never take down the tables.

### 2.3 Derived world layout (pure, deterministic)

A pure function `layoutWorld(snapshot)` in `src/app/world/layout.ts` maps a
`Snapshot` to tile-space placements. No Excalibur imports, no DOM — fully
unit-testable. Rules:

1. **Buildings** occupy one cell each on a plot grid: buildings sorted by
   id, plot index = rank in that order, plots laid out row-major with a
   one-tile gutter between plots, `PLOTS_PER_ROW = 5` per row. The grid
   gains rows as the colony grows; cells never collide.
2. **Stability.** Placement depends only on the *set of building ids*:
   constructing a new building (always the highest id) appends a plot and
   moves nothing. (Demolition does not exist; if it arrives later, ids keep
   plots stable except ranks above the removed one — acceptable, and moot
   once increment 3 makes positions sim-state.)
3. **Assigned workers** stand at deterministic per-slot offsets along the
   south edge of their building's cell. A worker's slot is keyed to its own
   id (id modulo the slot span, probing upward on collision in id order) —
   never to its rank in the current roster. The span is the building's
   `workerSlots`, stretched to the roster size for grandfathered
   over-capacity saves (legal after a slot retuning), so every spot stays
   inside the cell. Same snapshot → same layout, exactly.
4. **Idle workers** gather at a fixed camp area left of the plots, marked by
   a tent, on the same id-keyed slot scheme (span stretches past the camp's
   baseline capacity when needed).
5. **Slot allocation has explicit memory.** `layoutWorld(snapshot,
   previous?)` — a worker still at the same post keeps the exact slot it
   held in the previous layout; only newcomers allocate, into *free* slots
   (id-keyed hash, probing). Positions are pure functions of (post, slot) —
   never of roster size — so bystanders stand still through any arrival,
   departure, or span change, and an arrival can never stack onto a held
   spot. The renderer feeds each layout back as the next call's `previous`;
   without one (view open, save load) allocation is a deterministic fresh
   hash.
6. The function also reports the grid's `cols`/`rows` and `tileSize`
   (48 px) so the renderer can size the ground and fit the camera.

### 2.4 Rendering

`src/app/world/renderer.ts` wraps Excalibur behind the app-facing contract
(§2.5). Visuals, all theme-derived (§2.4.1), no assets:

- **Ground:** an Excalibur `TileMap` over the full grid, two alternating
  tints — the tile substrate increment 3 will build on.
- **Buildings:** a rounded rectangle per building tinted per building def,
  an emoji glyph (canvas text, e.g. farm 🌾, bakery 🍞, sawmill 🪚), a state
  ring — producing / waitingForInput / unstaffed in accent / warning /
  muted — and a thin progress bar showing `progressPct` while a batch is
  active.
- **Workers:** small circles, fill interpolated from starving-red to
  healthy-green by `efficiency`, a bright ring while tool coverage is
  active (`toolTicks > 0`). When a worker's target position changes
  (assignment change, idle reshuffle), the dot *walks* there
  (`actions.moveTo`, constant speed) instead of teleporting; new workers
  spawn in place.
- **Camera:** centered on the grid, zoom chosen to fit the whole grid with
  a small margin, recomputed on every sync (cheap; ≤ 8/s) so pane resizes
  and grid growth stay framed. `DisplayMode.FillContainer` tracks the host
  element's size.
- **Sync:** the view forwards every store snapshot to `renderer.sync()`,
  which diffs by entity id — create, update, remove; no full scene rebuild.
  Excalibur's own rAF loop handles frames between ticks.

#### 2.4.1 Theme integration

A palette module resolves Obsidian CSS variables (`--background-primary`,
`--text-muted`, `--interactive-accent`, `--color-red`, `--color-green`,
`--color-orange`, …) through an injected `readVar` function with hex
fallbacks per variable, so the canvas blends with the user's theme and the
module stays pure/testable. Resolved once at renderer construction; a theme
switch mid-session repaints on the next view open (documented limitation).

### 2.5 Architecture and boundaries

- All Excalibur-facing code lives in **`src/app/world/`** (app zone; zones
  file untouched): `layout.ts` (pure), `theme.ts` (pure), `renderer.ts`
  (the only module importing `excalibur`), `renderer-key.ts` (DI seam).
- **DI seam.** `renderer-key.ts` exports `WORLD_RENDERER_KEY`, an
  `InjectionKey<WorldRendererFactory>` mirroring `ENGINE_KEY`:

  ```ts
  interface WorldRenderer {
    sync(snapshot: Snapshot): void;
    start(): void;   // resume the render clock (tab shown)
    stop(): void;    // halt the render clock (tab hidden)
    dispose(): void; // tear down engine + canvas (view closed)
  }
  type WorldRendererFactory = (host: HTMLElement) => WorldRenderer;
  ```

  `createGameApp` provides the real Excalibur factory; `WorldView` only
  ever `inject`s. This is load-bearing for tests: Excalibur dies on import
  in plain Node (module-scope `window`) and costs ~5 s to evaluate under
  happy-dom, so **no test may import it, statically or transitively** —
  component tests inject fakes, and `src/app/index.ts` (untested by design)
  is the single place that touches the real factory.
- **Lint twins.** `no-restricted-imports` gains `excalibur` entries: the
  engine and shared contracts must stay renderer-agnostic, and the Obsidian
  shell (`src/main.ts`, `src/view/`) talks to rendering only through
  `createGameApp`. Mirrors the existing `sim-ecs` / `vue` restrictions.
- No changes to `GameEngine`, systems, snapshot shape, save format, or the
  Obsidian shell — the increment is additive in `src/app/`, `package.json`,
  `eslint.config.js`, `scripts/check-artifacts.mjs`, `styles.css`, and docs.

### 2.6 Testing

Same doctrine as increment 1: the logic carries the tests, the thin
adapter stays thin.

- **`layout.test.ts`** — determinism (same snapshot → deep-equal layout),
  stability (adding a building moves no existing placement; reassigning one
  worker moves only that worker), no plot collisions, workers-at-building
  clustering, idle camp filling, grid growth past one plot row, offsets
  staying inside the cell.
- **`theme.test.ts`** — resolved variable wins, fallback used when the
  variable is empty/missing, per-def colors defined for every
  `BuildingDefId` and every `BuildingState`.
- **`world-view.test.ts`** (happy-dom, fake factory) — factory receives the
  host element; latest snapshot synced on store ingest; `stop`/`start`
  invoked on deactivate/activate (kept-alive harness); `dispose` on
  unmount; throwing factory renders the fallback and touches nothing else.
- **`renderer.ts` is exempt from unit tests** — it needs a real WebGL/canvas
  runtime that happy-dom cannot provide; its correctness burden is pushed
  into the tested pure modules. It is covered instead by a **browser smoke
  test** (`npm run smoke:world`, optional dev tool outside `check:all`):
  the real adapter in a Chromium, asserting boot-and-draw, walk animation,
  stop/start clock behavior, and clean dispose via screenshots — plus the
  manual pass in Obsidian (`npm run dev` / `npm run test-build`). No
  coverage thresholds change.
- All gates stay green: lint, LOC cap (every new file < 500), quality
  ratchet (no new dead exports, dupes, complexity; maintainability floor
  holds), css ratchet, typecheck, tests, build, artifacts (with the §2.1
  budget).

---

## 3. Acceptance criteria — Increment 2 is done when:

1. `npm run check:all` passes with Excalibur bundled.
2. In Obsidian, the World tab shows the colony: ground grid, every building
   from the Buildings table (correct def glyph/color, live state ring,
   progress bar), every worker (hunger/efficiency color, tool ring),
   assigned workers at their buildings, idle workers at the camp.
3. Constructing a building / (un)assigning / recruiting from the tables
   appears in the World view on the next tick without moving anything that
   should not move; workers walk to new assignments.
4. Switching tabs back and forth, closing and reopening the game view, and
   restarting Obsidian neither leaks WebGL contexts nor duplicates canvases
   nor breaks the sim; with WebGL unavailable the tab degrades to its
   text fallback while tables keep working.
5. The sim remains byte-identical headless: no `src/engine/` or
   `src/shared/` diffs in the increment.

---

## 4. Alternatives considered and rejected

- **A dedicated Obsidian `ItemView` for the world** (second leaf beside the
  tables). Rejected: the plugin's single-engine invariant exists precisely
  because two live views raced autosaves; a world leaf would need shared
  engine ownership across leaves — a lifecycle project with zero gameplay
  payoff, touching exactly the shell files PR #3 is hardening. The Vue tab
  delivers the same "dedicated view" one click away.
- **Excalibur as the whole UI** (tables re-implemented in-canvas or as
  overlays). Rejected: the PRD names the table UI a first-class interface;
  rebuilding working UI is pure risk.
- **Dynamic `import('excalibur')` in `WorldView`** instead of the DI seam.
  Rejected: same bundle result, but the test-isolation guarantee would rest
  on lazy-load timing instead of an explicit seam, and vitest would still
  evaluate Excalibur in any test that awaits mount.
