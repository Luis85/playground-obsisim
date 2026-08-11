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
publishes off these counters is exact. Four independent reasons, each sufficient:

1. **Nothing measured demolishes anything.** `runScenario` enqueues exactly one
   command, `moveBuilding`, and has no demolition parameter at all;
   `runPopulationScenario` enqueues no commands whatsoever (it holds no
   reference to `CommandQueue`). So the whole `handleDemolishBuilding` half is
   out of reach by construction.
2. **The move always names a stage, and a stage is never a store site.**
   `Scenario.moveTo` moves `buildingIds[0]`, and `handleMoveBuilding` cancels
   only on `sourceSiteId`, which is a store site id. `storehouse` is the one
   building in the catalog with `storage > 0`, and it has no recipe;
   `stageResultOf` throws on a stage without one. So the moved building can
   never be a `sourceSiteId` and the cancel branch cannot match.
3. **The only measured relocation has no depot.** Both `moveTo` call sites in
   `balance.test.ts` go through `relocating()`, a single-stage forester with no
   `storehouses` — measured `transfers: 0`. A transfer needs a bounded site to
   exist at all.
4. **And that comparison must be unhoused.** `relocating()` passes
   `houseCrew: false` to every arm, so its haulers carry
   `round(6 x homelessFactor)` = 3, below `minTransferUnits` of 4 — a homeless
   hauler cannot be given a staging transfer or a non-exempt drain even if a
   depot were added to it.

Reaching the defect therefore needs a change to the harness itself (a demolish
command, or a `moveTo` able to name a storehouse) rather than merely a new
scenario written against today's `Scenario`.

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

## What is pinned today

`tests/support/balance-harness.test.ts`, 'a mid-run move cannot reach the
transfer counter, and the catalog is why', asserts the two load-bearing premises
above rather than the conclusion: the catalog fact that nothing that stores has
a recipe (reason 2 — it reddens the moment that stops being true), and,
behaviourally, that a run relocating a building mid-flight beside a live depot
still reports `transfers` and `transferReturns` in agreement, with the same
scenario minus the depot reporting zero.
