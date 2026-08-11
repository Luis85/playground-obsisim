---
id: OBS-7-02
title: A far processor is capped by its in-tray's concurrency rather than by its haulers, and the cap cannot be raised while it is also the only fairness floor
status: Open
severity: minor
area: engine
increment: 7
created: 2026-08-10
source: increment-7 task 14 (measure), section 4.1 q1; the blocking half found in task 15 by retuning the constant and measuring the result
affects:
  - src/engine/content/balance.ts
  - src/engine/systems/haul-dispatch.ts
type: Issue
parent: "[[Inputs Are Delivered, Not Teleported]]"
order: 200
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A far processor is capped by its in-tray, not by its haulers

## What happens

A camp-fed sawmill in the far corner (23,15), crew 2, plateaus at **71–72% of
its ceiling** and stays there however many haulers the colony hires. The fourth
hauler buys one point. Those four haulers are idle 5% of their ticks; the
sawmill waits for input 30% of its own. Hiring is not the answer, and the game
gives the player no way to tell.

The cause is arithmetic and it is not distance. `Claims.input`
(`src/engine/systems/haul-dispatch.ts`) counts a fetching hauler's
`plannedAmount` and an outbound hauler's `amount` against the target's in-tray
room, so at most `BALANCE.inputBufferCap / BALANCE.haulCarryCapacity` loads can
be walking toward one building at a time. That is `12 / 6 = 2`. Two loads of six
over a 1 + 13 + 13 = 27-tick round trip is 0.44 units per tick against a
two-worker sawmill's demand of 0.67 — 66% of ceiling. Measured 72%: the
arithmetic and the reading agree.

Confirmed causally, by temporary mutation with the constant restored:

| `inputBufferCap` | leg 13, 4 haulers: %ceiling | waiting% | in-tray at end | leg 6, 4 haulers: %ceiling |
| ---: | ---: | ---: | ---: | ---: |
| **12 (shipped)** | 72 | 30 | 3 | 98 |
| 24 | **92** | 3 | 6 | 97 |
| 48 | 89 | 3 | 30 | 97 |

## Why it matters

§1.2 of the increment 7 spec makes a promise: a processing building gets worse
the further it sits from the camp, and the player has three real answers — move
it, staff more haulers, or build a storehouse. **Two of the three do not work at
the far corner.** More haulers buys one point of ceiling. A depot beside a
camp-fed processor measures as a 10% *loss* at three haulers, because it can
never shorten that building's input leg while it does lengthen the hauler's next
fetch. Only moving the building works, and a design that offers three levers of
which one functions is not the design that was argued for.

The shipped comment on the constant also describes the wrong quantity. It reads
"12 batches of runway — ~36 ticks for a mill, comfortably longer than the 13-tick
worst-case one-way walk", which is a statement about how long a full in-tray
lasts. What the number actually sets is how many loads may be *in transit* toward
one building, and no amount of runway helps a tray that is never filled.

## Why it was not simply retuned, and what blocks it

It was retuned, on a branch, and measured back out. **`inputBufferCap` is
currently the dispatcher's only fairness floor.** At a 12-unit tray one delivery
claims a building's whole room, so a second hauler is forced to a different
building; at 24 several haulers pile onto the nearest one. `OBS-7-01` records
that the supply ranking has no deliberate fairness term, and doubling the cap
removes the accidental one before a replacement exists.

Measured on a two-consumer chain — a mill feeding a bakery, which is what a
colony actually looks like, rather than the single camp-fed processor the
gradient instrument uses:

| haulers | bread at cap 12 | bread at cap 24 |
| ---: | ---: | ---: |
| 1 | 0 | 0 |
| 2 | 150 | **79** |
| 3 | 319 | **274** |
| 4 | 375 | 376 |

The mill goes to its own ceiling (313 → 394 flour at two haulers) by absorbing
hauling the bakery needed, and the chain's end product — the thing the colony
eats — falls by 47% at two haulers. Eight unit tests in
`tests/engine/systems/haul-dispatch.test.ts` fail at 24 for the same reason, of
which the plainest is *"three haulers and three starved mills spread out rather
than converging on one"*. Those are not stale fixtures; they are the floor being
removed.

## Suggested resolution

