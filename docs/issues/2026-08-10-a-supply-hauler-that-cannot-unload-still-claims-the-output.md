---
id: OBS-7-03
title: A supply hauler that will arrive with its hands full still claims a full load of the target's output, delaying collection there
status: Open
severity: minor
area: engine
increment: 7
created: 2026-08-10
source: increment-7 task 7 review, deferred as "safe and conservative" and re-filed against whatever measures hauler idle time; task 14 measured hauler idle time and could not isolate it, so it is recorded here instead of being dropped
affects:
  - src/engine/systems/haul-dispatch.ts
type: Issue
parent: "[[The Supply-and-Collect Round Trip]]"
order: 210
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A supply hauler that cannot unload still claims the output it will not carry

## What happens

`Claims.output` (`src/engine/systems/haul-dispatch.ts`) adds a full
`capacityOf(row)` for every hauler whose phase is `fetching` or `outbound` and
whose `targetId` is that building — of both kinds, deliberately, because a
supply hauler loads output on arrival too (§2.6). That is right for the ordinary
case and this note is not asking for it to be dropped.

It is wrong for one arrival. §2.5 step 3 loads output **only into empty hands**,
so a supply hauler that arrives still holding an undelivered remainder collects
nothing at all. Its claim was never spendable, and it stood against that
building's output buffer for the whole of the outbound leg.

Three rechecks produce exactly that hauler, all of them the intended behaviour:

- the target's in-tray filled while the hauler walked, so only part of the load
  fits and the rest stays in hand;
- the target's last worker was unassigned, retired or died mid-leg, so nothing
  is unloaded into it at all;
- the target went into relocation mid-leg, same outcome.

While the claim is outstanding, `collectCandidates` reports that building's
`claimed` as higher than it will turn out to be, so `nextHaulTarget` — which
ranks on most-claimable-first — puts it behind buildings with less waiting, or
skips it. Collection there is delayed by up to the remainder of one leg.

## Why it matters

Less than it might. The direction is safe: `loadOutput` takes at most the same
`capacityOf`, so the claim can exceed the take but never fall short, and no
goods are lost or double-counted. Claims are rebuilt from live components every
tick, and the claim clears the moment the trip goes `returning`, so it
self-corrects without any repair step.

What makes it worth a note is that **nothing measures it, and the obvious
instrument does not**. Task 7's review filed it against "whatever measures
hauler saturation and idle time", on the reasoning that it manifests as idle
haulers and delayed collection rather than as fetch-leg ticks. §4.1 q3 reports
both — 5–8% hauler idle across the fixtures, collect-kind dispatch at 0–1% of
hauler-ticks in a two-consumer chain — and neither figure can separate this from
the ordinary reasons a hauler stands still. The three rechecks that produce the
case are all rare by construction, so it is plausibly negligible; "plausibly
negligible" is the claim, and it is unmeasured.

## Suggested resolution

Either refine the claim or record why it is deliberately coarse, and the second
is a legitimate answer.

Refining it means asking, at claim time, whether this hauler will have empty
hands on arrival — which is `!(kind === 'supply' && phase === 'outbound' &&
amount > 0 && !pickedUp)`, all four already on the trip and all four already
read elsewhere. That is cheap, but it builds a *prediction* into a claim
computation that §2.6 keeps deliberately free of them: an outbound supply hauler
holding a remainder may still unload some of it if the tray drained meanwhile,
in which case it *would* collect. So the refinement is not obviously more
correct than the over-claim — it trades an over-claim for an under-claim in a
narrower case, and an under-claim is the direction that sends two haulers at the
same six units.

**The measurement to take first**, since either choice should rest on one: count
arrivals that unloaded nothing and collected nothing, over a chain long enough
for in-trays to fill under contention. If that count is near zero on realistic
fixtures, close this as a documented coarseness with the number attached. The
balance harness already tracks `supplyReturns` and `supplyReturnsLoaded`, which
is the same family of counter.
