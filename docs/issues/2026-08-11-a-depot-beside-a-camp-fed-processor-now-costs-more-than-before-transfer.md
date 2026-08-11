---
id: OBS-8-03
title: A depot beside a camp-fed processor measures as a larger loss with transfer live than it did without it — 17% at three haulers
status: Open
severity: important
area: engine
increment: 8
created: 2026-08-11
source: increment-8 task 11 (measure), spec §4.2 point 4 — the configuration §1.2 committed in advance to reporting rather than rescuing, re-measured on this branch's HEAD
affects:
  - src/engine/systems/haul-transfer.ts
  - src/engine/systems/haul-dispatch.ts
type: Issue
parent: "[[Storehouse-to-Storehouse Transfer]]"
order: 270
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A depot beside a camp-fed processor now costs more than it did before transfer

## What happens

A camp-fed sawmill in the far corner (23,15), crew 2, with and without a depot
beside it. Increment 7 measured the depot as a **10% loss** at three haulers and
a **3% gain** at four. Increment 8 re-measured it with transfer live:

```
BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the camp-fed processor and OBS-7-02 readings'
```

| haulers | depot | made | %ceiling | wait% | fetch% | supply% | transfer% | drain ticks | stored |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | no | 232 | 55 | 28 | 4 | 100 | 0 | 0 | 0 |
| 2 | yes | 228 | 55 | 45 | 18 | 98 | 2 | 0 | 59 |
| 3 | no | **294** | 71 | 33 | 4 | 100 | 0 | 0 | 0 |
| 3 | yes | **243** | 58 | 40 | 26 | 84 | 16 | 244 | 48 |
| 4 | no | **296** | 72 | 30 | 4 | 100 | 0 | 0 | 3 |
| 4 | yes | **276** | 67 | 35 | 26 | 80 | 20 | 326 | 56 |

**A loss of 17.3% at three haulers (243 against 294) and 6.8% at four (276
against 296).** Worse on both counts than increment 7's 10% and +3%.

## Why it matters

§1.2 of the increment-8 spec committed in advance to reporting this
configuration *including worse*, and §2.13 put the obvious remedy out of scope,
so this is a promise kept rather than a regression discovered late. But it is
the one placement a player is most likely to try first — a depot next to the
building that is starving — and the game gives no signal that it is the wrong
answer.

It also bears directly on `OBS-7-02`: a depot beside a far processor was the one
mechanism the design had for relieving that building's in-tray cap without
occupying in-tray concurrency, and it measures as a loss instead.

## The mechanism, and the arithmetic that closes it

**The fetch leg is the cause, and it is not the dispatch-order change.** At
three haulers the fetch share of working ticks goes **4% → 26%**. In ticks: 4%
of 1,718 working ticks ≈ 69, against 26% of 1,730 ≈ 450 — the fetch leg grew by
about **381 hauler-ticks that buy nothing but position**. The transfer bucket
over the same run is 281 ticks (37 staging + 244 drain), so *at least* 100 of
those 381 ticks are extra fetch on trips that are not transfers at all. A hauler
that banked a load at the depot starts its next fetch there, and the wood this
building eats exists only at the camp.

**The drain-ahead-of-collect promotion (§2.6) is a structural no-op here**, which
is worth stating because it is the obvious suspect. `collect%` is **0 in every
row of this table**, with and without a depot: this is a single building whose
planks ride home on the return leg of the supply trips that feed it, so there is
no collect candidate for a drain to be promoted ahead of. The re-measured
figures equal the pre-fix figures exactly (243/294 and 276/296) and the split
says why they should.

The pre-fix tree was **not** re-run, so this is the agreement of two independent
readings plus a mechanism that makes the agreement expected — not a controlled
before/after.

## Suggested resolution

**A route-aware transfer**, named in spec §4.3 as this increment's successor and
deliberately not attempted (§2.13). A drain chosen on the site's need alone
cannot decline a trip that strands its hauler 13 tiles from the only stock the
colony's consumers eat. What such a rule would have to weigh is the *next* fetch
leg, which no current term looks at: every bound in `SiteLedger` is about the
site, and none is about where the hauler ends up.

Two cheaper things that are **not** the answer, recorded so they are not
retried:

- **Retuning `siteStagingTarget`.** Swept at 6 / 12 / 24 (§4.2 point 6): the
  camp-fed processor reads 245 / 243 / 255 against a no-depot control of 294.
  The best value is still a 13% loss.
- **Suppressing drains near a camp-fed building.** The drain is not what costs
  here — see the `collect% = 0` argument above. A rule aimed at the promotion
  would move nothing in this fixture and would give back the +81 / +126 / +222 /
  +343 the corner chain measures.

Whatever lands must be measured on **both** fixtures. The corner chain and the
camp-fed processor disagree about this mechanic in opposite directions, and a
change read off one of them alone will be wrong about the other.
