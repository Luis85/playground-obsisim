# Increment 4 — Logistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Goods stop teleporting — production output lands in a per-building buffer and must be hauled to the camp store by assigned haulers before the colony can spend it, so layout finally costs something.

**Architecture:** One pure shared module (`src/shared/haul.ts`) owns the spatial law of hauling — camp tile, distance, trip length, and job ordering — for the two consumers that must never disagree: the engine's `HaulSystem` (authoritative) and any UI that previews haul pressure. Buildings gain an `OutputBuffer` component that `ProductionSystem` fills instead of the stockpile; a full buffer stalls the building in a new `outputFull` state. Workers gain a `hauling` flag and a runtime-only `HaulTrip`; `HaulSystem` walks them out, loads, walks them back, and deposits into the `Stockpile` — which keeps its class and its role as the single ledger, now understood as the contents of the camp store.

**Tech Stack:** sim-ecs 0.6.4, excalibur 0.32.0, Vue 3 + Pinia, vitest + happy-dom — all existing, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-31-increment-4-logistics.md`

## Global Constraints

- **No new dependencies.** Artifact byte budgets unchanged (`scripts/check-artifacts.mjs` untouched).
- **Boundary zones hold:** `src/shared/**` imports nothing outside `src/shared/` (`haul.ts` imports only a type from `./placement`); the app never imports `sim-ecs`; the engine/shared never import `vue`/`excalibur`/`obsidian`; excalibur is imported only by `src/app/world/renderer.ts` and the smoke harness, and **no test may import excalibur**. `eslint.config.js` is untouched this increment.
- **Notice doctrine:** exactly one notice per drained command, success or rejection, emitted *after* the state change it describes. Every wording is pinned by a test. New wordings this increment: `Assigned a hauler.`, `Unassigned a hauler.`, `No hauler to unassign.`; `No idle workers available.` is reused verbatim.
- **Haul constants:** `outputBufferCap = 12`, `haulCarryCapacity = 6`, `haulTilesPerTick = 2`, `CAMP_TILE = { col: 2, row: 0 }`. The camp tile is the sim counterpart of the layout's tent anchor at tile-space `(2, 0.75)`.
- **Determinism:** job selection is a pure function of world state — fullest claimable first, then nearest the camp, then lowest building id. No randomness, no iteration-order dependence, no state carried between ticks outside components.
- **Every new component has two spawn sites, not one.** Entities are created both by `src/engine/world.ts` (`spawnBuilding`/`spawnWorker`, the save-restore path) and by `src/engine/systems/command-handlers.ts` (`handleConstructBuilding`/`handleRecruitWorker`, the live-play path). A component added to only one of them produces entities that are invisible to any query requiring it — which surfaces as unrelated-looking test failures, not as a clear error. This bit twice in this increment: `OutputBuffer` (Task 2) and `HaulTrip` (Task 4). Check both sites whenever you add a component.
- **Buffered goods are not wealth:** `colonyWealth`, stock readings, and every economic number stay stockpile-only. A buffer holds goods that have not arrived yet.
- **Gates:** every commit keeps `npm run lint`, `npm run typecheck`, `npm test` green. `npm run check:quality` reaches full green when the consumption chain closes (new exports gain consumers within 1–2 tasks); full `npm run check:all` + `npm run test:coverage` must pass at Task 15 (CI gates the PR head, not each commit). Every file stays < 500 nonblank lines (`check:loc`), no new `!important` (`check:css`), fallow pinned-at-zero counters stay 0 (`complexFunctions`, `criticalComplexity`, `boundaryViolations`, cycles), maintainability floor 90.7 holds.
- **UI conventions:** `data-test` attributes on interactive/asserted elements; Obsidian CSS variables in `styles.css`; `// @vitest-environment happy-dom` pragma on component tests; render-function/mount harnesses (no template compiler in vitest).
- **Coverage floors** (unchanged): `src/engine/**`, `src/shared/**`, `src/app/stores/**` at 90/85/90/90. Run `npm run test:coverage` only as a separate final step and delete `coverage/` before any later `check:quality` (see `docs/build-ci/quality-gates.md`, "The coverage/ gotcha").

## File Structure (final state)

```
src/shared/haul.ts                    # NEW pure haul law: CAMP_TILE, haulDistance, haulTicks, candidate ordering
src/shared/snapshot.ts                # MOD BuildingSnapshot.buffered, 'outputFull' state, WorkerSnapshot haul fields
src/shared/save.ts                    # MOD v3: SavedBuilding.buffer, SavedWorker.hauling, SaveGameV3, isSaveGameV3, LATEST=3
src/shared/save-migration.ts          # MOD second real step v2->v3 + guards table entry
src/shared/commands.ts                # MOD assignHauler, unassignHauler
src/engine/content/balance.ts         # MOD outputBufferCap, haulCarryCapacity, haulTilesPerTick
src/engine/components.ts              # MOD OutputBuffer, HaulTrip, JobAssignment.hauling
src/engine/systems/production-system.ts # MOD outputs to the buffer; outputFull stall
src/engine/systems/haul-system.ts     # NEW the trip state machine and deterministic claiming
src/engine/systems/command-handlers.ts# MOD hauler commands + mid-trip disposal
src/engine/systems/command-system.ts  # MOD HaulTrip in the workers query; hauler dispatch
src/engine/systems/snapshot-system.ts # MOD buffer/trip in the queries
src/engine/snapshot-builder.ts        # MOD facts carry buffered + haul fields; outputFull derivation
src/engine/world.ts                   # MOD OutputBuffer/HaulTrip registration, v3 spawn/validation/initial snapshot
src/engine/game-engine.ts             # MOD SaveGameV3, deposit-on-save, map in save
src/main.ts                           # MOD SaveGameV3 type renames only (3 sites)
src/app/world/layout.ts               # MOD haulers placed at target or camp
src/app/world/theme.ts                # MOD outputFull state colour
src/app/world/renderer.ts             # MOD carrying marker on hauler dots
src/app/components/WorldLegend.vue    # MOD outputFull + carrying legend entries
src/app/stores/game-store.ts          # MOD haulerCount, unitsWaiting, stalledBuildings getters
src/app/views/DashboardView.vue       # MOD hauler assignment controls
src/app/views/BuildingsView.vue       # MOD Waiting column
src/app/views/EconomyView.vue         # MOD haul pressure block
src/app/components/SelectionPanel.vue # MOD buffered goods line
src/app/labels.ts                     # MOD BUILDING_STATE_LABELS gains outputFull
styles.css                            # MOD hauler control + haul pressure classes
scripts/world-smoke-harness/main.ts   # MOD hauler fixtures + haul phases
scripts/world-smoke.mjs               # MOD haul cycle assertions
README.md                             # MOD Increment 4 section
tests/shared/haul.test.ts             # NEW
tests/shared/save-migration.test.ts   # MOD v2->v3 describe
tests/engine/systems/production-system.test.ts # MOD buffer/stall cases
tests/engine/systems/haul-system.test.ts # NEW
tests/engine/systems/command-system.test.ts # MOD hauler command cases
tests/engine/world.test.ts            # MOD v3 literals + buffer validation
tests/engine/decide-load.test.ts      # MOD titles + genuine-v2 migration case
tests/engine/game-engine.test.ts      # MOD save literals + deposit-on-save test
tests/engine/systems/snapshot-system.test.ts # MOD buffer/haul fields
tests/app/fixtures.ts                 # MOD makeBuilding/makeWorker gain the new fields
tests/app/world-layout.test.ts        # MOD hauler placement
tests/app/game-store.test.ts          # MOD haul getters
tests/app/dashboard-view.test.ts      # MOD hauler controls
tests/app/buildings-view.test.ts      # MOD Waiting column
tests/app/economy-view.test.ts        # MOD haul pressure
tests/app/selection-panel.test.ts     # MOD buffered line
```

Dependency spine: Task 1 (haul law) → 2 (output buffers) → 3 (hauler role + commands) → 4 (HaulSystem) → 5 (lifecycle edges) → 6 (save v3) → 7 (layout) → 8 (renderer/theme/legend) → 9 (store getters) → 10 (dashboard) → 11 (buildings table) → 12 (selection panel) → 13 (economy view) → 14 (smoke) → 15 (docs + gates).

---

### Task 1: The haul law, in one pure module

**Files:**
- Create: `src/shared/haul.ts`
- Test: `tests/shared/haul.test.ts`

**Interfaces:**
- Consumes: `TileRef` from `src/shared/placement.ts` (`{ col: number; row: number }`).
- Produces: `CAMP_TILE: TileRef`; `haulDistance(col: number, row: number): number`; `haulTicks(col: number, row: number, tilesPerTick: number): number`; `interface HaulCandidate { buildingId: number; col: number; row: number; buffered: number; claimed: number }`; `claimableAt(candidate: HaulCandidate): number`; `compareHaulCandidates(a: HaulCandidate, b: HaulCandidate): number`; `nextHaulTarget(candidates: readonly HaulCandidate[]): HaulCandidate | null`.

This module is the counterpart of `placement.ts`: it imports nothing but a type, holds no state, and is the single definition of what hauling costs and which building a hauler serves next. `BALANCE` is *not* imported — `src/shared/` may import nothing outside itself, so the rate arrives as an argument.

- [ ] **Step 1: Write the failing tests**

Create `tests/shared/haul.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CAMP_TILE, claimableAt, compareHaulCandidates, haulDistance, haulTicks, nextHaulTarget,
  type HaulCandidate,
} from '../../src/shared/haul';

function candidate(overrides: Partial<HaulCandidate> = {}): HaulCandidate {
  return { buildingId: 1, col: 4, row: 1, buffered: 4, claimed: 0, ...overrides };
}

describe('haul geometry', () => {
  it('measures from the camp tile', () => {
    expect(CAMP_TILE).toEqual({ col: 2, row: 0 });
    expect(haulDistance(CAMP_TILE.col, CAMP_TILE.row)).toBe(0);
  });

  it('is straight-line distance in tiles — the line the renderer walks', () => {
    expect(haulDistance(2, 3)).toBe(3);
    expect(haulDistance(5, 4)).toBe(5); // 3-4-5
  });

  it('never makes a trip free: even the camp tile costs a tick', () => {
    expect(haulTicks(CAMP_TILE.col, CAMP_TILE.row, 2)).toBe(1);
    expect(haulTicks(3, 0, 2)).toBe(1);
  });

  it('rounds up partial tiles but not exact multiples', () => {
    expect(haulTicks(2, 4, 2)).toBe(2); // distance 4, exactly 2 ticks
    expect(haulTicks(5, 4, 2)).toBe(3); // distance 5 -> ceil(2.5)
  });

  it('charges the far corner of the default map about thirteen ticks each way', () => {
    expect(haulTicks(22, 15, 2)).toBe(13); // distance 25
  });
});

describe('haul job selection', () => {
  it('counts only what earlier haulers have not spoken for', () => {
    expect(claimableAt(candidate({ buffered: 9, claimed: 6 }))).toBe(3);
    expect(claimableAt(candidate({ buffered: 6, claimed: 6 }))).toBe(0);
  });

  it('serves the fullest building first, even when it is farther', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 1, buffered: 3 });
    const far = candidate({ buildingId: 2, col: 20, row: 10, buffered: 9 });
    expect(nextHaulTarget([near, far])?.buildingId).toBe(2);
  });

  it('breaks a tie on backlog by distance to the camp', () => {
    const near = candidate({ buildingId: 1, col: 4, row: 0, buffered: 5 });
    const far = candidate({ buildingId: 2, col: 10, row: 0, buffered: 5 });
    expect(nextHaulTarget([far, near])?.buildingId).toBe(1);
  });

  it('breaks a full tie by lowest building id, so selection cannot depend on order', () => {
    const a = candidate({ buildingId: 7, col: 2, row: 3, buffered: 4 }); // distance 3
    const b = candidate({ buildingId: 3, col: 5, row: 0, buffered: 4 }); // distance 3
    expect(nextHaulTarget([a, b])?.buildingId).toBe(3);
    expect(nextHaulTarget([b, a])?.buildingId).toBe(3);
  });

  it('ignores buildings whose backlog is fully claimed, and returns null when nothing is open', () => {
    const claimed = candidate({ buildingId: 1, buffered: 6, claimed: 6 });
    const open = candidate({ buildingId: 2, col: 20, row: 10, buffered: 1 });
    expect(nextHaulTarget([claimed, open])?.buildingId).toBe(2);
    expect(nextHaulTarget([claimed])).toBeNull();
    expect(nextHaulTarget([])).toBeNull();
  });

  it('sorts a list the same way it picks a single target', () => {
    const list = [
      candidate({ buildingId: 1, col: 4, row: 1, buffered: 2 }),
      candidate({ buildingId: 2, col: 6, row: 1, buffered: 8 }),
      candidate({ buildingId: 3, col: 5, row: 0, buffered: 8 }),
    ];
    const sorted = [...list].sort(compareHaulCandidates);
    expect(sorted.map((c) => c.buildingId)).toEqual([3, 2, 1]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/shared/haul.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/shared/haul"`.

- [ ] **Step 3: Create `src/shared/haul.ts`**

```ts
import type { TileRef } from './placement';

/**
 * The colony's store: where every hauled good ends up, and the point every
 * haul distance is measured from. The app layer draws the camp tent at
 * tile-space (2, 0.75), so this is that tent's tile — the cost the simulation
 * charges and the walk the player watches describe the same journey.
 */
