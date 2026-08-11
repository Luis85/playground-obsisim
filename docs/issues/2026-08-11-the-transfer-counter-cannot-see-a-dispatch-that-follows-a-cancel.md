---
id: OBS-8-01
title: The balance harness's transfer counter cannot see a dispatch that follows a cancellation in the same tick
status: Open
severity: minor
area: tests
increment: 8
created: 2026-08-11
source: Codex review thread on PR #13 (tests/support/balance-harness.ts, the `dispatchedTransfer` predicate); investigated as increment-8 task E, which established the path is unreachable from every scenario the harness can express and filed it here rather than fixing it
affects:
  - tests/support/balance-harness.ts
type: Issue
parent: "[[The Balance Harness]]"
order: 250
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The transfer counter cannot see a dispatch that follows a cancel

## What happens

`dispatchedTransfer` (`tests/support/balance-harness.ts`) counts a transfer at
the `idle -> fetching` edge, sampled from the live `HaulTrip` components once
per tick, at end of tick:

```ts
return before === 'idle' && trip.phase === 'fetching' && trip.kind === 'transfer';
```

`before` is the previous tick's closing phase, so the predicate is sound only
while an intermediate `idle` is visible at a tick boundary. It is not, when a
trip is cancelled and the same hauler re-dispatched inside one tick.

`CommandSystem` is the first system in `ALL_SYSTEMS` and `HaulSystem` the sixth,
and two of `CommandSystem`'s handlers cancel a trip outright:

- `handleMoveBuilding` cancels a `fetching` trip whose `sourceSiteId` is the
  building being moved;
- `handleDemolishBuilding` cancels a `fetching` trip whose `sourceSiteId` **or**
  `targetId` is the building being demolished, and an `outbound` empty-handed
  one whose `targetId` is.

Either leaves the hauler idle, still flagged `hauling`, several systems before
`HaulSystem` runs `chooseJob` on it. If `chooseJob` picks a transfer, the tick
closes with `phase === 'fetching'` and `before` reading `fetching` (or
`outbound`) — never `idle`. The dispatch is not counted.

**Reproduced, not conjectured.** A hand-built world (`CommandSystem` +
`HaulSystem`) with two storehouses, a staffed sawmill nearest the second, a
housed hauler mid-`fetching` at the first, and one `moveBuilding` on that first
depot: the tick closes with `kind === 'transfer'`, `staging === true`,
`phase === 'fetching'`, `before === 'fetching'` — and the predicate returns
false.

Three consequences, all in the same direction:

- `transfers` under-counts;
- the `transfersStaging` / `transfersDrain` split loses the same trip, since the
  class is read only at the dispatch edge;
- `transferReturns` still counts that trip's turn for home, because it is keyed
  on `before !== 'returning'` — the loose form, which survives the same tick the
  strict form does not. So `transfers - transferReturns` can go **negative**,
  which the field's own doc comment says is impossible.

## Why it is filed rather than fixed

**No scenario either harness can express reaches it**, so every figure §4.2
publishes off these counters is exact.

The argument is a **conjunction of two facts, and neither is sufficient on its
own**. The path needs `CommandSystem` to cancel a trip and leave the colonist
still flagged `hauling`, and exactly two handlers can do that —
`handleDemolishBuilding` and `handleMoveBuilding`. So one fact per handler, and
falsifying **either** voids the argument:

1. **Nothing measured demolishes anything** — this closes the
   `handleDemolishBuilding` half. `runScenario` enqueues exactly one command,
   `moveBuilding`, and has no demolition parameter at all;
   `runPopulationScenario` enqueues no commands whatsoever (it holds no
   reference to `CommandQueue`). Checkable in one step rather than taken on
   trust: `runScenario` contains a single call to `enqueue`, and its command
   literal is `moveBuilding`.
2. **The move always names a stage, and a stage is never a store site** — this
   closes the `handleMoveBuilding` half. `Scenario.moveTo` moves
   `buildingIds[0]`, which `runScenario` populates from the scenario's STAGES
   only (a depot placed through `Scenario.storehouses` never enters that array).
   `handleMoveBuilding` cancels only on `trip.sourceSiteId === command
   .buildingId`, and a `sourceSiteId` is a store site id — a `storehouse`
   building's id, or `CAMP_SITE_ID`. `storehouse` is the one building in the
   catalog with `storage > 0` and it has no recipe, while `stageResultOf` throws
   on a stage without one. So `buildingIds[0]` is never a store site and the
   cancel branch cannot match.

Reaching the defect therefore needs a change to the harness itself (a demolish
command, or a `moveTo` able to name a storehouse) rather than merely a new
scenario written against today's `Scenario`.

### Two things that are NOT reasons, and why they are recorded as not being so

Earlier drafts of this issue listed two further reasons as independently
sufficient. Both are withdrawn; the conjunction above does not need either, and
leaving them in overstated how robust the argument was.

