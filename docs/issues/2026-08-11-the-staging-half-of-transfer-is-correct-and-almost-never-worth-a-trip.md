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

## Increment 9 did not measure this, and increment 10 owns the reading (2026-08-16)

`[[Construction as Work]]`'s spec originally claimed this reading. A construction
site is a consumer at an arbitrary player-chosen tile, which is exactly the remote
fixture this note says the repository lacks — every existing fixture puts the camp
within a few tiles of everything that consumes.

**That reasoning still holds. The timing was wrong, and the reading was not
taken.** Taking it requires teaching `demandSourcesOf` (`haul-transfer.ts:54`)
about sites: it skips unstaffed buildings and derives demand from `recipe.inputs`
alone, and a site is deliberately unstaffed and needs `def.cost`. **As the engine
stands, a remote site creates no depot demand and staging cannot fire for it at
any distance.** So a measurement taken today would report "staging never fires"
from an instrument that was never connected — the increment-7 harness failure
repeating, and the third of the three outcomes below reached by construction
rather than by evidence.

That is a dispatch change, and increment 9 was scoped to make none: it left
`compareSupplyCandidates` and `nextSupplyTarget` untouched so that the queue
ordering could be designed against a measured baseline instead of alongside it.
Making one exception for an instrument would have put a hand into exactly the
machinery the scope line was drawn around.

**It moves whole to increment 10** (`docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md`
§4.2), which changes dispatch anyway, with the warning intact: **connect the
instrument before taking the reading.** This note stays `Open` and unmeasured
until then — no evidence has been added for or against it since increment 8.

## Increment 10 took the reading, and the missing fixture now exists (2026-08-16)

**The instrument was connected first, as the section above insisted.**
`demandSourcesOf` (`haul-transfer.ts`) now gates on `acceptsSupply` — the rule
that already decides which buildings a hauler may deliver to — and reads a site's
`cost` where a finished building's demand comes from `recipe.inputs`. It is
proved by a fixture in `tests/engine/systems/haul-transfer.test.ts` where a depot
beside a `house` site acquires a wood and planks demand from it, with the site
asserted **unstaffed** so the demand cannot have arrived through the staffing
gate, and with a FINISHED house of the same def as the control that pulls
nothing. Three mutations redden it, including the exact pre-increment form.

**So the question this note left open is answered rather than re-asked.** The
first suggestion below — "build the fixture staging was designed for" — asked for
a consumer far enough from the camp that its supply leg dominates, and said this
repository could not express one. A construction site is that consumer, and it
now exists: one or three `house` sites at (23, 15), 26 tiles of walking from the
only goods in the colony, with a depot at (12, 8) on the line between them.

**The reading is the SECOND of the three outcomes, and nothing was tuned toward
it: staging FIRES, and it does not pay.** Increment 10 spec §4.2 has the full
tables; the four figures that decide it:

- **Two staging dispatches at one hauler and four at two and four haulers**, in
  every run. The trigger is not narrower than situational — it fired on the first
  fixture written for it, so this note's second hypothesis is **not** the live one.
- **Every completion tick is digit-for-digit identical with the depot and without
  it**, in all six with/without pairs: 128 / 72 / 44 for one site at one, two and
  four haulers, and 128, 240, 352 / 72, 128, 184 / 44, 72, 100 for three.
- **Nothing ever used what was staged.** The depot's closing level equals its peak
  in every run — 12 units at one hauler, 24 at two and four — so not one unit was
  fetched back out of it, and the loaded leg (`outbound` hauler-ticks) is 52 and
  156 with the depot and without. Every load that reached a site walked the full
  leg from the camp. The drain half did not fire at all: 24 units is far below the
  48-unit staging ceiling, so the parked stock is inert rather than silted.
- **Non-idle hauler-ticks RISE in all six pairs, by 22 to 44** — 20% to 41% more
  walking at one site. `supply` falls by 6, 12 or 24 ticks and two to five times
  that many reappear under `transfer`; the two bucket families cover the same
  non-idle ticks (`supply` is a *kind*, `fetching`/`outbound`/`returning` are
  *phases*), so a tick leaving `supply` was re-attributed rather than saved.

**And the reason is the triangle inequality, not this depot's siting.** For a
hauler standing on the camp tile (2, 0), `supplyRouteDistance` prices drawing
from the camp at 0 + hypot(21, 15) = **25.807** tiles and drawing from the depot
at hypot(10, 8) + hypot(11, 7) = 12.806 + 13.038 = **25.845**. The camp wins by
**0.038 tiles** — the whole of which is the depot's 0.70-tile offset from the
straight line — and in the ticks the engine actually charges the two routes come
out EQUAL, 1 + 13 against 7 + 7. **A route through an intermediate point is never
shorter than the direct one**, so a depot between the camp and a site can at best
TIE and can never beat drawing from the camp. It is not that this depot was sited
badly; no depot on this route can be sited well enough.

That confirms at the remote fixture what increment 8 §4.3 found for the ordinary
chain fixtures, and it sharpens rather than softens this note: **staging is
reachable and correct and is not worth its trips even at the fixture it was
written for.**

**The weakness, stated rather than left for a successor:** one depot tile on one
map, with haulers whose house is beside the camp. The shape that could still make
staging pay is a colony whose haulers idle NEAR the depot — a producer standing
next to it, say — because that is the only arrangement in which the first leg is
not paid twice. That fixture was not run: §4.2 asked for a remote SITE and that
is what was built.

### The site-demand change ships ON, and that was a decision rather than an oversight

The `demandSourcesOf` change prices as **pure cost** on every fixture above: it
is what makes staging fire at a site, and staging at a site buys nothing and
spends 22 to 44 hauler-ticks. The repo owner was asked whether to ship it on and
**chose to ship it on**, because increment 10 spec §2.5 and §4.2 scope that
increment to *measure* OBS-8-06 and not to act on it, and turning the instrument
off after reading it would be acting on it — quietly, and in the one direction
that also destroys the ability to re-take the reading.

**So this note stays `Open`, and it now owns a decision rather than a question.**
Acting on the reading — deleting the mechanic, re-siting it, or gating it on
whether the hauler is already near the depot — is still OBS-8-06's business.

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

**Option 1 is discharged (2026-08-16).** The remote fixture exists and has been
run, so the bar that stood in front of options 2 and 3 is cleared and the
evidence it produced is the section above. Option 2's question — *why does
staging lose to supply?* — is now answered too, and more strongly than it was
posed: not because `chooseJob` offers supply first, but because a two-leg route
through a depot cannot be shorter than the one-leg route it replaces for a hauler
standing at the source. That is arithmetic rather than tuning, and no value of
`siteStagingTarget` reaches it. What remains genuinely undecided is option 3
against a fourth option this reading suggests — keep staging but require the
hauler to already be nearer the depot than the source — and the fixture that
would separate them, a colony whose haulers idle near the depot, has still not
been built.
