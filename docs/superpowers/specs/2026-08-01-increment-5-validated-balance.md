# Spec: Increment 5 — Validated Balance

**Date:** 2026-08-01
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 4 (logistics — output buffers and haulers, PR #6, merged)

---

## 1. Why this increment exists

Increment 4 shipped the mechanic that makes space cost something: goods pile up
at the building that made them, and a hauler has to walk them to the camp. Its
own spec (§4) documented three constants as **"starting points, tuned in
increment 5"** — `outputBufferCap`, `haulCarryCapacity`, `haulTilesPerTick` —
and justified them with a claim about how the colony would play.

Nobody could check that claim. The engine is headless and deterministic, but
nothing ran it as an experiment, so "tuned" could only ever have meant "adjusted
until it felt right in a browser". This increment builds the instrument first,
then reports what it measures, and pins the answer so a later constant change
cannot quietly undo it.

The first measurement already found two things.

### 1.1 The documented reasoning was wrong

Spec §4 claims `haulTilesPerTick: 2` means *"One hauler roughly sustains one far
producer, or several near ones."* Measured against one fully staffed forester
(2 workers, ceiling 400 wood over 600 ticks):

| leg (ticks each way) | 1 hauler | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| 1 (beside camp) | **100%** | 100% | 100% | 100% |
| 4 | **99%** | 99% | 99% | 99% |
| 8 | 53% (50% stalled) | **98%** | 98% | 98% |
| 13 (far corner) | 33% (68% stalled) | 65% | **96%** | 96% |

A far producer needs **three** haulers, not one. The arithmetic is plain once
stated: a 2-worker forester makes 0.667 wood/tick, one hauler moves
`haulCarryCapacity / (2 × leg)` = `3 / leg` per tick, and the two cross at
leg ≈ 4.5.

The *gradient* is good — near buildings are free, mid-distance costs a second
hauler, the far corner costs a third. That is exactly the "distance is a real
investment" pressure increment 4 wanted. Only the stated reasoning was wrong, so
this increment corrects the document rather than the constants.

### 1.2 Haul pressure is currently opt-in

`handleMoveBuilding` charges nothing: relocation is instant, free, to any
buildable tile, and the output buffer survives it. With ~336 buildable tiles and
no spacing rule, a player can cluster every building beside the camp and never
need a second hauler. Increment 4's central mechanic is therefore **optional** —
the gradient above exists but need never be felt.

This also disposes of a knob increment 4 flagged for tuning here. Whether
demolition should keep refunding 100% of construction cost barely matters while
free relocation dominates it: nobody demolishes to fix a placement, they move.

## 2. Requirements

### 2.1 The balance harness

`tests/support/balance-harness.ts` exposes a pure function that runs a scenario
and returns metrics. A scenario is a plain descriptor — building def, tile,
crew size, hauler count, tick count — and the run boots a headless colony,
steps `ALL_SYSTEMS`, and reports:

| metric | meaning |
| --- | --- |
| `made` | units banked into output buffers (gross production) |
| `delivered` | units that reached the stockpile |
| `stalledTicks` | ticks the building spent in `outputFull` |
| `relocatingTicks` | ticks the building spent unable to work after a move |
| `haulerIdleTicks` | hauler-ticks spent at the camp with no trip |
| `finalBuffer` | units still waiting at the building when the run ended |

It must be **deterministic**: no wall-clock, no randomness, no dependence on
entity iteration order. Two runs of one scenario return identical numbers, and
a scenario is reproducible from its descriptor alone.

Workers are fed from a large berry stock so hunger does not confound throughput.
That is a property of the harness, stated here because it is a real limitation:
this instrument measures logistics, not starvation.

### 2.2 Two consumers, one module

- **`tests/engine/balance.test.ts`** asserts the curve of §1.1 as a regression
  test: one hauler reaches ≥95% of the production ceiling at leg ≤ 4, two are
  needed by leg 8, three by leg 13. It runs in `npm test`, so a constant change
  that flattens or inverts the gradient fails CI with a named expectation
  rather than a silent shift in feel.
- **`npm run balance:report`** runs that same file with `BALANCE_REPORT=1` set,
  which prints the full sweep table for a human tuning by eye. No new
  dependency, and no table printed during an ordinary test run.

Assertions are on **thresholds the gradient implies**, not on exact unit counts.
A test that pins `delivered === 394` would fail on any unrelated recipe change
and would teach nobody anything; a test that pins "one hauler is not enough at
leg 8" states the design intent.

### 2.3 Relocation costs downtime

A new `Relocation { ticksLeft }` component, attached in `buildingComponents`
(one edit, since increment 5 already unified the spawn paths — OBS-4-02).

`handleMoveBuilding` sets:

```
ticksLeft = max(1, ceil(tilesMoved / BALANCE.relocationTilesPerTick))
```

`tilesMoved` is the Euclidean distance from the old tile to the new one — the
same measure `haulDistance` uses, so "moving costs what walking costs" is one
idea the player learns once. The floor of 1 means even a one-tile nudge costs
something, while staying cheap enough that iterating on a layout is not
punished — the failure mode a flat fee would have.

**Moving a building that is already relocating replaces its remaining downtime,
it does not add to it.** `ticksLeft` is recomputed from the new move's distance.
Accumulating would let a player trap a building indefinitely by accident, and
the cost the player is paying is "this building is out of action until it has
travelled", which the recomputation states exactly.

`relocationTilesPerTick` starts at **1** — half the hauler rate, because
carrying a building is harder than carrying goods. It is a starting point in
exactly the sense §1 objects to, so it is the first thing the harness is pointed
at, and §4 records what it measured rather than what it hoped.

Rules:

- **`ProductionSystem` decrements `ticksLeft` and skips the building while it is
  above zero.** The downtime is a production stall, so it is enforced where
  production stalls are enforced, not in a new system with a new ordering
  question.
- **Haulers still collect from a relocating building.** Goods already in the
  buffer exist regardless of whether the crew is working; only production
  pauses. A relocating building with a full buffer therefore drains normally.
- **`BuildingState` gains `'relocating'`**, taking priority over `outputFull`
  and `unstaffed`. It is the reason nothing is happening, so it is what the
  player should be told.

### 2.4 Relocation is saved, not runtime-only

`SavedBuilding` gains `relocatingTicks`, and the save format goes to **v4** with
a v3 migration defaulting it to 0.

`HaulTrip` is deliberately runtime-only, and the tempting move is to copy that.
It does not transfer. A hauler caught mid-trip banks its carried load into the
saved stockpile, so reloading gains the player nothing. Relocation downtime is a
**penalty already incurred**; leaving it out of the save would let save-and-
reload cancel it. The migration is trivial and the precedent (v1→v2→v3) is
established.

Load-guard treatment follows the existing principle: `relocatingTicks` is
balance-coupled, so it is **clamped at load** in `buildingComponents`
(`src/engine/spawn.ts`) alongside `progress` and the buffer, not bounds-checked
in `isLoadableSave`. A save written under a slower `relocationTilesPerTick`
still loads, with its downtime brought down to what current balance allows.
`buildInitialSnapshot` mirrors the clamp through the same shared function, so
the seeded snapshot cannot disagree with the entities actually spawned.

### 2.5 Made vs delivered

Increment 4 changed what the stockpile's flow statistics mean — they became
store inflow, not gross production — and increment 5 already renamed the UI
column to `Delivered/t` (OBS-4-06). The schema still lies.

- A new `ProductionLedger` resource records units banked into a buffer.
  `ProductionSystem` writes it; `StatsSystem` folds it into a third
  `StatsHistory` series and resets it, exactly as it already does for the
  stockpile's per-tick flows.
- **`ResourceStats.productionRate` is renamed `deliveredRate`**, and a new
  `madeRate` joins it. `netFlow` keeps its meaning (`deliveredRate −
  consumptionRate`): the store's net movement is what a runway is computed
  from, and goods sitting in a buffer are not in the store.
- The Economy view gains a **`Made/t`** column beside `Delivered/t`. The gap
  between the two is the per-stage haul backlog — the diagnostic increment 4's
  spec says the player is owed, and which the aggregate haul-pressure line
  cannot give per stage.

The rename is the larger part of this section and is deliberate: OBS-4-06's
finding was that the *name* described something the number no longer measured.
Fixing the label and leaving the field called `productionRate` would leave the
same defect one layer down, where the next reader meets it first.

### 2.6 Demolition keeps its full refund

Decided, not deferred: `handleDemolishBuilding` continues to refund 100% of
construction cost, and continues to destroy the output buffer while naming the
loss (OBS-4-07's resolution stands untouched).

The reasoning is §1.2. The refund is not a meaningful balance knob while
relocation is free, and now that relocation costs downtime the two acts are
cleanly separated: **moving costs time, removing is fully refunded.** Demolition
is for a building you no longer want, not for fixing a placement, and taxing it
would only push players toward move — which is now the priced action.

A test pins the 100% refund so the decision is recorded in code rather than only
in prose.

### 2.7 Testing and gates

- Every new behaviour is mutation-tested: break the feature, confirm the named
  test fails, restore. This is the review bar (`docs/process/agent-workflow.md`).
  Assertions must **discriminate** — fixture values chosen so that binding to a
  neighbouring field changes the result.
- No vitest test may import `src/app/world/renderer.ts` or `graphics-cache.ts`.
  Relocation's canvas appearance is covered by `npm run smoke:world`, and its
  fixture phases change **one thing each**.
- `npm run check:all` green; `worstSrcFileMaintainability` may not drop below
  its locked floor. Baselines are never `--update`d to make a gate pass — the
  gate now refuses that without `--allow-regression`.
- Save v4 needs round-trip and migration tests: a v3 save loads with
  `relocatingTicks` 0, a mid-relocation v4 save round-trips intact.

### 2.8 Explicitly out of scope

- **No new buildings, resources, or chains.** This increment measures and
  prices what exists.
- **No spacing or footprint rules.** Constraining clustering was considered as
  an alternative to pricing relocation and rejected as the larger change: it
  touches placement rules, the ghost preview, auto-placement, and every existing
  save's layout validity.
- **The tick-interval sync seam stays deferred.** The renderer still measures
  the gap between syncs to pace a hauler's dot, clamped to [50, 1000] ms. Passing
  the interval down from the store would remove the heuristic and make it
  testable; it is unrelated to this increment's theme (OBS-4-09's note records
  it).
- **No change to the three haul constants** unless the harness produces a
  specific reason. "Validated" is a legitimate outcome of measuring.

## 3. Acceptance criteria

1. `npm run balance:report` prints the distance/hauler sweep. `npm test`
   includes a pinned curve that fails when a constant change breaks the
   gradient, naming which threshold moved.
2. Moving a forester 10 tiles halts its production for ~10 ticks; the building
   reads `relocating` with a remaining-tick countdown in the Buildings table and
   the selection panel, and is distinguishable on the canvas.
3. Haulers continue to collect from a relocating building's buffer while its
   production is paused.
4. A save written mid-relocation reopens still relocating with its remaining
   ticks intact; a v3 save loads with `relocatingTicks` 0.
5. A fully staffed forester with no haulers shows `Made/t` > 0 against
   `Delivered/t` = 0 — the pairing OBS-4-06 identified, now legible as a
   backlog rather than a contradiction.
6. Demolishing a building still refunds 100% of its construction cost, pinned
   by a test.
7. Spec §4 of the increment-4 document is corrected: its hauler claim is
   replaced with the measured curve.

## 4. Balance values

Measured, not assumed. The three inherited constants are **unchanged** — §1.1
found their gradient sound and only their documented justification wrong.

| Constant | Value | Status |
| --- | --- | --- |
| `outputBufferCap` | 12 | Validated: ~18 ticks of a 2-worker forester before stalling, matching its original claim. |
| `haulCarryCapacity` | 6 | Validated: two trips clear a full buffer. |
| `haulTilesPerTick` | 2 | Validated as a *gradient* — 1 hauler to leg ≈4, 2 by leg 8, 3 by leg 13. Its original one-hauler-per-far-producer claim was wrong and is corrected. |
| `relocationTilesPerTick` | 1 | **New.** Half the hauler rate. Unlike the three above it has never been measured, so the increment's last task points the harness at it and rewrites this row with the observed cost of a far-corner relocation. |

The gradient these produce is the point, and it now bites: near buildings are
cheap to serve, far ones demand real hauler investment, and — since relocation
costs downtime — a player who builds far cannot simply undo the decision for
free once the haulers prove expensive.