export const CAMP_TILE: TileRef = { col: 2, row: 0 };

/**
 * Straight-line tiles from the camp store to a tile. Euclidean, not Manhattan:
 * the renderer walks its dots in a straight line, and a cost model that
 * disagreed with the drawn motion would be unexplainable to the player.
 */
export function haulDistance(col: number, row: number): number {
  return Math.hypot(col - CAMP_TILE.col, row - CAMP_TILE.row);
}

/**
 * One-way trip length in ticks. `tilesPerTick` arrives as an argument rather
 * than an import: this module lives in src/shared/, which may import nothing
 * outside itself, while the tunable rate belongs to engine content (BALANCE).
 *
 * Never zero — a building beside the camp still costs a tick, so no placement
 * is ever free and no hauler can complete a round trip inside one tick.
 */
export function haulTicks(col: number, row: number, tilesPerTick: number): number {
  return Math.max(1, Math.ceil(haulDistance(col, row) / tilesPerTick));
}

/** What one building offers a hauler right now. */
export interface HaulCandidate {
  buildingId: number;
  col: number;
  row: number;
  /** Units sitting in the building's output buffer. */
  buffered: number;
  /** Units already spoken for by haulers currently outbound to it. */
  claimed: number;
}

/**
 * Units a newly dispatched hauler could still pick up. Claims are what let
 * several haulers serve one badly-backed-up building without all converging
 * on the same single unit.
 */
export function claimableAt(candidate: HaulCandidate): number {
  return candidate.buffered - candidate.claimed;
}

/**
 * THE job-selection order, so the engine's authoritative pick and any UI that
 * previews haul pressure can never disagree: clear the worst backlog first,
 * then prefer the cheapest round trip, then take the lowest id. The final
 * tie-break is what makes selection independent of entity iteration order —
 * without it, the same world could dispatch differently across runs.
 */
export function compareHaulCandidates(a: HaulCandidate, b: HaulCandidate): number {
  const byBacklog = claimableAt(b) - claimableAt(a);
  if (byBacklog !== 0) return byBacklog;
  const byDistance = haulDistance(a.col, a.row) - haulDistance(b.col, b.row);
  if (byDistance !== 0) return byDistance;
  return a.buildingId - b.buildingId;
}

