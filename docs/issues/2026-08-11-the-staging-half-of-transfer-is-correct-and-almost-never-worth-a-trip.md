---
id: OBS-8-06
title: The staging half of the transfer mechanic is reachable and correct and almost never worth a trip, which is the opposite of what §1.1 argued a depot is for
status: Open
severity: important
area: engine
increment: 8
created: 2026-08-11
source: increment-8 task 11 (measure), spec §4.2 point 6 and §4.3's fourth paragraph — recorded there as a second disagreement with §1 rather than as a detail, and carried here so a successor inherits a judgement rather than a sentence in a spec section
affects:
  - src/engine/systems/haul-transfer.ts
  - src/engine/content/balance.ts
type: Issue
parent: "[[Storehouse-to-Storehouse Transfer]]"
order: 300
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The staging half of transfer is correct, and almost never worth a trip

## What happens

This increment built two mechanics. **Only one of them pays.**

Staging — pull a resource toward the site nearest a consumer that wants it — is
reachable, correct, claim-bounded and covered by tests. Measured across every
fixture this repository can express, it is also nearly idle:

| fixture | staging dispatches | drain dispatches |
| --- | ---: | ---: |
| corner chain (the headline, 2,400 ticks) | **0** | 145 |
| camp-fed processor | 1–6 | 11 |
| staged chain | 4–6 | — |

`siteStagingTarget` is the constant that governs it, and across 6 / 12 / 24 it
**moves no fixture's output**. The corner chain is byte-identical at all three
values because it dispatches no staging at all, so the constant is never read.
The staged chain's staging volume does move — 4 → 6 → 6 dispatches, 68 → 112 →
112 hauler-ticks — and its output does not: 192 units at all three. The only
output figure the constant moves is the camp-fed processor's (245 / 243 / 255),
and its best value there is still 13% below the no-depot control of 294.

So §4's question — *does staging more than an in-tray's worth pay, or does it
just move the stall?* — is answered, and the answer is neither: **staging more
does not pay because staging does not move enough goods to matter.**

## Why it matters

**It contradicts the argument §1.1 makes for a storehouse.** §1.1 sells the
depot as a pipeline stage with two ends, and the inbound end — camp stock staged
outward so a consumer is fed without occupying in-tray concurrency — is the half
that was supposed to answer OBS-7-02. The measured mechanic is the *outbound*
end alone: a depot intercepts a producer's output on a short hop and drains it
back on a long one. §4.2 confirms the consumer-side relief is durable, but it is
being bought by the drain freeing room, not by staging filling the depot.

That matters beyond bookkeeping because **the increment's scope was argued from
staging**. The decision to fix OBS-7-01 first was justified by staging needing a
fair ranking to reach the far building; §2.4's whole pull/deficit apparatus —
`siteDemandOf`, `inboundAt`, the deficit/surplus symmetry that is §2.2's
termination proof — exists to make staging safe. All of it ships, all of it is
tested, and on the headline fixture none of it executes.

**It is filed as `important` rather than `minor` for that reason**: the honest
options include deleting a mechanic, and that is not a judgement to leave in a
spec section.

## What is *not* true of it

- **Not a bug.** Staging does what §2.4 specifies. Every fixture that exercises
  it passes, and `transfersStaging > 0` is asserted so the counter cannot
  silently become structurally empty.
- **Not "the depot doesn't pay."** It does — +222 planks at 2,400 ticks, growing
  with the horizon, acceptance criteria 3 and 4 both passing. The finding is
  about *which half* earns that.
- **Not obviously a fixture artefact**, though it may be. Every fixture here puts
  the camp within a few tiles of everything that consumes, so the leg staging
  would shorten is short. A colony with a genuinely remote cluster is the case
  staging was designed for and is the case this repository cannot currently
  express — which is the first suggestion below rather than an excuse.

## Suggested resolution

Three orderings, and the choice should be made on a measurement rather than on
which is least work.

1. **Build the fixture staging was designed for, first.** A consumer cluster far
   enough from the camp that its supply leg dominates, with a depot between. If
   staging does not pay *there*, it does not pay anywhere, and the case for
   removal is made on the mechanic's own best ground rather than on fixtures
   built for the drain. This is the only option that can produce evidence
   *against* the other two.
2. **Ask why staging loses to supply, which may be the real defect.** A supply
   trip fetches from any site and delivers to the building directly; staging
   moves the same goods one hop short of the same building, and a supply trip
   then has to move them again. On short legs that is strictly worse, and
   `chooseJob` offering supply first means the direct trip always wins the
   hauler. If that is the whole explanation, staging is not badly tuned — it is
   dominated by construction, and no value of `siteStagingTarget` fixes it.
3. **Remove it, and shrink §2.4 to the drain.** The prize is large: `stageInto`,
   `siteDemandOf`, `inboundAt`, `siteStagingTarget` and roughly half of §2.4's
   specification. §2.2's termination argument gets simpler rather than weaker,
   because a drain-only mechanic is bounded → unbounded and cannot cycle at all.

**Do not do 3 before 1.** Increment 7 declined to remove the round trip because a
measurement argued for it, and increment 8 declined to move
`storehouseFreeFloor` because one fixture family is not enough to move a
constant. Removing a shipped mechanic on evidence from fixtures that were never
built to exercise it would be the same error with the sign flipped.
