---
id: OBS-4-03
title: Two haul tests run systems in the reverse of production order
status: open
severity: minor
area: tests
increment: 4
created: 2026-08-01
source: increment-4 Task 5 review (caught a real false positive from this pattern)
affects:
  - tests/engine/systems/haul-system.test.ts
tags:
  - issue
  - test-validity
  - tech-debt
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
