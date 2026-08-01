# Increment 5 — Validated Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic instrument that measures colony balance, pin what it measures as regression tests, and price building relocation so the distance gradient it validates actually bites.

**Architecture:** A pure scenario runner in `tests/support/` boots headless colonies through `ALL_SYSTEMS` and returns metrics; one test file asserts the gradient and, under an env flag, prints the sweep. Alongside it, gross production gets plumbed through the snapshot (so "made" and "delivered" are separable), and a new `Relocation` component charges distance-scaled downtime when a building moves.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

## Global Constraints

- **Every component must be attached in `buildingComponents`/`workerComponents` in `src/engine/spawn.ts`** — the single shared list. Adding a component also means appending its type to `COMPONENT_TYPES` in `src/engine/world.ts` for save round-tripping.
- **No vitest test may import `src/app/world/renderer.ts` or `src/app/world/graphics-cache.ts`.** Excalibur throws on import outside a browser. Their only coverage is `npm run smoke:world`.
- **Mutation-test every test:** break the feature, confirm the named test fails, restore. Fixture values must *discriminate* — if the wrong field holds the same value, the assertion proves nothing.
- **Never `--update` a quality baseline to make a gate pass.** `check:quality --update` refuses a loosened value without `--allow-regression`, and refuses pinned-at-zero breaches outright.
- **Never pad comments to buy maintainability points.** Fallow's MI has no length term.
- **Commit by pathspec** (`git commit <path> -m …`), never `git add` + bare `git commit`. A new file needs one `git add` immediately before its commit.
- **Systems must be listed in `ALL_SYSTEMS` order** — `buildColonyPrepWorld` throws otherwise.
- `npm run check:all` must be green at the end of every task. Run `rm -rf coverage` first: `check:quality` hard-fails if `coverage/` exists.
- Balance constants live only in `src/engine/content/balance.ts`. Shared law takes rates as parameters (`src/shared/**` may import nothing outside itself).

---

### Task 1: Gross production ledger and the `deliveredRate` rename

**Files:**
- Modify: `src/engine/resources.ts` (add `ProductionLedger`; extend `StatsHistory`)
- Modify: `src/engine/systems/production-system.ts` (record made units)
- Modify: `src/engine/systems/stats-system.ts` (record + reset the ledger)
- Modify: `src/engine/world.ts:~470` (register the resource; rename in `buildInitialSnapshot`)
- Modify: `src/engine/systems/snapshot-system.ts:47-56`
- Modify: `src/shared/snapshot.ts` (`ResourceStats`)
- Test: `tests/engine/systems/stats-system.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `class ProductionLedger { readonly madeThisTick: Map<ResourceId, number>; add(id: ResourceId, amount: number): void; reset(): void }`
  - `StatsHistory.record(produced, consumed, made)`, `StatsHistory.rates(id): { delivered: number; consumed: number; made: number }`
  - `ResourceStats { stock; deliveredRate; madeRate; consumptionRate; netFlow; stockValue }` — `productionRate` is **gone**.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/systems/stats-system.test.ts`:

```ts
it('reports made and delivered as separate rates', async () => {
  // A forester with no haulers: it banks wood into its own buffer every batch
  // and nothing ever reaches the store. Under one combined "production" rate
  // these were indistinguishable, which is the schema half of OBS-4-06.
  const save = initialSave();
  save.workers = [];
  save.stockpile = {};
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const b = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4 });
  const bid = b.getComponent(Building)!.id;
  spawnWorker(prep, ids, { buildingId: bid });
  spawnWorker(prep, ids, { buildingId: bid });
  const world = await prep.prepareRun();

  for (let i = 0; i < 12; i++) {
    world.getResource(SimClock).tick++;
    await world.step();
  }
  const wood = world.getResource(SnapshotStore).latest!.stockpile.wood;
  expect(wood.madeRate).toBeGreaterThan(0);   // the crew is working
  expect(wood.deliveredRate).toBe(0);         // nobody carried any of it home
  expect(world.getResource(ProductionLedger).madeThisTick.size).toBe(0); // reset after recording
});
```

Add to that file's imports:

```ts
import { ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';
import { IdCounter, ProductionLedger, SimClock, SnapshotStore } from '../../../src/engine/resources';
import { Building } from '../../../src/engine/components';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/systems/stats-system.test.ts -t "made and delivered"`
Expected: FAIL — `ProductionLedger` is not exported from `src/engine/resources`.

- [ ] **Step 3: Add `ProductionLedger` and extend `StatsHistory`**

In `src/engine/resources.ts`, add after the `Stockpile` class:

```ts
/**
 * Units banked into output buffers this tick — gross production, as opposed to
 * the Stockpile's `producedThisTick`, which since increment 4 records only what
 * a hauler actually delivered. Kept apart from Stockpile because they are
 * genuinely different quantities: the gap between them IS the haul backlog.
 */
export class ProductionLedger {
  readonly madeThisTick = new Map<ResourceId, number>();

  add(id: ResourceId, amount: number): void {
    this.madeThisTick.set(id, (this.madeThisTick.get(id) ?? 0) + amount);
  }

  reset(): void {
    this.madeThisTick.clear();
  }
}
```

Replace `StatsFrame` and `StatsHistory` in the same file:

```ts
interface StatsFrame {
  produced: ReadonlyMap<ResourceId, number>;
  consumed: ReadonlyMap<ResourceId, number>;
  made: ReadonlyMap<ResourceId, number>;
}

export class StatsHistory {
  private readonly frames: StatsFrame[] = [];

  record(
    produced: ReadonlyMap<ResourceId, number>,
    consumed: ReadonlyMap<ResourceId, number>,
    made: ReadonlyMap<ResourceId, number>,
  ): void {
    this.frames.push({ produced: new Map(produced), consumed: new Map(consumed), made: new Map(made) });
    if (this.frames.length > BALANCE.statsWindowTicks) this.frames.shift();
  }

  /**
   * `delivered` is store inflow (what `produced` has meant since increment 4);
   * `made` is what buildings banked into their own buffers. Named for what they
   * measure — the old `production` described neither once haulers existed.
   */
  rates(id: ResourceId): { delivered: number; consumed: number; made: number } {
    if (this.frames.length === 0) return { delivered: 0, consumed: 0, made: 0 };
    let delivered = 0;
    let consumed = 0;
    let made = 0;
    for (const frame of this.frames) {
      delivered += frame.produced.get(id) ?? 0;
      consumed += frame.consumed.get(id) ?? 0;
      made += frame.made.get(id) ?? 0;
    }
    const n = this.frames.length;
    return { delivered: delivered / n, consumed: consumed / n, made: made / n };
  }
}
```

- [ ] **Step 4: Write to the ledger from `ProductionSystem`**

In `src/engine/systems/production-system.ts`:

Change the import line to add the resource:

```ts
import { ProductionLedger, Stockpile } from '../resources';
```

Change `completeBatches`'s signature and its `buffer.add` loop:

```ts
function completeBatches(
  production: Production, buffer: OutputBuffer, stockpile: Stockpile, recipe: RecipeDef, perBatch: number, ledger: ProductionLedger,
): void {
```

```ts
    for (const [id, amount] of Object.entries(recipe.outputs)) {
      buffer.add(id as ResourceId, amount);
      ledger.add(id as ResourceId, amount); // gross production, before any hauling
    }
```

Add the resource to the system definition and thread it through:

```ts
export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  ledger: WriteResource(ProductionLedger),
  buildings: queryComponents({
    building: Read(Building), production: Write(Production), buffer: Write(OutputBuffer),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, ledger, buildings, workers }) => {
```

and inside `advanceBatches`:

```ts
      completeBatches(production, buffer, stockpile, recipe, perBatch, ledger);
```

- [ ] **Step 5: Record and reset in `StatsSystem`**

Replace `src/engine/systems/stats-system.ts` entirely:

```ts
import { createSystem, WriteResource } from 'sim-ecs';
import { ProductionLedger, StatsHistory, Stockpile } from '../resources';

export const StatsSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  ledger: WriteResource(ProductionLedger),
  stats: WriteResource(StatsHistory),
})
  .withName('StatsSystem')
  .withRunFunction(({ stockpile, ledger, stats }) => {
    stats.record(stockpile.producedThisTick, stockpile.consumedThisTick, ledger.madeThisTick);
    stockpile.resetTickFlows();
    ledger.reset();
  })
  .build();
```