/** The building a hauler should serve next, or null when nothing is waiting. */
export function nextHaulTarget(candidates: readonly HaulCandidate[]): HaulCandidate | null {
  let best: HaulCandidate | null = null;
  for (const candidate of candidates) {
    if (claimableAt(candidate) <= 0) continue;
    if (best === null || compareHaulCandidates(candidate, best) < 0) best = candidate;
  }
  return best;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/shared/haul.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Full gates**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

(`npm run check:quality` will report `haul.ts` exports as unused until Task 2 and Task 4 consume them — that is the expected transient the Global Constraints describe, not a failure to chase.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/haul.ts tests/shared/haul.test.ts
git commit -m "feat(shared): the haul law — camp tile, trip length, job ordering"
```

---

### Task 2: Output buffers — buildings hold what they make

**Files:**
- Modify: `src/engine/content/balance.ts` (three constants)
- Modify: `src/engine/components.ts` (add `OutputBuffer`)
- Modify: `src/engine/systems/production-system.ts` (outputs to the buffer; the stall)
- Modify: `src/shared/snapshot.ts` (`buffered`, `'outputFull'`)
- Modify: `src/engine/snapshot-builder.ts` (facts carry `buffered`; state derivation)
- Modify: `src/engine/systems/snapshot-system.ts` (buffer in the buildings query)
- Modify: `src/engine/world.ts` (register the component; spawn it; initial snapshot)
- Modify: `src/engine/systems/command-handlers.ts` (the live construct path spawns the component too)
- Modify: `src/app/labels.ts`, `src/app/world/theme.ts` (the two `Record<BuildingState, …>` maps must gain `outputFull` the moment the union widens, or typecheck goes red)
- Test: `tests/engine/systems/production-system.test.ts` (new cases)
- Test: `tests/engine/systems/stats-system.test.ts`, `tests/engine/world.test.ts`, `tests/engine/integration.test.ts` (assertions that read produced goods from the stockpile)

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces: `class OutputBuffer` with `amounts: Map<ResourceId, number>`, `total(): number`, `room(cap: number): number`, `add(id: ResourceId, amount: number): void`, `take(id: ResourceId, amount: number): number`, `fullestResource(order: readonly ResourceId[]): ResourceId | null`; `BALANCE.outputBufferCap`, `BALANCE.haulCarryCapacity`, `BALANCE.haulTilesPerTick`; `BuildingFacts.buffered`; `BuildingSnapshot.buffered`; `BuildingState` including `'outputFull'`.

Buildings stop banking into the global stockpile. Nothing hauls yet — that is Task 4 — so after this task a colony produces until every buffer is full and then stalls. That is the correct intermediate state, and the tests assert exactly it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/systems/production-system.test.ts` (inside the existing `describe('ProductionSystem', …)`), and add `OutputBuffer` to the components import at the top of the file:

```ts
  it('banks output in the building instead of the stockpile', async () => {
    const { world, building, stockpile } = await setup('forester', {});
    await world.step();
    await world.step();
    await world.step();
    expect(stockpile.get('wood')).toBe(0); // nothing has been hauled in
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('stalls at a full buffer, holding one finished batch', async () => {
    // forester: 1 wood per 3 worker-ticks, cap 12 -> 36 ticks to fill
    const { world, building } = await setup('forester', {});
    for (let i = 0; i < 40; i++) await world.step();
    const buffer = building.getComponent(OutputBuffer)!;
    const production = building.getComponent(Production)!;
    expect(buffer.total()).toBe(BALANCE.outputBufferCap);
    expect(production.batchActive).toBe(true);
    expect(production.progress).toBe(BUILDINGS.forester.recipe.ticksPerBatch); // work done, waiting on a cart
  });

  it('resumes the tick after the buffer gains room', async () => {
    const { world, building } = await setup('forester', {});
    for (let i = 0; i < 40; i++) await world.step();
    const buffer = building.getComponent(OutputBuffer)!;
    expect(buffer.take('wood', 5)).toBe(5);
    await world.step();
    expect(buffer.total()).toBe(BALANCE.outputBufferCap - 5 + 1);
  });

  it('does not consume inputs it cannot bank the output of', async () => {
    // A mill with a full buffer must not eat wheat it can do nothing with:
    // the room check runs BEFORE pay(), so not a single grain is taken.
    const { world, building, stockpile } = await setup('mill', { wheat: 20 });
    const buffer = building.getComponent(OutputBuffer)!;
    buffer.add('flour', BALANCE.outputBufferCap);
    for (let i = 0; i < 6; i++) await world.step();
    expect(stockpile.get('wheat')).toBe(20);
    expect(buffer.total()).toBe(BALANCE.outputBufferCap);
  });
```

The file's imports gain:

```ts
import { Building, OutputBuffer, Production } from '../../../src/engine/components';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/production-system.test.ts`
Expected: FAIL — `OutputBuffer` is not exported from `components`.

- [ ] **Step 3: Add the balance constants**

In `src/engine/content/balance.ts`, inside the `BALANCE` object, after `statsWindowTicks: 100,`:

```ts
  /** Units a building may hold before it stalls (total across resources). */
  outputBufferCap: 12,
  /** Units one hauler carries per trip: two trips clear a full buffer. */
  haulCarryCapacity: 6,
  /** Hauler walking speed. A building beside the camp is a 1-tick walk; the far
   * corner of the default map is 13, so distance is a real investment. */
  haulTilesPerTick: 2,
```

- [ ] **Step 4: Add the `OutputBuffer` component**

In `src/engine/components.ts`, extend the type import and append the class:

```ts
import type { BuildingDefId, ResourceId } from '../shared/content-types';
```

```ts
/**
 * Finished goods waiting at the building that made them until a hauler carries
 * them to the camp store. The cap is counted across ALL resources: buildings
 * produce one resource today, and a total keeps the cap meaningful if a recipe
 * ever yields two.
 */
export class OutputBuffer {
  constructor(public readonly amounts = new Map<ResourceId, number>()) {}

  total(): number {
    let sum = 0;
    for (const amount of this.amounts.values()) sum += amount;
    return sum;
  }

  room(cap: number): number {
    return Math.max(0, cap - this.total());
  }

  add(id: ResourceId, amount: number): void {
    this.amounts.set(id, (this.amounts.get(id) ?? 0) + amount);
  }

  /** Remove up to `amount` of one resource; returns what was actually taken. */
  take(id: ResourceId, amount: number): number {
    const held = this.amounts.get(id) ?? 0;
    const taken = Math.min(amount, held);
    if (taken <= 0) return 0;
    if (held === taken) this.amounts.delete(id);
    else this.amounts.set(id, held - taken);
    return taken;
  }

  /**
   * The resource a hauler would load: whichever this building holds most of.
   * Ties break by catalog order — passed in rather than imported, so the
   * component stays free of content dependencies — which keeps the choice
   * deterministic instead of Map-insertion-ordered.
   */
  fullestResource(order: readonly ResourceId[]): ResourceId | null {
    let best: ResourceId | null = null;
    let bestAmount = 0;
    for (const id of order) {
      const amount = this.amounts.get(id) ?? 0;
      if (amount > bestAmount) {
        best = id;
        bestAmount = amount;
      }
    }
    return best;
  }
}
```

- [ ] **Step 5: Production deposits into the buffer**

Replace the body of `src/engine/systems/production-system.ts` with:

First add the shared helper to `src/engine/content/buildings.ts`, so the two
readers of it (this system and the snapshot builder) cannot drift and neither
has to import the other:

```ts
import type { BuildingDef, BuildingDefId, Recipe } from '../../shared/content-types';

/** Units one batch of a recipe adds to a building's output buffer. */
export function batchOutputUnits(recipe: Recipe): number {
  let units = 0;
  for (const amount of Object.values(recipe.outputs)) units += amount;
  return units;
}
```

Then replace `src/engine/systems/production-system.ts` with:

```ts
import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { ResourceId } from '../../shared/content-types';
import { BALANCE, workerWorkPower } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { Building, Efficiency, JobAssignment, OutputBuffer, Production, ToolCoverage } from '../components';
import { Stockpile } from '../resources';

export const ProductionSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({
    building: Read(Building), production: Write(Production), buffer: Write(OutputBuffer),
  }),
  workers: queryComponents({ job: Read(JobAssignment), efficiency: Read(Efficiency), coverage: Read(ToolCoverage) }),
})
  .withName('ProductionSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const powerByBuilding = new Map<number, number>();
    for (const { job, efficiency, coverage } of workers.iter()) {
      if (job.buildingId === null) continue;
      const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks);
      powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
    }

    // Isolated so the run function itself stays a flat dispatch loop.
    const advanceBatches = (building: Building, production: Production, buffer: OutputBuffer, workPower: number) => {
      const recipe = BUILDINGS[building.defId].recipe;
      const perBatch = batchOutputUnits(recipe);
      // Checked BEFORE paying inputs: a building that could not bank the result
      // must not eat the wheat it can do nothing with.
      if (!production.batchActive && buffer.room(BALANCE.outputBufferCap) < perBatch) return;
      if (!production.batchActive && stockpile.pay(recipe.inputs)) {
        production.batchActive = true;
        production.progress = 0;
      }
      if (!production.batchActive) return;

      production.progress += workPower;
      while (production.batchActive && production.progress >= recipe.ticksPerBatch) {
        // A batch completes only with room for ALL of its outputs. Otherwise the
        // building holds one finished batch at full progress — the outputFull
        // stall — until a hauler frees space. Effort beyond that one batch is
        // not banked: the crew is standing beside a full pile.
        if (buffer.room(BALANCE.outputBufferCap) < perBatch) {
          production.progress = recipe.ticksPerBatch;
          return;
        }
        for (const [id, amount] of Object.entries(recipe.outputs)) {
          buffer.add(id as ResourceId, amount);
        }
        // carry the remainder into the next batch (no throughput loss for
        // high-power buildings); chain by paying the next batch's inputs
        production.progress -= recipe.ticksPerBatch;
        production.batchActive = stockpile.pay(recipe.inputs);
      }
      if (!production.batchActive) production.progress = 0; // stalled: don't bank effort
    };

    for (const { building, production, buffer } of buildings.iter()) {
      const workPower = powerByBuilding.get(building.id) ?? 0;
      if (workPower === 0) continue;
      advanceBatches(building, production, buffer, workPower);
    }
  })
  .build();
```

(`Recipe` is already exported from `src/shared/content-types.ts`; combine the two type imports into one line if lint prefers it.)

- [ ] **Step 6: Snapshot carries the buffer**

In `src/shared/snapshot.ts`:

```ts
export type BuildingState = 'producing' | 'waitingForInput' | 'unstaffed' | 'outputFull';
```

and in `BuildingSnapshot`, after `workPower`:

```ts
  /** Units waiting in this building's output buffer for a hauler. */
  buffered: number;
```

In `src/engine/snapshot-builder.ts`: add `buffered: number;` to `BuildingFacts` (after `batchActive`), extend `buildingFactsOf` with a fifth parameter, and derive the new state.

```ts
export function buildingFactsOf(
  building: Building, slots: WorkerSlots, production: Production, position: Position, buffer: OutputBuffer,
): BuildingFacts {
  return {
    id: building.id,
    defId: building.defId,
    col: position.col,
    row: position.row,
    workerSlots: slots.max,
    progress: production.progress,
    batchActive: production.batchActive,
    buffered: buffer.total(),
  };
}
```

In `buildEntitySections`, replace the `state` line with:

```ts
      // A staffed building that cannot bank another batch is stalled on output,
      // whether or not its current batch has finished — the player's remedy is
      // the same either way: send a hauler. Staffing still takes precedence,
      // since an unstaffed building is not waiting on transport.
      const outputBlocked = BALANCE.outputBufferCap - b.buffered < batchOutputUnits(def.recipe);
      const state: BuildingState = staffed === 0
        ? 'unstaffed'
        : outputBlocked ? 'outputFull' : b.batchActive ? 'producing' : 'waitingForInput';
```

and add `buffered: b.buffered,` to the returned building snapshot object. `snapshot-builder.ts` gains imports:

```ts
import { BALANCE, workerWorkPower } from './content/balance';
import { batchOutputUnits, BUILDINGS } from './content/buildings';
import { OutputBuffer, ... } from './components';
```

- [ ] **Step 7: Wire the component through the world**

In `src/engine/systems/snapshot-system.ts`: add `OutputBuffer` to the components import, add `buffer: Read(OutputBuffer)` to the `buildings` query, and pass it: `buildingFactsOf(building, slots, production, position, buffer)` (destructure `buffer` in the loop).

In `src/engine/world.ts`:
- add `OutputBuffer` to the components import;
- add `OutputBuffer` to `COMPONENT_TYPES`;
- in `spawnBuilding`, add `.with(new OutputBuffer())` after the `Position` line — buffers start empty; save v3 (Task 6) restores real contents;
- in `buildInitialSnapshot`'s `buildingFacts` map, add `buffered: 0,` after `batchActive` with the comment `// save v3 (Task 6) restores real buffer contents`.

- [ ] **Step 8: Run the target file, then the full suite**

Run: `npx vitest run tests/engine/systems/production-system.test.ts`
Expected: PASS — the 8 pre-existing cases (their stockpile assertions now read the buffer through the new tests) plus the 4 new ones.

The pre-existing cases assert `stockpile.get('wood')` after production; those assertions must be updated to read `building.getComponent(OutputBuffer)!.total()` instead, since output no longer reaches the stockpile. Update every such assertion in the file — the counts and timings are unchanged, only the place the goods land.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green. Other suites that asserted produced goods in the stockpile (`tests/engine/integration.test.ts`, `tests/engine/systems/stats-system.test.ts`) will need the same read-site change; make it mechanically and do not alter what they assert.

- [ ] **Step 9: Commit**

```bash
git add src/engine/content/balance.ts src/engine/components.ts src/engine/systems/production-system.ts src/engine/systems/snapshot-system.ts src/engine/snapshot-builder.ts src/engine/world.ts src/shared/snapshot.ts tests/
git commit -m "feat(engine): buildings bank output locally and stall when the buffer fills"
```

---

### Task 3: The hauler role and its commands

**Files:**
- Modify: `src/engine/components.ts` (`JobAssignment.hauling`)
- Modify: `src/shared/commands.ts` (two commands)
- Modify: `src/shared/snapshot.ts` (`WorkerSnapshot.hauling`)
- Modify: `src/engine/snapshot-builder.ts` (facts + saved-worker subset unchanged)
- Modify: `src/engine/systems/command-handlers.ts` (two handlers)
- Modify: `src/engine/systems/command-system.ts` (dispatch)
- Modify: `src/engine/world.ts` (`spawnWorker` option)
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `JobAssignment { buildingId: number | null; hauling: boolean }`; commands `{ type: 'assignHauler' }` and `{ type: 'unassignHauler' }`; `handleAssignHauler(ctx: CommandContext): void`, `handleUnassignHauler(ctx: CommandContext): void`; `WorkerFacts.hauling`, `WorkerSnapshot.hauling`; `spawnWorker(..., { hauling?: boolean })`.

A worker is idle, assigned to a building, or hauling — mutually exclusive by construction, since a hauler holds `buildingId: null`. Trips arrive in Task 4; disposal of a load on unassignment lands with them, because until Task 4 there is nothing to dispose.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/systems/command-system.test.ts` inside `describe('CommandSystem', …)`:

```ts
  it('assigns and unassigns haulers, with one notice each', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a hauler.' }]);
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(1);
    expect(snapshot().idleWorkers).toBe(2); // 3 starting workers, one now hauling

    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    expect(snapshot().workers.filter((w) => w.hauling)).toHaveLength(0);
    expect(snapshot().idleWorkers).toBe(3);
  });

  it('rejects hauler assignment with no idle worker, and unassignment with no hauler', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No hauler to unassign.' }]);

    await dispatch({ type: 'assignHauler' }, { type: 'assignHauler' }, { type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('haulers are workers in every other respect — they still eat', async () => {
    // Built directly against HungerSystem: the shared `setup` runs only the
    // command and snapshot systems, so it could never show a hauler eating.
    const save = initialSave();
    save.workers = [];
    save.stockpile = { berries: 5 };
    const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
    spawnWorker(prep, getPrepResource(prep, IdCounter), { hauling: true });
    const world = await prep.prepareRun();
    for (let i = 0; i <= BALANCE.mealThreshold; i++) await world.step();
    expect(world.getResource(Stockpile).get('berries')).toBeLessThan(5);
  });

  it('never takes a building worker for hauling', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignHauler' }); // one idle worker left
    await dispatch({ type: 'assignHauler' }); // none left
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    expect(snapshot().buildings[0].workers).toBe(2); // the staffed pair was never poached
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: FAIL — typecheck rejects `{ type: 'assignHauler' }` (not in the `Command` union) and `w.hauling` (not on `WorkerSnapshot`).

- [ ] **Step 3: Extend the command union**

`src/shared/commands.ts` — append to the union:

```ts
  | { type: 'assignHauler' }
  | { type: 'unassignHauler' };
```

- [ ] **Step 4: The `hauling` flag**

`src/engine/components.ts`:

```ts
export class JobAssignment {
  constructor(public buildingId: number | null = null, public hauling = false) {}
}
```

`src/shared/snapshot.ts`, in `WorkerSnapshot` after `buildingId`:

```ts
  /** True while this worker is assigned to hauling rather than to a building. */
  hauling: boolean;
```

`src/engine/snapshot-builder.ts`: add `hauling: boolean;` to `WorkerFacts` (after `buildingId`), return `hauling: job.hauling` from `workerFactsOf`, and add `hauling: w.hauling,` to the worker snapshot object in `buildEntitySections`. `savedWorkerOf` is unchanged this task — `hauling` joins the save in Task 6.

`src/engine/world.ts`: `spawnWorker`'s options gain `hauling?: boolean`, passed through as `new JobAssignment(opts.buildingId ?? null, opts.hauling ?? false)`. `buildInitialSnapshot`'s `workerFacts` map gains `hauling: false,` with the comment `// save v3 (Task 6) restores hauler assignments`.

- [ ] **Step 5: The handlers**

Append to `src/engine/systems/command-handlers.ts`:

```ts
export function handleAssignHauler(ctx: CommandContext): void {
  // The first idle worker, matching handleAssignWorker's selection rule. A
  // worker already on a building is never poached: the player staffed it.
  const idle = ctx.workers.find(({ job }) => job.buildingId === null && !job.hauling);
  if (idle === undefined) {
    ctx.notices.reject('No idle workers available.');
    return;
  }
  idle.job.hauling = true;
  ctx.notices.succeed('Assigned a hauler.');
}

export function handleUnassignHauler(ctx: CommandContext): void {
  const hauler = ctx.workers.find(({ job }) => job.hauling);
  if (hauler === undefined) {
    ctx.notices.reject('No hauler to unassign.');
    return;
  }
  hauler.job.hauling = false;
  ctx.notices.succeed('Unassigned a hauler.');
}
```

`src/engine/systems/command-system.ts`: import both handlers and add two cases to the switch:

```ts
        case 'assignHauler': handleAssignHauler(ctx); break;
        case 'unassignHauler': handleUnassignHauler(ctx); break;
```

- [ ] **Step 6: Run the target file, then the full suite**

Run: `npx vitest run tests/engine/systems/command-system.test.ts`
Expected: PASS — pre-existing cases plus the 3 new ones.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green. `tests/app/fixtures.ts`'s `makeWorker` needs `hauling: false` in its defaults, and any test building a `WorkerSnapshot` literal needs the field; typecheck names every site.

- [ ] **Step 7: Commit**

```bash
git add src/shared/commands.ts src/shared/snapshot.ts src/engine/components.ts src/engine/snapshot-builder.ts src/engine/systems/command-handlers.ts src/engine/systems/command-system.ts src/engine/world.ts tests/
git commit -m "feat(engine): haulers are an assigned role, with their own commands"
```

---

### Task 4: HaulSystem — the trip that moves the goods

**Files:**
- Modify: `src/engine/components.ts` (`HaulTrip`)
- Create: `src/engine/systems/haul-system.ts`
- Modify: `src/shared/snapshot.ts` (`haulTargetId`, `carrying`)
- Modify: `src/engine/snapshot-builder.ts` (facts carry the trip)
- Modify: `src/engine/systems/snapshot-system.ts` (trip in the workers query)
- Modify: `src/engine/world.ts` (register `HaulTrip`, spawn it, `ALL_SYSTEMS`)
- Test: `tests/engine/systems/haul-system.test.ts`

**Interfaces:**
- Consumes: `haulTicks`, `nextHaulTarget`, `HaulCandidate` (Task 1); `OutputBuffer`, `BALANCE.haulCarryCapacity`, `BALANCE.haulTilesPerTick` (Task 2); `JobAssignment.hauling` (Task 3).
- Produces: `type HaulPhase = 'idle' | 'outbound' | 'returning'`; `class HaulTrip { phase: HaulPhase; targetId: number | null; ticksLeft: number; resource: ResourceId | null; amount: number }`; `HaulSystem` factory; `WorkerFacts.haulTargetId`, `WorkerFacts.carrying`, `WorkerFacts.carryingResource`; `WorkerSnapshot.haulTargetId`, `WorkerSnapshot.carrying`.

`HaulTrip` is runtime-only: it never enters the save (Task 6 banks a carried load into the saved stockpile instead), so it needs no guard and no migration.

- [ ] **Step 1: Write the failing tests**

Create `tests/engine/systems/haul-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Building, HaulTrip, OutputBuffer } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

interface BuildingSpec { col: number; row: number; wood: number; id?: number }

async function setup(specs: readonly BuildingSpec[], haulerCount: number) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = {};
  const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const buildings: IEntity[] = specs.map((spec) => {
    const entity = spawnBuilding(prep, ids, {
      id: spec.id, defId: 'forester', progress: 0, batchActive: false, col: spec.col, row: spec.row,
    });
    if (spec.wood > 0) entity.getComponent(OutputBuffer)!.add('wood', spec.wood);
    return entity;
  });
  const haulers: IEntity[] = Array.from({ length: haulerCount }, () => spawnWorker(prep, ids, { hauling: true }));
  const world = await prep.prepareRun();
  const step = async (times: number) => { for (let i = 0; i < times; i++) await world.step(); };
  return { world, buildings, haulers, step, stockpile: world.getResource(Stockpile) };
}

const tripOf = (hauler: IEntity) => hauler.getComponent(HaulTrip)!;
const bufferOf = (building: IEntity) => building.getComponent(OutputBuffer)!;

describe('HaulSystem', () => {
  it('walks out, loads a full carry, walks back, and banks it in the store', async () => {
    // (5,4) is 5 tiles from the camp -> 3 ticks each way
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('outbound');
    expect(tripOf(haulers[0]).ticksLeft).toBe(3);

    await step(3); // arrival tick
    expect(bufferOf(buildings[0]).total()).toBe(3); // 6 carried away
    expect(tripOf(haulers[0]).phase).toBe('returning');
    expect(tripOf(haulers[0]).amount).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.get('wood')).toBe(0); // not banked until it arrives

    await step(3);
    expect(stockpile.get('wood')).toBe(BALANCE.haulCarryCapacity);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('charges a tick each way even beside the camp — no trip is free', async () => {
    const { step, stockpile } = await setup([{ col: 3, row: 0, wood: 6 }], 1);
    await step(2);
    expect(stockpile.get('wood')).toBe(0); // dispatched, arrived, not yet home
    await step(1);
    expect(stockpile.get('wood')).toBe(6);
  });

  it('lets several haulers share one backlog without claiming the same units', async () => {
    const { haulers, step, stockpile } = await setup([{ col: 3, row: 0, wood: 12 }], 2);
    await step(1);
    expect(haulers.every((h) => tripOf(h).phase === 'outbound')).toBe(true);
    await step(2);
    expect(stockpile.get('wood')).toBe(12); // 6 each, nothing double-counted
  });

  it('leaves a hauler idle when the backlog is already spoken for', async () => {
    const { haulers, step } = await setup([{ col: 3, row: 0, wood: 6 }], 3);
    await step(1);
    const phases = haulers.map((h) => tripOf(h).phase).sort();
    expect(phases).toEqual(['idle', 'idle', 'outbound']);
  });

  it('serves the worst backlog first, even when it is farther away', async () => {
    const { buildings, haulers, step } = await setup(
      [{ col: 4, row: 1, wood: 2 }, { col: 20, row: 10, wood: 9 }],
      1,
    );
    await step(1);
    expect(tripOf(haulers[0]).targetId).toBe(buildings[1].getComponent(Building)!.id);
  });

  it('dispatches identically regardless of entity order — same world, same claim', async () => {
    // both 3 tiles from camp, both holding 4: the lowest id must win either way
    const forward = await setup([{ id: 10, col: 5, row: 0, wood: 4 }, { id: 11, col: 2, row: 3, wood: 4 }], 1);
    const reversed = await setup([{ id: 11, col: 2, row: 3, wood: 4 }, { id: 10, col: 5, row: 0, wood: 4 }], 1);
    await forward.step(1);
    await reversed.step(1);
    expect(tripOf(forward.haulers[0]).targetId).toBe(10);
    expect(tripOf(reversed.haulers[0]).targetId).toBe(10);
  });

  it('leaves haulers idle when nothing is waiting', async () => {
    const { haulers, step } = await setup([{ col: 5, row: 4, wood: 0 }], 2);
    await step(4);
    expect(haulers.every((h) => tripOf(h).phase === 'idle')).toBe(true);
  });

  it('returns empty-handed when the buffer is drained before arrival', async () => {
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 6 }], 1);
    await step(1);
    bufferOf(buildings[0]).take('wood', 6); // someone else got there first
    await step(3);
    expect(tripOf(haulers[0]).amount).toBe(0);
    await step(3);
    expect(stockpile.get('wood')).toBe(0);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('ignores workers who are not haulers', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const idle = spawnWorker(prep, ids, {});
    const world = await prep.prepareRun();
    for (let i = 0; i < 6; i++) await world.step();
    expect(idle.getComponent(HaulTrip)!.phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/haul-system.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/engine/systems/haul-system"`.

- [ ] **Step 3: Add the `HaulTrip` component**

Append to `src/engine/components.ts`:

```ts
export type HaulPhase = 'idle' | 'outbound' | 'returning';

/**
 * A hauler's current trip. Runtime-only: it never enters the save — a hauler
 * caught mid-trip banks its load into the saved stockpile instead — so nothing
 * here needs a load guard or a migration. Present on every worker; anyone who
 * is not hauling simply sits at 'idle'.
 */
export class HaulTrip {
  constructor(
    public phase: HaulPhase = 'idle',
    public targetId: number | null = null,
    public ticksLeft = 0,
    public resource: ResourceId | null = null,
    public amount = 0,
  ) {}

  /** Back to standing at the camp with empty hands. */
  reset(): void {
    this.phase = 'idle';
    this.targetId = null;
    this.ticksLeft = 0;
    this.resource = null;
    this.amount = 0;
  }
}
```

- [ ] **Step 4: Create `src/engine/systems/haul-system.ts`**

```ts
import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { HaulCandidate } from '../../shared/haul';
import { haulTicks, nextHaulTarget } from '../../shared/haul';
import { BALANCE } from '../content/balance';
import { RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, JobAssignment, OutputBuffer, Position } from '../components';
import { Stockpile } from '../resources';

/**
 * Haulers carry finished goods from the building that made them to the camp
 * store. Runs after ProductionSystem (goods produced this tick are claimable
 * immediately) and before StatsSystem (a deposit counts in this tick's flows).
 *
 * Every decision here is a pure function of world state: claims are recomputed
 * from live components each tick rather than remembered, and the tie-break
 * chain in nextHaulTarget ends at the building id, so entity iteration order
 * cannot change which building a hauler serves.
 */
export const HaulSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({
    building: Read(Building), position: Read(Position), buffer: Write(OutputBuffer),
  }),
  workers: queryComponents({ job: Read(JobAssignment), trip: Write(HaulTrip) }),
})
  .withName('HaulSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const buildingRows = [...buildings.iter()];
    const byId = new Map(buildingRows.map((row) => [row.building.id, row]));
    const workerRows = [...workers.iter()];

    // What haulers already on their way will take. Without this a second
    // hauler would be dispatched at the same single unit the first is already
    // fetching, and both would arrive to an empty buffer.
    const claimed = new Map<number, number>();
    for (const { job, trip } of workerRows) {
      if (!job.hauling || trip.phase !== 'outbound' || trip.targetId === null) continue;
      claimed.set(trip.targetId, (claimed.get(trip.targetId) ?? 0) + BALANCE.haulCarryCapacity);
    }
    const candidates: HaulCandidate[] = buildingRows.map(({ building, position, buffer }) => ({
      buildingId: building.id,
      col: position.col,
      row: position.row,
      buffered: buffer.total(),
      claimed: claimed.get(building.id) ?? 0,
    }));

    const dispatch = (trip: HaulTrip): void => {
      const target = nextHaulTarget(candidates);
      if (target === null) return;
      trip.phase = 'outbound';
      trip.targetId = target.buildingId;
      trip.ticksLeft = haulTicks(target.col, target.row, BALANCE.haulTilesPerTick);
      trip.resource = null;
      trip.amount = 0;
      // Mutating the candidate makes the claim visible to the next idle hauler
      // dispatched in this same tick, not only to the next tick's recompute.
      target.claimed += BALANCE.haulCarryCapacity;
    };

    const load = (trip: HaulTrip): void => {
      const row = trip.targetId === null ? undefined : byId.get(trip.targetId);
      // The building can be gone (demolished while this hauler walked): the trip
      // simply ends, which is cheaper than a special cancellation path.
      if (row === undefined) {
        trip.reset();
        return;
      }
      const resource = row.buffer.fullestResource(RESOURCE_IDS);
      const amount = resource === null ? 0 : row.buffer.take(resource, BALANCE.haulCarryCapacity);
      trip.resource = amount > 0 ? resource : null;
      trip.amount = amount;
      trip.phase = 'returning';
      // Recomputed from the building's CURRENT tile, so a building moved while
      // the hauler was outbound charges the walk home it actually walks.
      trip.ticksLeft = haulTicks(row.position.col, row.position.row, BALANCE.haulTilesPerTick);
    };

    const deposit = (trip: HaulTrip): void => {
      if (trip.resource !== null && trip.amount > 0) stockpile.add(trip.resource, trip.amount);
      trip.reset();
    };

    for (const { job, trip } of workerRows) {
      if (!job.hauling) continue;
      if (trip.phase === 'idle') {
        dispatch(trip);
        continue; // a trip dispatched this tick starts walking next tick
      }
      trip.ticksLeft -= 1;
      if (trip.ticksLeft > 0) continue;
      if (trip.phase === 'outbound') load(trip);
      else deposit(trip);
    }
  })
  .build();
```

- [ ] **Step 5: Snapshot carries the trip**

`src/shared/snapshot.ts`, in `WorkerSnapshot` after `hauling`:

```ts
  /** The building this hauler is walking to, or null when idle or heading home. */
  haulTargetId: number | null;
  /** Units in hand (0 unless carrying a load home). */
  carrying: number;
```

`src/engine/snapshot-builder.ts`: `WorkerFacts` gains

```ts
  haulTargetId: number | null;
  carrying: number;
  carryingResource: ResourceId | null;
```

(`ResourceId` joins the type import from `../shared/content-types`), `workerFactsOf` gains a `trip: HaulTrip` parameter:

```ts
export function workerFactsOf(
  worker: Worker, hunger: Hunger, job: JobAssignment, efficiency: Efficiency, coverage: ToolCoverage, trip: HaulTrip,
): WorkerFacts {
  return {
    id: worker.id,
    hunger: hunger.value,
    efficiency: efficiency.value,
    buildingId: job.buildingId,
    hauling: job.hauling,
    // Only an outbound hauler has somewhere to be: a returning one is walking
    // to the camp, which the layout places without needing a target.
    haulTargetId: trip.phase === 'outbound' ? trip.targetId : null,
    carrying: trip.amount,
    carryingResource: trip.resource,
    toolTicks: coverage.remainingTicks,
  };
}
```

and `buildEntitySections`'s worker map gains `haulTargetId: w.haulTargetId, carrying: w.carrying,`.

`gatherEntityFacts` passes the new component: `entity.getComponent(HaulTrip)!` as the sixth argument.

`src/engine/systems/snapshot-system.ts`: add `HaulTrip` to the components import, `trip: Read(HaulTrip)` to the `workers` query, and pass `trip` into `workerFactsOf`.

`src/engine/world.ts`:
- add `HaulTrip` to the components import and to `COMPONENT_TYPES`;
- `spawnWorker` gains `.with(new HaulTrip())` after `ToolCoverage`;
- `buildInitialSnapshot`'s `workerFacts` map gains `haulTargetId: null, carrying: 0, carryingResource: null,` (a restored colony's haulers start at the camp);
- `ALL_SYSTEMS` gains `HaulSystem` **between `ProductionSystem` and `StatsSystem`**, with the import added.

- [ ] **Step 6: Run the target file, then the full suite**

Run: `npx vitest run tests/engine/systems/haul-system.test.ts`
Expected: PASS (9 tests).

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green. `tests/app/fixtures.ts`'s `makeWorker` gains `haulTargetId: null, carrying: 0`; typecheck names any other literal site.

- [ ] **Step 7: Restore the end-to-end chain test**

`tests/engine/integration.test.ts` was narrowed in Task 2 to the raw stages
only, because with output buffers and nobody hauling a multi-stage chain
genuinely cannot run — the mill's wheat sits in the farm's buffer, not in the
store. Haulers exist now, so restore the full assertion: staff the colony's
chains **and** assign haulers, run the same colony, and assert bread and tools
reach the stockpile as the original test did.

Expect to **replace** the narrowing's raw-stage assertions rather than keep
them: with haulers running, `buffered === outputBufferCap`,
`state === 'outputFull'`, and the `wheat/flour/bread/tools === 0` checks all
become false by design — that reversal is the proof hauling works. Delete the
Task-4 restoration comment block the narrowing left behind at the same time.

Run: `npx vitest run tests/engine/integration.test.ts`
Expected: PASS — the full bread-and-tools chain, now dependent on hauling.

- [ ] **Step 8: Commit**

```bash
git add src/engine/components.ts src/engine/systems/haul-system.ts src/engine/systems/snapshot-system.ts src/engine/snapshot-builder.ts src/engine/world.ts src/shared/snapshot.ts tests/
git commit -m "feat(engine): haulers walk, load, and bank goods in the camp store"
```

---

### Task 5: Trips survive a colony that keeps changing

**Files:**
- Modify: `src/engine/systems/command-handlers.ts` (`WorkerRow.trip`, move retarget, unassign disposal)
- Modify: `src/engine/systems/command-system.ts` (trip in the workers query)
- Test: `tests/engine/systems/haul-system.test.ts` (lifecycle describe)
- Test: `tests/engine/systems/command-system.test.ts` (unassign disposal)

**Interfaces:**
- Consumes: `HaulTrip` (Task 4), `CommandContext` and its handlers (Task 3).
- Produces: `WorkerRow { job: JobAssignment; trip: HaulTrip }` — every later reader of a worker row gets the trip too.

Increment 3 let the player move and demolish buildings at any moment; a hauler is mid-journey when they do. Three cases, and the honest resolution for each is different: a moved building changes the walk, a demolished one ends the trip, and an unassigned hauler must not evaporate the goods in its hands.

- [ ] **Step 1: Write the failing tests**

Append to `tests/engine/systems/haul-system.test.ts` a new describe (it needs `CommandSystem` and the `enqueue` fixture, so add those imports):

```ts
describe('HaulSystem lifecycle', () => {
  it('ends the trip when the target is demolished mid-walk', async () => {
    // Demolition goes through the command path, the only way a building ever
    // leaves the world, so this exercises the real removal timing.
    const { world, buildings, haulers, step, stockpile } = await setup([{ col: 20, row: 10, wood: 9 }], 1, [CommandSystem]);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('outbound');
    enqueue(world, { type: 'demolishBuilding', buildingId: buildings[0].getComponent(Building)!.id });
    await step(12); // long past the arrival tick
    expect(tripOf(haulers[0]).phase).toBe('idle');
    expect(stockpile.get('wood')).toBe(0);
  });

  it('a hauler already carrying delivers even if its source is gone', async () => {
    const { world, buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1, [CommandSystem]);
    await step(4); // loaded, now returning
    expect(tripOf(haulers[0]).amount).toBe(BALANCE.haulCarryCapacity);
    enqueue(world, { type: 'demolishBuilding', buildingId: buildings[0].getComponent(Building)!.id });
    await step(3);
    // the refund lands in the stockpile too; the carried load is what matters
    expect(stockpile.get('wood')).toBeGreaterThanOrEqual(BALANCE.haulCarryCapacity);
  });

  it('a fresh colony starts with no trips in flight', async () => {
    // The reset path builds a new world from initialSave, so buffers and trips
    // are structurally empty — pinned here so a future "reuse the world" reset
    // cannot quietly carry a hauler across timelines.
    const { haulers } = await setup([{ col: 5, row: 4, wood: 0 }], 2);
    expect(haulers.every((h) => tripOf(h).phase === 'idle' && tripOf(h).amount === 0)).toBe(true);
  });
});
```

`setup` gains an optional third parameter — extra systems appended after `HaulSystem` — and the file imports `CommandSystem` plus `enqueue` from `../fixtures`:

```ts
async function setup(specs: readonly BuildingSpec[], haulerCount: number, extraSystems: readonly TColonySystemFactory[] = []) {
  …
  const prep = buildColonyPrepWorld({ save, systems: [HaulSystem, ...extraSystems] });
```

Append to `tests/engine/systems/command-system.test.ts`:

```ts
  it('a hauler unassigned mid-trip drops its load in the store, never into nothing', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'assignHauler' });
    await tick(); await tick(); await tick(); await tick(); // out and loaded
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + BALANCE.haulCarryCapacity);
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
  });

  it('a move retargets the haulers already walking to that building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 20, row: 10 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'assignHauler' });
    await tick(); // dispatched: a long walk to (20,10)
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 3, row: 0 } });
    const trips = [...world.getEntities()].map((e) => e.getComponent(HaulTrip)).filter((t) => t?.phase === 'outbound');
    expect(trips[0]!.ticksLeft).toBe(1); // recomputed against the new tile, not the old one
  });
```

(This test file's setup gains `HaulSystem` in its systems list; import `Building`, `OutputBuffer`, `HaulTrip`, `Stockpile`, and `BALANCE`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/engine/systems/command-system.test.ts tests/engine/systems/haul-system.test.ts`
Expected: FAIL — the unassign test finds the stockpile unchanged (the load vanished with the trip), and the move test finds `ticksLeft` still counting down the old distance.

- [ ] **Step 3: Give command rows their trips**

`src/engine/systems/command-handlers.ts` — extend the row interface and the imports:

```ts
import { Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, ToolCoverage, Worker, WorkerSlots } from '../components';
```

```ts
export interface WorkerRow {
  job: JobAssignment;
  trip: HaulTrip;
}
```

`src/engine/systems/command-system.ts` — the workers query and its materialization:

```ts
  workers: queryComponents({ job: Write(JobAssignment), trip: Write(HaulTrip) }),
```

```ts
      workers: [...workers.iter()].map(({ job, trip }) => ({ job, trip })),
```

- [ ] **Step 4: Dispose the load, and retarget the walk**

In `handleUnassignHauler`, between clearing the flag and the notice:

```ts
  hauler.job.hauling = false;
  // Anything already in hand goes to the store: those goods left the building
  // and must land somewhere. Only a returning hauler carries — an outbound one
  // is empty — so this is exactly the mid-return case.
  if (hauler.trip.resource !== null && hauler.trip.amount > 0) {
    ctx.stockpile.add(hauler.trip.resource, hauler.trip.amount);
  }
  hauler.trip.reset();
  ctx.notices.succeed('Unassigned a hauler.');
```

In `handleMoveBuilding`, after the position is rewritten and before the success notice:

```ts
  // Haulers already walking to this building now have a different journey:
  // recompute from the new tile so the ticks charged match the line the dot
  // visibly travels. A returning hauler is unaffected — it walks to the camp,
  // which did not move.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) {
      trip.ticksLeft = haulTicks(to.col, to.row, BALANCE.haulTilesPerTick);
    }
  }
```

with `haulTicks` imported from `../../shared/haul` and `BALANCE` already imported.

Demolition needs no handler change: `HaulSystem`'s `load` already ends a trip whose target has vanished, which is why that guard exists. The tests above pin both halves.

- [ ] **Step 4b: Close the spawn-path class of bug for good**

Twice now a new component reached `src/engine/world.ts`'s spawn helpers but not
the live command path, and both times it surfaced as an unrelated-looking test
failure rather than a clear error (`OutputBuffer` in Task 2, `HaulTrip` in
Task 4). Add one test that catches the whole class at the source.

In `tests/engine/systems/command-system.test.ts`, add a test that recruits a
worker through the command path, then asserts the resulting entity carries
**every** component that `spawnWorker` attaches — read the component list from
the entity spawned by the save-restore path in the same world and compare, so
the test keeps working when a future component is added rather than pinning
today's list:

```ts
  it('a recruited worker carries the same components as a restored one', async () => {
    const { world, tick, dispatch } = await setup();
    const before = [...world.getEntities()].find((e) => e.getComponent(Worker) !== undefined)!;
    const expected = COMPONENT_TYPES.filter((type) => before.getComponent(type) !== undefined);
    await dispatch({ type: 'recruitWorker' });
    await tick();
    const recruited = [...world.getEntities()]
      .filter((e) => e.getComponent(Worker) !== undefined)
      .find((e) => e.getComponent(Worker)!.id > before.getComponent(Worker)!.id)!;
    for (const type of expected) {
      expect(recruited.getComponent(type), `recruited worker is missing ${type.name}`).toBeDefined();
    }
  });
```

`COMPONENT_TYPES` must be exported from `src/engine/world.ts` for this (it is
currently module-private; exporting it is the smallest change that makes the
invariant testable). Do the same for buildings if it costs nothing — a
constructed building versus a restored one — but the worker case is the one
that has actually broken twice.

- [ ] **Step 5: Run both files, then the full suite**

Run: `npx vitest run tests/engine/systems/command-system.test.ts tests/engine/systems/haul-system.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/engine/systems/command-handlers.ts src/engine/systems/command-system.ts tests/
git commit -m "feat(engine): trips survive moves, demolition, and unassignment without losing goods"
```

---

### Task 6: Save v3 — buffers and haulers persist

**Files:**
- Modify: `src/shared/save.ts` (v3 types and guard, `LATEST_SAVE_VERSION`)
- Modify: `src/shared/save-migration.ts` (v2→v3 step, guards table)
- Modify: `src/engine/snapshot-builder.ts` (`savedBuildingOf`, `savedWorkerOf`)
- Modify: `src/engine/world.ts` (buffer validation, spawn from save, initial snapshot)
- Modify: `src/engine/game-engine.ts` (`SaveGameV3`, deposit-on-save)
- Modify: `src/main.ts` (type renames, 3 sites)
- Test: `tests/shared/save-migration.test.ts`, `tests/engine/world.test.ts`, `tests/engine/game-engine.test.ts`, `tests/engine/decide-load.test.ts`

**Interfaces:**
- Consumes: `OutputBuffer` (Task 2), `JobAssignment.hauling` (Task 3), `WorkerFacts.carrying`/`carryingResource` (Task 4).
- Produces: `interface SavedBuildingV2` (frozen), `SavedBuilding` with `buffer: Partial<Record<ResourceId, number>>`, `SavedWorker.hauling`, `SaveGameV3`, `isSaveGameV3`, `LATEST_SAVE_VERSION = 3`.

The chain built in increment 3 gets its second real step. A v2 colony is exactly a v3 colony with empty buffers and nobody hauling, so the migration is a shape fill — the interesting work is in the guards.

- [ ] **Step 1: Write the failing tests**

Append to `tests/shared/save-migration.test.ts`:

```ts
describe('migrateSaveToLatest (v2 -> v3)', () => {
  function v2Save(buildingCount = 2) {
    return {
      version: 2,
      tick: 40,
      lastRecruitTick: 10,
      stockpile: { wood: 12 },
      map: { cols: 24, rows: 16 },
      buildings: Array.from({ length: buildingCount }, (_, i) => ({
        id: i + 1, defId: 'forester', progress: 0, batchActive: false, col: 4 + 2 * i, row: 1,
      })),
      workers: [{ id: 100, hunger: 3, buildingId: null, toolTicks: 0 }],
      nextEntityId: 101,
    };
  }

  it('fills empty buffers and no haulers — what a v2 colony was', () => {
    const out = migrateSaveToLatest(v2Save())!;
    expect(out.version).toBe(3);
    expect(out.buildings.every((b) => Object.keys(b.buffer).length === 0)).toBe(true);
    expect(out.workers.every((w) => w.hauling === false)).toBe(true);
  });

  it('leaves every other field of the v2 save exactly as it was', () => {
    const before = v2Save();
    const out = migrateSaveToLatest(before)!;
    expect(out.tick).toBe(40);
    expect(out.map).toEqual({ cols: 24, rows: 16 });
    expect(out.buildings.map((b) => `${b.col},${b.row}`)).toEqual(['4,1', '6,1']);
    expect(before.buildings[0]).not.toHaveProperty('buffer'); // input untouched
  });

  it('migrates a v1 save all the way to v3 in one call', () => {
    const v1 = {
      version: 1, tick: 5, lastRecruitTick: 0, stockpile: {},
      buildings: [{ id: 1, defId: 'forester', progress: 0, batchActive: false }],
      workers: [], nextEntityId: 2,
    };
    const out = migrateSaveToLatest(v1)!;
    expect(out.version).toBe(3);
    expect(out.buildings[0]).toMatchObject({ col: 4, row: 1, buffer: {} });
  });
});
```

Append to `tests/engine/world.test.ts`'s `describe('isLoadableSave', …)`:

```ts
  it('rejects a buffer holding more than the cap', () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { wood: BALANCE.outputBufferCap + 1 },
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('rejects a buffer naming a resource the catalog does not have', () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1,
      buffer: { unobtainium: 1 } as never,
    });
    save.nextEntityId = 5;
    expect(isLoadableSave(save)).toBe(false);
  });

  it('restores buffered goods into the building that held them', async () => {
    const save = initialSave();
    save.buildings.push({
      id: 4, defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, buffer: { wood: 5 },
    });
    save.nextEntityId = 5;
    const world = await createColonyWorld(save);
    expect(world.getResource(SnapshotStore).latest!.buildings[0].buffered).toBe(5);
  });
```

Append to `tests/engine/game-engine.test.ts` (which already imports `buildSaveFromWorld`; add `createColonyWorld`, `HaulTrip`, and `Stockpile` to its imports):

```ts
  it('banks a hauler mid-trip load into the saved stockpile without touching the live world', async () => {
    const world = await createColonyWorld();
    let carried: HaulTrip | null = null;
    for (const entity of world.getEntities()) {
      const trip = entity.getComponent(HaulTrip);
      if (trip !== undefined) {
        trip.phase = 'returning';
        trip.resource = 'wood';
        trip.amount = 4;
        carried = trip;
        break;
      }
    }
    const before = world.getResource(Stockpile).get('wood');
    const save = buildSaveFromWorld(world);

    expect(save.stockpile.wood).toBe(before + 4);
    // A save is a snapshot, not an event: the running colony still delivers
    // that load normally, so the live world must be untouched.
    expect(world.getResource(Stockpile).get('wood')).toBe(before);
    expect(carried!.amount).toBe(4);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/shared/save-migration.test.ts tests/engine/world.test.ts`
Expected: FAIL — `out.version` is 2 (no v2→v3 step), and `buffer` is not a property typecheck accepts on `SavedBuilding`.

- [ ] **Step 3: The v3 save format**

In `src/shared/save.ts`:

```ts
export const LATEST_SAVE_VERSION = 3;
```

and update the doc comment's illustration to `SaveGameV3.version` / `Type '4' is not assignable to type '3'`.

```ts
/** The v2 building record — frozen legacy shape, pre-logistics. */
export interface SavedBuildingV2 extends SavedBuildingV1 {
  col: number;
  row: number;
}

/** The current building record: v2 plus the goods waiting at it (save v3). */
export interface SavedBuilding extends SavedBuildingV2 {
  /** Output-buffer contents; `{}` when the building is empty. */
  buffer: Partial<Record<ResourceId, number>>;
}

export interface SavedWorker {
  id: number;
  hunger: number;
  buildingId: number | null;
  toolTicks: number;
  /** True when this worker is assigned to hauling (save v3). */
  hauling: boolean;
}
```

`SaveGameV2.buildings` becomes `SavedBuildingV2[]`, and `SaveGameV2.workers` needs the pre-v3 worker shape — introduce `SavedWorkerV2` (the four fields without `hauling`) and point `SaveGameV1`/`SaveGameV2` at it, exactly as `SavedBuildingV1` was frozen in increment 3.

```ts
export interface SaveGameV3 {
  version: 3;
  tick: number;
  lastRecruitTick: number;
  stockpile: Partial<Record<ResourceId, number>>;
  map: WorldMapSize;
  buildings: SavedBuilding[];
  workers: SavedWorker[];
  nextEntityId: number;
}

function isBufferShape(buffer: unknown): boolean {
  if (typeof buffer !== 'object' || buffer === null || Array.isArray(buffer)) return false;
  // Structural only: catalog membership and the cap are cross-field truths
  // that live in isLoadableSave, beside the id and position checks.
  return Object.values(buffer).every((amount) => Number.isSafeInteger(amount) && (amount as number) >= 0);
}

export function isSaveGameV3(data: unknown): data is SaveGameV3 {
  if (typeof data !== 'object' || data === null) return false;
  const save = data as Record<string, unknown>;
  return (
    save.version === 3 &&
    isCommonSaveShape(save) &&
    isMapShape(save.map) &&
    (save.buildings as unknown[]).every((b) => hasSavedPosition(b) && isBufferShape((b as SavedBuilding).buffer)) &&
    (save.workers as unknown[]).every((w) => typeof (w as SavedWorker).hauling === 'boolean')
  );
}
```

- [ ] **Step 4: The migration step**

In `src/shared/save-migration.ts`:

```ts
const SAVE_GUARDS: SaveGuards = { 1: isSaveGameV1, 2: isSaveGameV2, 3: isSaveGameV3 };

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

const SAVE_MIGRATIONS: readonly MigrationStep[] = [migrateV1toV2, migrateV2toV3];
```

and `migrateSaveToLatest`'s return type becomes `SaveGameV3 | null`.

- [ ] **Step 5: Producers, guards, and restore**

`src/engine/snapshot-builder.ts`:

```ts
export function savedWorkerOf(facts: WorkerFacts): SavedWorker {
  return {
    id: facts.id, hunger: facts.hunger, buildingId: facts.buildingId,
    toolTicks: facts.toolTicks, hauling: facts.hauling,
  };
}

export function savedBuildingOf(facts: BuildingFacts): SavedBuilding {
  return {
    id: facts.id, defId: facts.defId, col: facts.col, row: facts.row,
    progress: facts.progress, batchActive: facts.batchActive, buffer: facts.buffer,
  };
}
```

`BuildingFacts` therefore gains `buffer: Partial<Record<ResourceId, number>>` beside the `buffered` total, filled in `buildingFactsOf` by `Object.fromEntries(buffer.amounts)`.

`src/engine/world.ts`:
- every `SaveGameV2` reference becomes `SaveGameV3` (typecheck names all of them);
- `initialSave()` workers gain `hauling: false`;
- new cross-field validator, called from `isLoadableSave` after `isPositionsValid`:

```ts
/**
 * Buffer contents are cross-field truths like positions: catalog membership and
 * the cap need the content catalog and BALANCE, which the structural guard in
 * src/shared/ cannot see.
 */
function isBuffersValid(data: SaveGameV3): boolean {
  return data.buildings.every((b) => {
    let total = 0;
    for (const [id, amount] of Object.entries(b.buffer)) {
      if (!Object.hasOwn(RESOURCES, id)) return false;
      total += amount as number;
    }
    return total <= BALANCE.outputBufferCap;
  });
}
```

- `spawnBuilding` restores the buffer. Its `saved` parameter makes `buffer`
  optional so the many test call sites that spawn a bare building keep
  compiling — the same treatment `id` already gets:

```ts
export function spawnBuilding(
  prep: IPreptimeWorld,
  ids: IdCounter,
  saved: Omit<SavedBuilding, 'id' | 'buffer'> & { id?: number; buffer?: Partial<Record<ResourceId, number>> },
): IEntity {
```

```ts
    .with(new OutputBuffer(new Map(Object.entries(saved.buffer ?? {}) as [ResourceId, number][])))
```

- `spawnWorker` passes `hauling: saved.hauling` through from `buildColonyPrepWorld`'s worker loop;
- `buildInitialSnapshot` maps the real values: `buffered` from the saved buffer's total, `buffer: saved.buffer`, and `hauling: saved.hauling` (replacing Task 2's and Task 3's transitional zeros — delete those comments).

`src/engine/game-engine.ts` — `SaveGameV3` everywhere, and the deposit-on-save rule:

```ts
export function buildSaveFromWorld(world: IRuntimeWorld): SaveGameV3 {
  const clock = world.getResource(SimClock);
  const facts = gatherEntityFacts(world);
  const stockpile = world.getResource(Stockpile).toJSON();
  // A hauler caught mid-trip banks its load here rather than persisting trip
  // state: conservation stays exact, and HaulTrip stays out of the save format
  // and its guards entirely. The live world is deliberately NOT mutated — this
  // is a snapshot, and the running colony still delivers that load normally.
  for (const worker of facts.workers) {
    if (worker.carryingResource === null || worker.carrying <= 0) continue;
    stockpile[worker.carryingResource] = (stockpile[worker.carryingResource] ?? 0) + worker.carrying;
  }
  return {
    version: LATEST_SAVE_VERSION,
    tick: clock.tick,
    lastRecruitTick: clock.lastRecruitTick,
    stockpile,
    map: { cols: world.getResource(WorldMap).cols, rows: world.getResource(WorldMap).rows },
    buildings: facts.buildings.map(savedBuildingOf).sort((a, b) => a.id - b.id),
    workers: facts.workers.map(savedWorkerOf).sort((a, b) => a.id - b.id),
    nextEntityId: world.getResource(IdCounter).peek(),
  };
}
```

`src/main.ts`: the three `SaveGameV2` annotations become `SaveGameV3`.

**Re-arm both save tripwires.** `tests/engine/world.test.ts`'s "every
non-derived fact is represented in the save record" tests were disarmed twice
while the save format lagged the sim. They use two separate exclusion arrays:

- `derivedBuilding` (the building test) — Task 2 added `'buffered'`; remove it.
- `DERIVED` (the worker test) — by the time you arrive it holds four entries:
  `'efficiency'`, `'hauling'`, `'haulTargetId'`, `'carrying'`. Remove **only
  `'hauling'`**. The other three stay and are not oversights: `efficiency` is
  recomputed from hunger every tick, and `haulTargetId`/`carrying` are
  runtime-only trip state that deliberately never enters the save (§2.5).

Both fields persist as of this task, so both exclusions come out. These tests
exist to catch a field that never reached the save; a permanent exclusion is
exactly the failure they are meant to prevent. Not optional cleanup.

- [ ] **Step 6: Run the touched files, then the full suite**

Run: `npx vitest run tests/shared/save-migration.test.ts tests/engine/world.test.ts tests/engine/game-engine.test.ts tests/engine/decide-load.test.ts`
Expected: PASS. Existing v2 literals in these files need `buffer: {}` on buildings and `hauling: false` on workers; test titles naming "v2" for the current version become "v3".

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/shared/save.ts src/shared/save-migration.ts src/engine/snapshot-builder.ts src/engine/world.ts src/engine/game-engine.ts src/main.ts tests/
git commit -m "feat(shared,engine): save v3 — buffered goods and hauler assignments persist"
```

---

### Task 7: Layout places haulers where they actually are

**Files:**
- Modify: `src/app/world/layout.ts`
- Test: `tests/app/world-layout.test.ts`

**Interfaces:**
- Consumes: `WorkerSnapshot.hauling`, `haulTargetId`, `carrying` (Task 4).
- Produces: `PlacedWorker.carrying: boolean`; haulers positioned at their target building's doorstep while outbound, at a camp slot otherwise.

The renderer already glides a dot between the positions successive layouts give it. That is the whole trick: put an outbound hauler at its target and a returning one at the camp, and increment 2's walk animation carries the load across the map for free.

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/world-layout.test.ts`:

```ts
describe('hauler placement', () => {
  const haulSnapshot = (overrides: Partial<WorkerSnapshot>) => makeSnapshot({
    buildings: [makeBuilding(1, { defId: 'forester', col: 8, row: 4 })],
    workers: [makeWorker(20, { hauling: true, ...overrides })],
  });

  it('stands an outbound hauler at the building it is walking to', () => {
    const layout = layoutWorld(haulSnapshot({ haulTargetId: 1 }));
    const hauler = layout.workers.find((w) => w.id === 20)!;
    const cell = layout.buildings.find((b) => b.id === 1)!;
    expect(hauler.at).toBe(1);
    expect(hauler.x).toBeCloseTo(cell.col + 0.5);
    expect(hauler.y).toBeGreaterThan(cell.row + 0.5); // on the doorstep, not in the crew's spots
  });

  it('sends a returning hauler back to the camp band', () => {
    const layout = layoutWorld(haulSnapshot({ haulTargetId: null, carrying: 6 }));
    const hauler = layout.workers.find((w) => w.id === 20)!;
    expect(hauler.at).toBeNull();
    expect(hauler.x).toBeLessThan(CAMP_COLS);
    expect(hauler.carrying).toBe(true);
  });

  it('keeps a hauler out of the building crew spots', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'forester', col: 8, row: 4, workerSlots: 2 })],
      workers: [
        makeWorker(1, { buildingId: 1 }),
        makeWorker(2, { buildingId: 1 }),
        makeWorker(20, { hauling: true, haulTargetId: 1 }),
      ],
    }));
    const spots = layout.workers.map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`);
    expect(new Set(spots).size).toBe(3); // nobody standing inside anybody else
  });

  it('parks an outbound hauler at the camp when its target vanished', () => {
    const layout = layoutWorld(haulSnapshot({ haulTargetId: 99 }));
    expect(layout.workers.find((w) => w.id === 20)!.at).toBeNull();
  });
});
```

(`CAMP_COLS` joins the imports from `../../src/shared/placement`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/world-layout.test.ts`
Expected: FAIL — the hauler is placed in the camp regardless of `haulTargetId`, and `carrying` is not on `PlacedWorker`.

