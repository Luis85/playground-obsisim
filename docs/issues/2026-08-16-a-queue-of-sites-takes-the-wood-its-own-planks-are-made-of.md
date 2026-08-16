---
id: OBS-10-01
title: The starvation band clears on a producer's FIRST claim, so a queue of sites takes the wood its own planks are made of — measured as a 1.65× delay to the first building rather than as a stall
status: Open
severity: important
area: engine
increment: 10
created: 2026-08-16
source: increment-10 task 3 (measure), spec §2.3 (the limitation, shipped knowingly) and §4.1's second reading (the sweep that prices it) — filed with the number because §2.3 recorded three remedies and left the choice to a measurement
affects:
  - src/engine/systems/haul-dispatch.ts
  - src/shared/haul.ts
type: Issue
parent: "[[Construction as Work]]"
order: 320
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A queue of sites takes the wood its own planks are made of

## What happens

Increment 10 stops a queue of construction sites outranking the producer that
supplies it by keeping sites out of the starvation band: a sawmill with an empty
in-tray *is* starving, a site never is, so a blocked producer wins. **That
protection is one load deep**, because the band's predicate is
`!batchActive && couldStartBatch && holdsNoneOf(input, resource) && claimedIn === 0`
(`haul-dispatch.ts`), and the *first* claim aimed at the sawmill clears the last
clause. So:

1. the sawmill is empty, is starving, and wins one wood claim;
2. `claimedIn` is now non-zero, so it stops being starving;
3. the sites, with large `movable`, take the wood that follows;
4. the sawmill turns its one load into planks, and the oldest site needs more;
5. the rest of the wood is consumed inside younger sites' in-trays.

Spec §2.3 shipped this knowingly and asked how reachable it is. It is now
measured, and **the answer is that it is a delay and not a stop.**

## The number

`stallScenario` / `stallSweepLines` in `tests/engine/balance.test.ts`, printed by
`npm run balance:report`, and re-takeable by running that command. N `house`
sites (15 wood **and** 5 planks each) ordered together at leg-4 tiles; a
two-crew `forester` at (6, 0) feeding a staffed `sawmill`; three haulers; 900
ticks; and **nothing seeded** — a two-stage scenario withholds every resource a
stage produces, so the only wood in the colony is the forester's and the only
planks are the sawmill's.

**With the sawmill twenty tiles out (18, 12) — leg 10 — and at crew parity, this
is what a queue costs:**

| queue | first completion | last | completed | wood made | planks made |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 113 | 113 | 1 of 1 | 488 | 454 |
| 3 | 137 | 244 | 3 of 3 | 494 | 430 |
| 5 | 186 | 364 | 5 of 5 | 510 | 413 |
| 10 | **186** | 655 | 10 of 10 | 536 | 363 |

**113 → 186 is 1.65×, and every site still finishes.** The sawmill's output
falls 454 → 363 across the same sweep (**−20%**), which is the mechanism showing
up where §2.3 said it would: the oldest site's room fills, it drops out of the
candidate set while its planks are still unmade, and the wood behind it lands in
younger sites' in-trays instead of in the sawmill.

**At no queue length up to ten does the first completion stop happening because
of the queue.** With the sawmill beside the camp at half crew the first house
completes at tick **116 whether one site was ordered or ten**, and all ten finish
inside the run — 116 / 209 / 296 / 520 for the last one at N = 1 / 3 / 5 / 10.
Nothing freezes, nothing needs cancelling, and the recovery §2.3 leaned on
(cancel a younger site, get its materials back) was never required by any row of
this sweep.

## The sweep's other four rows are a DIFFERENT failure, and it runs the other way round

**With the sawmill beside the camp (2, 4) — leg 2 — and at crew parity, nothing
completes at any queue length INCLUDING ONE.** 0 of 1, 0 of 3, 0 of 5, 0 of 10.
The sites' in-trays are empty at the end of every run and 592 of 600 logs became
planks.

This is the sentence in this note that changes what a successor should do. §2.3
describes sites taking every remaining log from a producer; these rows show **the
producer taking every log from the sites.** A sawmill re-enters the band after
each batch, a site is never in it, and a camp-adjacent producer's claim cycle is
short enough to catch each log as it lands. Move the same sawmill ten legs out
and the sites are served — which is what makes it a fact about the claim CYCLE
rather than about the band alone.

