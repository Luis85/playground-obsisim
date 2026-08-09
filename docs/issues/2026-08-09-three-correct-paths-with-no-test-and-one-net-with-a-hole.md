---
id: OBS-6-07
title: Three correct-but-untested paths, and the property test that does not net the family it was written for
status: Done
severity: minor
area: tests
increment: 6
created: 2026-08-09
resolved: 2026-08-09
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

**Status:** resolved 2026-08-09 (`5c1439c`, `acffd76`) — the net first, then the
three paths. See [Resolution](#resolution-5c1439c-acffd76).

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

## Resolution (5c1439c, acffd76)

### The net (`5c1439c`)

A fifth clause landed — nobody is homeless while a bed `rehome` could have
filled stands free — but measuring it first showed the hole was not quite
where this note placed it. Deleting `handleMoveBuilding`'s `pending.arrivals`
half (the mutation the note names) leaves the displaced nomad pointing *at*
the moving house rather than homeless, which the property test's existing
clauses one and three could already see. The gap the note's own mutation
table found needed a second arrival *regime*: with a recruit offered every
tick, the 30-tick arrival cooldown is spent the instant a bed opens, which in
this colony is only ever right after a construction, never on a relocation
tick — across 600 ticks, an arrival and a relocation drained together zero
times. The fixture now rides the churn twice: the original every-tick offer is
kept (a broken `spareBeds` needs that tightness), and a second run saves the
cooldown for every second relocation, which stages the contended drain 8
times. A single regime that catches both families was searched for and does
not exist.

The fifth clause reads relocation off the *previous* tick's snapshot, not the
current one, matching `PopulationSystem` reading `ticksLeft` before
`ProductionSystem` decrements it. Four mutations, each seen red and restored
byte-identical; only the last needed the new clause — nothing in the suite
caught it before, including the full 607-test run that once missed this bug's
demolition twin entirely:

| mutation | what it broke |
| --- | --- |
| `spareBeds` drops `pending.arrivals` | clause 4, every-tick regime |
| `ctx.shelters` frozen at context construction | clause 1, every-tick regime |
| `handleMoveBuilding`'s arrivals half deleted | clause 1, cooldown-saving regime |
| move evicts without re-seating | clause 5, cooldown-saving regime |

617/617 green.

### The three paths (`acffd76`)

Each gained the one test asserting on the reader that would actually be
wrong, verified red under a mutation of the code it protects and restored
byte-identical:

- **`reseatArrivalsOf`'s multi-arrival branch** — driven directly from a
  context built out of real components (spawn and `nomadGate` throw rather
  than stub), two houses with one free bed each: live, each arrival takes one;
  resolved once for the whole loop, both are handed the same house
  (`expected [91,91] to equal [91,92]`).
- **`HaulSystem`'s `pending.tileOf` fallback** — asserted on the load carried,
  the reader its `ProductionSystem` twin was already pinned on
  (`expected 3 to be 6` when the pending fallback is dropped).
- **`bedsFree`'s clamp against `spareBeds`' signed answer** — one colony, 6
  beds against 7 colonists, both readers on the same numbers: 0 for the view
  (`spareBedsIn`'s clamp), -1 for the gate (`spareBeds`' deliberate lack of
  one). Each direction of the divergence is now pinned rather than merely
  true by inspection.

617 -> 620 tests, all green.