- [ ] **Step 3: Place them**

In `src/app/world/layout.ts`, add `carrying: boolean;` to `PlacedWorker`, add the doorstep helper beside `campSpot`:

```ts
/**
 * Where a hauler stands while it is at a building: on the doorstep, below the
 * crew's spots. Deliberately outside the slot machinery — a hauler is a
 * visitor, not staff, and must never displace a worker's remembered slot.
 */
function haulerSpot(cell: BuildingCell): Spot {
  return { x: cell.col + 0.5, y: cell.row + 1.05 };
}
```

In `layoutWorld`, immediately after the building-roster loop and before `const idle = …`:

```ts
  // Outbound haulers stand at their target; returning and idle ones fall
  // through to the camp allocation below. Successive layouts therefore hand
  // the renderer a moving target, and its existing walk animation does the
  // rest — the dot carries the goods across the map on its own.
  for (const w of sorted) {
    if (!w.hauling || w.haulTargetId === null) continue;
    const cell = cellById.get(w.haulTargetId);
    if (cell === undefined) continue; // target demolished: the camp claims them
    placements.set(w.id, { at: w.haulTargetId, slot: HAULER_SLOT, spot: haulerSpot(cell) });
  }
```

with `const HAULER_SLOT = -1;` beside the other layout constants, and the mapped worker gaining `carrying: w.carrying > 0`.