**Sequenced, not parallel.** Fix `OBS-7-01` first, so the ranking has a
deliberate fairness term, then re-take this reading. 24 may well be right at
that point, and the numbers above are the ones to re-measure against.

Three things the re-measurement must do that this one could not:

- **Use a two-consumer fixture, not only a single camp-fed processor.** The
  entire reversal recorded above turned on solo-versus-chain: at 24 a solo
  sawmill reads 92% of ceiling while a mill-feeding-a-bakery chain's bread
  output falls by up to 47%. A re-measurement that repeats the original
  single-processor gradient run, with no second consumer competing for the
  same haulers, would reach the original 92%-looks-fine conclusion again and
  miss the reason 12 stayed shipped. The gradient instrument is a solo sawmill
  because `StageResult.ceiling` is exact there and `share` is comparable to
  increment 5's raw sweep row for row — it is a good instrument and a poor
  model of a colony, and this is the case where the difference decided the
  answer, so the chain fixture is not optional colour on top of it.
- **Watch the in-tray's end-of-run occupancy.** Goods in an in-tray are out of
  the spendable ledger, out of `colonyWealth` and out of `mealsPerHead`, and
  they die with the building on demolition. At 48 the far sawmill parked 30
  units in one tray; at 24 it parked 6. That cost is what rules out 48 and what
  bounds any value chosen.
- **Re-run the population curve.** `birthFoodPerHead` is a stock gate reading the
  colony's spendable total, so raising the amount of food-chain input that can
  sit invisible to it is a second-order coupling nothing has measured. The
  12,000-tick chain scenario's food chain has no input-consuming stage, so it
  would not see this; a fixture with a mill and a bakery in the food chain would.

The far-corner balance test is a **reading**, not a guard: it fails when the
constant moves, deliberately, and its comment carries the numbers to rewrite it
with. Do not relax its bounds — re-measure and restate them.

## Second measurement — increment 8, and the constant still does not move

Increment 8 §1.2 committed in advance to answering this issue with a measurement
rather than a retune, on the argument that if transfer made the cap non-binding
the issue would close on a finding. **It did not close.** Spec §4.2 point 5, and
`BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the camp-fed
processor and OBS-7-02 readings'`:

| haulers | depot | %ceiling | wait% | in-tray at end | staging dispatches |
| ---: | --- | ---: | ---: | ---: | ---: |
| 3 | no | **71** | 33 | 0 | — |
| 3 | yes | **58** | 40 | 10 | 2 |
| 4 | no | **72** | 30 | 3 | — |
| 4 | yes | **67** | 35 | 0 | 6 |

Three things this adds to the record:

- **The plateau is exactly where this issue left it.** 71% at three haulers and
  72% at four, the fourth hauler buying one point, with transfer live in the
  tree. The original reading re-takes.
- **The arrangement that was supposed to relieve the cap makes it worse.** A
  depot beside the camp-fed processor reads 58% at three haulers and 67% at
  four, with waiting *up* rather than down. §1.1 of the increment-8 spec argued
  that staging feeds a consumer "without occupying in-tray concurrency", which
  is precisely this issue's finding addressed head-on. Staging fires **2 times
  in 600 ticks** at three haulers and 6 at four — the one mechanism the design
  had for relieving the cap does not fire often enough to be measured against
  it. The loss has its own issue (`OBS-8-04`); what belongs here is that it
  leaves this cap un-relieved.
- **`siteStagingTarget: 24` does not rescue it either** — 255 planks against a
  no-depot control of 294, still a 13% loss. The sweep is in §4.2 point 6.

**So the statement of what a retune would have to buy is sharper than it was.**
The cap is not merely un-relieved by transfer; it is un-relieved by the *only*
mechanism the design had for relieving it, so raising the cap is once again the
only lever. What has changed in this issue's favour is the sequencing: `OBS-7-01`
is **Done**, so the deliberate fairness floor this issue was blocked on now
exists and 24 can be re-measured against it. What has not changed is the three
conditions that re-measurement must meet — a two-consumer fixture, end-of-run
in-tray occupancy, and the population curve — none of which anything measured in
increment 8 satisfies. `inputBufferCap` stays at 12 and the severity stays
`minor`.
