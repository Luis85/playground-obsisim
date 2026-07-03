# PRD: ObsiSim — a Colony Simulation Game as an Obsidian Plugin

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Scope of this document:** Game vision, pillars, and increment roadmap; detailed specification of Increment 1 (Economy Core).

---

## 1. Vision

A Banished-inspired colony simulation that runs entirely inside Obsidian as a community plugin. The player grows a settlement from a handful of workers into an economic powerhouse by building interlocking production chains: raw goods are refined into more valuable products, which feed workers, boost efficiency, unlock science, and eventually drive trade.

The heart of the game is the **economy simulation**. Everything else — graphics, map, events — is presentation layered on top later. The first increments have no graphics at all: the simulation is displayed in tables, and that table UI is a first-class interface, not a placeholder.

### 1.1 Pillars

1. **Value chains** — every resource has a value; refining multiplies it. Wealth is built by chaining production, not hoarding raw goods.
2. **Living economy** — production, consumption, and worker needs form feedback loops the player balances.
3. **Simulation-first** — the sim is a deterministic, headless engine, fully testable without any UI.
4. **Obsidian-native** — installs like any community plugin, opens as a workspace view, state persists between sessions, respects the user's theme.

### 1.2 Increment roadmap

Each increment gets its own detailed spec when its turn comes. This PRD specifies Increment 1 in full.

| # | Increment | Contents |
|---|-----------|----------|
| 1 | **Economy core** *(this PRD)* | Tick engine, resources, three-tier production chains, workers with hunger, table UI, autosave |
| 2 | Survival & population | Housing, birth/aging/death, seasons, food variety, death-spiral dynamics |
| 3 | Science chains | Research production, tech tree, unlocks and efficiency upgrades |
| 4 | Trade & markets | Traders, dynamic prices, imports/exports — the "economy powerhouse" endgame |
| 5 | Events & balancing | Disasters, migrations, difficulty tuning, milestones/win conditions, charts |
| 6 | Map & graphics | Spatial placement and rendering, replacing tables as the primary (not only) interface |

---

## 2. Architecture

Three layers with strict one-way dependencies — **UI → shared contracts ← engine** — hosted in a thin Obsidian shell.

### 2.1 Layers

- **Obsidian shell** (`src/main.ts`, `src/view/`): a `Plugin` subclass registers a custom `ItemView`, opened via ribbon icon and command palette. The view mounts the Vue app and owns lifecycle: create the engine on open, trigger autosave and teardown on close. Persistence goes through Obsidian's `loadData()` / `saveData()` (plugin `data.json`).
- **Engine** (`src/engine/`): the sim-ecs world plus all components, systems, and the content catalog (building/recipe/resource definitions as plain typed data). Exposes a small `GameEngine` facade:
  - `start()` / `pause()` / `setSpeed(1|2|4)` / `step()`
  - `dispatch(command: Command)`
  - `onSnapshot(callback: (s: Snapshot) => void)`
  - `serialize(): SaveGame` / `restore(save: SaveGame)`

  The engine knows nothing about Vue or Obsidian. It runs headless in vitest and could run in Node unchanged.
- **UI** (`src/app/`): Vue 3 app with Vue Router (memory history — Obsidian has no URL bar) and Pinia. Pinia stores are pure **read-models**: each engine tick publishes an immutable snapshot which a single store action ingests. User actions never mutate stores directly; they call `engine.dispatch(...)`, and the engine's command system applies them at the next tick boundary.
- **Shared contracts** (`src/shared/`): the TypeScript types both sides depend on — `Snapshot`, `Command`, `SaveGame`, and content-catalog types. This seam keeps the layers decoupled.

### 2.2 Data flow per tick

```
command queue drained → sim systems run (fixed order) → snapshot projected
→ Pinia store ingests snapshot → tables re-render
```

The tick loop runs on a `setInterval` owned by the engine facade, registered with the view's lifecycle so Obsidian cleans it up on close.

---

