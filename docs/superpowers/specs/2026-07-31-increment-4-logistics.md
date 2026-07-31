# Spec: Increment 4 — Logistics

**Date:** 2026-07-31
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 3 (player building placement, PR #5, merged)

---

## 1. Why this increment exists

Increment 3 made position sim truth: the player places, moves, and demolishes
buildings on a fixed 24×16 map, and those tiles persist. But that spec took a
deliberate decision — *"Positions are gameplay-neutral. Production, efficiency,
and hunger are untouched — a mill produces identically anywhere."* Space is
real and recorded, and it means nothing.

Two things are true of the colony today, and both are about to change:

- `ProductionSystem` pays a recipe's inputs out of one global `Stockpile` and
  adds its outputs back the same tick. Goods teleport.
- The worker dots that walk across the canvas — the whole animation apparatus
  built in increment 2 — are decoration. Nothing in the simulation cares that a
  worker is *between* two places.

This increment makes distance cost something by making goods physically move.
Production output lands at the building that made it and has to be carried to
the camp before the colony can spend it. Carrying is a job the player staffs.
Layout stops being decoration and becomes a decision: a forester in the far
corner is genuinely worse than one beside the camp, and the reason is visible
on the canvas rather than hidden in a multiplier.

### 1.1 Product decisions taken for this increment

- **Goods physically move.** The alternative — an abstract haul-capacity
  multiplier — was rejected: it would have left the dots decorative and the
  cost invisible.
- **Haulers are an assigned role**, not automatic behavior of idle workers.
  The player decides the producer/hauler split explicitly, the same way they
  decide building staffing.
- **One hub: the camp.** The global `Stockpile` is reinterpreted as the
  contents of the camp store — a real place at a real tile — rather than being
  replaced. Inputs still draw from it instantly.
- **Output-side only.** Buildings push finished goods out; nobody delivers
  inputs in. Two-way haul is the natural successor, not this increment.
- **Under-hauling stalls production visibly.** A building whose output buffer
  is full stops working and says so, in the canvas state colour, the table, and
  the Economy view.

### 1.2 Explicitly out of scope

Storage buildings and their capacity, input delivery (two-way haul), roads,
terrain and pathfinding (straight-line distance only), hunger or efficiency
affecting walk speed, player-authored haul routes or per-resource priorities,
carts and vehicles, and balance tuning beyond the documented starting values
(that stays increment 5's domain, alongside the flagged demolition-refund knob).

---

## 2. Requirements

### 2.1 Output buffers

- New component `OutputBuffer` on every building entity: amounts per resource,
  bounded by `BALANCE.outputBufferCap` **counted as the total across all
  resources** (buildings produce one resource today; the total rule keeps the
  cap meaningful if a recipe ever yields two).
- `ProductionSystem` deposits a completed batch into the building's own
  `OutputBuffer` instead of calling `stockpile.add`.
- **A batch completes only if the buffer has room for all of its outputs.**
  Otherwise the building holds at full progress in a new `outputFull` state:
  the work is done and waiting on a cart. Progress is neither lost nor banked
  further, and the building resumes the tick after a hauler makes room.
- Buffer contents are **not** colony wealth and not spendable: they are not in
  the stockpile yet. `colonyWealth` and every stock reading stay stockpile-only,
  so no existing economic number changes meaning.

### 2.2 The camp is the store

- `Stockpile` keeps its class, its API, and its role as the colony's single
  ledger. It is now *the contents of the camp store*, located at
  `CAMP_TILE = { col: 2, row: 0 }` — the sim counterpart of the tent the layout
  already anchors at tile-space `(2, 0.75)`.
- Everything that reads or writes the stockpile is unchanged by this increment:
  hunger meals, construction costs, demolition refunds, wealth, stats, save.
  Goods do not change what they are; they change what they must reach.

### 2.3 Haulers

- `JobAssignment` gains `hauling: boolean`. A hauler holds `buildingId: null`
  and `hauling: true`; an idle worker holds both empty. The three worker states
  are therefore idle, assigned to a building, and hauling — mutually exclusive
  by construction.
- Two new commands mirroring the existing worker pair, including notice
  doctrine (exactly one notice per drained command, after the state change):
  - `assignHauler` — promotes the first idle worker, the same selection rule
    `assignWorker` already uses. Success: `Assigned a hauler.` Rejection when
    nobody is idle: `No idle workers available.` (the existing wording, reused).
  - `unassignHauler` — returns one hauler to idle. Success:
    `Unassigned a hauler.` Rejection: `No hauler to unassign.`
- A hauler's trip lives in a runtime-only `HaulTrip` component present on every
  worker (idle for non-haulers): target building id, phase, ticks remaining,
  and the single resource plus amount being carried. **`HaulTrip` never enters
  the save** — see §2.5.
- `HaulSystem` runs each tick, after `ProductionSystem` (goods produced this
  tick are claimable immediately) and before `StatsSystem` (a deposit counts in
  the tick's flows) and `SnapshotSystem`. Per hauler:
  1. **Idle at camp** → claim a job, set phase `outbound` with
     `ticksLeft = haulTicks(building tile)`.
  2. **Outbound** → decrement; on reaching zero, load
     `min(BALANCE.haulCarryCapacity, buffered)` of the resource the building
     holds most of (ties by catalog order), remove it from the buffer, set
     phase `returning` with a freshly computed `ticksLeft`.
  3. **Returning** → decrement; on reaching zero, `stockpile.add` the load and
     return to idle.
- Haulers are workers in every other respect: they age, eat from the camp
  store, and starve like anyone else. Hunger does not change walk speed this
  increment (§1.2) — a starving hauler carries the same load at the same pace,
  and that coupling is increment 5's to consider.
- **Job selection is a pure, deterministic function of world state:** among
  buildings with unclaimed buffered goods, most-buffered first, then nearest to
  camp, then lowest building id. "Unclaimed" subtracts what haulers already
  outbound to that building will take, so several haulers may serve one
  badly-backed-up building without converging pointlessly on a single unit.
  No randomness, no iteration-order dependence, no memory between ticks beyond
  the components themselves.

### 2.4 The haul rule exists exactly once

A pure module `src/shared/haul.ts` owns the spatial law of hauling, exactly as
`placement.ts` owns the law of placement, and imports nothing:

- `CAMP_TILE`, and `haulDistance(tile)` — Euclidean distance in tiles from the
  camp, matching the straight line the renderer visibly walks.
- `haulTicks(tile, tilesPerTick)` — `max(1, ceil(haulDistance(tile) / tilesPerTick))`,
  the one-way trip length. A building adjacent to the camp still costs a tick;
  nothing is free. The rate arrives as an argument, never as an import.
- `claimableAt(buffered, claimed)` and the comparator that orders candidate
  buildings, so the engine's authoritative selection and any UI that previews
  haul pressure cannot disagree.

The balance constants themselves stay in `BALANCE` (engine content); `haul.ts`
takes them as arguments, preserving the shared-layer rule that it imports
nothing.

### 2.5 Save v3 and migration

- `SavedBuilding` gains `buffer` (partial resource → amount map, omitted when
  empty); `SavedWorker` gains `hauling`.
- The migration chain gains its second real step, v2→v3: buffers empty,
  `hauling: false` — which is precisely what a v2 colony was. `LATEST_SAVE_VERSION`
  becomes 3 with the same self-policing literal type.
- `isSaveGameV3` validates buffer shape structurally (known resource ids,
  safe non-negative integers); `isLoadableSave` adds the cross-field truth:
  a building's buffered total may not exceed `outputBufferCap`.
- **A hauler caught mid-trip deposits its load into the camp store at save
  time.** This is a deliberate simplification, not an oversight: conservation
  stays exact, `HaulTrip` stays out of the save format and out of the load
  guards, and the alternative — four persisted fields plus their validation and
  referential checks — buys fidelity no player can perceive. On load, haulers
  stand at camp and claim afresh; job selection is deterministic from persisted
  state, so a reloaded colony resumes identically.

### 2.6 Snapshot and canvas

- `BuildingSnapshot` gains `buffered` (total units waiting); `outputFull` joins
  the state union.
- `WorkerSnapshot` gains `hauling`, `haulTargetId` (`null` when idle or
  returning), and `carrying` (units, 0 when empty).
- Hauler counts and haul pressure derive in the app store rather than widening
  the snapshot.
- **Layout:** a hauler is placed at its target building's worker spot while
  outbound, and at a camp slot while returning or idle. The renderer's existing
  walk animation glides the dot between successive positions with no new
  machinery — increment 2's motion apparatus finally carries meaning.
- A carrying hauler is drawn with a distinct marker so flow direction reads at
  a glance. The renderer stays a dumb drawer: no haul logic, no dispatch.

### 2.7 Tables, panel, dashboard — no-WebGL parity holds

The fallback path must stay able to run the whole colony (the promise made in
increment 3 §1.1 and kept by its table demolition):

- **Dashboard**: hauler count with add/remove controls, dispatching
  `assignHauler`/`unassignHauler`. Haulers belong to no building, so this is
  their home.
- **Buildings table**: a `Waiting` column (buffered units) and `Output full`
  in the state column.
- **Selection panel**: the selected building's buffered goods.
- **Economy view**: the diagnostic that keeps the system legible — total units
  waiting and how many buildings are stalled on output. This is the answer to
  "why did my production drop?", and it is in scope, not deferred.
- **Legend**: an entry for the `outputFull` state colour.

### 2.8 Testing and gates

- `src/shared/haul.ts` gets exhaustive unit tests, as `placement.ts` did:
  distance, tick rounding (including the never-free minimum), ordering, and
  claim arithmetic.
- `HaulSystem` gets tick-by-tick trip tests and explicit **determinism** tests:
  identical world state yields identical claims.
- `ProductionSystem` gets buffer-fill, `outputFull` stall, and
  resume-after-haul cases.
- These edge cases are pinned by tests, not discovered later — most fall out of
  increment 3's own features:
  - a building **moved** mid-trip: the hauler retargets and `ticksLeft`
    recomputes from the new distance, matching what the dot visibly does;
  - a source **demolished** mid-trip: the trip cancels, any loaded goods go to
    the camp store, the hauler returns idle — riding the existing same-tick
    `demolishedIds` machinery;
  - a hauler **unassigned** mid-trip: same disposal rule;
  - a buffer **emptied by another hauler** before arrival: the trip completes
    empty rather than thrashing;
  - **colony reset**: buffers and haul state clear with the timeline.
- Save v3 gets round-trip, v2→v3 migration, and guard-rejection tests.
- The browser smoke test gains a haul cycle: a dot leaves camp, reaches a
  building, and returns.
- All existing gates hold: `npm run check:all` green (fallow counters pinned at
  zero, maintainability floor 90.7), coverage floors unchanged
  (`src/engine/**`, `src/shared/**`, `src/app/stores/**` at 90/85/90/90),
  every file under 500 nonblank lines, no new `!important`, no new dependencies,
  artifact budgets untouched, and the boundary zones intact — `src/shared/**`
  imports nothing outside itself, the app never imports `sim-ecs`, and
  engine/shared never import `vue`/`excalibur`/`obsidian`.

---

## 3. Acceptance criteria

1. A building with a full output buffer stops producing, reports `outputFull`,
   and resumes the tick after a hauler frees space.
2. Assigning a hauler from the Dashboard produces exactly one notice; the
   hauler walks to a backed-up building, loads, returns to camp, and the goods
   appear in the stockpile — visible as a dot leaving and returning on the
   canvas.
3. Two buildings at different distances from the camp, otherwise identical,
   deliver at measurably different rates through the same number of haulers.
4. With zero haulers assigned, every producing building eventually stalls, and
   the Economy view states how many are stalled and how many units wait.
5. Job selection is deterministic: the same world state produces the same
   claims across runs and across a save/load cycle.
6. A v2 save loads as a v3 colony with empty buffers and no haulers, its
   buildings exactly where increment 3 left them.
7. Moving or demolishing a building mid-trip resolves per §2.8 without losing
   or duplicating a single unit of goods.
8. The colony remains fully playable from the tables with no canvas: haulers
   assignable, waiting units and stalls visible.

---

## 4. Balance starting values

Documented as starting points, tuned in increment 5:

| Constant | Value | Reasoning |
| --- | --- | --- |
| `outputBufferCap` | 12 | ~18 ticks of a two-worker forester before stalling — long enough to be forgiving, short enough that neglect bites. |
| `haulCarryCapacity` | 6 | Two trips clear a full buffer. |
| `haulTilesPerTick` | 2 | A building beside the camp is a 1-tick walk; the far corner is ~13. One hauler roughly sustains one far producer, or several near ones. |
| `CAMP_TILE` | `{ col: 2, row: 0 }` | The tent's existing tile-space anchor, so sim cost and drawn distance agree. |

The gradient these produce is the point: near buildings are cheap to serve, far
ones demand real hauler investment, and the player feels the difference as
stalled production rather than as an invisible coefficient.