- [ ] **Step 6: Rename the schema field and publish `madeRate`**

In `src/shared/snapshot.ts`, replace `ResourceStats`:

```ts
export interface ResourceStats {
  stock: number;
  /**
   * Store inflow per tick. Since increment 4 goods reach the stockpile when a
   * hauler delivers them, not when they are made — the field is named for that
   * (it was `productionRate`, which described neither quantity once haulers
   * existed; see OBS-4-06).
   */
  deliveredRate: number;
  /** Units banked into output buffers per tick — gross production. */
  madeRate: number;
  consumptionRate: number;
  /** `deliveredRate - consumptionRate`: the STORE's net movement, which is what
   * a runway is computed from. Goods waiting in a buffer are not in the store. */
  netFlow: number;
  stockValue: number;
}
```

In `src/engine/systems/snapshot-system.ts`, replace the stockpile loop body:

```ts
    for (const id of RESOURCE_IDS) {
      const stock = stockpile.get(id);
      const { delivered, consumed, made } = stats.rates(id);
      const stockValue = stock * RESOURCES[id].value;
      colonyWealth += stockValue;
      stockpileStats[id] = {
        stock,
        deliveredRate: delivered,
        madeRate: made,
        consumptionRate: consumed,
        netFlow: delivered - consumed,
        stockValue,
      };
    }
```

In `src/engine/world.ts`, register the resource in `buildColonyPrepWorld`'s `instances` array (add `new ProductionLedger(),` after `new StatsHistory(),`), add it to the import from `./resources`, and update `buildInitialSnapshot`:

```ts
    stockpile[resourceId] = { stock, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
```

- [ ] **Step 7: Update the remaining call sites**

Rename `productionRate` → `deliveredRate` in these files (add `madeRate: 0` to every literal that constructs a `ResourceStats`):

- `src/app/views/EconomyView.vue` — `delivered: stats.deliveredRate.toFixed(2),`
- `src/app/views/DashboardView.vue` — `{{ fmt(store.snapshot.stockpile[id].deliveredRate) }}`
- `tests/app/fixtures.ts` (2 sites), `tests/app/economy-view.test.ts` (4), `tests/app/game-store.test.ts` (3), `tests/engine/integration.test.ts` (2), `tests/engine/systems/stats-system.test.ts` (1)

Run `npx tsc --noEmit -p .` or `npm run typecheck` and fix whatever it names — the compiler finds every site.

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — all tests green, including the new one.

- [ ] **Step 9: Mutation-test**

```bash
# The ledger must actually be written
sed -i 's|      ledger.add(id as ResourceId, amount); // gross production, before any hauling||' src/engine/systems/production-system.ts
npx vitest run tests/engine/systems/stats-system.test.ts -t "made and delivered"   # expect FAIL
git checkout src/engine/systems/production-system.ts

# The ledger must actually be reset
sed -i 's|    ledger.reset();||' src/engine/systems/stats-system.ts
npx vitest run tests/engine/systems/stats-system.test.ts -t "made and delivered"   # expect FAIL
git checkout src/engine/systems/stats-system.ts
```

Both must fail. If either passes, the assertion does not discriminate — fix it before continuing.

- [ ] **Step 10: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/engine/resources.ts src/engine/systems/production-system.ts src/engine/systems/stats-system.ts src/engine/systems/snapshot-system.ts src/engine/world.ts src/shared/snapshot.ts src/app/views/EconomyView.vue src/app/views/DashboardView.vue tests/ -m "feat(engine): track gross production separately from store inflow

ProductionLedger records units banked into output buffers; StatsHistory
carries a third series. ResourceStats.productionRate becomes deliveredRate
and gains madeRate — the old name described neither quantity once haulers
existed, which is the schema half of OBS-4-06."
```

---

### Task 2: The `Made/t` column

**Files:**
- Modify: `src/app/views/EconomyView.vue`
- Test: `tests/app/economy-view.test.ts`

**Interfaces:**
- Consumes: `ResourceStats.madeRate`, `ResourceStats.deliveredRate` (Task 1).
- Produces: `data-test="made-{buildingDefId}"` cells and a `data-test="made-heading"` header.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('EconomyView')` block in `tests/app/economy-view.test.ts`:

```ts
it('shows made and delivered side by side, so the gap reads as a backlog', async () => {
  const snapshot = makeSnapshot({
    buildings: [{ ...baseBuilding, id: 1, defId: 'forester', workers: 2, buffered: 12, state: 'producing' }],
  });
  // Deliberately distinct: 0.67 made, 0 delivered, 0.25 consumed, 4 stock — so
  // a column bound to the wrong field changes the assertion rather than
  // coinciding with it.
  snapshot.stockpile.wood = { stock: 4, deliveredRate: 0, madeRate: 0.67, consumptionRate: 0.25, netFlow: -0.25, stockValue: 0 };
  const wrapper = mountWith(EconomyView, snapshot);
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-test="made-heading"]').text()).toBe('Made/t');
  expect(wrapper.find('[data-test="made-forester"]').text()).toBe('0.67');
  expect(wrapper.find('[data-test="delivered-forester"]').text()).toBe('0.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/economy-view.test.ts -t "made and delivered side by side"`
Expected: FAIL — `[data-test="made-heading"]` not found.

- [ ] **Step 3: Add the column**

In `src/app/views/EconomyView.vue`, in the `chains` computed's returned row object, add beside `delivered`:

```ts
        // The gap between made and delivered is this stage's haul backlog —
        // the per-stage diagnostic the aggregate pressure line cannot give.
        made: stats.madeRate.toFixed(2),
```

In the template, add the header cell before `Delivered/t`:

```html
<th data-test="made-heading">Made/t</th>
```

and the body cell before the delivered cell:

```html
<td :data-test="`made-${row.building}`">{{ row.made }}</td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app/economy-view.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Mutation-test**

```bash
sed -i 's|made: stats.madeRate.toFixed(2),|made: stats.deliveredRate.toFixed(2),|' src/app/views/EconomyView.vue
npx vitest run tests/app/economy-view.test.ts -t "made and delivered side by side"   # expect FAIL
git checkout src/app/views/EconomyView.vue
```

- [ ] **Step 6: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/app/views/EconomyView.vue tests/app/economy-view.test.ts -m "feat(app): Made/t column beside Delivered/t

The gap between the two is the per-stage haul backlog, which the aggregate
haul-pressure line cannot give (OBS-4-06's larger option)."
```

---

### Task 3: The balance harness

**Files:**
- Create: `tests/support/balance-harness.ts`
- Test: `tests/support/balance-harness.test.ts`

**Interfaces:**
- Consumes: `ALL_SYSTEMS`, `buildColonyPrepWorld`, `spawnBuilding`, `spawnWorker`, `getPrepResource` (all from `src/engine/world`); `ResourceStats.madeRate` (Task 1).
- Produces:
  - `interface Scenario { defId: BuildingDefId; col: number; row: number; crew: number; haulers: number; ticks: number; resource: ResourceId }`
  - `interface BalanceResult { made: number; delivered: number; stalledTicks: number; haulerIdleTicks: number; finalBuffer: number; legTicks: number; ceiling: number }`
  - `async function runScenario(scenario: Scenario): Promise<BalanceResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/support/balance-harness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runScenario } from './balance-harness';

describe('balance harness', () => {
  it('is deterministic — the same scenario twice gives identical numbers', async () => {
    const scenario = { defId: 'forester' as const, col: 8, row: 4, crew: 2, haulers: 1, ticks: 60, resource: 'wood' as const };
    const a = await runScenario(scenario);
    const b = await runScenario(scenario);
    expect(a).toEqual(b);
  });

  it('separates what was made from what was delivered', async () => {
    // No haulers: the forester fills its buffer and stalls. Everything it makes
    // is real production; none of it reaches the store.
    const r = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 0, ticks: 120, resource: 'wood' });
    expect(r.made).toBeGreaterThan(0);
    expect(r.delivered).toBe(0);
    expect(r.finalBuffer).toBeGreaterThan(0);
    expect(r.stalledTicks).toBeGreaterThan(0);
  });

  it('reports the leg length and the unhauled production ceiling', async () => {
    // (8,4) is hypot(6,4) = 7.21 tiles from camp; at 2 tiles/tick that is 4.
    const r = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 1, ticks: 60, resource: 'wood' });
    expect(r.legTicks).toBe(4);
    // 2 workers = 2 work/tick, 3 ticks/batch, 1 wood per batch.
    expect(r.ceiling).toBeCloseTo(40, 5);
  });

  it('counts hauler idle ticks so over-provisioning is visible', async () => {
    // A building beside the camp cannot keep one hauler busy.
    const r = await runScenario({ defId: 'forester', col: 3, row: 0, crew: 2, haulers: 1, ticks: 120, resource: 'wood' });
    expect(r.haulerIdleTicks).toBeGreaterThan(0);
    expect(r.stalledTicks).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/support/balance-harness.test.ts`