## 3. Increment 1 — Game Design

### 3.1 Resources

Nine visible numbers: seven resources, each with a base value, plus two derived meta-numbers. Base values are the foundation of the value-chain pillar.

| Resource | Tier | Base value | Notes |
|----------|------|-----------:|-------|
| Berries | raw | 1 | edible |
| Wheat | raw | 1 | not edible directly (needs milling) |
| Wood | raw | 1 | construction input |
| Flour | processed | 3 | from wheat |
| Planks | processed | 3 | from wood; construction input |
| Bread | finished | 8 | best food |
| Tools | finished | 10 | boosts building efficiency |

Derived: **colony wealth** = Σ (stockpile × base value), and per-resource **net flow** (production − consumption per tick, rolling average). Slots for stone, iron, etc. open in later increments.

### 3.2 Production chains

- **Food chain:** Gatherer's Hut → berries *(safety net)*; Farm → wheat → Mill → flour → Bakery → bread.
- **Industry chain:** Forester → wood → Sawmill → planks → Workshop → tools.

### 3.3 Buildings

Seven building types. Each has: a construction cost (paid instantly from the stockpile), a number of worker slots, and exactly one recipe. Starting balance values (tuning expected during implementation; these are the initial catalog entries):

| Building | Cost | Worker slots | Recipe |
|----------|------|:---:|--------|
| Gatherer's Hut | 10 wood | 2 | → 1 berries, 3 worker-ticks/batch |
| Farm | 20 wood | 4 | → 1 wheat, 4 worker-ticks/batch |
| Mill | 20 wood + 10 planks | 2 | 1 wheat → 1 flour, 3 worker-ticks/batch |
| Bakery | 15 wood + 10 planks | 2 | 1 flour → 1 bread, 4 worker-ticks/batch |
| Forester | 10 wood | 2 | → 1 wood, 3 worker-ticks/batch |
| Sawmill | 25 wood | 2 | 1 wood → 1 planks, 3 worker-ticks/batch |
| Workshop | 20 planks | 2 | 1 planks → 1 tools, 5 worker-ticks/batch |

**Starting state:** 30 wood, 20 berries, 3 unassigned workers — enough to bootstrap a Gatherer's Hut or Forester and start either chain.

### 3.4 Recipes and production

Recipes are the universal production unit: `inputs → outputs over N worker-ticks per batch`.

- A staffed building accumulates progress each tick: `progress += Σ over assigned workers (workerEfficiency × workerToolMultiplier)` — each worker's own tool coverage determines their multiplier.
- Input availability is checked when a batch **starts**; inputs are consumed at batch start. When `progress ≥ ticksPerBatch`, outputs are added to the stockpile and the next batch may start.
- A building missing inputs stalls and reports "waiting for input" in its snapshot state. An unstaffed building reports "unstaffed".

### 3.5 Workers, hunger, efficiency

- Workers are recruited via a button, at most **1 recruit per 30 ticks** (cooldown), so food pressure stays meaningful.
- Each worker is an individual entity with `hunger: 0–100` (0 = full). Hunger rises by **1 per tick**. At the meal threshold (**hunger ≥ 50**) the worker eats from the stockpile: **bread first** (1 bread resets hunger to 0), **berries as fallback** (1 berries reduces hunger by 30). If no food is available, hunger keeps rising to the cap. These are starting balance values like §3.3's.
- Worker efficiency is a function of hunger: fed = **1.0**, sliding linearly down to **0.2** when fully starving. **Nobody dies in Increment 1** — starvation is soft pressure, not a fail state.
- Workers are assigned/unassigned to buildings via +/− buttons, bounded by each building's worker slots.

### 3.6 Tools loop

Tool coverage is **per worker**: each staffed worker consumes **1 tool per 300 ticks** *if tools are available*, and a covered worker works at **+50% efficiency** (tool multiplier 1.5 vs 1.0). Coverage belongs to the worker — it follows them across reassignment, wears down over time whether assigned or idle, and a replacement worker pays for their own tool (building-level buffs keyed on headcount proved exploitable in review). Idle workers never consume new tools. Tools are never mandatory — just profitable. This closes the economy: industry output feeds back into everyone's productivity.