In `heldSlots`, skip visitors so a hauler's sentinel can never enter slot memory:

```ts
    if (placed.slot === HAULER_SLOT) continue;
```

- [ ] **Step 4: Run the target file, then the full suite**

Run: `npx vitest run tests/app/world-layout.test.ts`
Expected: PASS — the pre-existing stability/camp cases plus the 4 new ones.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/layout.ts tests/app/world-layout.test.ts
git commit -m "feat(world): haulers appear where they are — doorstep or camp"
```

---

### Task 8: The colony shows its blockage

**Files:**
- Modify: `src/app/world/theme.ts` (`outputFull` ring)
- Modify: `src/app/world/renderer.ts` (carrying marker)
- Modify: `src/app/labels.ts` (state label)
- Modify: `src/app/components/WorldLegend.vue` (two entries)
- Modify: `styles.css`
- Test: `tests/app/world-theme.test.ts`, `tests/app/world-view.test.ts` (legend assertions)

**Interfaces:**
- Consumes: `BuildingState` including `'outputFull'`, and its `stateRing`/`BUILDING_STATE_LABELS` entries (all Task 2); `PlacedWorker.carrying` (Task 7).
- Produces: the legend entries and the carrying marker.

`stateRing` and `BUILDING_STATE_LABELS` are `Record<BuildingState, …>`, so Task 2 had to fill both the moment it widened the union — leaving them empty would have held typecheck red across six tasks, against this plan's own per-commit gate. This task therefore inherits working values and adds only what is genuinely visual: the legend rows and the carried-load marker.

- [ ] **Step 1: Write the failing tests**

The `outputFull` ring value itself already exists — Task 2 had to add it the
moment it widened `BuildingState`, since `stateRing` is a
`Record<BuildingState, …>`. This test pins it and its distinctness, and passes
on arrival; the RED for this task comes from the legend assertions below.

Append to `tests/app/world-theme.test.ts`:

```ts
  it('gives the output-full stall its own ring, distinct from every other state', () => {
    const theme = resolveWorldTheme(() => '');
    expect(theme.stateRing.outputFull).toBe('#8f6fbf');
    const rings = Object.values(theme.stateRing);
    expect(new Set(rings).size).toBe(rings.length);
  });
