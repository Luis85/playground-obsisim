---
id: OBS-10-02
title: PendingChanges.constructed is written on every build order and read by nothing, and no test reddens if clear() stops emptying it
status: Open
severity: minor
area: engine
increment: 10
created: 2026-08-16
source: increment-10 whole-branch review, filed as its merge condition — the field went write-only when §2.1 deleted the affordability check, and it is left in place rather than removed because removal reaches plumbing and fixtures this increment was scoped out of
affects:
  - src/engine/resources.ts
  - src/engine/systems/placement-handlers.ts
  - tests/engine/systems/population-system.test.ts
type: Issue
parent: "[[Construction as Work]]"
order: 330
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Nothing reddens if the pending construction ledger stops being cleared

## What happens

`PendingChanges.constructed` (`src/engine/resources.ts`) is pushed on every
accepted build order by `handleConstructBuilding`
(`src/engine/systems/placement-handlers.ts`), emptied by `clear()` at the top of
each command drain (`command-system.ts`), and **read by nothing.**

Its one reader was `outstandingMaterials` (placement-handlers.ts), which charged
each same-tick site its whole cost against the next order's affordability check.
Increment 10 §2.1 makes ordering a request, and Task 1 deleted that check and its
helper together. Every other system that names the field does so to say it
deliberately does *not* fold it in — `population-system.ts`, `haul-sites.ts`,
`haul-system.ts`, `production-system.ts`, `command-system.ts` — and those
comments record a **separate** decision that predates the deletion.

**The sharp part is not that it is dead. It is that its clearing is now
unpinned:** `tests/engine/systems/population-system.test.ts` says so in as many
words, in the note left where the retired affordability-era test used to be —
that test "was the only thing that reddened when `PendingChanges.clear()` stopped
emptying `constructed`, because a stale copy is exactly what it staged." It was
retired with the check it belonged to, and nothing took over that job. So
`clear()` could stop clearing this list tomorrow and the suite would stay green.

**Static analysis cannot see it either.** The field is *referenced* — the push is
a real write — so an unused-member gate has nothing to flag, and `PendingChanges`
is reached through interface-typed values (`CommandContext.pending`,
`PopulationContext.pending`), which is the same reason `clear()` itself carries a
`fallow-ignore-next-line unused-class-member`.

## Why it matters

- **It is dead but inert, and the second half is why this is `minor`.** The list
  is still cleared every drain, so it cannot grow without bound today, and no
  behaviour depends on the value it holds mid-drain. There is no player-visible
  symptom and nothing to reproduce.
- **The cost is carried in prose.** Roughly twenty lines across the class doc,
  the field's own doc and the comment on `clear()` explain and justify state that
  no code reads — the field doc's last sentence is now "nothing currently reads
  this list". A reader of `resources.ts` has to work through the history of a
  deleted check to learn that.
- **The one guarantee left standing is untested.** "A this-drain-only record must
  not survive its drain" is the reason the clearing exists, it is stated in the
  code, and after Task 1 it is the only thing about this field that could still
  break — and it is exactly the thing nothing pins.

## What is *not* true of it

- **Not a leak.** `clear()` does still empty it; the ledger is correct on every
  tick. The claim is about what would happen if that stopped, not about what
  happens now.
- **Not caused by the ordering change.** It is Task 1's — removing the
  order-time affordability check — and it would have arrived the same way if
  §2.2 had never been written.
- **Not the same fact as the five "does not fold in `pending.constructed`"
  comments.** Those say a same-tick site must stay invisible to homing, hauling
  and production, which is true whether or not this field exists, and which is
  why deleting the field would leave five comments needing rewording rather than
  deleting.

## What a successor would have to touch

No remedy is chosen here — removal and retention are both defensible, and the
choice belongs with whoever next opens `resources.ts` for a reason of their own.
What the decision costs, so it is made with the surface in view:

- **`src/engine/resources.ts`** — the field, its ~13-line doc, the paragraph
  about it in the class doc, and the sentence inside the `clear()` comment that
  exists to justify clearing a field nothing reads.
- **`src/engine/systems/placement-handlers.ts`** — the push, and the comment
  above it explaining why the push is placed after both rejection paths.
- **Five comments in four systems** (`population-system.ts`, `haul-sites.ts`,
  `haul-system.ts`, `production-system.ts`, `command-system.ts`) that name the
  field while recording a decision that is not about it. Each needs rewording
  rather than deleting, or a real fact about same-tick visibility is lost.
- **Hand-built `CommandContext` fixtures in the tests**, which construct a
  `PendingChanges` directly and comment on what they leave out of it
  (`tests/engine/systems/command-system.test.ts`), plus the retired-test note in
  `tests/engine/systems/population-system.test.ts` that is currently the only
  written record of why the clearing is unpinned.

**Whichever way it goes, the missing pin is the part that should not be left
implicit:** either something asserts that a drain's `constructed` entries do not
survive into the next drain, or the field goes and the assertion is moot. Keeping
the field *and* leaving nothing to redden is the one combination that has no
argument for it.
