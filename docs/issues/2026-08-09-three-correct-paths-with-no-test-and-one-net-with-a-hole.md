---
id: OBS-6-07
title: Three correct-but-untested paths, and the property test that does not net the family it was written for
status: Open
severity: minor
area: tests
increment: 6
created: 2026-08-09
source: increment-6 whole-branch review, recorded in the final fix pass — the three paths were verified correct by reading, so this is coverage debt rather than a defect; the net finding was re-verified by mutation during that pass
affects:
  - tests/engine/systems/haul-system.test.ts
  - tests/engine/systems/population-system.test.ts
  - tests/app/game-store.test.ts
type: Issue
parent: "[[Houses and Beds Throttle Growth]]"
order: 170
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Three correct-but-untested paths, and one net with a hole

Recorded together because they share one cause: increment 6 added several
same-tick-visibility mechanisms, and the tests written for them cover the reader
that happened to break first rather than every reader of the same fact.

## The three paths

All three were checked by reading and are correct today. None has a test that
would fail if it stopped being.

**1. `reseatArrivalsOf`'s multi-arrival branch**
(`src/engine/systems/command-handlers.ts`). The helper loops over
`ctx.pending.arrivals`, and its doc comment explains why the loop is safe for
several displaced arrivals at once — `shelterWithRoom` reads the ledger live, so
each re-seated arrival counts against its new house on the next call. That
branch is unreachable: `recruitCooldownTicks` blocks a second nomad in the same
drain, and `tryBirth` runs in `PopulationSystem`, after `CommandSystem` has
finished draining. Both of its callers (`handleMoveBuilding`,
`handleDemolishBuilding`) therefore only ever see one arrival. If the cooldown is
ever retuned to zero, or a bulk-arrival command is added, this becomes live code
with no coverage behind it.

**2. `HaulSystem`'s `pending.tileOf` fallback**
(`src/engine/systems/haul-system.ts:51`). A hauler housed by a construction
earlier in the same tick is resolved through `PendingChanges.tileOf`, or they
take the homeless carry capacity on the tick they were housed.
`ProductionSystem`'s twin of this lookup **is** pinned — by
`population-system.test.ts:444`, which deliberately asserts on the batch
advanced rather than on the published `workPower`, because the published figure
was never the broken reader. `HaulSystem`'s copy has no equivalent. The test
that would catch it has to assert on the load carried, for the same reason.

**3. `bedsFree` clamps where `spareBeds` does not.** `spareBedsIn`
(`src/app/stores/game-store.ts:49`) returns `Math.max(0, beds.total -
population)`; the engine's `spareBeds`
(`src/engine/systems/population-handlers.ts`) subtracts pending arrivals too and
is allowed to go negative. Both are right for their own caller — the UI must not
render `-1 spare` and the gate must be able to see a deficit — but nothing
records that the divergence is deliberate, and nothing fails if one of them
drifts toward the other.

## The net with a hole

The whole-branch review reported, and this pass re-verified by mutation, that
`population-system.test.ts`'s property test — *"never over-houses, admits an
arrival it has no bed for, or ends a tick it cannot reload"* — does not net the
family it was written for.

Measured, two partial reverts of `4012dd2` (the commit that made
`CommandContext.shelters` live and gave `handleMoveBuilding` its arrivals half):

| mutation | property test | what did catch it |
| --- | --- | --- |
| remove `handleMoveBuilding`'s arrivals half, keep the `pending.constructed` fold | **passes** | 2 scenario tests only |
| freeze `ctx.shelters` at context construction, keep the fold | fails | 3 tests, property test among them |

The two scenario tests that carry the first case alone:

- `tests/engine/systems/command-system.test.ts` — *re-seats a nomad in the other
  house when the one it landed in moves in the same drain*
- `tests/engine/world.test.ts` — *accepts every autosave a live mixed command
  drain produces*

A third data point from the same pass: the demolition twin of that bug
(`reseatArrivalsOf` never wired to `handleDemolishBuilding`) was present with the
**entire 607-test suite green**, property test included.

The reason is structural, not a tuning problem. The property test asserts three
things: nobody over-houses, no arrival is admitted without a bed, and the tick
ends reloadable. A nomad left **homeless beside a free bed** violates none of
them — it is a colony that is too empty, not too full — and the reload clause
only fires once the `homeId` is actually dangling. Raising the tick count or the
churn rate does not reach it; the missing assertion does.

## Suggested resolution

For the three paths: one test each, each asserting on the reader that would
actually be wrong (the load carried, not the published capacity; the batch
advanced, not the published work power). None is urgent — all three are correct
— so they belong in a coverage pass, not in a feature task.

For the net: add a fourth clause to the property test's per-tick invariant —
**no colonist is homeless while a usable bed stands free** — which is exactly the
condition `rehome` is specified to establish and the one the whole
seeded-snapshot-equals-tick-1 rule depends on. Then re-run the first mutation
above and confirm it goes red; a clause added without that check would be one
more claim in a file that already documents six tests which passed for the wrong
reason.

Until that clause exists, treat the property test as covering over-housing only,
and keep writing the scenario test as well.