### 3.7 Tick model and speed

- 1 tick = 1 simulation step. At 1× speed the engine runs **2 ticks/second** (2× → 4/s, 4× → 8/s). Pause and single-step included.
- All rates in this document are **per tick**, so determinism holds: *N ticks produce identical state at any speed* — speed only changes the wall-clock interval. There is no randomness in Increment 1.

---

## 4. Increment 1 — Data Model & Systems (ECS)

### 4.1 Static content catalog

Plain typed data modules (no entities): `ResourceDef`, `RecipeDef`, `BuildingDef`. The balancing tables in §3 live here as typed constants, validated by tests. The catalog is code, not save data.

### 4.2 Components

**Building entity:**
- `Building { defId }`
- `WorkerSlots { max }`
- `Production { progress, batchActive }`

**Worker entity:**
- `Worker {}` (tag)
- `Hunger { value }`
- `JobAssignment { buildingId | null }`
- `Efficiency { value }` (recomputed each tick)
- `ToolCoverage { remainingTicks }` (0 = no tool)

### 4.3 World resources (singletons)

- `Stockpile` — map `resourceId → amount`
- `SimClock { tick, paused, speed }`
- `CommandQueue` — commands dispatched from the UI since the last tick
- `StatsHistory` — rolling per-resource production/consumption rates over the last 100 ticks; colony wealth

### 4.4 Systems, in fixed execution order

Execution order is part of the spec — it is what makes runs reproducible.

1. **CommandSystem** — drains the queue: construct building (validates and pays cost), recruit worker (validates cooldown), assign/unassign worker (validates slots), reset colony. Invalid commands are rejected with a reason string surfaced to the UI.
2. **HungerSystem** — raises hunger; workers at the meal threshold eat from the stockpile (bread, then berries).
3. **EfficiencySystem** — computes each worker's efficiency from hunger; maintains per-worker tool coverage (staffed, uncovered workers consume a tool; coverage wears down each tick).
4. **ProductionSystem** — per staffed building: start a batch if inputs are available (consuming them), advance progress, emit outputs on completion.
5. **StatsSystem** — records per-tick flows into rolling averages; computes colony wealth.
6. **SnapshotSystem** — projects world state into an immutable `Snapshot` and invokes the engine's snapshot callback. This is the only place the UI boundary is touched.

### 4.5 Persistence

- **Autosave** every 100 ticks and on view close, to the plugin's `data.json` via `saveData()`.
- Custom serializer covering stockpile, clock, buildings, and workers. The content catalog is code, so saves stay small and survive balancing changes.
- The save embeds a **schema version** for future migrations. A corrupt or incompatible save is copied to a `.bak` key inside `data.json`, and a fresh colony starts with an Obsidian `Notice`.
- One save slot. A "reset colony" button (with confirmation) starts over.
- Save validation rejects only structural/identity violations no engine version could have written; balance-coupled values from older saves are clamped or grandfathered on load, so retuning balance never orphans a save.

---

## 5. Increment 1 — UI

A persistent **top bar** across all routes: tick counter, pause/play, speed (1×/2×/4×), step-one-tick button, and a colony summary (population, colony wealth, and a low-food warning when edible stock is low).

Four routes (Vue Router, memory history):

- **Dashboard** — colony wealth, population, headline stats, and a per-resource table: stock, production rate, consumption rate, net flow (color-coded ±), value of holdings. The "is my economy healthy?" screen.
- **Buildings** — table of constructed buildings: type, workers (with **+ / −** assign buttons), efficiency, recipe state (producing / waiting for input / unstaffed), output rate. Below it, a construction panel listing all building defs with costs; buttons disabled with a reason when unaffordable.
- **Population** — worker table: job, hunger, efficiency; plus the **Recruit worker** button with its cooldown state.
- **Economy** — the value-chain view: each chain as a table of stages (resource → building → resource) with throughput per stage, so bottlenecks are visible (e.g. "the mill starves the bakery").