Expected: FAIL — cannot resolve `./balance-harness`.

- [ ] **Step 3: Write the harness**

Create `tests/support/balance-harness.ts`:

```ts
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { SaveGameV3 } from '../../src/shared/save';
import { haulTicks } from '../../src/shared/haul';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS } from '../../src/engine/content/buildings';
import { Building } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import { ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../src/engine/world';

/**
 * A balance experiment, reproducible from this descriptor alone: one building
 * at one tile, a fixed crew and hauler count, run for a fixed number of ticks.
 *
 * The instrument exists because increment 4 documented three constants as
 * "starting points, tuned in increment 5" and nothing could check the claim —
 * the engine is headless and deterministic, but nothing ran it as an
 * experiment. See docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md.
 */
export interface Scenario {
  defId: BuildingDefId;
  col: number;
  row: number;
  crew: number;
  haulers: number;
  ticks: number;
  /** The output resource to measure. */
  resource: ResourceId;
}

export interface BalanceResult {
  /** Units banked into the building's buffer — gross production. */
  made: number;
  /** Units that reached the stockpile. */
  delivered: number;
  /** Ticks the building spent in `outputFull`. */
  stalledTicks: number;
  /** Hauler-ticks spent at the camp with no trip (over-provisioning). */
  haulerIdleTicks: number;
  /** Units still waiting at the building when the run ended. */
  finalBuffer: number;
  /** One-way trip length in ticks, for reference. */
  legTicks: number;
  /** Units the crew could produce with hauling never a constraint. */
  ceiling: number;
}

/**
 * Workers are fed from a large berry stock on purpose: this instrument
 * measures logistics, not starvation, and a crew that degrades mid-run would
 * confound every throughput number with hunger.
 */
const FED = 1_000_000;

export async function runScenario(scenario: Scenario): Promise<BalanceResult> {
  const { defId, col, row, crew, haulers, ticks, resource } = scenario;
  const save: SaveGameV3 = { ...initialSave(), workers: [], stockpile: { berries: FED }, nextEntityId: 1 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const entity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false, col, row });
  const buildingId = entity.getComponent(Building)!.id;
  for (let i = 0; i < crew; i++) spawnWorker(prep, ids, { buildingId });
  for (let i = 0; i < haulers; i++) spawnWorker(prep, ids, { hauling: true });
  const world = await prep.prepareRun();

  let stalledTicks = 0;
  let haulerIdleTicks = 0;
  const before = world.getResource(Stockpile).get(resource);

  for (let t = 0; t < ticks; t++) {
    world.getResource(SimClock).tick++;
    await world.step();
    const snapshot = world.getResource(SnapshotStore).latest!;
    const building = snapshot.buildings.find((b) => b.id === buildingId);
    if (building?.state === 'outputFull') stalledTicks++;
    haulerIdleTicks += snapshot.workers.filter((w) => w.hauling && w.haulPhase === 'idle').length;
  }

  const snapshot = world.getResource(SnapshotStore).latest!;
  const finalBuffer = snapshot.buildings.find((b) => b.id === buildingId)?.buffered ?? 0;
  const delivered = world.getResource(Stockpile).get(resource) - before;
  // Gross production, derived rather than sampled: madeRate is a rolling mean
  // over statsWindowTicks and would understate a short run. Everything made
  // either reached the store or is still in the buffer.
  const made = delivered + finalBuffer;

  const recipe = BUILDINGS[defId].recipe;
  const perBatch = Object.values(recipe.outputs).reduce((sum, n) => sum + n, 0);
  return {
    made,
    delivered,
    stalledTicks,
    haulerIdleTicks,
    finalBuffer,
    legTicks: haulTicks(col, row, BALANCE.haulTilesPerTick),
    ceiling: (ticks * crew * perBatch) / recipe.ticksPerBatch,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/support/balance-harness.test.ts`
Expected: PASS (4 tests).

If `ceiling` is off, check `perBatch` against `BUILDINGS.forester.recipe` (`outputs: { wood: 1 }`, `ticksPerBatch: 3`) — 2 crew × 60 ticks × 1 / 3 = 40.

- [ ] **Step 5: Mutation-test**

```bash
sed -i 's|  made = delivered + finalBuffer;|  made = delivered;|' tests/support/balance-harness.ts
npx vitest run tests/support/balance-harness.test.ts   # expect the made/delivered test to FAIL
git checkout tests/support/balance-harness.ts
```

- [ ] **Step 6: Commit**

```bash
git add tests/support/balance-harness.ts tests/support/balance-harness.test.ts
rm -rf coverage && npm run check:all
git commit tests/support/balance-harness.ts tests/support/balance-harness.test.ts -m "test(engine): deterministic balance harness

Runs a scenario headlessly through ALL_SYSTEMS and reports made, delivered,
stalled ticks, hauler idle ticks and final buffer. Increment 4 documented
three constants as starting points 'tuned in increment 5' and nothing could
check the claim; this is the instrument that can."
```

---

### Task 4: Pin the gradient, and the report script

**Files:**
- Create: `tests/engine/balance.test.ts`
- Modify: `package.json` (add `balance:report`)

**Interfaces:**
- Consumes: `runScenario`, `Scenario`, `BalanceResult` (Task 3).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the test**

Create `tests/engine/balance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/engine/content/balance';
import { runScenario } from '../support/balance-harness';

// The measured shape of increment 4's haul constants, pinned so a later change
// to outputBufferCap / haulCarryCapacity / haulTilesPerTick cannot quietly
// flatten it. Assertions are on the THRESHOLDS the gradient implies, never on
// exact unit counts: pinning `delivered === 394` would fail on any unrelated
// recipe change and would teach nobody anything.
//
// Increment 4 §4 claimed one hauler roughly sustains one FAR producer. It does
// not — a far producer needs three. The gradient is sound; the claim was wrong.

const TICKS = 600;
const forester = (col: number, row: number, haulers: number) =>
  runScenario({ defId: 'forester', col, row, crew: 2, haulers, ticks: TICKS, resource: 'wood' });

const share = (r: { delivered: number; ceiling: number }) => r.delivered / r.ceiling;

describe('haul balance gradient', () => {
  it('a building beside the camp is fully served by one hauler', async () => {
    const r = await forester(3, 0, 1);
    expect(r.legTicks).toBe(1);
    expect(share(r)).toBeGreaterThan(0.95);
    expect(r.stalledTicks).toBe(0);
  }, 60000);

  it('one hauler still keeps up at the crossover distance', async () => {
    const r = await forester(8, 4, 1);
    expect(r.legTicks).toBe(4);
    expect(share(r)).toBeGreaterThan(0.95);
  }, 60000);

  it('mid-distance needs a second hauler — one is not enough', async () => {
    const one = await forester(15, 8, 1);
    const two = await forester(15, 8, 2);
    expect(one.legTicks).toBe(8);
    expect(share(one)).toBeLessThan(0.7);   // one hauler visibly fails
    expect(one.stalledTicks).toBeGreaterThan(0);
    expect(share(two)).toBeGreaterThan(0.95); // two recovers it
  }, 120000);

  it('the far corner needs a third hauler', async () => {
    const two = await forester(23, 15, 2);
    const three = await forester(23, 15, 3);
    expect(two.legTicks).toBe(13);
    expect(share(two)).toBeLessThan(0.8);     // two is still short
    expect(share(three)).toBeGreaterThan(0.95);
  }, 120000);

  it('a full buffer is cleared by exactly two hauler trips', async () => {
    // outputBufferCap 12, haulCarryCapacity 6 — the claim increment 4 made for
    // these two constants together, stated as a ratio rather than as magnitudes.
    expect(BALANCE.outputBufferCap / BALANCE.haulCarryCapacity).toBe(2);
  });

  it('prints the sweep when BALANCE_REPORT is set', async () => {
    if (!process.env.BALANCE_REPORT) return;
    const lines = ['', 'tile        leg  haulers  delivered  %ceiling  stalled%  idle'];
    for (const [col, row] of [[3, 0], [8, 4], [15, 8], [23, 15]] as const) {
      for (const haulers of [1, 2, 3, 4]) {
        const r = await forester(col, row, haulers);
        lines.push(
          `(${String(col).padStart(2)},${String(row).padStart(2)})   ${String(r.legTicks).padStart(3)}  ` +
          `${String(haulers).padStart(7)}  ${String(r.delivered).padStart(9)}  ` +
          `${(share(r) * 100).toFixed(0).padStart(8)}  ${((r.stalledTicks / TICKS) * 100).toFixed(0).padStart(8)}  ${String(r.haulerIdleTicks).padStart(4)}`,
        );
      }
    }
    console.log(lines.join('\n'));
  }, 600000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/engine/balance.test.ts`