```

Append to the legend assertions in `tests/app/world-view.test.ts`:

```ts
    expect(legend.text()).toContain('output full');
    expect(legend.text()).toContain('carrying');
```

- [ ] **Step 2: Run to verify the legend assertions fail**

Run: `npx vitest run tests/app/world-theme.test.ts tests/app/world-view.test.ts`
Expected: the theme test PASSES (Task 2 supplied the value); the world-view legend assertions FAIL — the legend has no such entries yet.

- [ ] **Step 3: Theme, label, legend, marker**

`src/app/world/theme.ts` — in the `stateRing` object built by `resolveWorldTheme`:

```ts
    // Purple, deliberately outside the green/orange production language: this
    // building is not short of anything, it has nowhere to put what it made.
    outputFull: pick(read, '--color-purple', '#8f6fbf'),
```

`src/app/labels.ts`:

```ts
  outputFull: 'Output full',
```

`src/app/components/WorldLegend.vue` — two spans beside the existing state entries:

```html
    <span class="obsisim-chip" :style="{ borderColor: theme.stateRing.outputFull }">output full</span>
    <span class="obsisim-chip is-carrying">carrying</span>
```

`styles.css`:

```css
.obsisim-chip.is-carrying {
  border-style: dashed;
}
```

`src/app/world/renderer.ts` — in the worker-dot sync, a carrying hauler gets a visible load. Beside the existing tool-ring branch:

```ts
    // A carrying hauler reads as "loaded" at a glance, which is what makes the
    // flow direction legible: dots going out are empty, dots coming back are not.
    bundle.load.graphics.visible = w.carrying;
