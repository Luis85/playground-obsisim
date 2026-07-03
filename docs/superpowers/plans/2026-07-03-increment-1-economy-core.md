# ObsiSim Increment 1 (Economy Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first vertical slice of ObsiSim — a deterministic, headless colony-economy simulation (sim-ecs) with a table-based Vue 3 UI, running as an Obsidian plugin with single-slot autosave.

**Architecture:** A UI-agnostic `GameEngine` facade wraps a sim-ecs world that runs six systems in fixed stage order (Command → Hunger → Efficiency → Production → Stats → Snapshot). Each tick, the SnapshotSystem projects an immutable `Snapshot` that a Pinia store ingests; the Vue UI dispatches `Command` objects back through the facade's queue. A thin Obsidian `ItemView` hosts the Vue app and persists saves via `loadData()`/`saveData()`.

**Tech Stack:** TypeScript (strict), sim-ecs 0.6.4, Vue 3 (`<script setup>`), Vue Router 4 (memory history), Pinia, Vite (library mode), Vitest, ESLint flat config, Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md` — all balance values and rules come from there.

## Global Constraints

- Plugin id is `obsisim`; the custom view type is `obsisim-game`.
- TypeScript `strict: true` everywhere; Vue SFCs use `<script setup lang="ts">`.
- `sim-ecs` version: `0.6.4` (pin exactly — pre-1.0 minor bumps break APIs; 0.6.5 exists only in the GitHub repo, unpublished — npm's latest is 0.6.4, one small commit behind, with every API this plan uses).
- Layering: `src/engine/` and `src/shared/` MUST NOT import from `vue`, `pinia`, `vue-router`, or `obsidian`. `src/app/` MUST NOT import `sim-ecs` directly (only via the `GameEngine` facade and `Snapshot` types).
- `src/engine/content/` modules are pure data + pure functions and MUST NOT import `sim-ecs`; the UI is allowed to import them (catalog rendering).
- Determinism: no `Date.now()`, `Math.random()`, or wall-clock dependence anywhere in `src/engine/` (the `setInterval` in the GameEngine facade is the only timing code, and it only decides *when* to tick, never *what happens*).
- All production/consumption rates are **per tick**. 1× speed = 2 ticks/second (`BALANCE.baseTicksPerSecond`).
- Every balance number comes from the `BALANCE` constant or the content catalog — never inline magic numbers in systems.
- System execution order is fixed and must never be reordered: CommandSystem → HungerSystem → EfficiencySystem → ProductionSystem → StatsSystem → SnapshotSystem, one system per sim-ecs stage.
- Run `npm run lint` and `npm test` before every commit; both must pass. From Task 18 on, the full pre-push gate is `npm run check:all` (lint, LOC guard, CSS guard, quality ratchet, typecheck, tests, build, artifact smoke).
- Quality-gate policy (Task 18, ported from Luis85/specorator `docs/build-ci/quality-gates.md`): every ratchet baseline starts EMPTY or at zero — this is a greenfield repo, nothing gets grandfathered. Lint is all-error from day one (`warn` tier exists only for staging future rules and stays empty).

## File Structure (final state)

```
manifest.json                 # Obsidian plugin manifest (repo root)
styles.css                    # Obsidian-theme-aware styles (repo root, copied to build)
vite.config.ts, vitest.config.ts, eslint.config.js, tsconfig.json, package.json
.fallowrc.json                # fallow config: architecture boundary zones (Task 18)
.github/workflows/ci.yml      # CI gate jobs (Task 18)
scripts/                      # quality-gate scripts + ratchet baselines (Task 18)
docs/build-ci/quality-gates.md# gate catalogue for this repo (Task 18)
demo-vault/                   # minimal vault for the dev loop
src/
  main.ts                     # Plugin entry (Obsidian Plugin subclass)
  view/game-view.ts           # ItemView hosting the Vue app
  shared/content-types.ts     # ResourceId, BuildingDefId, defs, CostMap
  shared/commands.ts          # Command union
  shared/snapshot.ts          # Snapshot, BuildingSnapshot, WorkerSnapshot, ResourceStats, EngineStatus
  shared/save.ts              # SaveGameV1 + isSaveGameV1 guard
  engine/content/balance.ts   # BALANCE constant + workerEfficiency() + starting state
  engine/content/resources.ts # RESOURCES catalog
  engine/content/buildings.ts # BUILDINGS catalog
  engine/content/chains.ts    # CHAINS (economy view data)
  engine/components.ts        # ECS components
  engine/resources.ts         # ECS world resources (Stockpile, SimClock, ...)
  engine/systems/command-system.ts
  engine/systems/hunger-system.ts
  engine/systems/efficiency-system.ts
  engine/systems/production-system.ts
  engine/systems/stats-system.ts
  engine/systems/snapshot-system.ts
  engine/world.ts             # buildColonyPrepWorld, spawn helpers, createColonyWorld, initialSave
  engine/game-engine.ts       # GameEngine facade + buildSaveFromWorld
  app/index.ts                # createGameApp(engine, container)
  app/engine-key.ts           # InjectionKey<GameEngine>
  app/router.ts               # createGameRouter()
  app/stores/game-store.ts    # useGameStore (Pinia read-model)
  app/App.vue                 # nav + TopBar + router-view + banners
  app/components/TopBar.vue
  app/views/DashboardView.vue
  app/views/BuildingsView.vue
  app/views/PopulationView.vue
  app/views/EconomyView.vue
tests/                        # vitest suites, mirrors src/
```

**sim-ecs API cheat sheet** (verified against sim-ecs source at v0.6.4; implementers have zero sim-ecs context):

```ts
import { Actions, buildWorld, createSystem, queryComponents, Read, Write,
         ReadResource, WriteResource } from 'sim-ecs';
// createSystem takes a named-parameter dict: any number of queryComponents(...),
// XxxResource(...), and Actions entries. .withName('X').withRunFunction(fn).build()
// Prep world: buildWorld().withDefaultScheduling(root => root.addNewStage(s => s.addSystem(Sys))...)
//   .withComponent(Comp).build()
// Stages run sequentially → one system per stage enforces our fixed order.
// prepWorld.addResource(instanceOrCtor)  /  prepWorld.buildEntity().with(instance).build() → IEntity
// IEntity.getComponent(Ctor) → T | undefined   (tests hold entity refs and inspect them)
// const runWorld = await prepWorld.prepareRun();  await runWorld.step();  // one full pipeline pass + command sync
// runWorld.getResource(Ctor) → T
// Inside systems: actions.commands.buildEntity()... queues entity creation, applied at end of the step.
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `manifest.json`, `styles.css`, `.gitignore`, `src/main.ts` (stub), `tests/smoke.test.ts`, `demo-vault/.obsidian/app.json`, `demo-vault/.obsidian/community-plugins.json`, `demo-vault/Welcome.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: working `npm run lint` / `npm test` / `npm run build` / `npm run dev` commands every later task relies on. Build output lands in `demo-vault/.obsidian/plugins/obsisim/`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "obsisim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "dependencies": {
    "pinia": "^3.0.1",
    "sim-ecs": "0.6.4",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.20.0",
    "@vitejs/plugin-vue": "^5.2.1",
    "@vue/test-utils": "^2.4.6",
    "eslint": "^9.20.0",
    "eslint-plugin-vue": "^10.0.0",
    "happy-dom": "^20.10.6",
    "obsidian": "^1.7.2",
    "typescript": "^5.7.3",
    "typescript-eslint": "^8.24.0",
    "vite": "^6.1.0",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write vite.config.ts**

Library-mode build producing the Obsidian plugin format (single CJS `main.js`), with `obsidian` external and manifest/styles copied beside it:

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = 'demo-vault/.obsidian/plugins/obsisim';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'copy-plugin-assets',
      closeBundle() {
        copyFileSync('manifest.json', `${outDir}/manifest.json`);
        copyFileSync('styles.css', `${outDir}/styles.css`);
      },
    },
  ],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['obsidian'],
      output: { exports: 'named' },
    },
    outDir,
    emptyOutDir: false,
    sourcemap: 'inline',
  },
});
```

- [ ] **Step 4: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
  },
});
```

(Engine tests run in `node`; UI test files opt into happy-dom with a `// @vitest-environment happy-dom` pragma on line 1.)

- [ ] **Step 5: Write eslint.config.js**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';