- **"The only measured relocation has no depot"** (both `moveTo` call sites in
  `balance.test.ts` go through `relocating()`, a single-stage forester with no
  `storehouses`; measured `transfers: 0`). True today, and useful
  corroboration — but it is a fact about the fixtures currently written, not
  about what a `Scenario` can express, and it is strictly weaker than reason 2,
  which holds however many depots a relocating scenario gains. Adding a depot
  to a relocating fixture is a one-line change that anybody may make; it does
  not reach the defect, and reason 2 is why.
- **"And that comparison must be unhoused"** — the claim that `relocating()`'s
  homeless haulers carry `round(6 x homelessFactor) = 3` against
  `minTransferUnits` of 4, so they cannot be dispatched on a transfer at all.
  **This is false**, and it was falsified by a change in this very increment.
  `drainFrom` (`src/engine/systems/haul-transfer.ts`) lowers `minUnits` to
  `ANY_UNITS = 1` when `surplus < minTransferUnits && surplus < need` — the
  site-doing-its-best exemption — so an unhoused hauler with capacity 3 **can**
  be dispatched on an exempt drain, `movable = min(3, surplus, need) >= 1`. The
  measurement behind the original claim (a `houseCrew: false` move-plus-depot
  run reporting `transfers: 0`) was of a single-resource saturated depot, where
  the exemption's `surplus < minTransferUnits` clause does not hold; it never
  generalised. A capacity argument that assumes a floor the code does not
  guarantee is exactly the defect commit `2622be2` was written to correct, and
  this was the same error in the same direction a second time. Do not repair
  it — a hauler's capacity is a property of the hauler, and no argument about
  reachability should rest on one.

### What is pinned, and what is not

Because §4.2 publishes transfer counts on this argument, every link an assertion
can reach is pinned by one rather than by this prose. Conjunct 1 has no such
link; the gaps are named:

| link | pinned by | fails how |
| --- | --- | --- |
| nothing in the catalog both stores and has a recipe | `balance-harness.test.ts`, 'a mid-run move cannot reach the transfer counter, and the catalog is why' | reddens on the commit that gives a store a recipe or a producer storage |
| a stage without a recipe yields no result | `balance-harness.test.ts`, 'a stage the catalog gives no recipe yields no result at all' | reddens if `stageResultOf`'s throw is removed or its condition weakened |
| `runScenario` issues only `moveBuilding` | **nothing** | see below |
| `moveTo` names a stage, never a depot | **nothing** | see below |

The last two are unpinned, deliberately: both are properties of code that does
not exist (`Scenario` has no demolition field) or of a single literal
(`buildingIds` is built from `stages`, and the `enqueue` call names
`buildingIds[0]`). An assertion would have to read the harness's own source to
say anything, which is a check on text rather than on behaviour. What would
break them is a change to `runScenario` itself, made by someone reading this
file — so the trigger below is written for that reader.

**One hedge on the pin that does exist.** `stageResultOf`'s throw fires AFTER
the tick loop, and `ScenarioStage.defId` is typed `BuildingDefId`, so
`defId: 'storehouse'` is expressible today and would execute the entire run —
blind spot included — before rejecting. The guarantee is therefore "no such run
yields a `BalanceResult`", which is what a published figure needs, and not "the
defect never executes". Anyone who moves that check earlier strengthens the
argument; anyone who removes it voids conjunct 2.

## Suggested resolution

Fix it **when, and only when, a scenario gains a demolition or the ability to
move a storehouse** — at which point every figure taken from `transfers`,
`transfersStaging` or `transfersDrain` under that scenario must be re-taken.

Do not resolve it by counting inside `beginTransfer` or by persisting a dispatch
event on anything: the increment's constraint is that a transfer's intent is
reconstructible from its own trip components and that nothing outside the trip
remembers anything, and `src/` must gain nothing that exists only for a test.

The harness builds and steps the world itself, so the available fix is to
identify a **distinct trip** rather than a phase edge — remember per hauler the
tuple that a dispatch freezes and a walk does not change (`kind`,
`sourceSiteId`, `destSiteId`, `resource`, `staging`, `legFrom`/`legTo`), and
count a transfer whenever that tuple changes into a transfer's. That is
immune to an invisible `idle`, because the cancelled trip and the new one differ
in it. `returnedTransfer` needs no change; it is already the loose form.

## What the behavioural fixture does and does not add

`tests/support/balance-harness.test.ts`, 'a mid-run move cannot reach the
transfer counter, and the catalog is why', carries the catalog assertion named
in the table above, and also runs a 250-tick chain that relocates its forester
beside a live depot and reports `transfers` and `transferReturns` in agreement,
with the same scenario minus the depot reporting zero.

**That second half is corroboration, not coverage of the defect**, and the
distinction matters to whoever reads this next. By conjunct 2, a run that
relocates a STAGE beside a depot is exactly as unable to reach the blind spot as
one that relocates nothing at all, so the agreement of the two derivations
confirms the counters on a fixture where they were never in doubt. What it buys
is that the premises are asserted against a fixture that really does move a
building mid-flight, really does keep a depot live and really does dispatch
transfers — and that the class split partitions — rather than against an
imagined one. **No fixture in this repository exercises the defect**; the only
demonstration of it is the hand-built world under "What happens" above.