```

with the load actor created in the worker bundle beside the tool ring:

```ts
    const load = new Actor({ pos: vec(0, -WORKER_RADIUS - 3), z: 3 });
    load.graphics.use(new Circle({ radius: 3, color: Color.fromHex(theme.progressFill) }));
    load.graphics.visible = false;
    actor.addChild(load);
```

(Match the file's existing bundle idiom exactly; the renderer stays unit-test-exempt and is covered by the smoke test in Task 14.)

- [ ] **Step 4: Run the target files, then the full suite**

Run: `npx vitest run tests/app/world-theme.test.ts tests/app/world-view.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/theme.ts src/app/world/renderer.ts src/app/labels.ts src/app/components/WorldLegend.vue styles.css tests/
git commit -m "feat(world): the output-full stall and a carried load are visible"
```

---

### Task 9: Store getters — what the colony needs to know about hauling

**Files:**
- Modify: `src/app/stores/game-store.ts`
- Test: `tests/app/game-store.test.ts`

**Interfaces:**
- Consumes: `BuildingSnapshot.buffered`, `state`, `WorkerSnapshot.hauling` (Tasks 2–4).
- Produces: getters `haulerCount: number`, `unitsWaiting: number`, `stalledBuildings: number`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/game-store.test.ts`:

```ts
  it('counts haulers, waiting units, and stalled buildings', () => {
    const store = useGameStore();
    store.ingest(makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 12, state: 'outputFull' }),
        makeBuilding(2, { buffered: 3, state: 'producing' }),
        makeBuilding(3, { buffered: 0, state: 'unstaffed' }),
      ],
      workers: [makeWorker(1, { hauling: true }), makeWorker(2, { hauling: true }), makeWorker(3, {})],
    }), { paused: false, speed: 1, error: null });
    expect(store.haulerCount).toBe(2);
    expect(store.unitsWaiting).toBe(15);
    expect(store.stalledBuildings).toBe(1);
  });

  it('reports zeroes before the first snapshot', () => {
    const store = useGameStore();
    expect(store.haulerCount).toBe(0);
    expect(store.unitsWaiting).toBe(0);
    expect(store.stalledBuildings).toBe(0);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/game-store.test.ts`
Expected: FAIL — `store.haulerCount` is undefined.

- [ ] **Step 3: Add the getters**

In `src/app/stores/game-store.ts`, inside `getters`:

```ts
    /** Workers currently assigned to hauling rather than to a building. */
    haulerCount(state): number {
      return state.snapshot?.workers.filter((w) => w.hauling).length ?? 0;
    },

    /** Goods produced but not yet carried to the store — the haul backlog. */
    unitsWaiting(state): number {
      return state.snapshot?.buildings.reduce((sum, b) => sum + b.buffered, 0) ?? 0;
    },

    /** Buildings that have stopped because they cannot bank another batch. */
    stalledBuildings(state): number {
      return state.snapshot?.buildings.filter((b) => b.state === 'outputFull').length ?? 0;
    },
```

- [ ] **Step 4: Run to verify they pass, then the full suite**

Run: `npx vitest run tests/app/game-store.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/game-store.ts tests/app/game-store.test.ts
git commit -m "feat(app): store surfaces hauler count, backlog, and stalls"
```

---

### Task 10: Hauler controls on the Dashboard

**Files:**
- Modify: `src/app/views/DashboardView.vue`
- Modify: `src/app/views/PopulationView.vue` (haulers currently render as "Idle")
- Modify: `styles.css`
- Create: `tests/app/dashboard-view.test.ts` (the view has no test file yet — this task adds its first)
- Test: `tests/app/population-view.test.ts`

**Also in this task — the Population view must stop calling haulers idle.**
`PopulationView.vue`'s `jobLabel` returns `'Idle'` for any worker with
`buildingId === null`, which is now true of every hauler. Give it a `hauling`
branch returning `'Hauling'`, and pin it with a case in
`tests/app/population-view.test.ts` asserting a hauling worker's row reads
`Hauling` and an idle one still reads `Idle`. A player staffing haulers must
not see them counted as doing nothing.

**Interfaces:**
- Consumes: `haulerCount` (Task 9), commands `assignHauler`/`unassignHauler` (Task 3), `ENGINE_KEY`.
- Produces: `data-test="assign-hauler"`, `data-test="unassign-hauler"`, `data-test="hauler-count"`.

Haulers belong to no building, so the colony-wide view is their home. This is also the no-WebGL path's only way to staff hauling, so it is not optional polish.

- [ ] **Step 1: Write the failing tests**

`DashboardView` has no test file yet, so create `tests/app/dashboard-view.test.ts` — the harness mirrors `tests/app/buildings-view.test.ts`, which is the established shape for a view that dispatches:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestingPinia } from '@pinia/testing';
import DashboardView from '../../src/app/views/DashboardView.vue';
import { ENGINE_KEY } from '../../src/app/engine-key';
import { useGameStore } from '../../src/app/stores/game-store';
import { makeSnapshot, makeWorker } from './fixtures';

function mountDashboard() {
  const engine = { dispatch: vi.fn() };
  const wrapper = mount(DashboardView, {
    global: {
      plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: false })],
      provide: { [ENGINE_KEY as symbol]: engine },
    },
  });
  return { engine, wrapper };
}