export default tseslint.config(
  { ignores: ['demo-vault/', 'node_modules/', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
);
```

- [ ] **Step 6: Write manifest.json, styles.css, .gitignore, demo vault, and stubs**

`manifest.json`:

```json
{
  "id": "obsisim",
  "name": "ObsiSim",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "A colony simulation game: grow a settlement into an economic powerhouse through simulated production chains.",
  "author": "Luis85",
  "isDesktopOnly": false
}
```

`styles.css` (placeholder for now, filled in Task 17):

```css
/* ObsiSim — styles land in Task 17 */
```

`.gitignore`:

```
node_modules/
dist/
demo-vault/.obsidian/plugins/
demo-vault/.obsidian/workspace.json
.superpowers/
```

`demo-vault/.obsidian/app.json`:

```json
{}
```

`demo-vault/.obsidian/community-plugins.json`:

```json
["obsisim"]
```

`demo-vault/Welcome.md`:

```markdown
Open ObsiSim from the ribbon icon (factory) or the command palette: "ObsiSim: Open game".
```

`src/main.ts` (stub, replaced in Task 16):

```ts
import { Plugin } from 'obsidian';

export default class ObsiSimPlugin extends Plugin {}
```

`tests/smoke.test.ts` (deleted in Task 2):

```ts
import { expect, it } from 'vitest';

it('scaffold smoke test', () => {
  expect(true).toBe(true);
});
```

- [ ] **Step 7: Install and verify all gates**

Run: `npm install`
Expected: resolves cleanly (sim-ecs pinned at 0.6.4).

Run: `npm run lint`
Expected: exit 0, no errors.

Run: `npm test`
Expected: 1 passed (smoke test).

Run: `npm run build`
Expected: `demo-vault/.obsidian/plugins/obsisim/main.js`, `manifest.json`, `styles.css` exist.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Obsidian plugin project (vite, vitest, eslint, demo vault)"
```

---

### Task 2: Shared contracts and content catalog

**Files:**
- Create: `src/shared/content-types.ts`, `src/shared/commands.ts`, `src/shared/snapshot.ts`, `src/shared/save.ts`, `src/engine/content/balance.ts`, `src/engine/content/resources.ts`, `src/engine/content/buildings.ts`, `src/engine/content/chains.ts`
- Test: `tests/engine/content.test.ts`
- Delete: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `ResourceId`, `BuildingDefId`, `CostMap`, `ResourceDef`, `RecipeDef`, `BuildingDef` (content-types)
  - `Command` union (commands)
  - `Snapshot`, `BuildingSnapshot`, `WorkerSnapshot`, `ResourceStats`, `BuildingState`, `EngineStatus` (snapshot)
  - `SaveGameV1`, `SavedBuilding`, `SavedWorker`, `isSaveGameV1(data: unknown): data is SaveGameV1` (save)
  - `BALANCE`, `workerEfficiency(hunger: number): number`, `STARTING_STOCK`, `STARTING_WORKERS` (balance)
  - `RESOURCES: Record<ResourceId, ResourceDef>`, `RESOURCE_IDS: readonly ResourceId[]` (resources)
  - `BUILDINGS: Record<BuildingDefId, BuildingDef>`, `BUILDING_IDS: readonly BuildingDefId[]` (buildings)
  - `CHAINS: readonly Chain[]` (chains)

- [ ] **Step 1: Write the failing content-validation test**

`tests/engine/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE, STARTING_STOCK, workerEfficiency } from '../../src/engine/content/balance';
import { RESOURCES, RESOURCE_IDS } from '../../src/engine/content/resources';
import { BUILDINGS, BUILDING_IDS } from '../../src/engine/content/buildings';
import { CHAINS } from '../../src/engine/content/chains';
import type { ResourceId } from '../../src/shared/content-types';

describe('content catalog', () => {
  it('has 7 resources and 7 buildings', () => {
    expect(RESOURCE_IDS).toHaveLength(7);
    expect(BUILDING_IDS).toHaveLength(7);
  });

  it('recipes and costs only reference existing resources', () => {
    for (const id of BUILDING_IDS) {
      const def = BUILDINGS[id];
      for (const res of Object.keys(def.cost)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      for (const res of Object.keys(def.recipe.inputs)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      for (const res of Object.keys(def.recipe.outputs)) expect(RESOURCES[res as ResourceId]).toBeDefined();
      expect(def.recipe.ticksPerBatch).toBeGreaterThan(0);
      expect(def.workerSlots).toBeGreaterThan(0);
    }
  });

  it('every resource is produced by at least one recipe', () => {
    for (const id of RESOURCE_IDS) {
      const produced = BUILDING_IDS.some((b) => (BUILDINGS[b].recipe.outputs[id] ?? 0) > 0);
      expect(produced, `${id} has no producer`).toBe(true);
    }
  });

  it('all construction costs are reachable from the starting stock', () => {
    // every cost resource is either in STARTING_STOCK or produced by a building
    // whose own cost only needs starting-stock resources (wood bootstrap)
    const starting = new Set(Object.keys(STARTING_STOCK));
    for (const id of BUILDING_IDS) {
      for (const res of Object.keys(BUILDINGS[id].cost)) {
        const producedSomewhere = BUILDING_IDS.some((b) => (BUILDINGS[b].recipe.outputs[res as ResourceId] ?? 0) > 0);
        expect(starting.has(res) || producedSomewhere, `cost ${res} unreachable`).toBe(true);
      }
    }
  });

  it('chains reference real buildings that output the claimed resource', () => {
    for (const chain of CHAINS) {
      for (const step of chain.steps) {
        const def = BUILDINGS[step.building];
        expect(def).toBeDefined();
        expect((def.recipe.outputs[step.output] ?? 0) > 0).toBe(true);
      }
    }
  });

  it('exactly bread and berries are edible', () => {
    const edible = RESOURCE_IDS.filter((id) => RESOURCES[id].edible);
    expect(edible.sort()).toEqual(['berries', 'bread']);
  });

  it('workerEfficiency matches the spec curve', () => {
    expect(workerEfficiency(0)).toBe(1);
    expect(workerEfficiency(BALANCE.mealThreshold)).toBe(1);
    expect(workerEfficiency(75)).toBeCloseTo(0.6);
    expect(workerEfficiency(100)).toBeCloseTo(0.2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rm tests/smoke.test.ts && npx vitest run tests/engine/content.test.ts`
Expected: FAIL — cannot resolve `src/engine/content/balance` (module not found).

- [ ] **Step 3: Write the shared types**

`src/shared/content-types.ts`:

```ts
export type ResourceId = 'berries' | 'wheat' | 'wood' | 'flour' | 'planks' | 'bread' | 'tools';

export type BuildingDefId =
  | 'gatherersHut'
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'forester'
  | 'sawmill'
  | 'workshop';

export type ResourceTier = 'raw' | 'processed' | 'finished';

export type CostMap = Partial<Record<ResourceId, number>>;

export interface ResourceDef {
  id: ResourceId;
  name: string;
  tier: ResourceTier;
  value: number;
  edible: boolean;
}

export interface RecipeDef {
  inputs: CostMap;
  outputs: CostMap;
  /** Worker-ticks of accumulated progress needed to finish one batch. */
  ticksPerBatch: number;
}

export interface BuildingDef {
  id: BuildingDefId;
  name: string;
  cost: CostMap;
  workerSlots: number;
  recipe: RecipeDef;
}

export interface ChainStep {
  building: BuildingDefId;
  output: ResourceId;
}

export interface Chain {
  name: string;
  steps: readonly ChainStep[];
}
```

`src/shared/commands.ts`:

```ts
import type { BuildingDefId } from './content-types';

export type Command =
  | { type: 'constructBuilding'; buildingDefId: BuildingDefId }
  | { type: 'recruitWorker' }
  | { type: 'assignWorker'; buildingId: number }
  | { type: 'unassignWorker'; buildingId: number };
```

`src/shared/snapshot.ts`:

```ts
import type { BuildingDefId, ResourceId } from './content-types';

export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed';

export interface BuildingSnapshot {
  id: number;
  defId: BuildingDefId;
  workers: number;
  workerSlots: number;
  state: BuildingState;
  /** Raw batch progress in worker-ticks. */
  progress: number;
  batchActive: boolean;
  /** 0-100, for display. */
  progressPct: number;
  /** Assigned workers whose tool coverage is currently active. */
  tooledWorkers: number;
  /** Effective work per tick: sum of assigned worker efficiencies x per-worker tool multiplier. */
  workPower: number;
}

export interface WorkerSnapshot {
  id: number;
  hunger: number;
  efficiency: number;
  buildingId: number | null;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
}

export interface ResourceStats {
  stock: number;
  productionRate: number;
  consumptionRate: number;
  netFlow: number;
  stockValue: number;
}

export interface Snapshot {
  tick: number;
  lastRecruitTick: number;
  stockpile: Record<ResourceId, ResourceStats>;
  colonyWealth: number;
  population: number;
  idleWorkers: number;
  buildings: BuildingSnapshot[];
  workers: WorkerSnapshot[];
  /** Command rejections etc. from this tick; cleared after each snapshot. */
  notices: string[];
}

export interface EngineStatus {
  paused: boolean;
  speed: 1 | 2 | 4;
  error: string | null;
}
```

`src/shared/save.ts`:

```ts
import type { BuildingDefId, ResourceId } from './content-types';

export interface SavedBuilding {
  defId: BuildingDefId;
  progress: number;
  batchActive: boolean;
}

export interface SavedWorker {
  hunger: number;
  /** Index into SaveGameV1.buildings, or null when idle. */
  buildingIndex: number | null;
  /** Remaining ticks of this worker's tool coverage (0 = none). */
  toolTicks: number;
}

export interface SaveGameV1 {
  version: 1;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  buildings: SavedBuilding[];
  workers: SavedWorker[];
}

export function isSaveGameV1(data: unknown): data is SaveGameV1 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  // Number.isFinite, never typeof: NaN and Infinity pass typeof === 'number'
  // and would silently poison sim arithmetic instead of taking the backup path.
  return (
    save.version === 1 &&
    Number.isFinite(save.tick) &&
    Number.isFinite(save.lastRecruitTick) &&
    typeof save.stockpile === 'object' && save.stockpile !== null &&
    Array.isArray(save.buildings) &&
    save.buildings.every((b: unknown) =>
      typeof b === 'object' && b !== null &&
      typeof (b as SavedBuilding).defId === 'string' &&
      Number.isFinite((b as SavedBuilding).progress) &&
      typeof (b as SavedBuilding).batchActive === 'boolean') &&
    Array.isArray(save.workers) &&
    save.workers.every((w: unknown) =>
      typeof w === 'object' && w !== null &&
      Number.isFinite((w as SavedWorker).hunger) &&
      Number.isFinite((w as SavedWorker).toolTicks) &&
      ((w as SavedWorker).buildingIndex === null || Number.isFinite((w as SavedWorker).buildingIndex)))
  );
}
```

- [ ] **Step 4: Write the content catalog**

`src/engine/content/balance.ts`:

```ts
import type { ResourceId } from '../../shared/content-types';

export const BALANCE = {
  hungerPerTick: 1,
  hungerMax: 100,
  mealThreshold: 50,
  berriesHungerRestore: 30,
  starvingEfficiency: 0.2,
  toolMultiplier: 1.5,
  toolDurationTicks: 300,
  recruitCooldownTicks: 30,
  autosaveEveryTicks: 100,
  baseTicksPerSecond: 2,
  statsWindowTicks: 100,
} as const;

/** Spec 3.5: fed = 1.0 up to the meal threshold, then linear down to 0.2 at max hunger. */
export function workerEfficiency(hunger: number): number {
  if (hunger <= BALANCE.mealThreshold) return 1;
  const starvation = (hunger - BALANCE.mealThreshold) / (BALANCE.hungerMax - BALANCE.mealThreshold);
  return 1 - (1 - BALANCE.starvingEfficiency) * starvation;
}

export const STARTING_STOCK: Partial<Record<ResourceId, number>> = {
  wood: 30,
  berries: 20,
};

export const STARTING_WORKERS = 3;
```

`src/engine/content/resources.ts`:

```ts
import type { ResourceDef, ResourceId } from '../../shared/content-types';

export const RESOURCES: Record<ResourceId, ResourceDef> = {
  berries: { id: 'berries', name: 'Berries', tier: 'raw', value: 1, edible: true },
  wheat: { id: 'wheat', name: 'Wheat', tier: 'raw', value: 1, edible: false },
  wood: { id: 'wood', name: 'Wood', tier: 'raw', value: 1, edible: false },
  flour: { id: 'flour', name: 'Flour', tier: 'processed', value: 3, edible: false },
  planks: { id: 'planks', name: 'Planks', tier: 'processed', value: 3, edible: false },
  bread: { id: 'bread', name: 'Bread', tier: 'finished', value: 8, edible: true },
  tools: { id: 'tools', name: 'Tools', tier: 'finished', value: 10, edible: false },
};

export const RESOURCE_IDS = Object.keys(RESOURCES) as readonly ResourceId[];
```

`src/engine/content/buildings.ts`:

```ts
import type { BuildingDef, BuildingDefId } from '../../shared/content-types';

export const BUILDINGS: Record<BuildingDefId, BuildingDef> = {
  gatherersHut: {
    id: 'gatherersHut', name: "Gatherer's Hut", cost: { wood: 10 }, workerSlots: 2,
    recipe: { inputs: {}, outputs: { berries: 1 }, ticksPerBatch: 3 },
  },
  farm: {
    id: 'farm', name: 'Farm', cost: { wood: 20 }, workerSlots: 4,
    recipe: { inputs: {}, outputs: { wheat: 1 }, ticksPerBatch: 4 },
  },
  mill: {
    id: 'mill', name: 'Mill', cost: { wood: 20, planks: 10 }, workerSlots: 2,
    recipe: { inputs: { wheat: 1 }, outputs: { flour: 1 }, ticksPerBatch: 3 },
  },
  bakery: {
    id: 'bakery', name: 'Bakery', cost: { wood: 15, planks: 10 }, workerSlots: 2,
    recipe: { inputs: { flour: 1 }, outputs: { bread: 1 }, ticksPerBatch: 4 },
  },
  forester: {
    id: 'forester', name: 'Forester', cost: { wood: 10 }, workerSlots: 2,
    recipe: { inputs: {}, outputs: { wood: 1 }, ticksPerBatch: 3 },
  },
  sawmill: {
    id: 'sawmill', name: 'Sawmill', cost: { wood: 25 }, workerSlots: 2,
    recipe: { inputs: { wood: 1 }, outputs: { planks: 1 }, ticksPerBatch: 3 },
  },
  workshop: {
    id: 'workshop', name: 'Workshop', cost: { planks: 20 }, workerSlots: 2,
    recipe: { inputs: { planks: 1 }, outputs: { tools: 1 }, ticksPerBatch: 5 },
  },
};

export const BUILDING_IDS = Object.keys(BUILDINGS) as readonly BuildingDefId[];
```

`src/engine/content/chains.ts`:

```ts
import type { Chain } from '../../shared/content-types';

export const CHAINS: readonly Chain[] = [
  {
    name: 'Food',
    steps: [
      { building: 'gatherersHut', output: 'berries' },
      { building: 'farm', output: 'wheat' },
      { building: 'mill', output: 'flour' },
      { building: 'bakery', output: 'bread' },
    ],
  },
  {
    name: 'Industry',
    steps: [
      { building: 'forester', output: 'wood' },
      { building: 'sawmill', output: 'planks' },
      { building: 'workshop', output: 'tools' },
    ],
  },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine/content.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: shared contracts and content catalog with validation tests"
```

---

### Task 3: ECS components and world resources

**Files:**
- Create: `src/engine/components.ts`, `src/engine/resources.ts`
- Test: `tests/engine/resources.test.ts`

**Interfaces:**
- Consumes: `ResourceId`, `CostMap` (Task 2), `BALANCE` (Task 2), `Command` (Task 2), `Snapshot` (Task 2).
- Produces:
  - Components: `Building(id, defId)`, `WorkerSlots(max)`, `Production(progress=0, batchActive=false)`, `Worker(id)`, `Hunger(value=0)`, `JobAssignment(buildingId=null)`, `Efficiency(value=1)`, `ToolCoverage(remainingTicks=0)` (on workers) — all plain classes with public constructor fields.
  - World resources: `Stockpile(initial?)` with `get/add/take/pay/canAfford/resetTickFlows/toJSON` and `producedThisTick`/`consumedThisTick` maps; `SimClock` with `tick`, `lastRecruitTick`; `CommandQueue` with `pending: Command[]` and `drain(): Command[]`; `NoticeBoard` with `push(msg)` / `takeAll(): string[]`; `IdCounter` with `take(): number`; `StatsHistory` with `record(produced, consumed)` / `rates(id): { production, consumption }`; `SnapshotStore` with `latest: Snapshot | null`.

- [ ] **Step 1: Write the failing tests**

`tests/engine/resources.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CommandQueue, IdCounter, NoticeBoard, StatsHistory, Stockpile } from '../../src/engine/resources';

describe('Stockpile', () => {
  it('adds and reads amounts, tracking per-tick production', () => {
    const stock = new Stockpile({ wood: 5 });
    stock.add('wood', 3);
    expect(stock.get('wood')).toBe(8);
    expect(stock.producedThisTick.get('wood')).toBe(3);
  });

  it('take is all-or-nothing per resource and tracks consumption', () => {
    const stock = new Stockpile({ bread: 1 });
    expect(stock.take('bread', 1)).toBe(true);
    expect(stock.take('bread', 1)).toBe(false);
    expect(stock.get('bread')).toBe(0);
    expect(stock.consumedThisTick.get('bread')).toBe(1);
  });

  it('pay is all-or-nothing across the whole cost map', () => {
    const stock = new Stockpile({ wood: 20, planks: 5 });
    expect(stock.pay({ wood: 15, planks: 10 })).toBe(false);
    expect(stock.get('wood')).toBe(20); // nothing taken
    expect(stock.pay({ wood: 15, planks: 5 })).toBe(true);
    expect(stock.get('wood')).toBe(5);
    expect(stock.get('planks')).toBe(0);
  });

  it('pay with an empty cost map always succeeds', () => {
    expect(new Stockpile().pay({})).toBe(true);
  });

  it('resetTickFlows clears the per-tick maps but not the amounts', () => {
    const stock = new Stockpile();
    stock.add('wood', 2);
    stock.resetTickFlows();
    expect(stock.producedThisTick.size).toBe(0);
    expect(stock.get('wood')).toBe(2);
  });

  it('toJSON round-trips into the constructor', () => {
    const stock = new Stockpile({ wood: 7, bread: 2 });
    expect(new Stockpile(stock.toJSON()).get('wood')).toBe(7);
  });
});

describe('StatsHistory', () => {
  it('averages production and consumption over recorded frames', () => {
    const stats = new StatsHistory();
    stats.record(new Map([['wood', 2]]), new Map());
    stats.record(new Map(), new Map([['wood', 1]]));
    expect(stats.rates('wood')).toEqual({ production: 1, consumption: 0.5 });
  });

  it('returns zero rates with no history', () => {
    expect(new StatsHistory().rates('wood')).toEqual({ production: 0, consumption: 0 });
  });
});

describe('small resources', () => {
  it('IdCounter hands out sequential ids from 1', () => {
    const ids = new IdCounter();
    expect(ids.take()).toBe(1);
    expect(ids.take()).toBe(2);
  });

  it('CommandQueue drain empties the queue', () => {
    const queue = new CommandQueue();
    queue.pending.push({ type: 'recruitWorker' });
    expect(queue.drain()).toHaveLength(1);
    expect(queue.pending).toHaveLength(0);
  });

  it('NoticeBoard takeAll returns and clears', () => {
    const board = new NoticeBoard();
    board.push('nope');
    expect(board.takeAll()).toEqual(['nope']);
    expect(board.takeAll()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/resources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write components and resources**

`src/engine/components.ts`:

```ts
import type { BuildingDefId } from '../shared/content-types';

export class Building {
  constructor(public id: number, public defId: BuildingDefId) {}
}

export class WorkerSlots {
  constructor(public max: number) {}
}

export class Production {
  constructor(public progress = 0, public batchActive = false) {}
}

export class ToolCoverage {
  constructor(public remainingTicks = 0) {}
}

export class Worker {
  constructor(public id: number) {}
}

export class Hunger {
  constructor(public value = 0) {}
}

export class JobAssignment {
  constructor(public buildingId: number | null = null) {}
}

export class Efficiency {
  constructor(public value = 1) {}
}
```

`src/engine/resources.ts`:

```ts
import type { CostMap, ResourceId } from '../shared/content-types';
import type { Command } from '../shared/commands';
import type { Snapshot } from '../shared/snapshot';
import { BALANCE } from './content/balance';

export class Stockpile {
  private readonly amounts = new Map<ResourceId, number>();
  readonly producedThisTick = new Map<ResourceId, number>();
  readonly consumedThisTick = new Map<ResourceId, number>();

  constructor(initial: Partial<Record<ResourceId, number>> = {}) {
    for (const [id, amount] of Object.entries(initial)) {
      this.amounts.set(id as ResourceId, amount);
    }
  }

  get(id: ResourceId): number {
    return this.amounts.get(id) ?? 0;
  }

  add(id: ResourceId, amount: number): void {
    this.amounts.set(id, this.get(id) + amount);
    this.producedThisTick.set(id, (this.producedThisTick.get(id) ?? 0) + amount);
  }

  canAfford(cost: CostMap): boolean {
    return Object.entries(cost).every(([id, amount]) => this.get(id as ResourceId) >= amount);
  }

  /** All-or-nothing across the whole cost map. Returns success. */
  pay(cost: CostMap): boolean {
    if (!this.canAfford(cost)) return false;
    for (const [id, amount] of Object.entries(cost)) this.remove(id as ResourceId, amount);
    return true;
  }

  /** Take a quantity of one resource if fully available. Returns success. */
  take(id: ResourceId, amount: number): boolean {
    if (this.get(id) < amount) return false;
    this.remove(id, amount);
    return true;
  }

  resetTickFlows(): void {
    this.producedThisTick.clear();
    this.consumedThisTick.clear();
  }

  toJSON(): Partial<Record<ResourceId, number>> {
    return Object.fromEntries(this.amounts) as Partial<Record<ResourceId, number>>;
  }

  private remove(id: ResourceId, amount: number): void {
    this.amounts.set(id, this.get(id) - amount);
    this.consumedThisTick.set(id, (this.consumedThisTick.get(id) ?? 0) + amount);
  }
}

export class SimClock {
  tick = 0;
  lastRecruitTick = -BALANCE.recruitCooldownTicks; // first recruit available immediately
}

export class CommandQueue {
  pending: Command[] = [];

  drain(): Command[] {
    const commands = this.pending;
    this.pending = [];
    return commands;
  }
}

export class NoticeBoard {
  private notices: string[] = [];

  push(message: string): void {
    this.notices.push(message);
  }

  takeAll(): string[] {
    const notices = this.notices;
    this.notices = [];
    return notices;
  }
}

export class IdCounter {
  private next = 1;

  take(): number {
    return this.next++;
  }
}

interface StatsFrame {
  produced: ReadonlyMap<ResourceId, number>;
  consumed: ReadonlyMap<ResourceId, number>;
}

export class StatsHistory {
  private readonly frames: StatsFrame[] = [];

  record(produced: ReadonlyMap<ResourceId, number>, consumed: ReadonlyMap<ResourceId, number>): void {
    this.frames.push({ produced: new Map(produced), consumed: new Map(consumed) });
    if (this.frames.length > BALANCE.statsWindowTicks) this.frames.shift();
  }

  rates(id: ResourceId): { production: number; consumption: number } {
    if (this.frames.length === 0) return { production: 0, consumption: 0 };
    let produced = 0;
    let consumed = 0;
    for (const frame of this.frames) {
      produced += frame.produced.get(id) ?? 0;
      consumed += frame.consumed.get(id) ?? 0;
    }
    return { production: produced / this.frames.length, consumption: consumed / this.frames.length };
  }
}

export class SnapshotStore {
  latest: Snapshot | null = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/resources.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: ECS components and world resources with unit tests"
```

---
### Task 4: World scaffolding and spawn helpers

**Files:**
- Create: `src/engine/world.ts`
- Test: `tests/engine/world.test.ts`

**Interfaces:**
- Consumes: components + resources (Task 3), catalog (Task 2), `SaveGameV1` (Task 2), sim-ecs (`buildWorld`, `IPreptimeWorld`, `IRuntimeWorld`, `ISystem`, `IEntity`).
- Produces (systems tasks and the engine rely on these exact signatures):
  - `initialSave(): SaveGameV1` — fresh-colony save (starting stock, 3 idle workers, no buildings).
  - `buildColonyPrepWorld(options?: { save?: SaveGameV1; systems?: readonly TColonySystem[] }): IPreptimeWorld` — builds the prep world with ALL components registered, ALL resources added (initialized from the save), and save entities spawned. `systems` defaults to `ALL_SYSTEMS` (empty until Task 11 fills it); tests pass a subset to isolate one system.
  - `spawnBuilding(prep: IPreptimeWorld, ids: IdCounter, saved: SavedBuilding): IEntity`
  - `spawnWorker(prep: IPreptimeWorld, ids: IdCounter, opts?: { hunger?: number; buildingId?: number | null; efficiency?: number; toolTicks?: number }): IEntity`
  - `createColonyWorld(save?: SaveGameV1): Promise<IRuntimeWorld>` — prep + `prepareRun()`.
  - `isLoadableSave(data: unknown): data is SaveGameV1` — structural guard + catalog referential integrity + content-range validation: known resource/building ids; finite non-negative stockpile amounts; integer `tick >= 0` and integer `lastRecruitTick` (fractional clocks would desync modulo cadences); `0 <= hunger <= hungerMax`; integer `0 <= toolTicks <= toolDurationTicks`; catalog lookups via `Object.hasOwn` (never `in` — inherited keys); `0 <= progress <= that building's ticksPerBatch`; assignment indices in range and no building staffed beyond its worker slots. The Obsidian shell's load path (Task 16) uses this, never bare `isSaveGameV1`.
  - `buildColonyPrepWorld` seeds `SnapshotStore.latest` with an initial snapshot derived from the save (zero rates, notices empty) so the UI never renders from a null snapshot while the engine is paused pre-first-tick (fresh create and reset both hit this).
  - `ALL_SYSTEMS: TColonySystem[]` — mutable array, filled in Task 11 (type alias `TColonySystem` for sim-ecs's built system type).

- [ ] **Step 1: Write the failing test**

`tests/engine/world.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Hunger, JobAssignment, Worker } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import { buildColonyPrepWorld, createColonyWorld, initialSave, isLoadableSave } from '../../src/engine/world';

describe('initialSave', () => {
  it('matches the spec starting state', () => {
    const save = initialSave();
    expect(save.stockpile).toEqual({ wood: 30, berries: 20 });
    expect(save.workers).toHaveLength(3);
    expect(save.buildings).toHaveLength(0);
    expect(save.tick).toBe(0);
  });
});

describe('isLoadableSave', () => {
  it('accepts a fresh initial save', () => {
    expect(isLoadableSave(initialSave())).toBe(true);
  });

  it('rejects unknown building def ids', () => {
    const save = initialSave();
    save.buildings.push({ defId: 'castle' as never, progress: 0, batchActive: false });
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects out-of-range worker building indices', () => {
    const save = initialSave();
    save.workers[0].buildingIndex = 3; // no buildings exist
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects non-numeric, NaN, or negative stockpile amounts', () => {
    const bad = initialSave();
    (bad.stockpile as Record<string, unknown>).wood = 'lots';
    expect(isLoadableSave(bad)).toBe(false);
    const nan = initialSave();
    nan.stockpile.wood = Number.NaN;
    expect(isLoadableSave(nan)).toBe(false);
    const negative = initialSave();
    negative.stockpile.wood = -5;
    expect(isLoadableSave(negative)).toBe(false);
  });

  it('rejects unknown stockpile resource ids', () => {
    const save = initialSave();
    (save.stockpile as Record<string, unknown>).gold = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects out-of-range sim counters (hunger, toolTicks, progress)', () => {
    const hungry = initialSave();
    hungry.workers[0].hunger = 1000;
    expect(isLoadableSave(hungry)).toBe(false);
    const tooled = initialSave();
    tooled.workers[0].toolTicks = -1;
    expect(isLoadableSave(tooled)).toBe(false);
    const overworked = initialSave();
    overworked.buildings.push({ defId: 'forester', progress: 99, batchActive: true }); // ticksPerBatch is 3
    expect(isLoadableSave(overworked)).toBe(false);
  });

  it('rejects more assigned workers than a building has slots', () => {
    const save = initialSave();
    save.buildings.push({ defId: 'forester', progress: 0, batchActive: false }); // 2 slots
    save.workers = [0, 1, 2].map(() => ({ hunger: 0, buildingIndex: 0, toolTicks: 0 }));
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects fractional ticks and inherited-object-key building ids', () => {
    const fractional = initialSave();
    fractional.tick = 0.5; // would desync the autosave modulo forever
    expect(isLoadableSave(fractional)).toBe(false);
    const inherited = initialSave();
    inherited.buildings.push({ defId: 'toString' as never, progress: 0, batchActive: false });
    expect(isLoadableSave(inherited)).toBe(false); // must return false, not throw
  });
});

describe('createColonyWorld', () => {
  it('builds a runnable world with resources initialized from the save', async () => {
    const world = await createColonyWorld();
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    expect(world.getResource(SimClock).tick).toBe(0);
    await world.step(); // no systems registered yet -> must still step cleanly
  });

  it('spawns save entities with working component access', async () => {
    const save = initialSave();
    save.workers[0].hunger = 42;
    const prep = buildColonyPrepWorld({ save });
    const workers = [...prep.getEntities()].filter((e) => e.hasComponent(Worker));
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.getComponent(Hunger)!.value).sort((a, b) => b - a)[0]).toBe(42);
    expect(workers.every((w) => w.getComponent(JobAssignment)!.buildingId === null)).toBe(true);
  });

  it('IdCounter continues past spawned entities', () => {
    const prep = buildColonyPrepWorld();
    const ids = prep.getResource(IdCounter);
    expect(ids.take()).toBe(4); // workers took 1..3
  });

  it('seeds an initial snapshot so the UI never sees null', async () => {
    const world = await createColonyWorld();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.tick).toBe(0);
    expect(snapshot.population).toBe(3);
    expect(snapshot.idleWorkers).toBe(3);
    expect(snapshot.stockpile.wood.stock).toBe(30);
    expect(snapshot.colonyWealth).toBe(50); // 30 wood@1 + 20 berries@1
    expect(snapshot.notices).toEqual([]);
  });
});
```

Note: if `prep.getEntities()` is not available on the preptime world in 0.6.5, have `buildColonyPrepWorld` collect spawned entities into an exported array parameter instead — check `IPreptimeWorld` in `node_modules/sim-ecs/dist/index.d.ts` before changing the design. (`getEntities` is declared on the shared `IWorld` interface, so it should exist.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/world.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/world.ts**

```ts
import { buildWorld } from 'sim-ecs';
import type { IEntity, IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import { isSaveGameV1 } from '../shared/save';
import type { SaveGameV1, SavedBuilding } from '../shared/save';
import type { ResourceId } from '../shared/content-types';
import type { BuildingState, ResourceStats, Snapshot } from '../shared/snapshot';
import { BALANCE, STARTING_STOCK, STARTING_WORKERS, workerEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import {
  Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots,
} from './components';
import {
  CommandQueue, IdCounter, NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile,
} from './resources';

// sim-ecs's built system type; kept loose so ALL_SYSTEMS can be filled in world composition.
export type TColonySystem = Parameters<
  Parameters<Parameters<ReturnType<typeof buildWorld>['withDefaultScheduling']>[0]>[0]['addNewStage']
>[0] extends (stage: infer S) => unknown
  ? S extends { addSystem(system: infer Sys): unknown } ? Sys : never
  : never;

/** Filled in Task 11 (world composition). Empty until then so early tests can build worlds. */
export const ALL_SYSTEMS: TColonySystem[] = [];

const COMPONENT_TYPES = [Building, WorkerSlots, Production, Worker, Hunger, JobAssignment, Efficiency, ToolCoverage];

export function initialSave(): SaveGameV1 {
  return {
    version: 1,
    tick: 0,
    lastRecruitTick: -BALANCE.recruitCooldownTicks,
    stockpile: { ...STARTING_STOCK },
    buildings: [],
    workers: Array.from({ length: STARTING_WORKERS }, () => ({ hunger: 0, buildingIndex: null, toolTicks: 0 })),
  };
}

/**
 * Structural validity (isSaveGameV1) plus referential integrity against the content
 * catalog. The Obsidian shell must use THIS before restoring: a stale or hand-edited
 * save with an unknown building id would otherwise crash createColonyWorld instead of
 * taking the corrupt-save backup path (spec 7.2).
 */
export function isLoadableSave(data: unknown): data is SaveGameV1 {
  if (!isSaveGameV1(data)) return false;
  // integer clocks: a fractional tick would desync every modulo-based cadence
  // (autosave, recruit cooldown) forever
  if (!Number.isInteger(data.tick) || data.tick < 0) return false;
  if (!Number.isInteger(data.lastRecruitTick)) return false;
  // Object.hasOwn, never `in`: inherited keys like "toString" pass `in` and
  // then indexing the catalog throws inside the guard
  const stockpileOk = Object.entries(data.stockpile).every(
    ([id, amount]) => Object.hasOwn(RESOURCES, id) && Number.isFinite(amount) && (amount as number) >= 0,
  );
  if (!stockpileOk) return false;
  const buildingsOk = data.buildings.every(
    (b) =>
      Object.hasOwn(BUILDINGS, b.defId) &&
      b.progress >= 0 &&
      b.progress <= BUILDINGS[b.defId].recipe.ticksPerBatch,
  );
  if (!buildingsOk) return false;
  const staffCount = new Map<number, number>();
  for (const w of data.workers) {
    if (w.hunger < 0 || w.hunger > BALANCE.hungerMax) return false;
    if (!Number.isInteger(w.toolTicks) || w.toolTicks < 0 || w.toolTicks > BALANCE.toolDurationTicks) return false;
    if (w.buildingIndex === null) continue;
    if (!Number.isInteger(w.buildingIndex) || w.buildingIndex < 0 || w.buildingIndex >= data.buildings.length) {
      return false;
    }
    staffCount.set(w.buildingIndex, (staffCount.get(w.buildingIndex) ?? 0) + 1);
  }
  for (const [index, count] of staffCount) {
    if (count > BUILDINGS[data.buildings[index].defId].workerSlots) return false;
  }
  return true;
}

export function spawnBuilding(prep: IPreptimeWorld, ids: IdCounter, saved: SavedBuilding): IEntity {
  const def = BUILDINGS[saved.defId];
  return prep
    .buildEntity()
    .with(new Building(ids.take(), saved.defId))
    .with(new WorkerSlots(def.workerSlots))
    .with(new Production(saved.progress, saved.batchActive))
    .build();
}

export function spawnWorker(
  prep: IPreptimeWorld,
  ids: IdCounter,
  opts: { hunger?: number; buildingId?: number | null; efficiency?: number; toolTicks?: number } = {},
): IEntity {
  return prep
    .buildEntity()
    .with(new Worker(ids.take()))
    .with(new Hunger(opts.hunger ?? 0))
    .with(new JobAssignment(opts.buildingId ?? null))
    .with(new Efficiency(opts.efficiency ?? 1))
    .with(new ToolCoverage(opts.toolTicks ?? 0))
    .build();
}

export function buildColonyPrepWorld(
  options: { save?: SaveGameV1; systems?: readonly TColonySystem[] } = {},
): IPreptimeWorld {
  const save = options.save ?? initialSave();
  const systems = options.systems ?? ALL_SYSTEMS;

  let builder = buildWorld().withDefaultScheduling((root) => {
    for (const system of systems) {
      root = root.addNewStage((stage) => stage.addSystem(system));
    }
    return root;
  });
  for (const componentType of COMPONENT_TYPES) {
    builder = builder.withComponent(componentType);
  }
  const prep = builder.build();

  const clock = new SimClock();
  clock.tick = save.tick;
  clock.lastRecruitTick = save.lastRecruitTick;
  const ids = new IdCounter();

  prep.addResource(new Stockpile(save.stockpile));
  prep.addResource(clock);
  prep.addResource(new CommandQueue());
  prep.addResource(new NoticeBoard());
  prep.addResource(ids);
  prep.addResource(new StatsHistory());
  const store = new SnapshotStore();
  prep.addResource(store);

  const buildingIds = save.buildings.map(
    (saved) => spawnBuilding(prep, ids, saved).getComponent(Building)!.id,
  );
  const workerIds = save.workers.map(
    (saved) =>
      spawnWorker(prep, ids, {
        hunger: saved.hunger,
        toolTicks: saved.toolTicks,
        buildingId: saved.buildingIndex === null ? null : buildingIds[saved.buildingIndex],
      }).getComponent(Worker)!.id,
  );
  // The UI must never see a null snapshot: a reset or freshly created engine is
  // paused until its first tick, so seed the store from the save. SnapshotSystem
  // replaces this on the first step.
  store.latest = buildInitialSnapshot(save, buildingIds, workerIds);

  return prep;
}

function buildInitialSnapshot(save: SaveGameV1, buildingIds: number[], workerIds: number[]): Snapshot {
  const staffCount = new Map<number, number>();
  const powerByBuilding = new Map<number, number>();
  const tooledByBuilding = new Map<number, number>();
  const workers = save.workers.map((saved, index) => {
    const buildingId = saved.buildingIndex === null ? null : buildingIds[saved.buildingIndex];
    const efficiency = workerEfficiency(saved.hunger);
    const tooled = saved.toolTicks > 0;
    if (buildingId !== null) {
      staffCount.set(buildingId, (staffCount.get(buildingId) ?? 0) + 1);
      powerByBuilding.set(
        buildingId,
        (powerByBuilding.get(buildingId) ?? 0) + efficiency * (tooled ? BALANCE.toolMultiplier : 1),
      );
      if (tooled) tooledByBuilding.set(buildingId, (tooledByBuilding.get(buildingId) ?? 0) + 1);
    }
    return { id: workerIds[index], hunger: saved.hunger, efficiency, buildingId, toolTicks: saved.toolTicks };
  });
  const buildings = save.buildings.map((saved, index) => {
    const def = BUILDINGS[saved.defId];
    const id = buildingIds[index];
    const staffed = staffCount.get(id) ?? 0;
    const state: BuildingState = staffed === 0 ? 'unstaffed' : saved.batchActive ? 'producing' : 'waitingForInput';
    return {
      id,
      defId: saved.defId,
      workers: staffed,
      workerSlots: def.workerSlots,
      state,
      progress: saved.progress,
      batchActive: saved.batchActive,
      progressPct: Math.min(100, Math.round((saved.progress / def.recipe.ticksPerBatch) * 100)),
      tooledWorkers: tooledByBuilding.get(id) ?? 0,
      workPower: powerByBuilding.get(id) ?? 0,
    };
  });
  const stockpile = {} as Record<ResourceId, ResourceStats>;
  let colonyWealth = 0;
  for (const resourceId of RESOURCE_IDS) {
    const stock = save.stockpile[resourceId] ?? 0;
    const stockValue = stock * RESOURCES[resourceId].value;
    colonyWealth += stockValue;
    stockpile[resourceId] = { stock, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
  }
  return {
    tick: save.tick,
    lastRecruitTick: save.lastRecruitTick,
    stockpile,
    colonyWealth,
    population: workers.length,
    idleWorkers: workers.filter((w) => w.buildingId === null).length,
    buildings,
    workers,
    notices: [],
  };
}

export async function createColonyWorld(save?: SaveGameV1): Promise<IRuntimeWorld> {
  return buildColonyPrepWorld({ save }).prepareRun();
}
```

If the `TColonySystem` conditional-type extraction fails to compile against 0.6.5's typings, replace it with the direct import `import type { ISystem } from 'sim-ecs'` and use `ISystem` — check `node_modules/sim-ecs/dist/index.d.ts` for which name is exported. The rest of the plan refers to this alias only through `ALL_SYSTEMS` and the `systems` option, so nothing else changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/world.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: colony world scaffolding, save-driven spawning, seeded snapshot"
```

---

### Task 5: HungerSystem

**Files:**
- Create: `src/engine/systems/hunger-system.ts`
- Test: `tests/engine/systems/hunger-system.test.ts`

**Interfaces:**
- Consumes: `Hunger` component, `Stockpile` resource, `BALANCE`, world helpers (Task 4).
- Produces: `HungerSystem` (a built sim-ecs system). Behavior contract: each tick every worker's hunger rises by `BALANCE.hungerPerTick` (capped at `hungerMax`); at `hunger >= mealThreshold` the worker eats — 1 bread resets hunger to 0, else 1 berries reduces hunger by `berriesHungerRestore` (floor 0), else nothing.

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/hunger-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Hunger } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { HungerSystem } from '../../../src/engine/systems/hunger-system';
import { buildColonyPrepWorld, initialSave, spawnWorker } from '../../../src/engine/world';

async function setup(hunger: number, stock: Partial<Record<'bread' | 'berries', number>>) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
  const worker: IEntity = spawnWorker(prep, prep.getResource(IdCounter), { hunger });
  const world = await prep.prepareRun();
  return { world, worker, stockpile: world.getResource(Stockpile) };
}

describe('HungerSystem', () => {
  it('raises hunger by 1 per tick up to the cap', async () => {
    const { world, worker } = await setup(0, {});
    await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(1);
    for (let i = 0; i < 150; i++) await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(100);
  });

  it('eats bread at the meal threshold, resetting hunger to 0', async () => {
    const { world, worker, stockpile } = await setup(49, { bread: 1, berries: 5 });
    await world.step(); // 49 -> 50 -> eats
    expect(worker.getComponent(Hunger)!.value).toBe(0);
    expect(stockpile.get('bread')).toBe(0);
    expect(stockpile.get('berries')).toBe(5); // bread preferred
  });

  it('falls back to berries when no bread', async () => {
    const { world, worker, stockpile } = await setup(49, { berries: 2 });
    await world.step(); // 50 - 30 = 20
    expect(worker.getComponent(Hunger)!.value).toBe(20);
    expect(stockpile.get('berries')).toBe(1);
  });

  it('starves without food (no crash, hunger capped)', async () => {
    const { world, worker } = await setup(98, {});
    await world.step();
    await world.step();
    await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/hunger-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/hunger-system.ts**

```ts
import { createSystem, queryComponents, Write, WriteResource } from 'sim-ecs';
import { BALANCE } from '../content/balance';
import { Hunger } from '../components';
import { Stockpile } from '../resources';

export const HungerSystem = createSystem({
  stockpile: WriteResource(Stockpile),
  workers: queryComponents({ hunger: Write(Hunger) }),
})
  .withName('HungerSystem')
  .withRunFunction(({ stockpile, workers }) => {
    for (const { hunger } of workers.iter()) {
      hunger.value = Math.min(BALANCE.hungerMax, hunger.value + BALANCE.hungerPerTick);
      if (hunger.value < BALANCE.mealThreshold) continue;
      if (stockpile.take('bread', 1)) {
        hunger.value = 0;
      } else if (stockpile.take('berries', 1)) {
        hunger.value = Math.max(0, hunger.value - BALANCE.berriesHungerRestore);
      }
    }
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/hunger-system.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: hunger system - meals from bread then berries, capped starvation"
```

---

### Task 6: EfficiencySystem

**Files:**
- Create: `src/engine/systems/efficiency-system.ts`
- Test: `tests/engine/systems/efficiency-system.test.ts`

**Interfaces:**
- Consumes: `Hunger`, `JobAssignment`, `Efficiency`, `ToolCoverage` components; `Stockpile`; `workerEfficiency`; `BALANCE`; world helpers.
- Produces: `EfficiencySystem`. Behavior contract, per worker each tick: `Efficiency.value = workerEfficiency(hunger)`. Tool coverage is **per worker**: if `ToolCoverage.remainingTicks > 0` it decrements (whether assigned or idle — a benched tool still wears); otherwise a STAFFED worker tries `stockpile.take('tools', 1)` and on success gets `remainingTicks = BALANCE.toolDurationTicks`. Idle workers never consume new tools. Coverage follows the worker across reassignment, so replacement workers pay for their own tool — headcount-based building buffs proved exploitable in review (Codex P2 x3).

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/efficiency-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Building, Efficiency, JobAssignment, ToolCoverage } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { EfficiencySystem } from '../../../src/engine/systems/efficiency-system';
import { buildColonyPrepWorld, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

function makePrep(tools: number) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = { tools };
  return buildColonyPrepWorld({ save, systems: [EfficiencySystem] });
}

describe('EfficiencySystem', () => {
  it('computes worker efficiency from hunger', async () => {
    const prep = makePrep(0);
    const worker = spawnWorker(prep, prep.getResource(IdCounter), { hunger: 75 });
    const world = await prep.prepareRun();
    await world.step();
    expect(worker.getComponent(Efficiency)!.value).toBeCloseTo(0.6);
  });

  it('staffed worker consumes one tool for a 300-tick coverage that ticks down', async () => {
    const prep = makePrep(2);
    const ids = prep.getResource(IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const worker = spawnWorker(prep, ids, { buildingId: building.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(1);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(300);
    await world.step(); // covered: ticks down, no extra tool consumed
    expect(world.getResource(Stockpile).get('tools')).toBe(1);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(299);
  });

  it('idle workers never consume tools', async () => {
    const prep = makePrep(2);
    const worker = spawnWorker(prep, prep.getResource(IdCounter), {});
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(2);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(0);
  });

  it('covers exactly as many workers as there are tools', async () => {
    const prep = makePrep(1);
    const ids = prep.getResource(IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    const first = spawnWorker(prep, ids, { buildingId });
    const second = spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();
    await world.step();
    const covered = [first, second].filter((w) => w.getComponent(ToolCoverage)!.remainingTicks > 0);
    expect(covered).toHaveLength(1);
    expect(world.getResource(Stockpile).get('tools')).toBe(0);
  });

  it('coverage follows the worker: replacements pay for their own tool', async () => {
    const prep = makePrep(2);
    const ids = prep.getResource(IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    const veteran = spawnWorker(prep, ids, { buildingId, toolTicks: 100 });
    const replacement = spawnWorker(prep, ids, {});
    const world = await prep.prepareRun();
    await world.step(); // veteran already covered, replacement idle: nothing charged
    expect(world.getResource(Stockpile).get('tools')).toBe(2);
    // swap the staff without changing the headcount
    veteran.getComponent(JobAssignment)!.buildingId = null;
    replacement.getComponent(JobAssignment)!.buildingId = buildingId;
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(1); // replacement paid
    expect(replacement.getComponent(ToolCoverage)!.remainingTicks).toBe(300);
    expect(veteran.getComponent(ToolCoverage)!.remainingTicks).toBeGreaterThan(0); // keeps his own
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/efficiency-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/efficiency-system.ts**

```ts
import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import { BALANCE, workerEfficiency } from '../content/balance';
import { Efficiency, Hunger, JobAssignment, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const EfficiencySystem = createSystem({
  stockpile: WriteResource(Stockpile),
  workers: queryComponents({
    hunger: Read(Hunger),
    job: Read(JobAssignment),
    efficiency: Write(Efficiency),
    coverage: Write(ToolCoverage),
  }),
})
  .withName('EfficiencySystem')
  .withRunFunction(({ stockpile, workers }) => {
    for (const { hunger, job, efficiency, coverage } of workers.iter()) {
      efficiency.value = workerEfficiency(hunger.value);
      if (coverage.remainingTicks > 0) {
        // wears down whether assigned or idle: simple and deterministic
        coverage.remainingTicks--;
      } else if (job.buildingId !== null && stockpile.take('tools', 1)) {
        coverage.remainingTicks = BALANCE.toolDurationTicks;
      }
    }
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/efficiency-system.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: efficiency system - hunger curve and per-worker tool coverage"
```

---

### Task 7: ProductionSystem

**Files:**
- Create: `src/engine/systems/production-system.ts`
- Test: `tests/engine/systems/production-system.test.ts`

**Interfaces:**
- Consumes: `Building`, `Production`, `JobAssignment`, `Efficiency`, `ToolCoverage` components; `Stockpile`; `BUILDINGS`; `BALANCE`.
- Produces: `ProductionSystem`. Behavior contract per staffed building (workPower = Σ over assigned workers of `efficiency.value × (coverage.remainingTicks > 0 ? BALANCE.toolMultiplier : 1)` — each worker's own tool coverage determines their multiplier):
  1. If no batch active, try `stockpile.pay(recipe.inputs)` → batch starts (empty inputs always start).
  2. If a batch is active, `progress += workPower`; at `progress >= ticksPerBatch` the outputs are added, then it immediately tries to start the next batch (so continuously supplied buildings stay in `producing` state).
  3. At most one batch completes per tick; leftover progress is discarded (documented determinism trade-off).
  4. Zero workPower → nothing happens.

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/production-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Building, Production } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { buildColonyPrepWorld, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';

async function setup(defId: BuildingDefId, stock: Partial<Record<ResourceId, number>>, workerCount = 1, workerToolTicks = 0) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
  const ids = prep.getResource(IdCounter);
  const building: IEntity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false });
  const buildingId = building.getComponent(Building)!.id;
  for (let i = 0; i < workerCount; i++) spawnWorker(prep, ids, { buildingId, toolTicks: workerToolTicks });
  const world = await prep.prepareRun();
  return { world, building, stockpile: world.getResource(Stockpile) };
}

describe('ProductionSystem', () => {
  it('produces raw output after ticksPerBatch worker-ticks (forester: 3)', async () => {
    const { world, stockpile } = await setup('forester', {});
    await world.step();
    await world.step();
    expect(stockpile.get('wood')).toBe(0);
    await world.step();
    expect(stockpile.get('wood')).toBe(1);
  });

  it('consumes inputs at batch start, all-or-nothing (mill)', async () => {
    const { world, building, stockpile } = await setup('mill', { wheat: 1 });
    await world.step();
    expect(stockpile.get('wheat')).toBe(0); // consumed at start
    expect(building.getComponent(Production)!.batchActive).toBe(true);
    await world.step();
    await world.step(); // 3 worker-ticks done
    expect(stockpile.get('flour')).toBe(1);
    expect(building.getComponent(Production)!.batchActive).toBe(false); // no wheat for next batch
  });

  it('stalls without inputs', async () => {
    const { world, building, stockpile } = await setup('mill', {});
    await world.step();
    expect(building.getComponent(Production)!.batchActive).toBe(false);
    expect(stockpile.get('flour')).toBe(0);
  });

  it('does nothing when unstaffed', async () => {
    const { world, stockpile } = await setup('forester', {}, 0);
    for (let i = 0; i < 5; i++) await world.step();
    expect(stockpile.get('wood')).toBe(0);
  });

  it('tooled workers contribute 1.5x work power', async () => {
    // forester needs 3 worker-ticks; 2 covered workers x 1.5 = 3 power/tick -> 1 wood per tick
    const { world, stockpile } = await setup('forester', {}, 2, 1000);
    await world.step();
    expect(stockpile.get('wood')).toBe(1);
  });

  it('only covered workers get the multiplier (mixed staffing)', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
    const ids = prep.getResource(IdCounter);
    // one covered worker (1.5) + one bare worker (1.0) = 2.5 power/tick, forester batch is 3
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, toolTicks: 1000 });
    spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();
    await world.step(); // 2.5 < 3: batch not done
    expect(world.getResource(Stockpile).get('wood')).toBe(0);
    await world.step(); // 5.0 >= 3
    expect(world.getResource(Stockpile).get('wood')).toBe(1);
  });

  it('completes at most one batch per tick and discards overflow progress', async () => {
    // 4 workers on the farm (4 power/tick, needs 4): exactly 1 wheat per tick
    const { world, stockpile } = await setup('farm', {}, 4);
    await world.step();
    await world.step();
    expect(stockpile.get('wheat')).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/production-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/production-system.ts**

```ts
import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { Building, Efficiency, JobAssignment, Production, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const ProductionSystem = createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({ building: Read(Building), production: Write(Production) }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const powerByBuilding = new Map<number, number>();
    for (const { job, efficiency, coverage } of workers.iter()) {
      if (job.buildingId === null) continue;
      const contribution = efficiency.value * (coverage.remainingTicks > 0 ? BALANCE.toolMultiplier : 1);
      powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
    }

    for (const { building, production } of buildings.iter()) {
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;

      const recipe = BUILDINGS[building.defId].recipe;
      if (!production.batchActive && stockpile.pay(recipe.inputs)) {
        production.batchActive = true;
        production.progress = 0;
      }
      if (!production.batchActive) continue;

      production.progress += workPower;
      if (production.progress >= recipe.ticksPerBatch) {
        for (const [id, amount] of Object.entries(recipe.outputs)) {
          stockpile.add(id as ResourceId, amount);
        }
        production.progress = 0;
        // try to chain straight into the next batch so supplied buildings stay 'producing'
        production.batchActive = stockpile.pay(recipe.inputs);
      }
    }
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/production-system.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: production system - batch recipes with per-worker tool multipliers"
```

---

### Task 8: SnapshotSystem

**Files:**
- Create: `src/engine/systems/snapshot-system.ts`
- Test: `tests/engine/systems/snapshot-system.test.ts`

**Interfaces:**
- Consumes: all components; `SimClock`, `Stockpile`, `StatsHistory`, `NoticeBoard`, `SnapshotStore`; `RESOURCES`, `RESOURCE_IDS`, `BUILDINGS`, `BALANCE`; `Snapshot` types.
- Produces: `SnapshotSystem`. Behavior contract: writes a complete `Snapshot` into `SnapshotStore.latest` each tick — buildings/workers sorted by id ascending; building `state` is `'unstaffed'` (0 workers) / `'producing'` (batchActive) / `'waitingForInput'`; stockpile stats from `StatsHistory.rates()`; `colonyWealth` = Σ stock × value; notices drained from `NoticeBoard`.

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/snapshot-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Building } from '../../../src/engine/components';
import { IdCounter, NoticeBoard, SnapshotStore } from '../../../src/engine/resources';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { buildColonyPrepWorld, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

describe('SnapshotSystem', () => {
  it('projects a complete snapshot', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = { wood: 10, bread: 2 };
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = prep.getResource(IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 1.5, batchActive: true });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, hunger: 20, toolTicks: 10 });
    spawnWorker(prep, ids); // idle
    prep.getResource(NoticeBoard).push('test notice');

    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;

    expect(snapshot.population).toBe(2);
    expect(snapshot.idleWorkers).toBe(1);
    expect(snapshot.stockpile.wood.stock).toBe(10);
    expect(snapshot.colonyWealth).toBe(10 * 1 + 2 * 8); // wood@1 + bread@8
    expect(snapshot.notices).toEqual(['test notice']);

    const b = snapshot.buildings[0];
    expect(b.defId).toBe('forester');
    expect(b.workers).toBe(1);
    expect(b.state).toBe('producing');
    expect(b.progressPct).toBe(50); // 1.5 / 3
    expect(b.tooledWorkers).toBe(1);
    expect(b.workPower).toBeCloseTo(1.5); // 1 covered worker: eff 1.0 x tool 1.5

    expect(snapshot.workers.map((w) => w.buildingId)).toEqual([buildingId, null]);
    expect(snapshot.workers[0].toolTicks).toBe(10);
  });

  it('marks unstaffed and waiting states', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
    const ids = prep.getResource(IdCounter);
    spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false });
    const staffed = spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false });
    spawnWorker(prep, ids, { buildingId: staffed.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.buildings.map((b) => b.state)).toEqual(['unstaffed', 'waitingForInput']);
  });

  it('clears notices after snapshotting them', async () => {
    const prep = buildColonyPrepWorld({ save: initialSave(), systems: [SnapshotSystem] });
    prep.getResource(NoticeBoard).push('once');
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual(['once']);
    await world.step();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/snapshot-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/snapshot-system.ts**

```ts
import { createSystem, queryComponents, Read, ReadResource, WriteResource } from 'sim-ecs';
import type { BuildingSnapshot, ResourceStats, WorkerSnapshot } from '../../shared/snapshot';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots } from '../components';
import { NoticeBoard, SimClock, SnapshotStore, StatsHistory, Stockpile } from '../resources';

export const SnapshotSystem = createSystem({
  clock: ReadResource(SimClock),
  stockpile: ReadResource(Stockpile),
  stats: ReadResource(StatsHistory),
  notices: WriteResource(NoticeBoard),
  store: WriteResource(SnapshotStore),
  buildings: queryComponents({
    building: Read(Building), slots: Read(WorkerSlots), production: Read(Production),
  }),
  workers: queryComponents({
    worker: Read(Worker), hunger: Read(Hunger), job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage),
  }),
})
  .withName('SnapshotSystem')
  .withRunFunction(({ clock, stockpile, stats, notices, store, buildings, workers }) => {
    const workerSnaps: WorkerSnapshot[] = [];
    const staffCount = new Map<number, number>();
    const powerByBuilding = new Map<number, number>();
    const tooledByBuilding = new Map<number, number>();
    for (const { worker, hunger, job, efficiency, coverage } of workers.iter()) {
      workerSnaps.push({
        id: worker.id,
        hunger: hunger.value,
        efficiency: efficiency.value,
        buildingId: job.buildingId,
        toolTicks: coverage.remainingTicks,
      });
      if (job.buildingId !== null) {
        const tooled = coverage.remainingTicks > 0;
        staffCount.set(job.buildingId, (staffCount.get(job.buildingId) ?? 0) + 1);
        powerByBuilding.set(
          job.buildingId,
          (powerByBuilding.get(job.buildingId) ?? 0) + efficiency.value * (tooled ? BALANCE.toolMultiplier : 1),
        );
        if (tooled) tooledByBuilding.set(job.buildingId, (tooledByBuilding.get(job.buildingId) ?? 0) + 1);
      }
    }
    workerSnaps.sort((a, b) => a.id - b.id);

    const buildingSnaps: BuildingSnapshot[] = [];
    for (const { building, slots, production } of buildings.iter()) {
      const def = BUILDINGS[building.defId];
      const staffed = staffCount.get(building.id) ?? 0;
      buildingSnaps.push({
        id: building.id,
        defId: building.defId,
        workers: staffed,
        workerSlots: slots.max,
        state: staffed === 0 ? 'unstaffed' : production.batchActive ? 'producing' : 'waitingForInput',
        progress: production.progress,
        batchActive: production.batchActive,
        progressPct: Math.min(100, Math.round((production.progress / def.recipe.ticksPerBatch) * 100)),
        tooledWorkers: tooledByBuilding.get(building.id) ?? 0,
        workPower: powerByBuilding.get(building.id) ?? 0,
      });
    }
    buildingSnaps.sort((a, b) => a.id - b.id);

    const stockpileStats = {} as Record<ResourceId, ResourceStats>;
    let colonyWealth = 0;
    for (const id of RESOURCE_IDS) {
      const stock = stockpile.get(id);
      const { production, consumption } = stats.rates(id);
      const stockValue = stock * RESOURCES[id].value;
      colonyWealth += stockValue;
      stockpileStats[id] = {
        stock,
        productionRate: production,
        consumptionRate: consumption,
        netFlow: production - consumption,
        stockValue,
      };
    }

    store.latest = {
      tick: clock.tick,
      lastRecruitTick: clock.lastRecruitTick,
      stockpile: stockpileStats,
      colonyWealth,
      population: workerSnaps.length,
      idleWorkers: workerSnaps.filter((w) => w.buildingId === null).length,
      buildings: buildingSnaps,
      workers: workerSnaps,
      notices: notices.takeAll(),
    };
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/snapshot-system.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: snapshot system - immutable per-tick world projection"
```

---
### Task 9: CommandSystem

**Files:**
- Create: `src/engine/systems/command-system.ts`
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: `Command` union, all components, `CommandQueue`, `SimClock`, `Stockpile`, `IdCounter`, `NoticeBoard`, `BUILDINGS`, `BALANCE`; `SnapshotSystem` (as a test probe: constructed entities only appear after the step's sync point, so tests read the *next* tick's snapshot).
- Produces: `CommandSystem`. Behavior contract:
  - `constructBuilding`: pay `def.cost` (all-or-nothing) → queue new building entity (`Building(ids.take(), defId)`, `WorkerSlots`, `Production()`); on failure push notice `` `Cannot afford ${def.name}.` ``
  - `recruitWorker`: reject with notice `'Recruiting is still on cooldown.'` unless `tick >= lastRecruitTick + recruitCooldownTicks`; on success set `lastRecruitTick = tick` and queue worker entity (`Worker(ids.take())`, `Hunger()`, `JobAssignment()`, `Efficiency()`, `ToolCoverage()`).
  - `assignWorker {buildingId}`: notices `'Building not found.'` / `'No free worker slots at this building.'` / `'No idle workers available.'`; otherwise sets the first idle worker's `JobAssignment.buildingId`.
  - `unassignWorker {buildingId}`: unassigns the first worker of that building, or notices `'No worker assigned to this building.'`
  - New entities exist from the **next** tick (sim-ecs applies entity commands at the end of the step).

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/command-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, SimClock, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { buildColonyPrepWorld, initialSave } from '../../../src/engine/world';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV1 } from '../../../src/shared/save';

async function setup(save: SaveGameV1 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  // mirror GameEngine.stepOnce: the engine owns time, bumping the clock before each step.
  // Without this the recruit cooldown (which compares SimClock.tick) can never elapse.
  const tick = async () => {
    world.getResource(SimClock).tick++;
    await world.step();
  };
  const dispatch = async (...commands: Command[]) => {
    world.getResource(CommandQueue).pending.push(...commands);
    await tick();
  };
  const snapshot = (w: IRuntimeWorld = world) => w.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

describe('CommandSystem', () => {
  it('constructs a building, paying its cost; entity appears next tick', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(20); // 30 - 10
    expect(snapshot().buildings).toHaveLength(0); // command applied at end of step
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0].defId).toBe('forester');
  });

  it('rejects unaffordable construction with a notice', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'workshop' }); // needs 20 planks
    expect(snapshot().notices).toEqual(['Cannot afford Workshop.']);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('recruits a worker and enforces the 30-tick cooldown', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(4);
    await dispatch({ type: 'recruitWorker' }); // still on cooldown
    expect(snapshot().notices).toEqual(['Recruiting is still on cooldown.']);
    for (let i = 0; i < 30; i++) await tick();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(5);
  });

  it('assigns and unassigns workers within slot limits', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(2);
    await dispatch({ type: 'assignWorker', buildingId }); // forester has 2 slots
    expect(snapshot().notices).toEqual(['No free worker slots at this building.']);
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(1);
    expect(snapshot().idleWorkers).toBe(2);
  });

  it('notices when assigning to a missing building or with no idle workers', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignWorker', buildingId: 999 });
    expect(snapshot().notices).toEqual(['Building not found.']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/command-system.ts**

```ts
import { Actions, createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { Building, Efficiency, Hunger, JobAssignment, Production, ToolCoverage, Worker, WorkerSlots } from '../components';
import { CommandQueue, IdCounter, NoticeBoard, SimClock, Stockpile } from '../resources';

export const CommandSystem = createSystem({
  actions: Actions,
  queue: WriteResource(CommandQueue),
  clock: WriteResource(SimClock),
  stockpile: WriteResource(Stockpile),
  ids: WriteResource(IdCounter),
  notices: WriteResource(NoticeBoard),
  buildings: queryComponents({ building: Read(Building), slots: Read(WorkerSlots) }),
  workers: queryComponents({ worker: Read(Worker), job: Write(JobAssignment) }),
})
  .withName('CommandSystem')
  .withRunFunction(({ actions, queue, clock, stockpile, ids, notices, buildings, workers }) => {
    for (const command of queue.drain()) {
      switch (command.type) {
        case 'constructBuilding': {
          const def = BUILDINGS[command.buildingDefId];
          if (!stockpile.pay(def.cost)) {
            notices.push(`Cannot afford ${def.name}.`);
            break;
          }
          actions.commands
            .buildEntity()
            .with(new Building(ids.take(), def.id))
            .with(new WorkerSlots(def.workerSlots))
            .with(new Production())
            .build();
          break;
        }
        case 'recruitWorker': {
          if (clock.tick < clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
            notices.push('Recruiting is still on cooldown.');
            break;
          }
          clock.lastRecruitTick = clock.tick;
          actions.commands
            .buildEntity()
            .with(new Worker(ids.take()))
            .with(new Hunger())
            .with(new JobAssignment())
            .with(new Efficiency())
            .with(new ToolCoverage())
            .build();
          break;
        }
        case 'assignWorker': {
          let maxSlots: number | null = null;
          for (const { building, slots } of buildings.iter()) {
            if (building.id === command.buildingId) {
              maxSlots = slots.max;
              break;
            }
          }
          if (maxSlots === null) {
            notices.push('Building not found.');
            break;
          }
          let assigned = 0;
          let idle: JobAssignment | null = null;
          for (const { job } of workers.iter()) {
            if (job.buildingId === command.buildingId) assigned++;
            else if (job.buildingId === null && idle === null) idle = job;
          }
          if (assigned >= maxSlots) {
            notices.push('No free worker slots at this building.');
            break;
          }
          if (idle === null) {
            notices.push('No idle workers available.');
            break;
          }
          idle.buildingId = command.buildingId;
          break;
        }
        case 'unassignWorker': {
          let found = false;
          for (const { job } of workers.iter()) {
            if (job.buildingId === command.buildingId) {
              job.buildingId = null;
              found = true;
              break;
            }
          }
          if (!found) notices.push('No worker assigned to this building.');
          break;
        }
      }
    }
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: command system - validated construct/recruit/assign commands"
```

---

### Task 10: StatsSystem

**Files:**
- Create: `src/engine/systems/stats-system.ts`
- Test: `tests/engine/systems/stats-system.test.ts`

**Interfaces:**
- Consumes: `Stockpile`, `StatsHistory`.
- Produces: `StatsSystem`. Behavior contract: each tick it records `stockpile.producedThisTick` / `consumedThisTick` into `StatsHistory` and then calls `stockpile.resetTickFlows()`. It runs AFTER ProductionSystem (captures the tick's flows) and BEFORE SnapshotSystem (whose rates include the current tick).

- [ ] **Step 1: Write the failing test**

`tests/engine/systems/stats-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { IdCounter, SnapshotStore, StatsHistory, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { StatsSystem } from '../../../src/engine/systems/stats-system';
import { Building } from '../../../src/engine/components';
import { buildColonyPrepWorld, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

describe('StatsSystem', () => {
  it('records per-tick flows and resets them', async () => {
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem, StatsSystem, SnapshotSystem] });
    const ids = prep.getResource(IdCounter);
    // 3 workers on a forester = 1 wood per tick
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    for (let i = 0; i < 3; i++) spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();

    for (let i = 0; i < 10; i++) await world.step();

    expect(world.getResource(StatsHistory).rates('wood').production).toBeCloseTo(1);
    expect(world.getResource(Stockpile).producedThisTick.size).toBe(0); // reset after recording
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.productionRate).toBeCloseTo(1);
    expect(snapshot.stockpile.wood.netFlow).toBeCloseTo(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/stats-system.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/systems/stats-system.ts**

```ts
import { createSystem, WriteResource } from 'sim-ecs';
import { StatsHistory, Stockpile } from '../resources';

export const StatsSystem = createSystem({
  stockpile: WriteResource(Stockpile),
  stats: WriteResource(StatsHistory),
})
  .withName('StatsSystem')
  .withRunFunction(({ stockpile, stats }) => {
    stats.record(stockpile.producedThisTick, stockpile.consumedThisTick);
    stockpile.resetTickFlows();
  })
  .build();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/systems/stats-system.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: stats system - rolling production/consumption rates"
```

---

### Task 11: World composition and integration tests

**Files:**
- Modify: `src/engine/world.ts` (fill `ALL_SYSTEMS`)
- Test: `tests/engine/integration.test.ts`

**Interfaces:**
- Consumes: all six systems (Tasks 5-10).
- Produces: `ALL_SYSTEMS` filled in the spec's fixed order — `[CommandSystem, HungerSystem, EfficiencySystem, ProductionSystem, StatsSystem, SnapshotSystem]`. From here on, `createColonyWorld()` runs the full simulation.

- [ ] **Step 1: Fill ALL_SYSTEMS in src/engine/world.ts**

Add imports and replace the empty array (keep the `TColonySystem` type):

```ts
import { CommandSystem } from './systems/command-system';
import { HungerSystem } from './systems/hunger-system';
import { EfficiencySystem } from './systems/efficiency-system';
import { ProductionSystem } from './systems/production-system';
import { StatsSystem } from './systems/stats-system';
import { SnapshotSystem } from './systems/snapshot-system';

/** Fixed execution order per spec 4.4 — one system per stage; never reorder. */
export const ALL_SYSTEMS: TColonySystem[] = [
  CommandSystem,
  HungerSystem,
  EfficiencySystem,
  ProductionSystem,
  StatsSystem,
  SnapshotSystem,
];
```

- [ ] **Step 2: Write the failing integration tests**

`tests/engine/integration.test.ts` — scenario helpers plus the two spec scenarios (economy bootstrap, starvation soft-pressure):

```ts
import { describe, expect, it } from 'vitest';
import { CommandQueue, SimClock, SnapshotStore } from '../../src/engine/resources';
import { createColonyWorld, initialSave } from '../../src/engine/world';
import type { Command } from '../../src/shared/commands';
import type { SaveGameV1 } from '../../src/shared/save';

async function run(world: Awaited<ReturnType<typeof createColonyWorld>>, ticks: number) {
  const clock = world.getResource(SimClock);
  for (let i = 0; i < ticks; i++) {
    clock.tick++;
    await world.step();
  }
}

function dispatch(world: Awaited<ReturnType<typeof createColonyWorld>>, ...commands: Command[]) {
  world.getResource(CommandQueue).pending.push(...commands);
}

/** Rich fixture: enough stock + idle workers to build the full economy at once. */
function richSave(): SaveGameV1 {
  const save = initialSave();
  save.stockpile = { wood: 500, planks: 200, berries: 200 };
  save.workers = Array.from({ length: 14 }, () => ({ hunger: 0, buildingIndex: null, toolTicks: 0 }));
  return save;
}

describe('full colony integration', () => {
  it('bootstraps both chains to steady bread and tools production', async () => {
    const world = await createColonyWorld(richSave());
    dispatch(
      world,
      { type: 'constructBuilding', buildingDefId: 'gatherersHut' },
      { type: 'constructBuilding', buildingDefId: 'farm' },
      { type: 'constructBuilding', buildingDefId: 'mill' },
      { type: 'constructBuilding', buildingDefId: 'bakery' },
      { type: 'constructBuilding', buildingDefId: 'forester' },
      { type: 'constructBuilding', buildingDefId: 'sawmill' },
      { type: 'constructBuilding', buildingDefId: 'workshop' },
    );
    await run(world, 2); // construct, then entities appear
    const snapshot = () => world.getResource(SnapshotStore).latest!;
    const byDef = Object.fromEntries(snapshot().buildings.map((b) => [b.defId, b.id]));
    dispatch(
      world,
      { type: 'assignWorker', buildingId: byDef.gatherersHut },
      { type: 'assignWorker', buildingId: byDef.farm },
      { type: 'assignWorker', buildingId: byDef.farm },
      { type: 'assignWorker', buildingId: byDef.mill },
      { type: 'assignWorker', buildingId: byDef.mill },
      { type: 'assignWorker', buildingId: byDef.bakery },
      { type: 'assignWorker', buildingId: byDef.bakery },
      { type: 'assignWorker', buildingId: byDef.forester },
      { type: 'assignWorker', buildingId: byDef.forester },
      { type: 'assignWorker', buildingId: byDef.sawmill },
      { type: 'assignWorker', buildingId: byDef.sawmill },
      { type: 'assignWorker', buildingId: byDef.workshop },
      { type: 'assignWorker', buildingId: byDef.workshop },
    );
    await run(world, 400);

    const final = snapshot();
    expect(final.stockpile.bread.stock).toBeGreaterThan(0);
    expect(final.stockpile.tools.productionRate).toBeGreaterThan(0);
    expect(final.stockpile.bread.productionRate).toBeGreaterThan(0);
    // wheat must not accumulate unboundedly (2 farm workers vs 2 mill workers)
    expect(final.stockpile.wheat.stock).toBeLessThan(50);
    // everyone stays fed on the safety net + bread
    expect(final.workers.every((w) => w.efficiency > 0.5)).toBe(true);
    expect(final.colonyWealth).toBeGreaterThan(0);
  });

  it('starvation drops efficiency toward 0.2 and food restores it (nobody dies)', async () => {
    const save = initialSave(); // 20 berries, 3 workers, no production
    const world = await createColonyWorld(save);
    await run(world, 400); // berries run out, workers starve
    const snapshot = () => world.getResource(SnapshotStore).latest!;
    expect(snapshot().population).toBe(3); // nobody dies
    expect(snapshot().workers.every((w) => w.efficiency <= 0.21)).toBe(true);

    // hand the colony bread: everyone recovers within a meal cycle
    const { Stockpile } = await import('../../src/engine/resources');
    world.getResource(Stockpile).add('bread', 50);
    await run(world, 60);
    expect(snapshot().workers.every((w) => w.efficiency === 1)).toBe(true);
  });

  it('starting state matches the spec (30 wood, 20 berries, 3 idle workers)', async () => {
    const world = await createColonyWorld();
    await run(world, 1);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.stockpile.wood.stock).toBe(30);
    expect(snapshot.population).toBe(3);
    expect(snapshot.idleWorkers).toBe(3);
    expect(snapshot.buildings).toHaveLength(0);
  });
});
```

Note the `run()` helper increments `SimClock.tick` before each step — mirroring what the GameEngine facade does (Task 12). Berries consumption in the bootstrap test: 13 workers eat 1 berries/~30 ticks against a 200-berry buffer plus gatherer output; if the assertion on efficiency flakes, raise the fixture's berries — the point of the test is chain throughput, not food balance.

- [ ] **Step 3: Run tests to verify integration works**

Run: `npx vitest run tests/engine/integration.test.ts`
Expected: PASS (3 tests). If the bootstrap test fails on food, adjust the fixture (more berries), NOT the balance constants.

- [ ] **Step 4: Run the full suite to catch regressions**

Run: `npm test`
Expected: all tests pass (isolated system tests still pass since they inject their own `systems` subset).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: compose full colony world; integration tests for both chains and starvation"
```

---

### Task 12: GameEngine facade

**Files:**
- Create: `src/engine/game-engine.ts`
- Test: `tests/engine/game-engine.test.ts`

**Interfaces:**
- Consumes: `createColonyWorld`, `initialSave`, resources (Task 4/3), `BALANCE`, `Snapshot`/`EngineStatus`/`SaveGameV1`/`Command` types, `RESOURCE_IDS`.
- Produces (the UI and Obsidian shell program against exactly this):
  - `class GameEngine` with: `static create(save?: SaveGameV1 | null): Promise<GameEngine>`; `dispatch(command: Command): void`; `stepOnce(): Promise<void>`; `start(): void`; `pause(): void`; `setSpeed(speed: 1 | 2 | 4): void`; `reset(): Promise<void>`; `serialize(): SaveGameV1`; `destroy(): void`; `get snapshot(): Snapshot | null`; `get status(): EngineStatus`; `onUpdate(listener: (snapshot: Snapshot | null, status: EngineStatus) => void): void` (multiple listeners allowed); `onAutosave(listener: (save: SaveGameV1) => void): void`.
  - `buildSaveFromWorld(world: IRuntimeWorld): SaveGameV1` (exported for tests). Serialization reads LIVE ECS state, never the snapshot: entities created by a command are applied at the step's sync point AFTER SnapshotSystem ran, so a snapshot-based save on that tick would persist the paid cost while dropping the new building/worker (Codex review P1).
  - Timing: `stepOnce` increments `SimClock.tick` then awaits `world.step()`; the interval is `1000 / (BALANCE.baseTicksPerSecond * speed)` ms; re-entrant calls are dropped while a step is in flight. Autosave fires every `BALANCE.autosaveEveryTicks` ticks and after `reset()`. A throwing step stores the message in `status.error` and pauses.

- [ ] **Step 1: Write the failing tests**

`tests/engine/game-engine.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { GameEngine } from '../../src/engine/game-engine';
import type { SaveGameV1 } from '../../src/shared/save';

async function steps(engine: GameEngine, n: number) {
  for (let i = 0; i < n; i++) await engine.stepOnce();
}

/** Deterministic scripted session used by both determinism tests. */
async function scriptedRun(ticks: number, save?: SaveGameV1): Promise<GameEngine> {
  const engine = await GameEngine.create(save ?? null);
  if (!save) {
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce();
    // ids: workers 1-3 spawned first, the constructed forester gets id 4
    engine.dispatch({ type: 'assignWorker', buildingId: 4 });
    engine.dispatch({ type: 'assignWorker', buildingId: 4 });
  }
  await steps(engine, ticks);
  return engine;
}

describe('GameEngine', () => {
  it('publishes snapshots and status to listeners on every step', async () => {
    const engine = await GameEngine.create();
    const listener = vi.fn();
    engine.onUpdate(listener); // fires immediately with the seeded tick-0 snapshot
    expect(listener.mock.calls[0][0].tick).toBe(0);
    await engine.stepOnce();
    const [snapshot, status] = listener.mock.calls.at(-1)!;
    expect(snapshot.tick).toBe(1);
    expect(status).toEqual({ paused: true, speed: 1, error: null });
  });

  it('is deterministic: same script twice yields identical saves', async () => {
    const a = await scriptedRun(100);
    const b = await scriptedRun(100);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('save/restore round-trip: 500 ticks + save + 100 == 600 straight ticks', async () => {
    const straight = await scriptedRun(600);
    const first = await scriptedRun(500);
    const resumed = await GameEngine.create(first.serialize());
    await steps(resumed, 100);
    expect(resumed.serialize()).toEqual(straight.serialize());
  }, 30000);

  it('speed only changes wall-clock pacing, never the per-tick result', async () => {
    const a = await scriptedRun(50);
    const b = await scriptedRun(50);
    b.setSpeed(4); // no effect on manual stepping determinism
    await steps(a, 10);
    await steps(b, 10);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('fires autosave every 100 ticks', async () => {
    const engine = await GameEngine.create();
    const autosave = vi.fn();
    engine.onAutosave(autosave);
    await steps(engine, 100);
    expect(autosave).toHaveBeenCalledTimes(1);
    expect(autosave.mock.calls[0][0].tick).toBe(100);
  });

  it('autosave on a command tick includes entities created that tick', async () => {
    // P1 regression: the tick-100 snapshot misses entities from tick-100 commands,
    // but the autosaved file must not (serialize reads live state after the sync point)
    const engine = await GameEngine.create();
    const autosave = vi.fn();
    engine.onAutosave(autosave);
    await steps(engine, 99);
    engine.dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await engine.stepOnce(); // tick 100 -> autosave fires
    const save: SaveGameV1 = autosave.mock.calls[0][0];
    expect(save.buildings).toEqual([{ defId: 'forester', progress: 0, batchActive: false }]);
    expect(save.stockpile.wood).toBe(20); // cost paid AND building present
  });

  it('serialize before any step reflects the initial colony', async () => {
    const engine = await GameEngine.create();
    expect(engine.serialize().stockpile).toEqual({ wood: 30, berries: 20 });
  });

  it('reset returns to the initial colony and publishes a fresh, non-null snapshot', async () => {
    const engine = await scriptedRun(50);
    await engine.reset();
    expect(engine.serialize()).toEqual((await GameEngine.create()).serialize());
    // seeded snapshot: the UI must show the fresh colony while still paused,
    // not fall back to a loading screen (Codex P2)
    expect(engine.snapshot).not.toBeNull();
    expect(engine.snapshot!.tick).toBe(0);
    expect(engine.snapshot!.stockpile.wood.stock).toBe(30);
  });

  it('start/pause drive the interval loop', async () => {
    vi.useFakeTimers();
    try {
      const engine = await GameEngine.create();
      engine.start();
      expect(engine.status.paused).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); // 2 ticks/s at 1x
      engine.pause();
      expect(engine.snapshot!.tick).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.snapshot!.tick).toBe(2); // paused: no more ticks
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/engine/game-engine.ts**

```ts
import type { IRuntimeWorld } from 'sim-ecs';
import type { Command } from '../shared/commands';
import type { EngineStatus, Snapshot } from '../shared/snapshot';
import type { SaveGameV1, SavedBuilding } from '../shared/save';
import { BALANCE } from './content/balance';
import { Building, Hunger, JobAssignment, Production, ToolCoverage, Worker } from './components';
import { CommandQueue, SimClock, SnapshotStore, Stockpile } from './resources';
import { createColonyWorld, initialSave } from './world';

export type UpdateListener = (snapshot: Snapshot | null, status: EngineStatus) => void;

export function buildSaveFromWorld(world: IRuntimeWorld): SaveGameV1 {
  const clock = world.getResource(SimClock);
  const buildings: { id: number; saved: SavedBuilding }[] = [];
  const workers: { id: number; hunger: number; buildingId: number | null; toolTicks: number }[] = [];
  for (const entity of world.getEntities()) {
    const building = entity.getComponent(Building);
    if (building) {
      const production = entity.getComponent(Production)!;
      buildings.push({
        id: building.id,
        saved: {
          defId: building.defId,
          progress: production.progress,
          batchActive: production.batchActive,
        },
      });
      continue;
    }
    const worker = entity.getComponent(Worker);
    if (worker) {
      workers.push({
        id: worker.id,
        hunger: entity.getComponent(Hunger)!.value,
        buildingId: entity.getComponent(JobAssignment)!.buildingId,
        toolTicks: entity.getComponent(ToolCoverage)!.remainingTicks,
      });
    }
  }
  buildings.sort((a, b) => a.id - b.id);
  workers.sort((a, b) => a.id - b.id);
  const buildingIndexById = new Map(buildings.map((b, index) => [b.id, index]));
  return {
    version: 1,
    tick: clock.tick,
    lastRecruitTick: clock.lastRecruitTick,
    stockpile: world.getResource(Stockpile).toJSON(),
    buildings: buildings.map((b) => b.saved),
    workers: workers.map((w) => ({
      hunger: w.hunger,
      toolTicks: w.toolTicks,
      buildingIndex: w.buildingId === null ? null : (buildingIndexById.get(w.buildingId) ?? null),
    })),
  };
}

export class GameEngine {
  private paused = true;
  private speed: 1 | 2 | 4 = 1;
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stepping = false;
  private readonly updateListeners: UpdateListener[] = [];
  private autosaveListener: ((save: SaveGameV1) => void) | null = null;

  private constructor(private world: IRuntimeWorld) {}

  static async create(save?: SaveGameV1 | null): Promise<GameEngine> {
    return new GameEngine(await createColonyWorld(save ?? initialSave()));
  }

  get snapshot(): Snapshot | null {
    return this.world.getResource(SnapshotStore).latest;
  }

  get status(): EngineStatus {
    return { paused: this.paused, speed: this.speed, error: this.error };
  }

  onUpdate(listener: UpdateListener): void {
    this.updateListeners.push(listener);
    listener(this.snapshot, this.status);
  }

  onAutosave(listener: (save: SaveGameV1) => void): void {
    this.autosaveListener = listener;
  }

  dispatch(command: Command): void {
    this.world.getResource(CommandQueue).pending.push(command);
  }

  async stepOnce(): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      const clock = this.world.getResource(SimClock);
      clock.tick++;
      await this.world.step();
      if (clock.tick % BALANCE.autosaveEveryTicks === 0) {
        this.autosaveListener?.(this.serialize());
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.pauseInternal();
    } finally {
      this.stepping = false;
    }
    this.publish();
  }

  start(): void {
    this.paused = false;
    this.schedule();
    this.publish();
  }

  pause(): void {
    this.pauseInternal();
    this.publish();
  }

  setSpeed(speed: 1 | 2 | 4): void {
    this.speed = speed;
    if (!this.paused) this.schedule();
    this.publish();
  }

  serialize(): SaveGameV1 {
    // live ECS state, never the snapshot — see buildSaveFromWorld
    return buildSaveFromWorld(this.world);
  }

  async reset(): Promise<void> {
    this.pauseInternal();
    this.error = null;
    this.world = await createColonyWorld(initialSave());
    this.autosaveListener?.(this.serialize());
    this.publish();
  }

  destroy(): void {
    this.clearTimer();
    this.updateListeners.length = 0;
    this.autosaveListener = null;
  }

  private pauseInternal(): void {
    this.paused = true;
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    const intervalMs = 1000 / (BALANCE.baseTicksPerSecond * this.speed);
    this.timer = setInterval(() => {
      void this.stepOnce();
    }, intervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private publish(): void {
    for (const listener of this.updateListeners) {
      listener(this.snapshot, this.status);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/game-engine.test.ts`
Expected: PASS (9 tests). The round-trip test is the load-bearing one — if it fails, compare the two `SaveGameV1` objects field by field; the usual culprit is sim-affecting state not captured by buildSaveFromWorld (there must be none).

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: GameEngine facade - tick loop, commands, autosave, save round-trip"
```

---

### Task 13: Pinia game store

**Files:**
- Create: `src/app/stores/game-store.ts`
- Test: `tests/app/game-store.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `EngineStatus` (Task 2), `BALANCE` (Task 2).
- Produces: `useGameStore` (Pinia). State: `snapshot: Snapshot | null`, `paused: boolean`, `speed: 1|2|4`, `error: string | null`, `recentNotices: { tick: number; message: string }[]` (newest first, max 5). Actions: `ingest(snapshot, status)`. Getters: `lowFood: boolean` (edible stock < population × 2), `recruitCooldownRemaining: number` (ticks until recruit allowed).

- [ ] **Step 1: Write the failing test**

`tests/app/game-store.test.ts` (node env is fine — Pinia needs no DOM):

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGameStore } from '../../src/app/stores/game-store';
import type { EngineStatus, ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import type { ResourceId } from '../../src/shared/content-types';

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const stockpile = Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: 0, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
  return {
    tick: 0, lastRecruitTick: -30, stockpile, colonyWealth: 0,
    population: 0, idleWorkers: 0, buildings: [], workers: [], notices: [],
    ...overrides,
  };
}

const status: EngineStatus = { paused: true, speed: 1, error: null };

describe('useGameStore', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('ingests snapshot and status', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ tick: 5 }), { paused: false, speed: 2, error: null });
    expect(store.snapshot!.tick).toBe(5);
    expect(store.paused).toBe(false);
    expect(store.speed).toBe(2);
  });

  it('collects notices newest-first, capped at 5', () => {
    const store = useGameStore();
    for (let tick = 1; tick <= 7; tick++) {
      store.ingest(makeSnapshot({ tick, notices: [`n${tick}`] }), status);
    }
    expect(store.recentNotices).toHaveLength(5);
    expect(store.recentNotices[0]).toEqual({ tick: 7, message: 'n7' });
  });

  it('lowFood getter flags scarce edible stock', () => {
    const store = useGameStore();
    const snapshot = makeSnapshot({ population: 3 });
    snapshot.stockpile.bread.stock = 2;
    snapshot.stockpile.berries.stock = 3;
    store.ingest(snapshot, status);
    expect(store.lowFood).toBe(true); // 5 < 6
    snapshot.stockpile.berries.stock = 10;
    store.ingest({ ...snapshot }, status);
    expect(store.lowFood).toBe(false);
  });

  it('computes recruit cooldown remaining', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({ tick: 10, lastRecruitTick: 0 }), status);
    expect(store.recruitCooldownRemaining).toBe(20);
    store.ingest(makeSnapshot({ tick: 40, lastRecruitTick: 0 }), status);
    expect(store.recruitCooldownRemaining).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/game-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write src/app/stores/game-store.ts**

```ts
import { defineStore } from 'pinia';
import type { EngineStatus, Snapshot } from '../../shared/snapshot';
import { BALANCE } from '../../engine/content/balance';

export interface NoticeEntry {
  tick: number;
  message: string;
}

const MAX_NOTICES = 5;

export const useGameStore = defineStore('game', {
  state: () => ({
    snapshot: null as Snapshot | null,
    paused: true,
    speed: 1 as 1 | 2 | 4,
    error: null as string | null,
    recentNotices: [] as NoticeEntry[],
  }),
  getters: {
    lowFood(state): boolean {
      if (!state.snapshot) return false;
      const edible = state.snapshot.stockpile.bread.stock + state.snapshot.stockpile.berries.stock;
      return edible < state.snapshot.population * 2;
    },
    recruitCooldownRemaining(state): number {
      if (!state.snapshot) return 0;
      return Math.max(
        0,
        state.snapshot.lastRecruitTick + BALANCE.recruitCooldownTicks - state.snapshot.tick,
      );
    },
  },
  actions: {
    ingest(snapshot: Snapshot | null, status: EngineStatus) {
      this.snapshot = snapshot;
      this.paused = status.paused;
      this.speed = status.speed;
      this.error = status.error;
      if (snapshot) {
        for (const message of snapshot.notices) {
          this.recentNotices.unshift({ tick: snapshot.tick, message });
        }
        this.recentNotices.splice(MAX_NOTICES);
      }
    },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app/game-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: Pinia game store - snapshot read-model with notices and getters"
```

---
### Task 14: Vue app shell (createGameApp, router, App, TopBar)

**Files:**
- Create: `src/app/engine-key.ts`, `src/app/router.ts`, `src/app/index.ts`, `src/app/App.vue`, `src/app/components/TopBar.vue`, and four **placeholder** views `src/app/views/{Dashboard,Buildings,Population,Economy}View.vue` (filled in Task 15)
- Test: `tests/app/top-bar.test.ts`

**Interfaces:**
- Consumes: `GameEngine` (Task 12), `useGameStore` (Task 13).
- Produces:
  - `ENGINE_KEY: InjectionKey<GameEngine>` — every component gets the engine via `inject(ENGINE_KEY)!`.
  - `createGameRouter(): Router` — memory history; routes `/` (dashboard), `/buildings`, `/population`, `/economy`.
  - `createGameApp(engine: GameEngine, container: HTMLElement): App<Element>` — creates Pinia + router + app, provides the engine, wires `engine.onUpdate` into `store.ingest`, mounts, returns the app (caller unmounts).

- [ ] **Step 1: Write the failing TopBar test**

`tests/app/top-bar.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import TopBar from '../../src/app/components/TopBar.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './game-store.test';

function mountTopBar() {
  const engine = { start: vi.fn(), pause: vi.fn(), setSpeed: vi.fn(), stepOnce: vi.fn(), reset: vi.fn() };
  const wrapper = mount(TopBar, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const store = useGameStore();
  store.ingest(makeSnapshot({ tick: 42, population: 3, colonyWealth: 123 }), { paused: true, speed: 1, error: null });
  return { engine, wrapper, store };
}

describe('TopBar', () => {
  it('shows tick, population, and wealth from the store', async () => {
    const { wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('42');
    expect(wrapper.text()).toContain('123');
  });

  it('play/pause/speed/step call the engine', async () => {
    const { engine, wrapper } = mountTopBar();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="play"]').trigger('click');
    expect(engine.start).toHaveBeenCalled();
    await wrapper.find('[data-test="step"]').trigger('click');
    expect(engine.stepOnce).toHaveBeenCalled();
    await wrapper.find('[data-test="speed-4"]').trigger('click');
    expect(engine.setSpeed).toHaveBeenCalledWith(4);
  });
});
```

Add dev dependency: `npm install -D @pinia/testing@^1.0.0`. Also export `makeSnapshot` from `tests/app/game-store.test.ts` (it already is, per Task 13).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install -D @pinia/testing && npx vitest run tests/app/top-bar.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the app shell files**

`src/app/engine-key.ts`:

```ts
import type { InjectionKey } from 'vue';
import type { GameEngine } from '../engine/game-engine';

export const ENGINE_KEY: InjectionKey<GameEngine> = Symbol('obsisim-engine');
```

`src/app/router.ts`:

```ts
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import BuildingsView from './views/BuildingsView.vue';
import PopulationView from './views/PopulationView.vue';
import EconomyView from './views/EconomyView.vue';

export function createGameRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'dashboard', component: DashboardView },
      { path: '/buildings', name: 'buildings', component: BuildingsView },
      { path: '/population', name: 'population', component: PopulationView },
      { path: '/economy', name: 'economy', component: EconomyView },
    ],
  });
}
```

`src/app/index.ts`:

```ts
import { createApp, type App } from 'vue';
import { createPinia } from 'pinia';
import type { GameEngine } from '../engine/game-engine';
import AppRoot from './App.vue';
import { ENGINE_KEY } from './engine-key';
import { createGameRouter } from './router';
import { useGameStore } from './stores/game-store';

export function createGameApp(engine: GameEngine, container: HTMLElement): App<Element> {
  const pinia = createPinia();
  const app = createApp(AppRoot);
  app.use(pinia);
  app.use(createGameRouter());
  app.provide(ENGINE_KEY, engine);

  const store = useGameStore(pinia);
  engine.onUpdate((snapshot, status) => store.ingest(snapshot, status));

  app.mount(container);
  return app;
}
```

`src/app/App.vue`:

```vue
<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useGameStore } from './stores/game-store';
import TopBar from './components/TopBar.vue';

const store = useGameStore();
const route = useRoute();
const tabs = [
  { to: '/', label: 'Dashboard' },
  { to: '/buildings', label: 'Buildings' },
  { to: '/population', label: 'Population' },
  { to: '/economy', label: 'Economy' },
];
</script>

<template>
  <div class="obsisim">
    <TopBar />
    <div v-if="store.error" class="obsisim-error" data-test="error-banner">
      Simulation paused on error: {{ store.error }}
    </div>
    <div v-if="store.recentNotices.length" class="obsisim-notices">
      <div v-for="notice in store.recentNotices" :key="notice.tick + notice.message" class="obsisim-notice">
        [t{{ notice.tick }}] {{ notice.message }}
      </div>
    </div>
    <nav class="obsisim-nav">
      <router-link
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="obsisim-tab"
        :class="{ 'is-active': route.path === tab.to }"
      >
        {{ tab.label }}
      </router-link>
    </nav>
    <main v-if="store.snapshot">
      <router-view />
    </main>
    <main v-else class="obsisim-loading">Starting simulation…</main>
  </div>
</template>
```

`src/app/components/TopBar.vue`:

```vue
<script setup lang="ts">
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();
const speeds = [1, 2, 4] as const;

function onReset() {
  if (window.confirm('Reset the colony? This cannot be undone.')) void engine.reset();
}
</script>

<template>
  <header class="obsisim-topbar">
    <div class="obsisim-controls">
      <button v-if="store.paused" data-test="play" @click="engine.start()">▶ Play</button>
      <button v-else data-test="pause" @click="engine.pause()">⏸ Pause</button>
      <button data-test="step" :disabled="!store.paused" @click="void engine.stepOnce()">Step</button>
      <button
        v-for="s in speeds"
        :key="s"
        :data-test="`speed-${s}`"
        :class="{ 'is-active': store.speed === s }"
        @click="engine.setSpeed(s)"
      >
        {{ s }}×
      </button>
    </div>
    <div v-if="store.snapshot" class="obsisim-summary">
      <span data-test="tick">Tick {{ store.snapshot.tick }}</span>
      <span>👥 {{ store.snapshot.population }}</span>
      <span>💰 {{ store.snapshot.colonyWealth.toFixed(0) }}</span>
      <span v-if="store.lowFood" class="obsisim-warning" data-test="low-food">⚠ Low food</span>
    </div>
    <button class="obsisim-reset" data-test="reset" @click="onReset">Reset colony</button>
  </header>
</template>
```

Placeholder views (all four identical shape; real content in Task 15), e.g. `src/app/views/DashboardView.vue`:

```vue
<template>
  <div>Dashboard (Task 15)</div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app/top-bar.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: Vue app shell - router, engine injection, top bar controls"
```

---

### Task 15: The four table views

**Files:**
- Modify: `src/app/views/DashboardView.vue`, `src/app/views/BuildingsView.vue`, `src/app/views/PopulationView.vue`, `src/app/views/EconomyView.vue` (replace placeholders)
- Test: `tests/app/buildings-view.test.ts`

**Interfaces:**
- Consumes: `useGameStore`, `ENGINE_KEY`, catalog (`RESOURCES`, `RESOURCE_IDS`, `BUILDINGS`, `BUILDING_IDS`, `CHAINS`), `BALANCE` via store getters.
- Produces: the four routed views. Only BuildingsView gets a component test (the views are read-only tables off the store; BuildingsView carries the interaction logic).

- [ ] **Step 1: Write the failing BuildingsView test**

`tests/app/buildings-view.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import BuildingsView from '../../src/app/views/BuildingsView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot } from './game-store.test';

function mountView(stock: { wood?: number } = {}) {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(BuildingsView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  const snapshot = makeSnapshot({
    buildings: [{
      id: 7, defId: 'forester', workers: 1, workerSlots: 2, state: 'producing',
      progress: 1, batchActive: true, progressPct: 33, tooledWorkers: 0, workPower: 1,
    }],
    idleWorkers: 2,
  });
  snapshot.stockpile.wood.stock = stock.wood ?? 0;
  useGameStore().ingest(snapshot, { paused: true, speed: 1, error: null });
  return { engine, wrapper };
}

describe('BuildingsView', () => {
  it('renders constructed buildings with state', async () => {
    const { wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Forester');
    expect(wrapper.text()).toContain('producing');
  });

  it('dispatches assign/unassign for a building row', async () => {
    const { engine, wrapper } = mountView();
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-test="assign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignWorker', buildingId: 7 });
    await wrapper.find('[data-test="unassign-7"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignWorker', buildingId: 7 });
  });

  it('construct button dispatches when affordable and disables when not', async () => {
    const rich = mountView({ wood: 100 });
    await rich.wrapper.vm.$nextTick();
    await rich.wrapper.find('[data-test="construct-forester"]').trigger('click');
    expect(rich.engine.dispatch).toHaveBeenCalledWith({ type: 'constructBuilding', buildingDefId: 'forester' });

    const poor = mountView({ wood: 0 });
    await poor.wrapper.vm.$nextTick();
    expect((poor.wrapper.find('[data-test="construct-forester"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/buildings-view.test.ts`
Expected: FAIL — placeholder view has no table.

- [ ] **Step 3: Write the four views**

`src/app/views/BuildingsView.vue`:

```vue
<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS } from '../../engine/content/buildings';
import { RESOURCES } from '../../engine/content/resources';
import type { BuildingDefId, CostMap, ResourceId } from '../../shared/content-types';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

function costLabel(cost: CostMap): string {
  return Object.entries(cost)
    .map(([id, amount]) => `${amount} ${RESOURCES[id as ResourceId].name}`)
    .join(', ');
}

const affordable = computed(() => {
  const snapshot = store.snapshot;
  return Object.fromEntries(
    BUILDING_IDS.map((id) => [
      id,
      snapshot !== null &&
        Object.entries(BUILDINGS[id].cost).every(
          ([res, amount]) => snapshot.stockpile[res as ResourceId].stock >= amount,
        ),
    ]),
  ) as Record<BuildingDefId, boolean>;
});
</script>

<template>
  <div v-if="store.snapshot">
    <h3>Buildings</h3>
    <table class="obsisim-table">
      <thead>
        <tr><th>Building</th><th>Workers</th><th>State</th><th>Batch</th><th>Work power</th><th>Tools</th></tr>
      </thead>
      <tbody>
        <tr v-for="b in store.snapshot.buildings" :key="b.id">
          <td>{{ BUILDINGS[b.defId].name }}</td>
          <td>
            <button :data-test="`unassign-${b.id}`" :disabled="b.workers === 0" @click="engine.dispatch({ type: 'unassignWorker', buildingId: b.id })">−</button>
            {{ b.workers }} / {{ b.workerSlots }}
            <button :data-test="`assign-${b.id}`" :disabled="b.workers >= b.workerSlots || store.snapshot.idleWorkers === 0" @click="engine.dispatch({ type: 'assignWorker', buildingId: b.id })">+</button>
          </td>
          <td>{{ b.state }}</td>
          <td>{{ b.progressPct }}%</td>
          <td>{{ b.workPower.toFixed(2) }}</td>
          <td>{{ b.tooledWorkers > 0 ? `⚒ ${b.tooledWorkers}/${b.workers}` : '—' }}</td>
        </tr>
        <tr v-if="store.snapshot.buildings.length === 0">
          <td colspan="6">No buildings yet — construct one below.</td>
        </tr>
      </tbody>
    </table>

    <h3>Construct</h3>
    <table class="obsisim-table">
      <thead>
        <tr><th>Building</th><th>Cost</th><th>Slots</th><th>Recipe</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="id in BUILDING_IDS" :key="id">
          <td>{{ BUILDINGS[id].name }}</td>
          <td>{{ costLabel(BUILDINGS[id].cost) }}</td>
          <td>{{ BUILDINGS[id].workerSlots }}</td>
          <td>
            {{ costLabel(BUILDINGS[id].recipe.inputs) || '—' }} → {{ costLabel(BUILDINGS[id].recipe.outputs) }}
            ({{ BUILDINGS[id].recipe.ticksPerBatch }}wt)
          </td>
          <td>
            <button
              :data-test="`construct-${id}`"
              :disabled="!affordable[id]"
              :title="affordable[id] ? '' : 'Not enough resources'"
              @click="engine.dispatch({ type: 'constructBuilding', buildingDefId: id })"
            >
              Build
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

`src/app/views/DashboardView.vue`:

```vue
<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { RESOURCES, RESOURCE_IDS } from '../../engine/content/resources';

const store = useGameStore();
const fmt = (n: number) => n.toFixed(2);
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <span>Colony wealth: <strong>{{ store.snapshot.colonyWealth.toFixed(0) }}</strong></span>
      <span>Population: <strong>{{ store.snapshot.population }}</strong> ({{ store.snapshot.idleWorkers }} idle)</span>
      <span>Buildings: <strong>{{ store.snapshot.buildings.length }}</strong></span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Resource</th><th>Tier</th><th>Stock</th><th>Prod/t</th><th>Cons/t</th><th>Net</th><th>Value</th></tr>
      </thead>
      <tbody>
        <tr v-for="id in RESOURCE_IDS" :key="id">
          <td>{{ RESOURCES[id].name }}</td>
          <td>{{ RESOURCES[id].tier }}</td>
          <td>{{ store.snapshot.stockpile[id].stock }}</td>
          <td>{{ fmt(store.snapshot.stockpile[id].productionRate) }}</td>
          <td>{{ fmt(store.snapshot.stockpile[id].consumptionRate) }}</td>
          <td :class="store.snapshot.stockpile[id].netFlow >= 0 ? 'obsisim-positive' : 'obsisim-negative'">
            {{ fmt(store.snapshot.stockpile[id].netFlow) }}
          </td>
          <td>{{ store.snapshot.stockpile[id].stockValue.toFixed(0) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

`src/app/views/PopulationView.vue`:

```vue
<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS } from '../../engine/content/buildings';

const engine = inject(ENGINE_KEY)!;
const store = useGameStore();

const jobNames = computed(() => {
  const names = new Map<number, string>();
  for (const b of store.snapshot?.buildings ?? []) names.set(b.id, BUILDINGS[b.defId].name);
  return names;
});
</script>

<template>
  <div v-if="store.snapshot">
    <div class="obsisim-headline">
      <button
        data-test="recruit"
        :disabled="store.recruitCooldownRemaining > 0"
        @click="engine.dispatch({ type: 'recruitWorker' })"
      >
        Recruit worker
      </button>
      <span v-if="store.recruitCooldownRemaining > 0">available in {{ store.recruitCooldownRemaining }} ticks</span>
    </div>
    <table class="obsisim-table">
      <thead>
        <tr><th>Worker</th><th>Job</th><th>Hunger</th><th>Efficiency</th><th>Tool</th></tr>
      </thead>
      <tbody>
        <tr v-for="w in store.snapshot.workers" :key="w.id">
          <td>#{{ w.id }}</td>
          <td>{{ w.buildingId === null ? 'Idle' : jobNames.get(w.buildingId) ?? '?' }}</td>
          <td>{{ w.hunger }} / 100</td>
          <td>{{ (w.efficiency * 100).toFixed(0) }}%</td>
          <td>{{ w.toolTicks > 0 ? `⚒ ${w.toolTicks}t` : '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

`src/app/views/EconomyView.vue`:

```vue
<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { CHAINS } from '../../engine/content/chains';
import { BUILDINGS } from '../../engine/content/buildings';
import { RESOURCES } from '../../engine/content/resources';

const store = useGameStore();

function buildingCount(defId: string): { total: number; staffed: number } {
  const buildings = (store.snapshot?.buildings ?? []).filter((b) => b.defId === defId);
  return { total: buildings.length, staffed: buildings.filter((b) => b.workers > 0).length };
}
</script>

<template>
  <div v-if="store.snapshot">
    <section v-for="chain in CHAINS" :key="chain.name">
      <h3>{{ chain.name }} chain</h3>
      <table class="obsisim-table">
        <thead>
          <tr><th>Stage</th><th>Buildings (staffed)</th><th>Output</th><th>Prod/t</th><th>Cons/t</th><th>Stock</th></tr>
        </thead>
        <tbody>
          <tr v-for="step in chain.steps" :key="step.building">
            <td>{{ BUILDINGS[step.building].name }}</td>
            <td>{{ buildingCount(step.building).total }} ({{ buildingCount(step.building).staffed }})</td>
            <td>{{ RESOURCES[step.output].name }}</td>
            <td>{{ store.snapshot.stockpile[step.output].productionRate.toFixed(2) }}</td>
            <td>{{ store.snapshot.stockpile[step.output].consumptionRate.toFixed(2) }}</td>
            <td>{{ store.snapshot.stockpile[step.output].stock }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app/buildings-view.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint, full suite, commit**

```bash
npm run lint && npm test
git add -A
git commit -m "feat: dashboard, buildings, population, and economy table views"
```

---

### Task 16: Obsidian shell (plugin entry + ItemView)

**Files:**
- Create: `src/view/game-view.ts`
- Modify: `src/main.ts` (replace the Task 1 stub)

**Interfaces:**
- Consumes: `GameEngine` (Task 12), `createGameApp` (Task 14), `SaveGameV1`/`isSaveGameV1` (Task 2), Obsidian API (`Plugin`, `ItemView`, `WorkspaceLeaf`, `Notice`).
- Produces: `VIEW_TYPE_OBSISIM = 'obsisim-game'`, `class GameView extends ItemView`, `default class ObsiSimPlugin extends Plugin` with `loadSave(): Promise<SaveGameV1 | null>` and `saveSave(save: SaveGameV1): Promise<void>` — saveSave serializes all data.json writes through a single FIFO promise chain so a stale fire-and-forget autosave can never land after (and clobber) a newer close-save (Codex review P2).
- No automated tests: Obsidian's API cannot run under vitest; this layer is deliberately thin and manually verified (spec 7.1 puts the test weight on the engine).

- [ ] **Step 1: Write src/view/game-view.ts**

```ts
import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { App as VueApp } from 'vue';
import { GameEngine } from '../engine/game-engine';
import { createGameApp } from '../app';
import type ObsiSimPlugin from '../main';

export const VIEW_TYPE_OBSISIM = 'obsisim-game';

export class GameView extends ItemView {
  private engine: GameEngine | null = null;
  private vueApp: VueApp<Element> | null = null;
  private lastError: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ObsiSimPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_OBSISIM;
  }

  getDisplayText(): string {
    return 'ObsiSim';
  }

  getIcon(): string {
    return 'factory';
  }

  async onOpen(): Promise<void> {
    const save = await this.plugin.loadSave();
    this.engine = await GameEngine.create(save);
    this.engine.onAutosave((s) => void this.plugin.saveSave(s));
    this.engine.onUpdate((_snapshot, status) => {
      if (status.error && status.error !== this.lastError) {
        new Notice(`ObsiSim paused on error: ${status.error}`);
      }
      this.lastError = status.error;
    });
    this.vueApp = createGameApp(this.engine, this.contentEl);
    this.engine.start();
  }

  async onClose(): Promise<void> {
    if (this.engine) {
      this.engine.pause();
      await this.plugin.saveSave(this.engine.serialize());
      this.engine.destroy();
      this.engine = null;
    }
    this.vueApp?.unmount();
    this.vueApp = null;
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Replace src/main.ts**

```ts
import { Notice, Plugin } from 'obsidian';
import type { SaveGameV1 } from './shared/save';
import { isLoadableSave } from './engine/world';
import { GameView, VIEW_TYPE_OBSISIM } from './view/game-view';

interface PluginData {
  save?: unknown;
  corruptBackup?: unknown;
}

export default class ObsiSimPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_OBSISIM, (leaf) => new GameView(leaf, this));
    this.addRibbonIcon('factory', 'Open ObsiSim', () => void this.activateView());
    this.addCommand({
      id: 'open',
      name: 'Open game',
      callback: () => void this.activateView(),
    });
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSISIM)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_OBSISIM, active: true });
  }

  async loadSave(): Promise<SaveGameV1 | null> {
    const data = ((await this.loadData()) as PluginData | null) ?? {};
    if (data.save === undefined || data.save === null) return null;
    if (isLoadableSave(data.save)) return data.save; // catalog-aware guard, not bare isSaveGameV1
    // spec 7.2: corrupt/incompatible save -> back it up, start fresh, tell the user
    new Notice('ObsiSim: save was corrupt or incompatible — starting a fresh colony (old save backed up).');
    await this.saveData({ ...data, save: undefined, corruptBackup: data.save } satisfies PluginData);
    return null;
  }

  /**
   * All data.json writes flow through one FIFO promise chain: autosaves are
   * fire-and-forget, so without ordering a slow autosave could resolve AFTER
   * the awaited close-save and clobber data.json with an older tick.
   */
  private saveQueue: Promise<void> = Promise.resolve();

  saveSave(save: SaveGameV1): Promise<void> {
    const write = this.saveQueue.then(async () => {
      const data = ((await this.loadData()) as PluginData | null) ?? {};
      await this.saveData({ ...data, save } satisfies PluginData);
    });
    this.saveQueue = write.catch(() => undefined); // keep the chain alive on failure
    return write;
  }
}
```

- [ ] **Step 3: Verify build and gates**

Run: `npm run lint && npm test && npm run build`
Expected: all pass; `demo-vault/.obsidian/plugins/obsisim/main.js` regenerated.

- [ ] **Step 4: Manual verification in Obsidian (dev loop smoke test)**

Open `demo-vault` as a vault in Obsidian (Settings → Community plugins → enable ObsiSim if prompted), then verify:
1. Ribbon "factory" icon opens the ObsiSim view; tables render and the tick counter advances at ~2/s.
2. Build a Forester (30 wood → 20), assign a worker, watch wood grow on the Dashboard.
3. Close the view, reopen it: state is intact (autosave on close).
4. Quit and restart Obsidian: state is intact.
5. Reset colony (with confirm) returns to 30 wood / 20 berries / 3 workers.

If a step fails, fix before committing (this is the plugin's reason to exist). Console errors: View → Toggle Developer Tools.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Obsidian plugin shell - game view, ribbon, autosave persistence"
```

---

### Task 17: Styles, README, and acceptance pass

**Files:**
- Modify: `styles.css` (replace placeholder), `README.md` (create)
- Test: none new — this is the final gate + polish task.

**Interfaces:**
- Consumes: everything.
- Produces: the finished increment.

- [ ] **Step 1: Write styles.css (Obsidian-theme-aware, tables + controls)**

```css
.obsisim {
  padding: var(--size-4-3);
  font-size: var(--font-ui-small);
}

.obsisim-topbar {
  display: flex;
  align-items: center;
  gap: var(--size-4-4);
  flex-wrap: wrap;
  padding-bottom: var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
}

.obsisim-controls,
.obsisim-summary,
.obsisim-headline {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-wrap: wrap;
}

.obsisim-summary { margin-left: auto; }

.obsisim-controls button.is-active {
  background-color: var(--interactive-accent);
  color: var(--text-on-accent);
}

.obsisim-nav {
  display: flex;
  gap: var(--size-4-1);
  margin: var(--size-4-2) 0;
}

.obsisim-tab {
  padding: var(--size-2-2) var(--size-4-2);
  border-radius: var(--radius-s);
  text-decoration: none;
  color: var(--text-muted);
}

.obsisim-tab.is-active {
  background-color: var(--background-modifier-hover);
  color: var(--text-normal);
}

.obsisim-table {
  width: 100%;
  border-collapse: collapse;
  margin: var(--size-4-2) 0 var(--size-4-4);
}

.obsisim-table th,
.obsisim-table td {
  padding: var(--size-2-2) var(--size-4-2);
  border-bottom: 1px solid var(--background-modifier-border);
  text-align: left;
}

.obsisim-table th {
  color: var(--text-muted);
  font-weight: var(--font-semibold);
  background-color: var(--background-secondary);
}

.obsisim-positive { color: var(--color-green); }
.obsisim-negative { color: var(--color-red); }
.obsisim-warning { color: var(--color-orange); font-weight: var(--font-semibold); }

.obsisim-error {
  padding: var(--size-4-2);
  margin: var(--size-4-2) 0;
  border: 1px solid var(--color-red);
  border-radius: var(--radius-s);
  color: var(--color-red);
}

.obsisim-notice { color: var(--text-muted); font-style: italic; }
.obsisim-loading { color: var(--text-muted); padding: var(--size-4-4); }
.obsisim-reset { margin-left: var(--size-4-4); }
```

- [ ] **Step 2: Write README.md**

```markdown
# ObsiSim

A Banished-inspired colony simulation game that runs inside Obsidian.
Grow a settlement from three workers into an economic powerhouse through
simulated production chains — displayed, for now, entirely in tables.

## Increment 1 — Economy Core

- Deterministic tick simulation (sim-ecs): 2 ticks/s, pause / 2× / 4× / single-step
- Two production chains: berries & wheat→flour→bread, wood→planks→tools
- Workers with hunger-driven efficiency (soft pressure — nobody dies)
- Tooled workers gain +50% efficiency while their tool lasts (1 tool per worker per 300 ticks)
- Single-slot autosave into the plugin's data.json

## Development

- `npm install`
- `npm run dev` — watch-build into `demo-vault/.obsidian/plugins/obsisim/`
- Open `demo-vault/` as an Obsidian vault, enable the ObsiSim community plugin,
  and reload Obsidian (Ctrl/Cmd-R) after rebuilds
- `npm test` / `npm run lint` / `npm run build`

## Documentation

- Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md`
- Plan: `docs/superpowers/plans/2026-07-03-increment-1-economy-core.md`

## Architecture (one paragraph)

`src/engine/` is a headless, UI-agnostic sim-ecs world behind a `GameEngine`
facade (commands in, immutable snapshots out). `src/app/` is a Vue 3 + Pinia
read-model over those snapshots. `src/view/` + `src/main.ts` are the thin
Obsidian shell that hosts the app and persists saves.
```

- [ ] **Step 3: Full gate run**

Run: `npm run lint && npm test && npm run build`
Expected: everything green.

- [ ] **Step 4: Acceptance criteria walkthrough (spec section 8)**

Verify each — automated ones by pointing at the passing test, manual ones in the demo vault:

1. Plugin loads, view opens, survives close/reopen and Obsidian restart → manual (Task 16 step 4).
2. Bootstrap both chains via table UI from the starting state → manual play session; the engine-level equivalent is `tests/engine/integration.test.ts` ("bootstraps both chains").
3. Hunger drops efficiency to 0.2 and recovers; nobody dies → `tests/engine/integration.test.ts` ("starvation").
4. Tools +50% and consumed over time → `tests/engine/systems/efficiency-system.test.ts` + `production-system.test.ts` ("tool buff").
5. Deterministic pause/speed/step → `tests/engine/game-engine.test.ts` ("deterministic", "speed only changes wall-clock").
6. Engine behavior covered by headless tests; lint + tests clean → the gate run above.

Record any manual-check failures as new tasks; do not ship with a red acceptance item.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: obsidian-themed styles, README, acceptance pass for increment 1"
```

---

### Task 18: Quality gates and CI (specorator guardrails, greenfield-strict)

Ports the machine-enforced guardrails from Luis85/specorator (`docs/build-ci/quality-gates.md`) to this repo. Adaptations, stated once: **every baseline starts empty or at zero** (greenfield — nothing grandfathered); the LOC guard also covers `.vue` files; the CSS guard covers the single root `styles.css`; specorator's provider-boundary guards map to our layer boundaries (fallow zones + `no-restricted-imports` twins); perf scaling guards are deferred until a hot path with unbounded input exists (the determinism tests already pin sim behavior); the test job runs on Linux only for now.

**Files:**
- Create: `scripts/check-loc.mjs`, `scripts/loc-baseline.json`, `scripts/check-css-important.mjs`, `scripts/css-important-baseline.json`, `scripts/check-quality.mjs`, `scripts/quality-baseline.json`, `scripts/check-artifacts.mjs`, `.fallowrc.json`, `.github/workflows/ci.yml`, `docs/build-ci/quality-gates.md`
- Modify: `package.json` (scripts, engines, devDeps), `eslint.config.js` (boundary-twin rules), `vitest.config.ts` (coverage thresholds), `.gitignore` (`.fallow/`, `coverage/`)

**Interfaces:**
- Consumes: the completed codebase (Tasks 1-17).
- Produces: `npm run check:all` — the single local pre-push gate — plus CI jobs `lint`, `quality`, `typecheck`, `test`, `coverage`, `build`. All gates fail fast with output short enough to act on without opening CI logs.

**Verified tool facts** (probed against `fallow@2.104.0` — do not re-derive): the JSON report has `check.summary.{total_issues,circular_dependencies,re_export_cycles,boundary_violations}`, `dupes.stats.{clone_groups,duplicated_lines}`, `health.summary.{functions_above_threshold,severity_critical_count,average_maintainability}`. Boundary config is `boundaries: { zones: [{ name, patterns }], rules: [{ from, allow, allowTypeOnly? }] }` in `.fallowrc.json`. Fallow parses `.vue` SFCs natively.

- [ ] **Step 1: package.json — scripts, engines, devDeps**

Add to `scripts` (keep the existing ones):

```json
{
  "typecheck": "vue-tsc --noEmit",
  "test:coverage": "vitest run --coverage",
  "check:loc": "node scripts/check-loc.mjs",
  "check:css": "node scripts/check-css-important.mjs",
  "check:quality": "node scripts/check-quality.mjs",
  "check:artifacts": "node scripts/check-artifacts.mjs",
  "check:all": "npm run lint && npm run check:loc && npm run check:css && npm run check:quality && npm run typecheck && npm run test && npm run build && npm run check:artifacts"
}
```

Add top-level `"engines": { "node": ">=22" }` (CI and any release tooling must run the same Node major). Install the new dev tooling:

```bash
npm install -D vue-tsc@^2.2.0 @vitest/coverage-v8@^3.0.5 fallow@^2.104.0
```

Note `check:all` deliberately runs `check:quality` before `test:coverage` ever runs: fallow flips from static-estimated to istanbul coverage when a `coverage/` directory exists, which skews CRAP-based counts (specorator campaign run 9 lesson). `check-quality.mjs` hard-fails if `coverage/` is present.

- [ ] **Step 2: eslint.config.js — machine-enforce the layering constraints**

Append two config objects (these are the lint twins of the fallow zones; they also catch what zones cannot, e.g. the UI importing `sim-ecs` directly):

```js
  {
    files: ['src/app/**', 'src/view/**', 'src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'sim-ecs', message: 'UI and shell talk to the engine only through the GameEngine facade and shared types.' }],
      }],
    },
  },
  {
    files: ['src/engine/**', 'src/shared/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'vue', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'pinia', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'vue-router', message: 'The engine and shared contracts must stay UI-agnostic.' },
          { name: 'obsidian', message: 'The engine and shared contracts must stay Obsidian-agnostic.' },
        ],
      }],
    },
  },
```

Severity policy: everything ships at `error`. The `warn` tier is reserved for staging a future rule against a nonzero backlog and is currently empty — CI does not pass `--max-warnings`, so a `warn` rule would never fail the build.

- [ ] **Step 3: vitest.config.ts — coverage floors**

```ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/shared/**', 'src/app/**'],
      thresholds: {
        // the sim is the product: gate it hard. Views are gated by the LOC guard
        // and BuildingsView's interaction tests; their coverage floor comes later.
        'src/engine/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/shared/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/app/stores/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
```

Add `coverage/` and `.fallow/` to `.gitignore`.

- [ ] **Step 4: LOC guard**

`scripts/loc-baseline.json` (starts empty — no grandfathered hotspots):

```json
{
  "maxLoc": 500,
  "files": {}
}
```

`scripts/check-loc.mjs`:

```js
#!/usr/bin/env node
// LOC ratchet over src/**/*.{ts,vue}: new files above the cap fail; baselined
// hotspots may shrink but never grow; stale baseline entries fail (keeps the
// baseline minimal and honest). Ported from specorator's check-loc gate.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE_PATH = 'scripts/loc-baseline.json';
const update = process.argv.includes('--update');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|vue)$/.test(entry)) yield path;
  }
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const maxLoc = baseline.maxLoc;
const counts = new Map();
for (const file of walk('src')) {
  const loc = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  counts.set(file.replaceAll('\\', '/'), loc);
}

if (update) {
  const files = {};
  for (const [file, loc] of [...counts].sort()) {
    if (loc > maxLoc) files[file] = { loc, reason: baseline.files[file]?.reason ?? 'TODO: justify or split' };
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ maxLoc, files }, null, 2)}\n`);
  console.log(`loc baseline updated (${Object.keys(files).length} entries)`);
  process.exit(0);
}

const failures = [];
for (const [file, loc] of counts) {
  const entry = baseline.files[file];
  if (loc <= maxLoc) {
    if (entry) failures.push(`${file}: baseline entry is stale (now ${loc} <= ${maxLoc}) — remove it`);
  } else if (!entry) {
    failures.push(`${file}: ${loc} nonblank lines exceeds the ${maxLoc} cap — split it, or baseline it with a reason`);
  } else if (loc > entry.loc) {
    failures.push(`${file}: grew ${entry.loc} -> ${loc}; grandfathered files may only shrink`);
  }
}
for (const file of Object.keys(baseline.files)) {
  if (!counts.has(file)) failures.push(`${file}: baseline entry is stale (file deleted) — remove it`);
}

if (failures.length) {
  console.error(`LOC guard failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`LOC guard ok (${counts.size} files, cap ${maxLoc})`);
```

Run: `npm run check:loc`
Expected: `LOC guard ok` — if any file written in Tasks 1-17 exceeds 500 nonblank lines, **split it now** rather than baselining it; the empty baseline is the point.

- [ ] **Step 5: CSS !important guard**

`scripts/css-important-baseline.json`:

```json
{
  "files": {}
}
```

`scripts/check-css-important.mjs`:

```js
#!/usr/bin/env node
// !important ratchet over styles.css (comments excluded): any new use fails
// unless baselined with a reason; baselined files may shrink but never grow.
import { readFileSync, writeFileSync } from 'node:fs';

const BASELINE_PATH = 'scripts/css-important-baseline.json';
const FILES = ['styles.css'];
const update = process.argv.includes('--update');

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const counts = new Map();
for (const file of FILES) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  counts.set(file, (css.match(/!important/g) ?? []).length);
}

if (update) {
  const files = {};
  for (const [file, count] of counts) {
    if (count > 0) files[file] = { count, reason: baseline.files[file]?.reason ?? 'TODO: justify or re-scope' };
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(`css baseline updated (${Object.keys(files).length} entries)`);
  process.exit(0);
}

const failures = [];
for (const [file, count] of counts) {
  const allowed = baseline.files[file]?.count ?? 0;
  if (count > allowed) {
    failures.push(`${file}: ${count} !important (allowed ${allowed}) — re-scope by specificity or CSS variables`);
  } else if (baseline.files[file] && count < allowed) {
    failures.push(`${file}: baseline is stale (${allowed} -> ${count}) — re-lock with --update`);
  }
}

if (failures.length) {
  console.error(`CSS !important guard failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('CSS !important guard ok');
```

Run: `npm run check:css`
Expected: `CSS !important guard ok` (Task 17's stylesheet uses zero `!important`; keep it that way).

- [ ] **Step 6: fallow config and quality ratchet**

`.fallowrc.json` — declares the plan's layer architecture as machine-checked boundary zones (the spec's §2.1 one-way dependencies). Note the `engine` zone lists explicit subpaths so it does not swallow `engine-content`:

```json
{
  "boundaries": {
    "zones": [
      { "name": "shared", "patterns": ["src/shared/**"] },
      { "name": "engine-content", "patterns": ["src/engine/content/**"] },
      { "name": "engine", "patterns": ["src/engine/systems/**", "src/engine/*.ts"] },
      { "name": "app", "patterns": ["src/app/**"] },
      { "name": "obsidian-shell", "patterns": ["src/main.ts", "src/view/**"] }
    ],
    "rules": [
      { "from": "shared", "allow": [] },
      { "from": "engine-content", "allow": ["shared"] },
      { "from": "engine", "allow": ["shared", "engine-content"] },
      { "from": "app", "allow": ["shared", "engine", "engine-content"] },
      { "from": "obsidian-shell", "allow": ["shared", "engine", "engine-content", "app"] }
    ]
  }
}
```

`scripts/quality-baseline.json` (placeholder; locked from the real report in Step 9):

```json
{}
```

`scripts/check-quality.mjs`:

```js
#!/usr/bin/env node
// Fallow quality ratchet: counters may shrink but not grow; floors may rise but
// not drop; structural counters and criticalComplexity are pinned at 0 — bumping
// them is an architecture decision (ADR territory), not a metric trade-off.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE_PATH = 'scripts/quality-baseline.json';
const update = process.argv.includes('--update');

if (existsSync('coverage')) {
  console.error(
    'check:quality must run without a coverage/ directory: fallow switches to istanbul coverage and CRAP-based counts skew. Delete coverage/ and re-run.',
  );
  process.exit(1);
}

const raw = execFileSync('npx', ['fallow', '--format', 'json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const report = JSON.parse(raw);

const current = {
  deadCodeIssues: report.check.summary.total_issues,
  circularDependencies: report.check.summary.circular_dependencies,
  reExportCycles: report.check.summary.re_export_cycles,
  boundaryViolations: report.check.summary.boundary_violations,
  cloneGroups: report.dupes.stats.clone_groups,
  duplicatedLines: report.dupes.stats.duplicated_lines,
  complexFunctions: report.health.summary.functions_above_threshold,
  criticalComplexity: report.health.summary.severity_critical_count,
  maintainability: report.health.summary.average_maintainability,
};

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`quality baseline locked: ${JSON.stringify(current)}`);
  process.exit(0);
}

const PINNED_AT_ZERO = ['circularDependencies', 'reExportCycles', 'boundaryViolations', 'criticalComplexity'];
const SHRINK_ONLY = ['deadCodeIssues', 'cloneGroups', 'duplicatedLines', 'complexFunctions'];
const FLOORS = ['maintainability'];

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const failures = [];
const improvements = [];

for (const key of PINNED_AT_ZERO) {
  if (current[key] > 0) failures.push(`${key}: ${current[key]} (pinned at 0 — fix the finding, do not bump the baseline)`);
}
for (const key of SHRINK_ONLY) {
  if (current[key] > baseline[key]) failures.push(`${key}: ${baseline[key]} -> ${current[key]} (counters may not grow)`);
  else if (current[key] < baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}
for (const key of FLOORS) {
  if (current[key] < baseline[key]) failures.push(`${key}: ${baseline[key]} -> ${current[key]} (floors may not drop)`);
  else if (current[key] > baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}

if (failures.length) {
  console.error(`Quality ratchet failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
if (improvements.length) {
  console.log(
    `Unlocked improvements — lock them in with \`npm run check:quality -- --update\`:\n${improvements.map((f) => `  - ${f}`).join('\n')}`,
  );
}
console.log('quality ratchet ok');
```

Before locking the baseline, tune out false positives the way specorator did: run `npx fallow` and inspect findings. Expected tuning for this repo: exports consumed only by tests (e.g. `buildSaveFromWorld`, spawn helpers) may show as unused — configure fallow's entry/ignore options (`npx fallow config-schema` documents them) so `tests/**` counts as consumption, rather than deleting the exports or baselining noise. The target before lock-in: **`deadCodeIssues`, `cloneGroups`, and `criticalComplexity` all 0; structural counters 0; `complexFunctions` 0** — a greenfield repo has no excuse for debt at adoption. Genuine findings get fixed, not baselined.

- [ ] **Step 7: Artifact smoke**

`scripts/check-artifacts.mjs`:

```js
#!/usr/bin/env node
// Post-build gate (does not build): artifacts exist and are non-empty, versions
// are in sync, minAppVersion present, bundles within byte budgets. Bump a budget
// deliberately, with a reason in the PR, when a real dependency pushes it up.
import { readFileSync, statSync } from 'node:fs';

const DIR = 'demo-vault/.obsidian/plugins/obsisim';
const BUDGETS = { 'main.js': 1_500_000, 'styles.css': 50_000, 'manifest.json': 10_000 };
const failures = [];

for (const [name, budget] of Object.entries(BUDGETS)) {
  let size = null;
  try {
    size = statSync(`${DIR}/${name}`).size;
  } catch {
    failures.push(`${name} missing — run npm run build first`);
  }
  if (size === 0) failures.push(`${name} is empty`);
  else if (size !== null && size > budget) failures.push(`${name} is ${size} bytes, over its ${budget}-byte budget`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (pkg.version !== manifest.version) failures.push(`version desync: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
if (!manifest.minAppVersion) failures.push('manifest.json missing minAppVersion');

if (failures.length) {
  console.error(`Artifact smoke failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('artifact smoke ok');
```

Run: `npm run build && npm run check:artifacts`
Expected: `artifact smoke ok`.

- [ ] **Step 8: CI workflow**

`.github/workflows/ci.yml` — every job on the same Node major as `engines`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run check:loc
      - run: npm run check:css

  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run check:quality

  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test

  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run test:coverage

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run check:artifacts
```

- [ ] **Step 9: Lock baselines and write the gate catalogue doc**

Lock the ratchet baselines from the now-green state:

```bash
npm run check:quality -- --update   # all counters 0 per Step 6's target
npm run check:loc                    # confirms the empty baseline holds
npm run check:css                    # confirms zero !important holds
```

Write `docs/build-ci/quality-gates.md` — the catalogue for THIS repo, mirroring specorator's structure (a gates table with Gate / Command / CI job / What it catches rows for the eight gates above; the all-error lint severity policy; ratchet mechanics for LOC, CSS, and fallow with the update commands; the boundary-zone table from `.fallowrc.json`; the coverage/ gotcha; a "Next slices" section listing the deferred items: perf scaling guards once a hot path exists, a Windows test job, per-view coverage floors). Credit the origin: adapted from Luis85/specorator `docs/build-ci/quality-gates.md`, adopted greenfield with all baselines at zero.

- [ ] **Step 10: Full gate run and commit**

Run: `npm run check:all`
Expected: every gate green in one pass. Then run `npm run test:coverage` (last, so `coverage/` never coexists with a quality run) and confirm the thresholds hold.

```bash
git add -A
git commit -m "chore: quality gates and CI - lint policy, LOC/CSS/quality ratchets, coverage floors, artifact smoke"
```

---

## Execution Notes

- Tasks must run in order — later tasks import earlier tasks' exports.
- If sim-ecs 0.6.4's typings differ from the cheat-sheet (e.g. `ISystem` naming, `getEntities` location), check `node_modules/sim-ecs/dist/index.d.ts` FIRST and adapt the type import, never the runtime design.
- Never modify balance constants to make a test pass; fix the test fixture or the code.
- The determinism and round-trip tests (Task 12) are the increment's keystone — if they fail, stop and fix before building UI on top.
