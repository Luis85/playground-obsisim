# Spec: Increment 3 — Player Building Placement

**Date:** 2026-07-30
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 2 (Excalibur world view, PR #4, merged)

---

## 1. Why this increment exists

Increment 2 put the colony on screen but left it untouchable: buildings get
*derived* positions and the canvas accepts no commands. Its spec reserved the
next step explicitly — *"Real, player-chosen, persisted grid positions are
increment 3's first task, replacing the derived layout."* This increment is
that task, taken to a playable whole by explicit product decision: the player
**places** new buildings on the world, **moves** existing ones, and
**demolishes** them — the full editing kit, from the canvas, with the tables
keeping full economic parity.

Space becomes sim truth. Building positions move out of the app-layer layout
function and into the ECS world, the save file, and the snapshot. Everything
downstream of that decision — logistics, distance costs, terrain — becomes
buildable later without another migration of ownership.

### 1.1 Product decisions taken for this increment

- **Scope: place + demolish + move.** All three ship together (product
  choice over the minimal place-only cut).
- **Positions are gameplay-neutral.** Production, efficiency, and hunger are
  untouched — a mill produces identically anywhere. Distance mechanics and
  logistics are a later increment on top of real positions.
- **Fixed map.** A bounded world; placement means something because space is
  finite. Map size is persisted so a later increment can grow it.
- **Tables stay self-sufficient.** Constructing from the Buildings table
  auto-places deterministically; demolition works from the table too. A
  no-WebGL player can still run the whole economy (Increment 2's failure-
  containment promise extends to acting, not just viewing).

### 1.2 Explicitly out of scope

Distance/travel effects on the economy, logistics and goods movement,
terrain and obstacles, roads, multi-tile buildings, map growth UI, worker
placement (worker spots stay derived), sprites/asset pipeline, demolition
refund tuning (full refund now; balancing is Increment 5's domain).

---

## 2. Requirements

### 2.1 Map model

- Default map **24×16 tiles** (`DEFAULT_MAP`), persisted per save as
  `map: { cols, rows }`. Structural bounds: `8 ≤ cols ≤ 256`,
  `6 ≤ rows ≤ 256`, integers.
- The **left 3 columns are the idle camp band** (`CAMP_COLS = 3`), derived
  from the map by constant — not persisted (YAGNI). The camp tent keeps its
  Increment 2 anchor and idle workers their derived spots; over-capacity
  idle crowds keep the existing overflow machinery, contained to the band.
- Buildable tile = in bounds, `col ≥ CAMP_COLS`, not occupied by a building.
  One building per tile; adjacency is allowed (gutters are a player choice
  now, not a rule).

### 2.2 The placement rule exists exactly once

A pure module `src/shared/placement.ts` owns the spatial law, imported by
the engine (authoritative validation), the app (cosmetic ghost pre-check),
and the save migration (position synthesis):

- `isTileBuildable(map, occupied, col, row)` — the predicate above. No
  self-exemption parameter: a move to a *different* tile never conflicts
  with the mover's own occupancy, and a move onto its own tile is rejected
  by the equality check in §2.3 before this predicate is consulted.
- `autoPlacePosition(map, occupied)` — first free tile in the **legacy plot
  sequence** (Increment 2's derived pattern: cols 4, 6, 8, 10, 12 × rows 1,
  3, 5, …, occupied entries skipped), then — once the sequence runs off the
  map — the first free buildable tile in row-major order; `null` when no
  free tile remains.

The legacy-sequence-first rule is what makes v1 migration (§2.4) replay
Increment 2's exact geometry, and keeps table-built colonies looking like
they always have.

### 2.3 Sim becomes spatial

- New component `Position { col, row }` on building entities (registered in
  `COMPONENT_TYPES`; workers get none). New resource `WorldMap { cols, rows }`
  restored from the save. `spawnBuilding` takes the saved position;
  `buildingFactsOf`/`gatherEntityFacts`/`savedBuildingOf` extend per the
  one-edit principle; `BuildingSnapshot` gains `col`/`row` and `Snapshot`
  gains `map: { cols, rows }`.
- **`constructBuilding`** gains optional `at: { col, row }`:
  - With `at`: reject (notice) unless the tile is buildable. Position is
    validated **before** `pay()` — refusing after payment would swallow the
    cost, the same ordering principle the id-exhaustion check documents.
  - Without `at`: `autoPlacePosition`; reject with a notice when it returns
    `null` (map full). This is the tables' path and the no-WebGL fallback.
- **`demolishBuilding { buildingId }`** (new): reject if unknown; otherwise
  refund **100% of the def's cost** (`Stockpile.add`, saturating — flagged
  balance knob), set every assigned worker's `JobAssignment` to `null`
  (their dots walk home to the camp via the existing animation), and
  `actions.commands.removeEntity(entity)` — the building entity is obtained
  via `ReadEntity()` in the buildings query. Active batch progress is lost.
  One success notice.
- **`moveBuilding { buildingId, to }`** (new): reject if unknown, if the
  target equals its current tile, or if the target is not buildable.
  Otherwise rewrite `Position`. Workers, staffing, progress, and batch all
  survive; assigned dots walk to the new tile. One success notice.
- **Same-tick semantics.** sim-ecs defers entity removal to post-step sync,
  so the drain loop keeps a per-drain set of demolished ids: any later
  command this tick that targets one (assign, unassign, move, demolish)
  rejects as not found instead of acting on the still-synced entity. A tile
  freed by demolition becomes buildable on the **next** tick — occupancy
  queries are the truth and still see the leaving building; construct/move
  onto it this tick reject harmlessly.
- **Snapshot refresh on removal.** Entity removal consumes no id, so the
  id-counter delta that gates `refreshEntitySections` cannot see it — the
  exact gap game-engine.ts's `INVARIANT for increment 2` comment reserved.
  The demolish handler sets a dirty flag on a new tiny resource; `runStep`
  refreshes when `ids moved OR flag set`, clearing the flag. Position
  mutation (move) needs no signal: components mutate in place and
  SnapshotSystem runs after CommandSystem in the fixed stage order.
- `command-system.ts` decomposes (handlers extracted to a sibling module) so
  every unit stays under the complexity and LOC gates; the drain-loop
  dispatch shape is preserved. One notice per command, success or rejection,
  emitted after the state change it describes — doctrine unchanged.

### 2.4 Save v2 and migration

- `SavedBuilding` gains `col`/`row` (structural: safe integers ≥ 0);
  `SaveGameV2` gains `map` (bounds per §2.1). `LATEST_SAVE_VERSION → 2` —
  the deliberately self-policing bump: producers fail typecheck until the
  save type moves with it.
- The migration chain gets its **first real step, v1→v2** (guards table goes
  live with `2: isSaveGameV2`): copy the save, set `version: 2` and
  `map: DEFAULT_MAP`, and assign positions to buildings in ascending-id
  order via `autoPlacePosition` — pure structure, no catalog, honoring
  save-migration.ts's import discipline (shared-sibling imports only). An
  old colony loads with every building exactly where Increment 2 drew it.
  Fidelity governs the map size: `mapThatFits` makes the map tall enough
  that the **legacy plot sequence itself holds the whole colony**, so every
  building keeps the exact tile increment 2's (unbounded) derived grid drew
  it at — building 41 lands on its historical `(4, 17)`, not in a row-major
  spill. That exactness holds through 640 buildings (128 plot rows × 5
  inside `MAX_MAP`'s 256 rows), far past any organic colony. A colony that
  outgrew even that is a **valid save, not a corrupt one** — v1 never
  capped construction, and the structural guard admits up to 10,000 building
  records — so the map then grows for raw capacity (rows, then columns,
  within `MAX_MAP`, whose 64,768 buildable tiles cover the guard's cap) and
  buildings past the legacy band get compact, not historical, positions.
  The migration walks the linear placement sequence (`autoPlaceSequence` —
  provably `autoPlacePosition` replayed over an empty map), so even the
  cap-sized save migrates without stalling startup. The step's
  throw-on-exhaustion remains only as an unreachable invariant guard
  routing genuine geometry bugs to the corrupt-save backup path.
- `isLoadableSave` (v2, catalog-aware): every position on a buildable-class
  tile (in bounds, off the camp band) and **no two buildings on one tile**.
  Structural shape stays in `isSaveGameV2`; cross-field truths live here,
  like the id checks today.
- `initialSave()` emits v2 with `DEFAULT_MAP` and no buildings (unchanged
  otherwise). `buildSaveFromWorld` serializes positions and the map.

### 2.5 Renderer seam — three additions, still a dumb drawer

```ts
interface WorldRenderer {
  // existing: sync, pick, onFatal, start, stop, dispose
  tileAt(pageX: number, pageY: number): { col: number; row: number } | null;
  setGhost(ghost: GhostPreview | null): void;  // { defId, col, row, valid }
  setSelection(buildingId: number | null): void;
}
```

- `tileAt` converts through the live camera (`pageToWorldCoordinates`),
  `null` off-map. `setGhost` draws one translucent cached building visual at
  the tile — accent-tinted when `valid`, danger-tinted when not.
  `setSelection` draws a highlight ring at the selected building's tile,
  following it across moves (id-based, redrawn per sync). No mode logic, no
  dispatch, nothing testable beyond drawing lives in the renderer; it stays
  unit-test-exempt, covered by the optional Chromium smoke test (extended
  with ghost/selection assertions) and the manual Obsidian pass.
- `layout.ts` drops rank-derivation: buildings render at snapshot positions;
  grid dims come from `snapshot.map` (fixed — the rows-growth logic and
  `MIN_ROWS` go away). Worker spot derivation, slot memory, camp layout,
  and `pickBuildingAt` survive unchanged. The camera fit now frames constant
  dims; the resize refit stays.

### 2.6 Interaction model — the Vue view owns every mode

A three-state machine in the World view: `idle` / `place(defId)` /
`move(buildingId)`.

- **BuildPalette.vue** (DOM strip by the canvas): one button per def — name,
  glyph, cost, live affordability (disabled when unaffordable). Click arms
  `place`; click again (or Escape, or right-click on the canvas) disarms.
  While armed: pointer moves call `tileAt` and feed `setGhost` with
  `valid = isTileBuildable && affordable`; hover tooltips are suppressed; a
  click on a valid tile dispatches `constructBuilding { defId, at }` and
  **stays armed** (Banished-style repeat placement).
- **Selection.** In `idle`, clicking a building selects it (`setSelection`
  ring) and shows **SelectionPanel.vue** (DOM): name, staffing, state, tile,
  and two actions. **Demolish** is two-step — the button becomes "Confirm
  demolish?" and only then dispatches (`MouseEvent.detail` guard against
  double-click bypass, the colony-reset pattern). **Move** arms `move` with
  the building's own def as the ghost; a click on a valid target dispatches
  `moveBuilding` and returns to `idle` with the building still selected.
  Clicking empty ground deselects; workers stay hover-only this increment.
- Selection and modes are id-based and reactive: if the selected building
  vanishes from a snapshot (demolished, colony reset), selection clears and
  `move` mode cancels — the hover-revalidation pattern extended.
- Escape handling uses a window-level keydown listener registered only
  while a mode is armed or a selection exists — Escape cancels an armed
  mode first, and clears the selection when pressed in `idle`; right-click
  cancellation prevents the context menu only while armed.
- The engine stays authoritative: a click racing a same-tick occupation or
  stock change simply produces the engine's rejection notice in the existing
  NoticeBanner; the ghost is cosmetic pre-validation, never a promise.
- WorldView.vue decomposes (palette, panel, mode logic extracted) to hold
  the LOC and complexity gates; component tests keep driving everything
  through injected fake renderers.

### 2.7 Tables keep economic parity

- Buildings table: new **Tile** column (`(col, row)`), and a per-row
  **Demolish** with the same two-step confirm. Construct keeps dispatching
  without `at` (auto-place); its tooltip says so.
- Move is canvas-only — inherently spatial; a no-WebGL player loses nothing
  economic.
- WorldLegend gains entries for the ghost tints and the selection ring.

### 2.8 Testing

- **`placement.test.ts`** — buildability (bounds, camp band, occupancy),
  auto-place determinism, **golden equivalence**: for n ≤ 40 buildings the
  auto-place sequence reproduces Increment 2's derived `placeBuildings`
  geometry exactly (the legacy capacity of the default map); full-map →
  `null`.
- **`save-migration.test.ts`** — the real v1→v2 step: version/map/position
  synthesis, legacy-pattern fidelity (exact tiles past the default map's 40
  plots), ascending-id order, **overflow → capacity growth** (the
  guard-cap 10,000-building save migrates whole, distinct, and without
  stalling — `null` is reserved for genuine invariant failures, §2.4),
  guard registration (v2 now known, v3 unknown).
- **`command-system.test.ts`** — construct with `at` (accept; reject: out of
  bounds, camp band, occupied, unaffordable — and validate-before-pay:
  a rejected position leaves the stockpile untouched); auto-place path and
  map-full rejection; demolish (refund banked, workers idled, entity gone
  from next tick's facts, unknown id rejected); move (accept; reject:
  unknown, occupied, own tile, out of bounds; staffing/progress preserved);
  same-tick demolish-then-{assign,move,demolish} rejections.
- **`game-engine.test.ts`** — a demolishing tick refreshes entity sections
  (dirty flag), including while paused via `stepOnce`.
- **`world.test.ts` / `decide-load.test.ts`** — v2 spawn with positions;
  loadable-save rejections: duplicate tile, out of bounds, camp band, bad
  map bounds; v1 save restores through migration.
- **App tests** (fake renderers) — palette arm/disarm, ghost feed and
  validity, click dispatch with tile, stay-armed repeat, Escape/right-click
  cancel, selection lifecycle incl. reactive deselect, move flow, demolish
  confirm; Buildings table Tile column and Demolish; snapshot/store
  fixtures extended with positions and map.
- All gates green: lint (zones untouched — `shared/placement.ts` imports
  shared only), LOC cap < 500 per file via the §2.3/§2.6 decompositions,
  quality ratchet, css ratchet, typecheck, tests, build, artifacts
  (budgets unchanged — no new dependencies).

---

## 3. Acceptance criteria — Increment 3 is done when:

1. `npm run check:all` passes.
2. In Obsidian: arming a def shows a cursor-following ghost with
   valid/invalid tints; clicking a valid tile constructs that building
   there on the next tick; placement stays armed for repeat builds; Escape
   and right-click disarm.
3. Selecting a building shows its panel; Move relocates it (workers walking
   after it, staffing and batch intact); Demolish (after confirm) refunds
   its cost, frees the tile next tick, and sends its workers walking to the
   camp. Both also reject cleanly (notice, no state change) on invalid
   targets.
4. Constructing from the Buildings table auto-places on the legacy pattern;
   the table shows tiles and can demolish; with WebGL unavailable the
   economy remains fully playable from tables.
5. A v1 save loads with every building exactly where Increment 2 drew it
   (exact through 640 buildings — §2.4; compact positions only in the
   pathological band beyond); a
   fresh colony starts as v2; saves round-trip positions and map byte-
   stably; unloadable v2 shapes (duplicate tiles, out-of-bounds) take the
   backup path.
6. The world is a fixed 24×16 grid with the camp band on the left (a
   migrated colony that outgrew it carries the larger persisted map
   `mapThatFits` chose — §2.4); nothing can be placed out of bounds, on the
   camp, or on another building — each rejection surfaces as a notice.

---

## 4. Alternatives considered and rejected

- **App-owned positions** (Pinia store persisted beside the save; sim stays
  spaceless). Rejected: demolition requires engine entity removal anyway,
  two persistence stores can desync, and logistics later forces the sim-side
  rework regardless — debt with no lasting payoff.
- **DOM-overlay interaction** (absolutely-positioned tile grid over the
  canvas for clicks/ghost instead of extending the renderer seam).
  Rejected: the camera transform (zoom, centering, resize) would be
  mirrored in CSS forever, while the seam's `pick()` already solved
  pointer→world conversion; the seam extension is three drawing-only
  methods.
- **Plot-grid placement** (players choose among gutter-spaced plots rather
  than free tiles). Rejected: free adjacency is genre-normal and the
  gutter aesthetic remains available to players who want it; enforcing it
  would complicate the rule module for no simulation gain.
- **Place-only scope** (defer demolish/move). Rejected by product decision:
  misplacements would be permanent, and the engine comments had already
  reserved the removal path; the full kit makes the increment a complete
  play loop.