describe('DashboardView', () => {
  it('shows the hauler count and dispatches both hauler commands', async () => {
    const { wrapper, engine } = mountDashboard();
    useGameStore().ingest(makeSnapshot({
      workers: [makeWorker(1, { hauling: true }), makeWorker(2, {})],
    }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="hauler-count"]').text()).toContain('1');
    await wrapper.find('[data-test="assign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'assignHauler' });
    await wrapper.find('[data-test="unassign-hauler"]').trigger('click');
    expect(engine.dispatch).toHaveBeenCalledWith({ type: 'unassignHauler' });
  });

  it('disables removing a hauler when there are none', async () => {
    const { wrapper } = mountDashboard();
    useGameStore().ingest(makeSnapshot({ workers: [makeWorker(1, {})] }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect((wrapper.find('[data-test="unassign-hauler"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/dashboard-view.test.ts`
Expected: FAIL — no such elements.

- [ ] **Step 3: Add the controls**

`src/app/views/DashboardView.vue` — script gains:

```ts
import { inject } from 'vue';
import { ENGINE_KEY } from '../engine-key';

const engine = inject(ENGINE_KEY)!;
```

and the headline row gains a control group:

```html
      <span class="obsisim-haulers">
        Haulers: <strong data-test="hauler-count">{{ store.haulerCount }}</strong>
        <button
          data-test="unassign-hauler"
          :disabled="store.haulerCount === 0"
          title="Send a hauler back to the idle camp"
          @click="engine.dispatch({ type: 'unassignHauler' })"
        >−</button>
        <button
          data-test="assign-hauler"
          :disabled="store.snapshot.idleWorkers === 0"
          title="Put an idle worker on hauling duty"
          @click="engine.dispatch({ type: 'assignHauler' })"
        >+</button>
      </span>
```

`styles.css`:

```css
.obsisim-haulers button {
  margin-left: 0.25em;
  min-width: 1.8em;
}
```

- [ ] **Step 4: Run the target file, then the full suite**

Run: `npx vitest run tests/app/dashboard-view.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/DashboardView.vue styles.css tests/app/dashboard-view.test.ts
git commit -m "feat(app): staff hauling from the dashboard"
```

---

### Task 11: The Buildings table shows the backlog

**Files:**
- Modify: `src/app/views/BuildingsView.vue`
- Test: `tests/app/buildings-view.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/app/buildings-view.test.ts`:

The file's `mountView(stock, state)` builds one fixed building, so give it a third parameter for the rest of that building's fields:

```ts
function mountView(
  stock: { wood?: number } = {},
  state: BuildingState = 'producing',
  building: Partial<BuildingSnapshot> = {},
) {
```

and merge it into the existing `makeBuilding` call:

```ts
    buildings: [makeBuilding(7, { defId: 'forester', workers: 1, workerSlots: 2, state, progress: 1, batchActive: true, progressPct: 33, workPower: 1, col: 5, row: 2, ...building })],
```

Then the new test:

```ts
  it('shows waiting units and names the output-full stall', async () => {
    const { wrapper } = mountView({}, 'outputFull', { buffered: 12 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="waiting-7"]').text()).toBe('12');
    expect(wrapper.text()).toContain('Output full');
  });
```

(`BuildingSnapshot` joins the type imports from `../../src/shared/snapshot`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/buildings-view.test.ts`
Expected: FAIL — no waiting column.

- [ ] **Step 3: Add the column**

`src/app/views/BuildingsView.vue` — the existing-buildings header gains `<th>Waiting</th>` after `Tile`, the row gains

```html
          <td :data-test="`waiting-${b.id}`">{{ b.buffered }}</td>
```

and the row element gains `:data-test="`building-row-${b.id}`"`. The empty-colony row's `colspan` grows by one.

- [ ] **Step 4: Run, then the full suite**

Run: `npx vitest run tests/app/buildings-view.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/BuildingsView.vue tests/app/buildings-view.test.ts
git commit -m "feat(app): buildings table shows what is waiting to be hauled"
```

---

### Task 12: The selection panel lists what is waiting

**Files:**
- Modify: `src/app/components/SelectionPanel.vue`
- Test: `tests/app/selection-panel.test.ts`

**Interfaces:**
- Consumes: `BuildingSnapshot.buffered` (Task 2).
- Produces: `data-test="selection-waiting"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/selection-panel.test.ts`:

The file's `mountPanel(buildingId)` builds its own fixture, so give it an overrides parameter:

```ts
function mountPanel(buildingId = 7, building: Partial<BuildingSnapshot> = {}) {
```

merged into its `makeBuilding` call as `..., ...building })`. Then:

```ts
  it('reports the goods waiting at the selected building', async () => {
    const wrapper = mountPanel(7, { buffered: 4 });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="selection-waiting"]').text()).toContain('4');
  });
```

(`BuildingSnapshot` joins the type imports from `../../src/shared/snapshot`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/selection-panel.test.ts`
Expected: FAIL — no such element.

- [ ] **Step 3: Add the line**

`src/app/components/SelectionPanel.vue`, beside the staffing line:

```html
    <div data-test="selection-waiting">Waiting: {{ building.buffered }}</div>
```

- [ ] **Step 4: Run, then the full suite**

Run: `npx vitest run tests/app/selection-panel.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/SelectionPanel.vue tests/app/selection-panel.test.ts
git commit -m "feat(app): the selection panel reports waiting goods"
```

---

### Task 13: The Economy view answers "why did production drop?"

**Files:**
- Modify: `src/app/views/EconomyView.vue`
- Modify: `styles.css`
- Test: `tests/app/economy-view.test.ts`

**Interfaces:**
- Consumes: `unitsWaiting`, `stalledBuildings`, `haulerCount` (Task 9).

This is the diagnostic the spec insists ships with the mechanic rather than after it: under-hauling must never be an invisible sag.

- [ ] **Step 1: Write the failing tests**

Append to `tests/app/economy-view.test.ts`:

```ts
  it('states the haul backlog and how many buildings it has stopped', async () => {
    const wrapper = mountEconomy();
    useGameStore().ingest(makeSnapshot({
      buildings: [
        makeBuilding(1, { buffered: 12, state: 'outputFull' }),
        makeBuilding(2, { buffered: 6, state: 'producing' }),
      ],
      workers: [makeWorker(1, { hauling: true })],
    }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    const haul = wrapper.find('[data-test="haul-pressure"]').text();
    expect(haul).toContain('18');
    expect(haul).toContain('1 stalled');
    expect(haul).toContain('1 hauler');
  });

  it('says the colony is keeping up when nothing waits', async () => {
    const wrapper = mountEconomy();
    useGameStore().ingest(makeSnapshot({ buildings: [makeBuilding(1, { buffered: 0 })] }), { paused: false, speed: 1, error: null });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-test="haul-pressure"]').text()).toContain('keeping up');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/economy-view.test.ts`
Expected: FAIL — no `haul-pressure` element.

- [ ] **Step 3: Add the block**

`src/app/views/EconomyView.vue` — script:

```ts
// One sentence, because a number nobody can interpret is not a diagnostic:
// this is the answer to "my production fell and I did not change anything".
const haulPressure = computed(() => {
  if (store.unitsWaiting === 0) return 'Hauling is keeping up: nothing is waiting at a building.';
  const haulers = `${store.haulerCount} hauler${store.haulerCount === 1 ? '' : 's'}`;
  const stalled = `${store.stalledBuildings} stalled`;
  return `${store.unitsWaiting} units waiting for collection — ${stalled} — ${haulers} on duty.`;
});
```

template, above the chain table:

```html
    <p
      class="obsisim-haul-pressure"
      data-test="haul-pressure"
      :class="{ 'obsisim-negative': store.stalledBuildings > 0 }"
    >{{ haulPressure }}</p>
```

`styles.css`:

```css
.obsisim-haul-pressure {
  margin: 0 0 0.75em;
}
```

- [ ] **Step 4: Run, then the full suite**

Run: `npx vitest run tests/app/economy-view.test.ts`
Expected: PASS.

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/app/views/EconomyView.vue styles.css tests/app/economy-view.test.ts
git commit -m "feat(app): the economy view explains a haul backlog"
```

---

### Task 14: The smoke test watches a haul cycle

**Files:**
- Modify: `scripts/world-smoke-harness/main.ts`
- Modify: `scripts/world-smoke.mjs`

**Interfaces:**
- Consumes: the snapshot fields from Tasks 2–4.

Neither file is covered by vitest or `tsconfig`, so a signature slip here surfaces only in the Chromium run — transcribe carefully and keep the phase indices in the harness and the runner in exact agreement.

- [ ] **Step 1: Extend the harness fixtures**

`scripts/world-smoke-harness/main.ts` — `building()` gains `buffered = 0` (positional, after `row`), passed into the snapshot object; `worker()` gains `hauling`, `haulTargetId`, `carrying` in its overrides object with defaults `false`, `null`, `0`; `snap()` is unchanged.

Append two phases to the end of the `phases` array (the current final phase is `dispose()` — insert before it and renumber the runner accordingly):

```ts
  // hauler walking out to a backed-up building, then the same hauler home
  // with a load: two snapshots is all the renderer needs to animate a trip
  () => renderer.sync(snap(5,
    [building(1, 'forester', 4, 1, 12), building(2, 'farm', 6, 1)],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { hauling: true, haulTargetId: 1 })])),
  () => renderer.sync(snap(6,
    [building(1, 'forester', 4, 1, 6), building(2, 'farm', 6, 1)],
    [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { hauling: true, carrying: 6 })])),
```

- [ ] **Step 2: Assert the cycle in the runner**

`scripts/world-smoke.mjs` — after the existing colony phases and before the reset phases, with every later `step(n)` index shifted by two:

```js
await step(6); // hauler walks out to the backed-up forester
await wait(400);
const outbound = await shot();
check('a hauler walking out changes the scene', !outbound.equals(resumed));

await step(7); // same hauler, home with a load
await wait(2500); // the walk back settles
const delivered = await shot();
check('the hauler returns to camp carrying its load', !delivered.equals(outbound));
```

- [ ] **Step 3: Run the smoke test**

Run: `npm run smoke:world`
Expected: `world-smoke: all green`, with the two new checks listed. (Chromium lives at `/opt/pw-browsers/chromium`; `npm install --no-save playwright-core` if the runner reports it missing.)

- [ ] **Step 4: Commit**

```bash
git add scripts/world-smoke-harness/main.ts scripts/world-smoke.mjs
git commit -m "test(world): the browser smoke test watches a haul cycle"
```

---

### Task 15: README, full gates, coverage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the increment**

Add after the Increment 3 section, and amend Increment 3's last bullet to note that positions became meaningful in increment 4:

```markdown
### Increment 4 — logistics

- Goods stop teleporting: a building banks what it makes in its own output
  buffer and stalls (**Output full**) when that buffer fills
- Haulers are a staffed role — assign them on the Dashboard — who walk to the
  fullest building, load up, and carry goods back to the camp store
- Distance is now a real cost: a building beside the camp is a one-tick walk,
  the far corner is thirteen, so where you build changes what you get
- The Economy view names the backlog — units waiting, buildings stalled,
  haulers on duty — so a production drop is never a mystery
- Save v3 persists buffers and hauler assignments; v2 colonies load as
  themselves, with empty buffers and nobody hauling yet
```

Add the spec and plan to the documentation list.

- [ ] **Step 2: Full gate battery**

Run: `npm run check:all`
Expected: all green — lint, `check:loc`, `check:css`, `check:quality` ("quality ratchet ok", maintainability ≥ 90.7), typecheck, test, build, `check:artifacts`.

Run: `npm run test:coverage`
Expected: green, floors met on `src/engine/**`, `src/shared/**`, `src/app/stores/**`.

Run: `rm -rf coverage && npm run check:quality`
Expected: "quality ratchet ok" — the coverage/ gotcha, cleared before it can skew the analysis.

Run: `npm run smoke:world`
Expected: `world-smoke: all green`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README for increment 4 — logistics"
```

---

## Increment 4 — Logistics

**Spec coverage:** §2.1 output buffers → Task 2; §2.2 camp store → Tasks 2, 4; §2.3 haulers → Tasks 3–5; §2.4 the haul rule module → Task 1; §2.5 save v3 → Task 6; §2.6 snapshot and canvas → Tasks 4, 7, 8; §2.7 tables, panel, dashboard → Tasks 9–13; §2.8 testing and gates → per-task cycles + Tasks 14, 15.

**Acceptance criteria coverage:** 1 → Task 2; 2 → Tasks 3, 4, 10, 14; 3 → Tasks 1, 4; 4 → Tasks 9, 13; 5 → Task 4; 6 → Task 6; 7 → Task 5; 8 → Tasks 10–13.
