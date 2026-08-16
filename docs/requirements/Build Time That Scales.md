---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 35
status: New
tags:
  - game-design
  - balance
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Build Time That Scales

`BALANCE.buildTicks` is one constant — 30 — for every building in the catalog. A
gatherer's hut costing 10 wood and a mill costing 30 wood and planks wait exactly
as long once their materials are there. Increment 9 shipped it that way
deliberately (`[[Construction as Work]]`, spec §2.12) and measured whether it was
right. **It is not**, and this note is the number to size the fix against rather
than an argument that one is needed.

## What was measured

Increment 9 §4.1, second question. One site, two haulers, delivery ticks and
total to completion:

| def | units | materials | delivery, leg 1 | total, leg 1 | total, leg 13 |
| --- | ---: | ---: | ---: | ---: | ---: |
| gatherer's hut | 10 | 1 | 3 | 32 | 44 |
| house | 20 | 2 | 7 | 36 | 72 |
| workshop | 20 | 1 | 7 | 36 | 72 |
| mill | 30 | 2 | 11 | 40 | 100 |
| sawmill | 25 | 1 | 11 | 40 | 100 |

**Delivery already scales with cost and the countdown does not.** The delivery
column tracks the cost almost linearly, and the *number of distinct materials*
does not enter it at all — a workshop (20 planks) and a house (15 wood + 5 planks)
are identical at every distance and hauler count measured. So the flat countdown
is a constant added to a term that is already correct.

**Near the camp that constant is most of the price.** A mill costs three times a
hut and takes 25% longer to appear (40 against 32). At leg 13 the same pair is
100 against 44, because delivery has taken over. A player building close to home
— which is where they build first — feels almost no difference between the
cheapest and most expensive buildings in the game.

## The two levers, and they are not equivalent

**Scale `buildTicks` with `unitsOf(cost)`.** One line, no new mechanic, and it
makes a mill feel like a mill at every distance rather than only at leg 13. The
delivery term it adds to counts **loads, not units** — increment 9 §4.1 records a
sawmill (25 units, one material) delivering in exactly the same time as a mill (30
units, two), because with two haulers both are three waves of round trips, and the
sawmill's third wave carries a single unit for what `cost mod capacity` leaves. So
a cost one under a multiple of `haulCarryCapacity` is quietly the most expensive
shape in the catalog to deliver, and a scaling rule laid on top of that should
know it.

**Or give the countdown a lever: the builder role.** `[[Construction as Work]]`
lists it under "what it would take" and both of its increments defer it. §4.1's
first question is the argument for it: a far-corner house at four haulers cuts
delivery from 99 ticks to 15 and leaves the countdown at 30 throughout, so **the
countdown is the one part of the price a player cannot buy off with logistics.**
Building time that responds to nothing the player does is a flat tax; building
time that responds to *labour* is a decision. That is a larger change — a fourth
call on the same colonists, commute and hunger applying to it, and the question of
whether building competes with producing — and it is the one that would make this
increment about labour allocation, which is why it was deferred twice.

They compose: scaling with cost sets what a building *should* cost in time, and a
builder role decides who pays it. Scaling is the cheap half and can ship alone.

## What this is not

- **Not a defect.** Nothing is broken; a flat rate is a defensible choice that
  measured worse than the alternative.
- **Not urgent.** Increment 9's §4 records the disagreement rather than retuning
  toward its own claim, which is the point of measuring. The constant is a
  one-line change whenever a successor wants it.
- **Not blocked by increment 10.** The queue work changes which site is served
  first, not how long a served site takes.

## Documentation

- `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md` §4.1
  questions 1 and 2 — the sweep, the tables above, and the loads-not-units finding
- `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md` §2.12 —
  where both scaling and the builder role were deferred, and why