Expected: PASS (6 tests; the report case returns early).

If a threshold fails, do **not** loosen it to match — re-read §1.1 of the spec and confirm the measurement, because a genuine mismatch means the gradient moved.

- [ ] **Step 3: Add the report script**

In `package.json`, add to `scripts`:

```json
    "balance:report": "BALANCE_REPORT=1 vitest run tests/engine/balance.test.ts",
```

- [ ] **Step 4: Verify the report runs**

Run: `npm run balance:report`
Expected: the 16-row sweep table printed, all tests green.

- [ ] **Step 5: Mutation-test the pin**

```bash
sed -i 's|  haulTilesPerTick: 2,|  haulTilesPerTick: 8,|' src/engine/content/balance.ts
npx vitest run tests/engine/balance.test.ts   # expect FAILs — the gradient is gone
git checkout src/engine/content/balance.ts
npx vitest run tests/engine/balance.test.ts   # green again
```

- [ ] **Step 6: Commit**

```bash
git add tests/engine/balance.test.ts
rm -rf coverage && npm run check:all
git commit tests/engine/balance.test.ts package.json -m "test(engine): pin the haul distance gradient

One hauler serves to leg ~4, two are needed by leg 8, three by leg 13.
Thresholds, not unit counts, so an unrelated recipe change does not fail
them. npm run balance:report prints the full sweep."
```

---

### Task 5: Relocation downtime

**Files:**
- Modify: `src/shared/placement.ts` (add `relocationTicks`)
- Modify: `src/engine/content/balance.ts` (add `relocationTilesPerTick`, `maxRelocationTicks`)
- Modify: `src/engine/components.ts` (add `Relocation`)
- Modify: `src/engine/spawn.ts` (attach it; clamp)
- Modify: `src/engine/world.ts` (`COMPONENT_TYPES`)
- Modify: `src/engine/systems/command-system.ts` (query `Relocation`; add to `BuildingRow`)
- Modify: `src/engine/systems/command-handlers.ts` (`BuildingRow`, `handleMoveBuilding`)
- Modify: `src/engine/systems/production-system.ts` (skip + decrement)
- Test: `tests/shared/placement.test.ts`, `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: `buildingComponents` / `BuildingSpec` (`src/engine/spawn.ts`).
- Produces:
  - `relocationTicks(tilesMoved: number, tilesPerTick: number): number` in `src/shared/placement.ts`
  - `class Relocation { constructor(public ticksLeft = 0) {} }`
  - `BuildingSpec.relocatingTicks?: number`
  - `BuildingRow.relocation: Relocation`
  - `BALANCE.relocationTilesPerTick = 1`, `BALANCE.maxRelocationTicks = 30`

- [ ] **Step 1: Write the failing law test**

Append to `tests/shared/placement.test.ts`:

```ts
describe('relocationTicks', () => {
  it('scales with distance moved', () => {
    expect(relocationTicks(10, 1)).toBe(10);
    expect(relocationTicks(10, 2)).toBe(5);
  });

  it('rounds up, so a partial tile still costs a whole tick', () => {
    expect(relocationTicks(7.21, 2)).toBe(4);
  });

  it('never returns zero — even a one-tile nudge costs something', () => {
    expect(relocationTicks(1, 100)).toBe(1);
    expect(relocationTicks(0, 1)).toBe(1);
  });
});
```

Add `relocationTicks` to that file's import from `../../src/shared/placement`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/shared/placement.test.ts -t "relocationTicks"`
Expected: FAIL — `relocationTicks is not a function`.

- [ ] **Step 3: Add the law and the constants**

Append to `src/shared/placement.ts`:

```ts
/**
 * Ticks a building is out of action after being moved `tilesMoved` tiles.
 *
 * `tilesPerTick` arrives as an argument rather than an import, for the same
 * reason `haulTicks` takes one: this module lives in src/shared/, which may
 * import nothing outside itself, while the tunable rate belongs to BALANCE.
 *
 * Never zero. Relocation used to be free and instant, which let a player
 * cluster every building beside the camp and never feel increment 4's haul
 * pressure at all — the gradient existed but need never be paid. The floor
 * means even a one-tile nudge costs something, while distance-scaling keeps
 * iterating on a layout cheap.
 */
export function relocationTicks(tilesMoved: number, tilesPerTick: number): number {
  return Math.max(1, Math.ceil(tilesMoved / tilesPerTick));
}
```

In `src/engine/content/balance.ts`, add inside `BALANCE`:

```ts
  /** Building relocation speed — half the hauler rate, because carrying a
   * building is harder than carrying goods. */
  relocationTilesPerTick: 1,
  /** Clamp for a saved countdown (spec 4.5). The default 24x16 map's diagonal
   * is ~28 tiles, so 30 covers any move the current balance can produce. */
  maxRelocationTicks: 30,
```

- [ ] **Step 4: Run to verify the law test passes**

Run: `npx vitest run tests/shared/placement.test.ts -t "relocationTicks"`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing behaviour test**

Append inside `describe('CommandSystem')` in `tests/engine/systems/command-system.test.ts`:

**The shared `setup()` in this file builds `[CommandSystem, HaulSystem,
SnapshotSystem]` — no `ProductionSystem`, so downtime would never decrement and
nothing would ever be produced.** These two tests need their own world. Add this
helper beside `setup`:

```ts
// Relocation downtime is enforced by ProductionSystem, which the shared setup()
// deliberately omits. Order matches ALL_SYSTEMS (buildColonyPrepWorld throws
// otherwise).
async function setupWithProduction(save: SaveGameV3 = initialSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, ProductionSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  const tick = async () => {
    world.getResource(SimClock).tick++;
    await world.step();
  };
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = () => world.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}
```

Add `ProductionSystem` to the imports from `../../../src/engine/systems/production-system`.

```ts
it('a moved building stops producing for a distance-scaled downtime', async () => {
  const { tick, dispatch, snapshot } = await setupWithProduction();
  await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
  await tick();
  const buildingId = snapshot().buildings[0].id;
  await dispatch({ type: 'assignWorker', buildingId });
  await dispatch({ type: 'assignWorker', buildingId });
  for (let i = 0; i < 10; i++) await tick(); // it is genuinely producing
  const madeBefore = snapshot().buildings[0].buffered;
  expect(madeBefore).toBeGreaterThan(0);

  // (5,4) -> (15,4) is exactly 10 tiles; at 1 tile/tick that is 10 ticks.
  await dispatch({ type: 'moveBuilding', buildingId, to: { col: 15, row: 4 } });
  const paused = snapshot().buildings[0].buffered;
  for (let i = 0; i < 9; i++) await tick();
  expect(snapshot().buildings[0].buffered).toBe(paused); // nothing made while relocating

  for (let i = 0; i < 6; i++) await tick(); // downtime over, work resumes
  expect(snapshot().buildings[0].buffered).toBeGreaterThan(paused);
});

it('moving again replaces the remaining downtime rather than adding to it', async () => {
  const { world, dispatch, snapshot } = await setupWithProduction();
  await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
  await tick();
  const buildingId = snapshot().buildings[0].id;
  await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } }); // long move
  await dispatch({ type: 'moveBuilding', buildingId, to: { col: 21, row: 14 } }); // 1 tile: 1 tick
  const relocation = [...world.getEntities()]
    .find((e) => e.getComponent(Building)?.id === buildingId)!
    .getComponent(Relocation)!;
  expect(relocation.ticksLeft).toBeLessThanOrEqual(1);
});
```