Plain HTML tables and buttons, styled minimally with Obsidian CSS variables so the plugin inherits the user's theme. No canvas, no charts (charts arrive with Increment 5).

---

## 6. Tech Setup

- **Language:** TypeScript, strict mode.
- **Build:** Vite in library mode producing the Obsidian plugin format — single CJS `main.js`, plus `manifest.json` and `styles.css`. `@vitejs/plugin-vue` for SFCs.
- **Frontend:** Vue 3 (Composition API), Vue Router 4 (memory history), Pinia.
- **Simulation:** `sim-ecs@0.6.4`.
- **Test:** Vitest — Node environment for engine tests, happy-dom for store/component tests.
- **Lint:** ESLint flat config with `typescript-eslint` and `eslint-plugin-vue`.
- **Obsidian:** `obsidian` package (types, dev-only dependency).
- **Dev loop:** `npm run dev` builds in watch mode into `demo-vault/.obsidian/plugins/obsisim/` — a minimal vault committed to the repo. Open the vault in Obsidian and reload to test.

**Repo layout:**

```
src/
  main.ts        # Plugin entry: registers view, ribbon, commands, load/save
  view/          # ItemView subclass, Vue app mount/unmount
  app/           # Vue: views (routes), components, stores, router
  engine/        # sim-ecs: components, systems, content catalog, GameEngine facade
  shared/        # Snapshot, Command, SaveGame, catalog types
tests/           # vitest suites (mirrors src structure)
demo-vault/      # minimal Obsidian vault for the dev loop
```

---

## 7. Testing & Error Handling

### 7.1 Testing

The sim is the product, so engine tests carry the weight:

- **System tests:** headless world, scripted commands, run N ticks, assert stockpile/entity state. Example: "farm + mill + bakery staffed for 200 ticks ⇒ bread > 0 and wheat does not accumulate unboundedly."
- **Determinism test:** the same command script run twice ⇒ deep-equal final snapshots.
- **Content validation tests:** every recipe references existing resources; every building's recipe exists; every building's cost is payable in some reachable state (no orphaned or circular definitions).
- **Serialization round-trip test:** run 500 ticks → save → restore → run 100 more ⇒ state identical to 600 straight ticks.
- **Store tests:** snapshot ingestion updates Pinia correctly. UI component tests kept minimal (tables render from store state).

### 7.2 Error handling

- A system throwing during a tick **pauses the sim** and surfaces an Obsidian `Notice` plus an error banner in the view. State stays inspectable — freeze, don't crash.
- Corrupt/incompatible saves: backed up to a `.bak` key in `data.json`; fresh colony starts with a notice (see §4.5).
- Command validation is authoritative in the CommandSystem (unaffordable → rejected with a reason the UI surfaces). The UI additionally pre-checks affordability to disable buttons, but the engine check decides.

---

## 8. Acceptance Criteria — Increment 1 is done when:

1. The plugin loads in Obsidian, opens its view from the ribbon, and survives view close/reopen and Obsidian restart with state intact (autosave).
2. From the starting state, a player can bootstrap both full chains and reach steady bread + tools production, using only the table UI.
3. Hunger works: cutting off food visibly drops worker efficiency toward 0.2, and restoring food recovers it; nobody dies.
4. Tools work: tooled workers demonstrably work +50% faster and tools are consumed over time.
5. Pause/speed/step behave deterministically — N ticks produce identical state regardless of speed, verified by test.
6. All engine behavior above is covered by headless vitest tests; lint and tests pass clean.

### Explicitly out of scope for Increment 1

Graphics/map/spatial placement, housing, birth/death/aging, seasons, science, trade, difficulty/win conditions, mobile support, multiple save slots.
