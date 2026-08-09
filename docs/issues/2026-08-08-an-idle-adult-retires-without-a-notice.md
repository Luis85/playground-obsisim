---
id: OBS-6-03
title: An idle adult crossing the elder band retires silently, while a working one is announced
status: Open
severity: minor
area: engine
increment: 6
created: 2026-08-08
source: increment-6 Task 13 close-out — a deferred refinement, judged a design question rather than a bug and written down instead of settled
affects:
  - src/engine/systems/population-handlers.ts
  - tests/engine/systems/population-system.test.ts
type: Issue
order: 130
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# An idle adult crossing the elder band retires silently, while a working one is announced

## What happens

`standDownNonAdults` (`population-handlers.ts`) walks every non-adult and
returns early on anyone who holds no job:

```ts
if (stage === 'adult') continue;
if (row.job.buildingId === null && !row.job.hauling) continue; // already stood down
standDown(ctx, row);
ctx.notices.succeed(`Colonist #${row.colonist.id} ${stage === 'elder' ? 'retired' : 'is too young to work'}.`);
```

That guard answers two questions with one test. "Is there anything to stand
down?" — correctly no. "Is there anything to announce?" — assumed no, which is
the part in question. So two colonists crossing `retireTicks` on the same tick
get different treatment purely on whether they happened to be employed: the one
staffing a forester is announced, the one standing idle at the camp is not.

It is not rare. In the self-feeding curve of spec §4.1 the colony holds 34–40
against roughly six job slots — four in the huts and two hauling — so the large
majority of the 38 retirements in the increment's own headline measurement are
the silent kind. (The figure was 41 against the same six slots before the
`birthFoodPerHead` retune, when that curve ended in extinction rather than a
plateau. The retune changed the ending, not this ratio: the harness's chain is
the same size either way, so the gap between population and job slots is what
it always was.)

## Why this is filed rather than fixed

Because the spec supports both readings, and picking one is a product decision
this close-out task had no mandate to make.

- **§2.2** ties the notice to the unassignment: "An adult who reaches the elder
  band is *unassigned from its job or hauling role*… **with a notice**." Under
  this reading the notice means *you just lost a worker, go re-staff something*,
  and firing it for an idle colonist would be noise carrying no action.
- **§2.13** lists the notice categories flatly — "Notices for birth, death
  (naming the cause), and **retirement**" — with no employment qualifier. Under
  this reading the notice means *your labour pool shrank*, which is true whether
  or not the colonist was working: an idle adult is assignable and an idle elder
  is not.

**Acceptance criterion 2 is met either way**; it describes an adult "unassigned
from its job with a notice", which is exactly the case that already fires.

## The fix, if the second reading wins

Trigger on the band transition rather than on the stand-down. It is detectable
as `row.age.ticks === BALANCE.lifeBands.retireTicks`: `ageEveryone` increments
by exactly 1, so equality fires exactly once per colonist per run.

The obvious worry — a colonist restored from a save already *past*
`retireTicks`, who would never hit equality — is not reachable. Non-adults have
their job and hauling flags cleared on the way in (`colonistComponents`, pinned
by `world.test.ts`'s `a retune that lowers retireTicks does not seed an elder
still hauling`), so such a colonist arrives already stood down and has nothing
to announce during play either.

Two things to settle at the same time, since they are the same question:

1. Whether **coming of age** deserves the mirror notice. If retirement is about
   the labour pool, a child reaching `matureTicks` grows it, and announcing one
   without the other is a new asymmetry replacing this one. §2.13's list does
   not include it.
2. Whether the "is too young to work" branch should also move to a transition
   trigger, or stay a stand-down message — it fires only for a save loaded with
   a staffed child after a `matureTicks` retune, which is a repair, not an
   event in the colony's life.

## Test that would catch it

Two colonists seeded one tick short of `retireTicks`, one holding a job and one
idle, stepped once: assert **two** retirement notices, not one. Today's suite
cannot see it — `retires an adult who crosses the elder band, freeing its job
slot` seeds a single colonist that holds a job, so the employed path is the only
one exercised.
