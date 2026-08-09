---
id: OBS-6-05
title: The v4 migration conflates "has a shelter" with "has a usable one", and code, comment and test disagree about it
status: Open
severity: minor
area: shared
increment: 6
created: 2026-08-09
source: increment-6 whole-branch review, recorded in the final fix pass — filed rather than fixed because the correct answer is a decision, and the code, its own doc comment and its test each currently give a different one
affects:
  - src/shared/save-migration.ts
  - tests/shared/save-migration.test.ts
type: Issue
parent: "[[Save v5 - Age, Home and Starvation Clock]]"
order: 150
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The v4 migration conflates "has a shelter" with "has a usable one"

## What happens

`migrateV4toV5` decides whether to gift a colony a free starter house from one
expression (`src/shared/save-migration.ts:251`):

```ts
const wantsStarterHouse = shelterIds.length === 0 && v4.buildings.length < MAX_SAVED_ENTITIES;
```

`shelterIds` comes from `savedShelterIds()` (line 147), which filters:

```ts
.filter((b) => b.defId === 'house' && b.relocatingTicks === 0)
```

That filter is right for the job it was written for — deciding **where to seat
people**, where it has to agree with `rehome`, which excludes relocating
shelters. It is being reused for a different question: **whether the colony has
a shelter at all**. A v4 colony whose only house happens to be in transit at
save time therefore reads as shelterless and is handed a second, free house it
keeps forever.

One filtered list is answering two questions that differ exactly when a house is
mid-relocation.

## Code, comment and test each say something different

| | says |
| --- | --- |
| the code (line 251) | a colony whose only house is relocating **is** shelterless, so gift it a house |
| its own doc comment (line 237) | "The house is synthesised **ONLY** for a colony with no shelter at all" |
| `tests/shared/save-migration.test.ts:386` | pins the code: "The colony counts as shelterless, so it DOES get the starter house" |

The test and the code agree with each other and contradict the comment. Whatever
is decided, one of the three has to change — which is why this is filed as a
decision rather than a bug with an obvious patch.

## Why it matters, and why it is only `minor`

Reachability is near nil. A v4 save containing houses at all only exists in dev
builds cut between Task 5 (when the house def shipped) and Task 9 (when v5
landed), and that save must additionally have been written on one of the handful
of ticks its only house was in transit. No released build can produce one.

What makes it worth recording is not the scenario but the shape: a predicate
whose name describes existence (`savedShelterIds`) being consumed as a predicate
about eligibility. Increment 6 has already paid for that exact confusion twice
in the bed counts (`overCapacityEvictions` treating a relocating house as
usable; the load repair evicting without filling).

## Suggested resolution

Split the two questions rather than picking a filter that serves both:

- **Seating** keeps `savedShelterIds()` and its relocating filter. That
  agreement with `rehome` is load-bearing and must not move.
- **The gift** should ask an unfiltered question — does this colony own any
  house? — which is what the doc comment already claims and what the
  justification supports: "a colony that demonstrably has houses does not need a
  free one." A relocation ends in a few ticks; a free building is permanent.

Under that change, such a save migrates with everyone homeless until the house
lands, which is consistent rather than merely tolerable: the load repair
(`restoredColonists`) also excludes relocating shelters from the beds it fills
from, and `rehome` does the same on tick 1 — so the seeded snapshot still equals
what the first tick produces, which is the property the whole migration exists
to preserve.

`tests/shared/save-migration.test.ts:386` then flips: the colony counts as
sheltered, gets no starter house, and its colonists load homeless. Keep the
first assertion of that test exactly as it is (`homeId !== 90` — nobody is
seated in the house in transit); it is testing the seating rule, which is not
what changes.

If instead the code's current behaviour is judged correct, the fix is one line
in the doc comment — but then say explicitly that "no shelter at all" means "no
*usable* shelter", so the next reader is not left to infer it from a filter two
functions away.