Two consequences:

- **A queue of one suffers it in full**, so it is not reachable by queueing and
  increment 10 does not make it worse. It is increment 9's third reading arriving
  from the other side: a producer and a queue eating the same resource, with the
  sign flipped.
- **The third remedy below would make these rows worse rather than better.**
  Widening the band so a producer holds it until it can run a whole batch is
  precisely more of what is already happening here.

## Why it matters

- **It is reachable by doing exactly what increment 10 invites.** A build order
  is now a request, so queueing more than the colony can currently feed is the
  intended use, and the 1.65× is what that costs at this fixture.
- **The player is given no explanation for either half.** A site publishes its
  per-material shortfall, so "needs 5 planks" is visible; that the sawmill making
  those planks is being outbid for its own input by the sites waiting on it is
  not.
- **It sits on the boundary between two correct rules.** The band is increment
  8's and is right for producers; age-first phase 1 is increment 10's and is
  right for queues. Neither is wrong on its own, and that is why this is a
  decision rather than a patch.

## What is *not* true of it

- **Not a deadlock.** Every row that was served at all completed every site it
  was given, at every queue length up to ten. §2.3 called it a stall; measured,
  at these fixtures, it is a delay.
- **Not caused by removing the affordability check.** The far-sawmill rows delay
  a queue of three as readily as a queue of ten, and the near-sawmill parity rows
  fail at a queue of ONE, which no affordability check could have prevented.
- **Not the ordering rule leaking.** Conservation reads zero across the sweep,
  every site's completion order is age order, and `nextSupplyTarget`'s two phases
  are what put the wood into the oldest site rather than round-robin.
- **Not measured widely.** See below — this is one point in a space with at least
  four dimensions in it.

## What is weak about the reading

Carried from spec §4.1's fourth reading rather than left for a successor to
find:

- **Three haulers only**, two crew arrangements, two sawmill tiles. The 1.65×
  should be quoted as "measured at this fixture", not as the cost of a queue.
- **The ledger starts empty.** `runScenario` seeds a resource at 1,000,000 or
  withholds it entirely, so a chain fixture has no opening pile — where increment
  9's stall reading gave its colony 60 wood. A player queueing against a real
  pile sits between the two and neither instrument can express that.
- **A site's in-tray is sampled only at the END of a run** (`siteInputUnits`), so
  this sweep can say "did not complete" where increment 9's scratch rig could say
  "was short for 884 of 900 ticks".

## Suggested resolution

The three options are spec §2.3's, recorded verbatim so the choice is made
against the number above rather than against an intuition. **Not chosen here** —
increment 10's deliverable was the measurement, and §2.5 puts acting on it in a
successor.

1. **Reserve** a producer's inputs against the demand of sites needing its output
   (a dependency graph — the most correct and by far the most machinery).
2. **Cap** the share of a resource all sites may hold at once (a global throttle
   — one constant, no graph, and it degrades gracefully).
3. **Widen the band** so it survives until a producer can actually run a batch
   rather than until its first claim (deeper than it looks, and it changes
   dispatch for producers generally, including cases with no sites in them at all).

What the number says about them, which is the whole reason it is in this note:

- A worst case of a first building arriving two-thirds later, with every site
  still completing, **does not buy option 1.** A dependency graph is priced
  against a stall and there is no stall in this sweep.
- **Option 3 is contraindicated by the parity rows above**, which are the one
  arrangement in the sweep where nothing gets built at all and are caused by a
  producer holding the band too well rather than too briefly.
- **Option 2 is the only one this figure argues for at all, and "nothing" is
  defensible.** A cap would bound the far-sawmill delay without touching
  producer dispatch, and it is one constant; against 1.65× it is also not
  obviously worth a constant.

**Whatever is taken, the fixture is `stallSweepLines`'s**, and a fix must be
judged on both halves of it: the far-sawmill rows must get their 113 back
without the near-sawmill parity rows going from "nothing completes" to
"nothing completes, and the sawmill is slower too".