```ts
it('haulers still collect from a relocating building', async () => {
  // Acceptance criterion 3. Goods already in the buffer exist whether or not
  // the crew is working, so only production pauses — a relocating building
  // with a full buffer must still drain.
  const { world, tick, dispatch, snapshot } = await setupWithProduction();
  await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
  await tick();
  const buildingId = snapshot().buildings[0].id;
  for (const entity of world.getEntities()) {
    if (entity.getComponent(Building)?.id === buildingId) {
      entity.getComponent(OutputBuffer)!.add('wood', BALANCE.haulCarryCapacity);
    }
  }
  await dispatch({ type: 'assignHauler' });
  // Move it far enough that the downtime outlasts the whole haul round trip.
  await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } });
  const relocating = [...world.getEntities()]
    .find((e) => e.getComponent(Building)?.id === buildingId)!
    .getComponent(Relocation)!;
  expect(relocating.ticksLeft).toBeGreaterThan(10); // genuinely out of action for the whole trip

  const before = world.getResource(Stockpile).get('wood');
  for (let i = 0; i < 40; i++) await tick();
  expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity);
  expect(snapshot().buildings[0].buffered).toBe(0); // the buffer genuinely drained
});
```

This asserts on the `Relocation` component rather than on
`BuildingSnapshot.state`, because the `'relocating'` state does not exist until
Task 6. Task 6 tightens it.

Add `Relocation` to that file's import from `../../../src/engine/components`.

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/engine/systems/command-system.test.ts -t "distance-scaled downtime"`
Expected: FAIL — `Relocation` is not exported.

- [ ] **Step 7: Add the component and attach it**

In `src/engine/components.ts`:

```ts
/**
 * Ticks a building is still out of action after being moved. Runtime state that
 * IS saved (unlike HaulTrip): it is a penalty already incurred, so leaving it
 * out of the save would let save-and-reload cancel it.
 */
export class Relocation {
  constructor(public ticksLeft = 0) {}
}
```

In `src/engine/spawn.ts`: add `Relocation` to the import from `./components`, add to `BuildingSpec`:

```ts
  relocatingTicks?: number;
```

add the clamp beside the others:

```ts
/** A saved relocation countdown, clamped to what current balance can produce. */
export function clampedRelocation(ticksLeft: number): number {
  return Math.max(0, Math.min(ticksLeft, BALANCE.maxRelocationTicks));
}
```

and add to `buildingComponents`'s returned array:

```ts
    new Relocation(clampedRelocation(spec.relocatingTicks ?? 0)),
```

In `src/engine/world.ts`, add `Relocation` to the `./components` import and append it to `COMPONENT_TYPES`.

- [ ] **Step 8: Thread it to the handler**

In `src/engine/systems/command-system.ts`: add `Relocation` to the `../components` import, add `relocation: Write(Relocation)` to the `buildings` query, and include it in the row mapping:

```ts
      buildings: [...buildings.iter()].map(({ entity, building, slots, position, buffer, relocation }) => ({ entity, building, slots, position, buffer, relocation })),
```

In `src/engine/systems/command-handlers.ts`: add `Relocation` to the `../components` import, add to `BuildingRow`:

```ts
  relocation: Relocation;
```

and in `handleMoveBuilding`, after the two position writes:

```ts
  // Distance-scaled downtime: relocation used to be free and instant, which let
  // a player cluster at the camp and never feel haul pressure. Replaces any
  // remaining downtime rather than adding to it — accumulating would let a
  // player trap a building by accident.
  found.relocation.ticksLeft = relocationTicks(
    Math.hypot(to.col - found.position.col, to.row - found.position.row),
    BALANCE.relocationTilesPerTick,
  );
```

**Read the distance BEFORE overwriting `found.position`** — compute it first:

```ts
  const moved = Math.hypot(to.col - found.position.col, to.row - found.position.row);
  found.position.col = to.col;
  found.position.row = to.row;
  found.relocation.ticksLeft = relocationTicks(moved, BALANCE.relocationTilesPerTick);
```

Add `relocationTicks` to the import from `../../shared/placement`.

- [ ] **Step 9: Make `ProductionSystem` respect it**

In `src/engine/systems/production-system.ts`: add `Relocation` to the `../components` import, add `relocation: Write(Relocation)` to the `buildings` query, and change the dispatch loop:

```ts
    for (const { building, production, buffer, relocation } of buildings.iter()) {
      // A relocating building is out of action: its crew are carrying it, not
      // working. Haulers still collect from its buffer — goods already made
      // exist regardless of whether the crew is working.
      if (relocation.ticksLeft > 0) {
        relocation.ticksLeft--;
        continue;
      }
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;
      advanceBatches(building, production, buffer, workPower);
    }
```

- [ ] **Step 10: Run to verify it passes**

Run: `npm run typecheck && npx vitest run tests/engine/systems/command-system.test.ts`
Expected: PASS.

- [ ] **Step 11: Mutation-test**

```bash
sed -i 's|      if (relocation.ticksLeft > 0) {|      if (false) {|' src/engine/systems/production-system.ts
npx vitest run tests/engine/systems/command-system.test.ts -t "distance-scaled downtime"  # expect FAIL
git checkout src/engine/systems/production-system.ts

sed -i 's|  found.relocation.ticksLeft = relocationTicks(moved, BALANCE.relocationTilesPerTick);||' src/engine/systems/command-handlers.ts
npx vitest run tests/engine/systems/command-system.test.ts -t "distance-scaled downtime"  # expect FAIL
git checkout src/engine/systems/command-handlers.ts
```

- [ ] **Step 12: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/shared/placement.ts src/engine/content/balance.ts src/engine/components.ts src/engine/spawn.ts src/engine/world.ts src/engine/systems/command-system.ts src/engine/systems/command-handlers.ts src/engine/systems/production-system.ts tests/shared/placement.test.ts tests/engine/systems/command-system.test.ts -m "feat(engine): moving a building costs distance-scaled downtime

Relocation was free and instant, so a player could cluster every building
beside the camp and never feel increment 4's haul pressure — the gradient
existed but need never be paid. Moving now stops production for
ceil(tiles / relocationTilesPerTick) ticks, minimum 1. Haulers still
collect from the buffer; only work pauses. Moving again replaces the
remaining downtime rather than accumulating it."
```

---

### Task 6: The `relocating` building state

**Files:**
- Modify: `src/shared/snapshot.ts` (`BuildingState`)
- Modify: `src/engine/snapshot-builder.ts` (`BuildingFacts`, `buildingFactsOf`, state selection)
- Modify: `src/engine/systems/snapshot-system.ts` (query `Relocation`)
- Modify: `src/engine/world.ts` (`gatherEntityFacts` / `buildInitialSnapshot`)
- Modify: `src/app/labels.ts`
- Test: `tests/engine/systems/snapshot-system.test.ts`

**Interfaces:**
- Consumes: `Relocation` (Task 5).
- Produces: `BuildingState` includes `'relocating'`; `BuildingSnapshot.relocatingTicks: number`; `BuildingFacts.relocatingTicks: number`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('SnapshotSystem')` in `tests/engine/systems/snapshot-system.test.ts`:

```ts
it('reports a relocating building as relocating, with its remaining ticks', async () => {
  const save = initialSave();
  save.workers = [];
  save.stockpile = {};
  const prep = buildColonyPrepWorld({ save, systems: [SnapshotSystem] });
  const ids = getPrepResource(prep, IdCounter);
  // Staffed AND relocating: 'relocating' must win, because it is the reason
  // nothing is happening — an unstaffed or output-full label would misdirect.
  const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 4, relocatingTicks: 7 });
  const buildingId = building.getComponent(Building)!.id;
  spawnWorker(prep, ids, { buildingId });
  const world = await prep.prepareRun();
  await world.step();

  const snap = world.getResource(SnapshotStore).latest!.buildings[0];
  expect(snap.state).toBe('relocating');
  expect(snap.relocatingTicks).toBe(7);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/engine/systems/snapshot-system.test.ts -t "relocating building"`
Expected: FAIL — `relocatingTicks` is not a `BuildingSpec` field / not on the snapshot.

- [ ] **Step 3: Extend the schema**

In `src/shared/snapshot.ts`:

```ts
export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed' | 'outputFull' | 'relocating';
```

and add to `BuildingSnapshot`:

```ts
  /** Ticks until a moved building can work again (0 when not relocating). */
  relocatingTicks: number;
