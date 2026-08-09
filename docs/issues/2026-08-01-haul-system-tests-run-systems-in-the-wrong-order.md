---
id: OBS-4-03
title: Two haul tests run systems in the reverse of production order
status: Done
severity: minor
area: tests
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 Task 5 review (caught a real false positive from this pattern)
affects:
  - tests/engine/systems/haul-system.test.ts
tags:
  - test-validity
  - tech-debt
type: Issue
parent: "[[Increment 4 - Logistics]]"
order: 30
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Two haul tests run systems in the reverse of production order

`tests/engine/systems/haul-system.test.ts` builds two of its worlds with
`[HaulSystem, CommandSystem]`. Production runs `CommandSystem` before
`HaulSystem` (`ALL_SYSTEMS` in `src/engine/world.ts`). A test harness whose
system order disagrees with the real one is testing a world that cannot occur.

## Why this is not merely untidy

The same pattern already produced a false positive in this increment, in a
different file. `tests/engine/systems/command-system.test.ts` ran
`[HaulSystem, CommandSystem, SnapshotSystem]`, and its move-retarget assertion
**held only because of the inversion** — under the real order the trip loads in
the same tick and the assertion throws. The production code was correct the
whole time; the test was asserting a fiction.

That instance was found in review and fixed: the harness was reordered, the
predicted failure reproduced exactly, the assertion re-derived from the real
timing, and a further test added pinning that a move leaves *returning* haulers
alone.

## Current status

The two remaining sites in `haul-system.test.ts` were checked and are **not**
order-sensitive today — they pass identically under either order. So this is not
a live incorrect test; it is the same latent hazard sitting in the tree, ready
to make the next assertion written near it mean something other than it appears
to.

## Proposed fix

Reorder both harnesses to match `ALL_SYSTEMS`, and confirm the tests still pass
for the right reason rather than by coincidence.

Better, remove the choice: have the test setup helper derive its system list
from `ALL_SYSTEMS` (filtered to the systems under test, preserving that array's
order) instead of accepting a hand-written array, so a harness cannot express an
order production never runs.

## Resolution (697bc86)

The first half was done: the helper's parameter is now `systemsBefore` and it
builds `[...systemsBefore, HaulSystem]`, so both demolition harnesses drain
commands before haulers move. Both existing tests still pass under the new
order, and the reorder immediately earned its keep — the eager trip
cancellation added in `5d92ff0` is *only* observable under the production
order, because it is the tick's later `HaulSystem` run that would otherwise
re-dispatch the hauler at the building just demolished.

The stronger form was left undone at the time: `systemsBefore` still took a
hand-written array, and the same latent hazard existed in any other test file
that composes systems by hand.

## Stronger form, done in increment 5

Rather than change the eighteen call sites that pass a hand-written array,
`buildColonyPrepWorld` — the one function all of them go through — now asserts
the order itself. `assertSystemOrder` walks the given systems, ranks each by its
index in `ALL_SYSTEMS`, and throws if any known system runs before one that
production runs earlier, naming both. A wrong order is no longer merely
discouraged; it fails at setup.

Systems **not** in `ALL_SYSTEMS` are skipped rather than sorted, so a test-only
arrange system — `stats-system.test.ts`'s `DepositWoodSystem`, which stages
state ahead of the real systems — can still sit wherever the test needs it. That
distinction is the subtle part: if an unknown system took a rank, every known
system after it would look out of order.

The guard passed against all 398 existing tests unchanged, which confirms the
first half of this note's fix held: no harness is currently mis-ordered.

Five tests in `tests/engine/world.test.ts` cover it, and three mutations fail
them: removing the guard call, making it never throw, and giving unknown systems
a rank instead of skipping them. The last mutation initially survived, because
the test placed the test-only system last where nothing follows it; it now
asserts all three positions, and the first — the shape `stats-system.test.ts`
actually uses — is the one that discriminates.