```

- [ ] **Step 4: Publish it**

In `src/engine/snapshot-builder.ts`:

Add to `BuildingFacts`:

```ts
  relocatingTicks: number;
```

Change `buildingFactsOf`'s signature and body:

```ts
export function buildingFactsOf(
  building: Building, slots: WorkerSlots, production: Production, position: Position, buffer: OutputBuffer, relocation: Relocation,
): BuildingFacts {
  return {
    // ...existing fields unchanged...
    relocatingTicks: relocation.ticksLeft,
  };
}
```

(add `Relocation` to the `./components` import).

Change the state selection so relocating wins:

```ts
      const outputBlocked = BALANCE.outputBufferCap - b.buffered < batchOutputUnits(def.recipe);
      // Relocating first: it is the reason nothing is happening, and an
      // unstaffed/output-full label would send the player after the wrong fix.
      const state: BuildingState = b.relocatingTicks > 0
        ? 'relocating'
        : staffed === 0
          ? 'unstaffed'
          : outputBlocked ? 'outputFull' : b.batchActive ? 'producing' : 'waitingForInput';
```

and add to the returned `BuildingSnapshot` literal:

```ts
        relocatingTicks: b.relocatingTicks,
```

- [ ] **Step 5: Update both fact producers**

In `src/engine/systems/snapshot-system.ts`: add `Relocation` to the `../components` import, add `relocation: Read(Relocation)` to the `buildings` query, and pass it:

```ts
    for (const { building, slots, production, position, buffer, relocation } of buildings.iter()) {
      buildingFacts.push(buildingFactsOf(building, slots, production, position, buffer, relocation));
    }
```

In `src/engine/world.ts`'s `buildInitialSnapshot`, add to the `buildingFacts` literal:

```ts
      relocatingTicks: clampedRelocation(saved.relocatingTicks ?? 0),
```

(import `clampedRelocation` from `./spawn`).

So this compiles without a cast, add the field to `SavedBuilding` in
`src/shared/save.ts` **as optional** in this task:

```ts
  /** Ticks still out of action after a move. Optional here; save v4 (Task 7)
   * makes it required and migrates existing records. */
  relocatingTicks?: number;
```

Task 7 promotes it to required on `SaveGameV4`'s record. Nothing else about the
save format changes in this task — no version bump, no migration, no guard.

Also update `gatherEntityFacts` in `src/engine/snapshot-builder.ts` — find its `buildingFactsOf(...)` call and add the `Relocation` component read the same way.

In `src/app/labels.ts`:

```ts
  relocating: 'Relocating',
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Mutation-test**

```bash
sed -i "s|      const state: BuildingState = b.relocatingTicks > 0|      const state: BuildingState = false|" src/engine/snapshot-builder.ts
npx vitest run tests/engine/systems/snapshot-system.test.ts -t "relocating building"  # expect FAIL
git checkout src/engine/snapshot-builder.ts
```

- [ ] **Step 8: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/shared/snapshot.ts src/engine/snapshot-builder.ts src/engine/systems/snapshot-system.ts src/engine/world.ts src/app/labels.ts tests/engine/systems/snapshot-system.test.ts -m "feat(engine): relocating building state and countdown

Takes priority over unstaffed and outputFull: it is the reason nothing is
happening, and either other label would send the player after the wrong fix."
```

---

### Task 7: Save v4

**Files:**
- Modify: `src/shared/save.ts` (`SaveGameV4`, `SavedBuilding`, guard, `LATEST_SAVE_VERSION`)
- Modify: `src/shared/save-migration.ts` (v3→v4)
- Modify: `src/engine/snapshot-builder.ts` (`savedBuildingOf`)
- Modify: `src/engine/world.ts` (`isLoadableSave`; `SaveGameV3` -> `SaveGameV4`)
- Test: `tests/shared/save-migration.test.ts`, `tests/engine/world.test.ts`

**Interfaces:**
- Consumes: `BuildingFacts.relocatingTicks` (Task 6), `clampedRelocation` (Task 5).
- Produces: `SaveGameV4`, `isSaveGameV4`, `SavedBuilding.relocatingTicks: number`, `LATEST_SAVE_VERSION = 4`.

- [ ] **Step 1: Write the failing migration test**

Append to `tests/shared/save-migration.test.ts`:

```ts
it('v3 -> v4 gives every building a zero relocation countdown', () => {
  const v3 = {
    version: 3, tick: 5, lastRecruitTick: 0, stockpile: { wood: 10 },
    map: { cols: 24, rows: 16 }, nextEntityId: 3,
    buildings: [{ id: 1, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: { wood: 2 } }],
    workers: [{ id: 2, hunger: 0, buildingId: null, toolTicks: 0, hauling: false }],
  };
  const migrated = migrateSaveToLatest(v3) as SaveGameV4;
  expect(migrated.version).toBe(4);
  expect(migrated.buildings[0].relocatingTicks).toBe(0);
  expect(migrated.buildings[0].buffer).toEqual({ wood: 2 }); // everything else survives
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/shared/save-migration.test.ts -t "v3 -> v4"`
Expected: FAIL — migrates to 3, not 4.

- [ ] **Step 3: Add the format**

In `src/shared/save.ts`:

```ts
export const LATEST_SAVE_VERSION = 4;
```

Rename the current `SavedBuilding` to `SavedBuildingV3` (keep it as the frozen
legacy shape — and drop the optional `relocatingTicks?` Task 6 added to it), and add:

```ts
/** The current building record: v3 plus the relocation countdown (save v4). */
export interface SavedBuilding extends SavedBuildingV3 {
  /** Ticks the building is still out of action after a move; 0 normally. */
  relocatingTicks: number;
}

export interface SaveGameV4 {
  version: 4;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  map: WorldMapSize;
  buildings: SavedBuilding[];
  workers: SavedWorker[];
  nextEntityId: number;
}
```

Change `SaveGameV3.buildings` to `SavedBuildingV3[]`, and add the guard:

```ts
export function isSaveGameV4(data: unknown): data is SaveGameV4 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 4 &&
    isCommonSaveShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every(
      (b) => hasSavedPosition(b) && isBufferShape((b as SavedBuilding).buffer)
        && Number.isFinite((b as SavedBuilding).relocatingTicks),
    ) &&
    (save.workers as unknown[]).every((w) => typeof (w as SavedWorker).hauling === 'boolean')
  );
}
```

- [ ] **Step 4: Add the migration**

In `src/shared/save-migration.ts`:

```ts
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
```

Register it: `const SAVE_MIGRATIONS: readonly MigrationStep[] = [migrateV1toV2, migrateV2toV3, migrateV3toV4];`
and add to `SAVE_GUARDS`: `4: isSaveGameV4`. Update the imports.

- [ ] **Step 5: Persist and restore the field**

In `src/engine/snapshot-builder.ts`:

```ts
export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return {
    id: facts.id, defId: facts.defId, col: facts.col, row: facts.row,
    progress: facts.progress, batchActive: facts.batchActive, buffer: facts.buffer,
    relocatingTicks: facts.relocatingTicks,
  };
}
```

In `src/engine/world.ts`: change every `SaveGameV3` type reference to `SaveGameV4`, change `isSaveGameV3` to `isSaveGameV4` in `isLoadableSave`, and add the structural check to `isLoadableSave`'s building walk:

```ts
    // Structural/identity, not balance: a negative or fractional countdown is a
    // record no version of the engine could write. Magnitude is CLAMPED at
    // spawn instead (clampedRelocation), so a save written under a slower
    // relocationTilesPerTick still loads.
    if (!Number.isSafeInteger(b.relocatingTicks) || b.relocatingTicks < 0) return false;
```

`spawnBuilding` already forwards `relocatingTicks` because it spreads `saved` into `buildingComponents`.

- [ ] **Step 6: Write the round-trip test**

Append to `tests/engine/world.test.ts`:

```ts
it('a building mid-relocation survives save -> restore with its countdown', async () => {
  const save = initialSave();
  save.buildings.push({ id: 4, defId: 'forester', progress: 0, batchActive: false, col: 6, row: 3, buffer: {}, relocatingTicks: 9 });
  save.nextEntityId = 5;
  const world = await createColonyWorld(save);
  const written = buildSaveFromWorld(world);
  expect(written.buildings[0].relocatingTicks).toBe(9);
  expect(isLoadableSave(written)).toBe(true);
});
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. Fix whatever the compiler names — the v3→v4 split touches every `SaveGameV3` annotation, including `tests/support/balance-harness.ts` (change its `SaveGameV3` import to `SaveGameV4`).

- [ ] **Step 8: Mutation-test**

```bash
sed -i 's|      buildings: v3.buildings.map((b) => ({ ...b, relocatingTicks: 0 })),|      buildings: v3.buildings,|' src/shared/save-migration.ts
npx vitest run tests/shared/save-migration.test.ts -t "v3 -> v4"   # expect FAIL
git checkout src/shared/save-migration.ts

sed -i 's|    relocatingTicks: facts.relocatingTicks,||' src/engine/snapshot-builder.ts
npx vitest run tests/engine/world.test.ts -t "mid-relocation"      # expect FAIL
git checkout src/engine/snapshot-builder.ts
```

- [ ] **Step 9: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/shared/save.ts src/shared/save-migration.ts src/engine/snapshot-builder.ts src/engine/world.ts tests/ -m "feat(save): v4 carries the relocation countdown

Saved rather than runtime-only, unlike HaulTrip: a mid-trip hauler banks
its load into the saved stockpile so reloading gains nothing, but
relocation downtime is a penalty already incurred and leaving it out would
let save-and-reload cancel it. Magnitude is clamped at spawn, so a save
written under a slower rate still loads."
```

---

### Task 8: Relocation in the UI

**Files:**
- Modify: `src/app/world/theme.ts` (`stateRing.relocating`)
- Modify: `src/app/components/WorldLegend.vue`
- Modify: `src/app/components/SelectionPanel.vue`
- Modify: `src/app/views/BuildingsView.vue`
- Test: `tests/app/world-theme.test.ts`, `tests/app/selection-panel.test.ts`, `tests/app/buildings-view.test.ts`

**Interfaces:**
- Consumes: `BuildingSnapshot.state === 'relocating'`, `BuildingSnapshot.relocatingTicks` (Task 6).
- Produces: `data-test="selection-relocating"`.

- [ ] **Step 1: Write the failing tests**

In `tests/app/world-theme.test.ts`, extend whichever test enumerates `stateRing` keys so `relocating` is required, or add:

```ts
it('gives the relocating state its own ring colour', () => {
  const theme = readWorldTheme(() => '');
  expect(theme.stateRing.relocating).toMatch(/^#/);
  expect(theme.stateRing.relocating).not.toBe(theme.stateRing.outputFull);
  expect(theme.stateRing.relocating).not.toBe(theme.stateRing.unstaffed);
});
```

In `tests/app/selection-panel.test.ts`:

```ts
// mountPanel's signature is (buildingId = 7, overrides = {}) — it always builds
// building id 7 and merges the overrides, so pass the id explicitly.
it('shows the remaining downtime for a relocating building', async () => {
  const wrapper = mountPanel(7, { state: 'relocating', relocatingTicks: 6 });
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-test="selection-relocating"]').text()).toContain('6');
  expect(wrapper.text()).toContain('Relocating');
});

it('shows no downtime line for a settled building', async () => {
  const wrapper = mountPanel(7, { state: 'producing', relocatingTicks: 0 });
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-test="selection-relocating"]').exists()).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/world-theme.test.ts tests/app/selection-panel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the theme colour**

In `src/app/world/theme.ts`, inside `stateRing`:

```ts
      // Cyan-adjacent, matching the carried-load hue: both say "in transit".
      relocating: pick(read, '--color-cyan', '#4bbfd4'),
```

- [ ] **Step 4: Add the legend entry**

In `src/app/components/WorldLegend.vue`, beside the output-full chip:

```html
      <span><i class="obsisim-chip" :style="{ borderColor: theme.stateRing.relocating }" /> relocating</span>
```

- [ ] **Step 5: Add the panel line**

In `src/app/components/SelectionPanel.vue`, after the waiting line:

```html
    <span v-if="building.relocatingTicks > 0" data-test="selection-relocating">Relocating: {{ building.relocatingTicks }}t left</span>
```

- [ ] **Step 6: Add the table column**

In `src/app/views/BuildingsView.vue`, add a header cell `<th>Downtime</th>` beside the `Waiting` column and the matching body cell:

```html
          <td :data-test="`downtime-${b.id}`">{{ b.relocatingTicks > 0 ? `${b.relocatingTicks}t` : '—' }}</td>
```

Add to `tests/app/buildings-view.test.ts` (the `Waiting` column sits at
`data-test="waiting-{id}"`, so this follows the same shape):

`mountView`'s signature is `(stock = {}, state = 'producing', building = {})`
and it always builds a single forester with **id 7** — so target `downtime-7`,
not `downtime-1`:

```ts
it('shows remaining downtime for a relocating building', async () => {
  const wrapper = mountView({}, 'relocating', { relocatingTicks: 6 });
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('6t');
});

it('shows an em dash when a building is not relocating', async () => {
  const wrapper = mountView({}, 'producing', { relocatingTicks: 0 });
  await wrapper.vm.$nextTick();
  expect(wrapper.find('[data-test="downtime-7"]').text()).toBe('—');
});
```

- [ ] **Step 7: Run to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 8: Mutation-test**

```bash
sed -i 's|v-if="building.relocatingTicks > 0" data-test="selection-relocating"|v-if="false" data-test="selection-relocating"|' src/app/components/SelectionPanel.vue
npx vitest run tests/app/selection-panel.test.ts   # expect FAIL
git checkout src/app/components/SelectionPanel.vue
```

- [ ] **Step 9: Commit**

```bash
rm -rf coverage && npm run check:all
git commit src/app/world/theme.ts src/app/components/WorldLegend.vue src/app/components/SelectionPanel.vue src/app/views/BuildingsView.vue tests/ -m "feat(app): surface relocation downtime

A stall the player cannot see the reason for is the defect class OBS-4-06
was about. Ring colour, legend entry, selection-panel countdown and a
Buildings table column."
```

---

### Task 9: Smoke phase for a relocating building

**Files:**
- Modify: `scripts/world-smoke-harness/main.ts`
- Modify: `scripts/world-smoke.mjs`

**Interfaces:**
- Consumes: `BuildingSnapshot.state`, `relocatingTicks` (Task 6); the theme ring (Task 8).
- Produces: nothing.

- [ ] **Step 1: Add `relocatingTicks` to the harness fixture**

In `scripts/world-smoke-harness/main.ts`, add to `building()`'s defaults:

```ts
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0, relocatingTicks: 0,
```

- [ ] **Step 2: Add a single-change phase**

Insert a phase immediately after the four haul phases (so it becomes index 10, and every later `step(n)` in the runner shifts by one):

```ts
  // ONE change from the previous phase: building 1 flips to relocating. Its
  // ring colour must differ, and nothing else in the scene moves.
  () => renderer.sync(haulScene(9, { hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 1, carrying: 6 }, { state: 'relocating', relocatingTicks: 6 })),
```

This requires `haulScene` to take a third parameter — building-1 overrides:

```ts
const haulScene = (tick: number, hauler: Partial<WorkerSnapshot>, forester: Partial<BuildingSnapshot> = {}) => snap(tick,
  [building(1, 'forester', 4, 1, { buffered: 12, state: 'outputFull', ...forester }), building(2, 'farm', 6, 1)],
  [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { toolTicks: 100, ...hauler })]);
```

- [ ] **Step 3: Add the check and shift the later indices**

In `scripts/world-smoke.mjs`, after the load-marker check:

```js
await step(10); // ONLY change: building 1 becomes relocating
await wait(400);
const relocating = await shot();
check('a relocating building is drawn differently (only its state differs)', !relocating.equals(carrying));
```

Then increment every subsequent `step(n)` by 1 (`10→11`, `11→12`, `12→13`, `13→14`, `14→15`, `15→16`).

- [ ] **Step 4: Run the smoke suite**

Run: `npm run smoke:world`
Expected: `world-smoke: all green`, 19 checks.

- [ ] **Step 5: Mutation-test**

```bash
# Remove the relocating ring colour distinction
sed -i "s|      relocating: pick(read, '--color-cyan', '#4bbfd4'),|      relocating: pick(read, '--color-purple', '#8f6fbf'),|" src/app/world/theme.ts
npm run smoke:world    # expect the relocating check to FAIL (same colour as outputFull)
git checkout src/app/world/theme.ts
npm run smoke:world    # all green again
```

- [ ] **Step 6: Commit**

```bash
git commit scripts/world-smoke-harness/main.ts scripts/world-smoke.mjs -m "test(world): smoke phase for a relocating building

One change from the previous phase, per the fixture rule in
docs/process/agent-workflow.md."
```

---

### Task 10: Measure `relocationTilesPerTick` and close out the spec

**Files:**
- Modify: `tests/support/balance-harness.ts` (add `relocatingTicks`, optional mid-run move)
- Modify: `tests/engine/balance.test.ts` (report the relocation cost)
- Modify: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` (§4)
- Modify: `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` (§4 correction)

**Interfaces:**
- Consumes: `runScenario`, `Scenario` (Task 3); `relocationTicks` (Task 5).
- Produces: `Scenario.moveTo?: { col: number; row: number; atTick: number }`; `BalanceResult.relocatingTicks: number`.

- [ ] **Step 1: Extend the harness**

Add to `Scenario`:

```ts
  /** Optionally relocate the building mid-run, to measure what downtime costs. */
  moveTo?: { col: number; row: number; atTick: number };
```

Add to `BalanceResult`:

```ts
  /** Ticks the building spent out of action after a move. */
  relocatingTicks: number;
```

In the tick loop, count it and perform the move. The harness runs `ALL_SYSTEMS`, which includes `CommandSystem`, so enqueue a real command rather than mutating components — import `enqueue` from `../engine/fixtures`:

```ts
    if (scenario.moveTo && t === scenario.moveTo.atTick) {
      enqueue(world, { type: 'moveBuilding', buildingId, to: { col: scenario.moveTo.col, row: scenario.moveTo.row } });
    }
```

and inside the loop after stepping:

```ts
    if (building?.state === 'relocating') relocatingTicks++;
```

- [ ] **Step 2: Write the measurement test**

Append to `tests/engine/balance.test.ts`:

```ts
it('a far-corner relocation costs a measurable share of a run', async () => {
  const settled = await runScenario({ defId: 'forester', col: 8, row: 4, crew: 2, haulers: 2, ticks: 200, resource: 'wood' });
  const moved = await runScenario({
    defId: 'forester', col: 8, row: 4, crew: 2, haulers: 2, ticks: 200, resource: 'wood',
    moveTo: { col: 23, row: 15, atTick: 50 },
  });
  // The move is ~19 tiles; at 1 tile/tick that is ~19 ticks of lost work, plus
  // the far corner then needing more haulers than the two provided.
  expect(moved.relocatingTicks).toBeGreaterThan(15);
  expect(moved.relocatingTicks).toBeLessThan(25);
  expect(moved.made).toBeLessThan(settled.made); // relocation genuinely costs output
}, 120000);
```

- [ ] **Step 3: Run it and record the number**

Run: `npx vitest run tests/engine/balance.test.ts -t "far-corner relocation"`
Expected: PASS. Note the actual `relocatingTicks` and the `made` delta — they go into the spec in the next step.

- [ ] **Step 4: Rewrite the spec's §4 row**

In `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md`, replace the `relocationTilesPerTick` row with the measured cost, e.g.:

```markdown
| `relocationTilesPerTick` | 1 | **Measured.** A far-corner relocation (~19 tiles) costs ~19 ticks out of action and <N> units of output against a settled control — roughly <N> full output buffers. Enough that clustering is a decision, not a reflex. |
```

Fill `<N>` from Step 3's actual numbers. Do not leave a placeholder.

- [ ] **Step 5: Correct increment 4's spec**

In `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` §4, replace the `haulTilesPerTick` reasoning cell:

```markdown
| `haulTilesPerTick` | 2 | A building beside the camp is a 1-tick walk; the far corner is ~13. **Corrected in increment 5:** this row previously claimed "one hauler roughly sustains one far producer". Measured, a far producer needs THREE — one hauler serves to leg ~4, two to leg 8, three at leg 13. The gradient is sound; the claim was not. See `tests/engine/balance.test.ts`. |
```

- [ ] **Step 6: Commit**

```bash
rm -rf coverage && npm run check:all
git commit tests/support/balance-harness.ts tests/engine/balance.test.ts docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md docs/superpowers/specs/2026-07-31-increment-4-logistics.md -m "test(engine): measure relocation downtime, correct increment 4's spec

relocationTilesPerTick was the one constant this increment shipped without
measuring; the harness now reports what a far-corner move costs and §4
records it. Increment 4 §4's one-hauler-per-far-producer claim is replaced
with the measured curve."
```

---

### Task 11: Demolition refund, README, and final gates

**Files:**
- Modify: `README.md`
- Test: `tests/engine/systems/command-system.test.ts`
- Modify: `docs/build-ci/quality-gates.md` if a baseline moved

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Pin the demolition refund**

Append inside `describe('CommandSystem')` in `tests/engine/systems/command-system.test.ts`:

```ts
it('demolition still refunds 100% of construction cost', async () => {
  // A decision, not an accident: increment 5 considered cutting the refund as a
  // balance knob and rejected it, because free relocation dominated it. Now
  // that moving costs downtime the two acts are cleanly separated — moving
  // costs time, removing is fully refunded. Pinned so the decision lives in
  // code, not only in prose.
  const { world, tick, dispatch, snapshot } = await setup();
  const before = world.getResource(Stockpile).get('wood');
  await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
  await tick();
  expect(world.getResource(Stockpile).get('wood')).toBe(before - 10); // forester costs 10 wood
  await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
  expect(world.getResource(Stockpile).get('wood')).toBe(before);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/engine/systems/command-system.test.ts -t "refunds 100%"`
Expected: PASS.

- [ ] **Step 3: Update the README**

Add an `## Increment 5 — Validated Balance` section after increment 4's, covering: the balance harness and `npm run balance:report`; the measured gradient (1 hauler to leg ~4, 2 by leg 8, 3 by leg 13) and the correction to increment 4's claim; relocation downtime; `Made/t` beside `Delivered/t`; save v4. Add the spec and plan to the document list at the bottom.

- [ ] **Step 4: Full gates**

```bash
rm -rf coverage
npm run check:all
npm run smoke:world
npm run test:coverage
rm -rf coverage
```

Expected: `check:all` green; `world-smoke: all green` (19 checks); coverage floors met for `src/engine/**`, `src/shared/**`, `src/app/stores/**`.

If `worstSrcFileMaintainability` improved, lock it in with `npm run check:quality -- --update` and note the move in `docs/build-ci/quality-gates.md`. **If it dropped, do not `--update`** — find the file the gate names and improve it, or explain the drop in the PR.

- [ ] **Step 5: Commit and push**

```bash
git commit README.md tests/engine/systems/command-system.test.ts -m "docs: increment 5 in the README, pin the demolition refund"
git push -u origin claude/excalibur-game-engine-r4qy0v
```

---

## Notes for the implementer

- **Push back rather than guess.** Roughly half of increment 4's task briefs contained an error — a helper that did not exist, a wrong expected value, a parameter that would have corrupted eight call sites. Implementers caught them only because they were told to. If a brief here disagrees with the code, the code wins: say so.
- **The `SaveGameV3` → `SaveGameV4` rename in Task 7 has the widest blast radius.** Let `npm run typecheck` enumerate the sites; do not hunt them by hand.
- **Task 6 adds `relocatingTicks?` to `SavedBuilding` as OPTIONAL**; Task 7 promotes it to required on the v4 record and drops it from the frozen `SavedBuildingV3`. Neither task needs a cast.
- **Timeouts:** balance scenarios run hundreds of ticks through the full system set. The explicit `60000`/`120000` timeouts in Tasks 4 and 10 are required — vitest's 5s default will fail them.
