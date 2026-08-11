---
id: OBS-8-02
title: A scheduled pickup costs a transfer leg of latency on both sides of the rule — staging room does not net it out, and drain occupancy nets out a stale one
status: Open
severity: minor
area: engine
increment: 8
created: 2026-08-11
source: two Codex review threads on PR #13 (haul-transfer.ts:164 and haul-transfer.ts:137), filed together because they are the same latency mirrored and one principle decides both; left unfixed on purpose ahead of the increment's measurement task (§1.2, §4.3)
affects:
  - src/engine/systems/haul-transfer.ts
  - src/engine/systems/haul-claims.ts
type: Issue
parent: "[[Storehouse-to-Storehouse Transfer]]"
order: 260
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A scheduled pickup costs a transfer leg of latency, in both directions

## What happens

Two bounds in `haul-transfer.ts`'s `SiteLedger` read an outgoing claim
differently from the term beside them. Neither loses a unit; each delays a trip
by up to a full transfer leg.

**Inbound half — `room` does not subtract `plannedOutAt`.**

```ts
room: (site) => Math.max(0, site.capacity - BALANCE.storehouseFreeFloor - claims.heldAt(site.id))
```

`heldAt` is gross occupancy. A depot at 48 of 48 usable with 12 demanded wheat
and a six-unit supply fetch already scheduled against it has a **deficit of 6**
— because `deficit` runs through `unclaimedAt`, which *is* claimed-net — and
**room of 0**, because `heldAt` still reads 48. `min(capacity, deficit, surplus,
room)` is therefore zero and the replacement cannot be staged until the pickup
physically happens. The deficit is claimed-net on the outgoing side and this
companion bound is not.

**Outbound half — `plannedOutAt` subtracts a claim that may bring back less.**

```ts
const occupancy = (site) => claims.inHandAt(site.id) - claims.plannedOutAt(site.id);
```

`plannedOut` (`haul-claims.ts`) sums `plannedAmount` for **every** fetching trip
out of the site, unconditionally. When `Stockpile.pay` spends camp-first out
from under a claim — a construction cost, a meal — or a demolition removes the
stock, `takeAt` will return less or nothing, but the full original plan is still
discounted. A 60-unit depot holding 6 claimed wood plus 48 other units, with the
wood then consumed and a six-unit collection returning, reads `occupancy` 48 and
schedules no drain; the failed pickup leaves it at 54, six units of headroom
against a floor of 12. `occupancy` reads low, `drainNeed` reads low, and a
needed drain is not dispatched.

## Why it matters, and why it is filed rather than fixed

**Both are latency-only and both self-correct.** The inbound one clears when the
pickup lands and `heldAt` falls. The outbound one clears on the very next
dispatch tick: when the fetching hauler arrives and `takeAt` returns less,
`plannedOutAt` drops to zero, occupancy jumps back, and the drain goes out. One
trip of latency, nothing lost, no cascade.

**The current code is on the safe side of one principle, and both suggested
fixes move it to the other.** §2.4 adjudicated exactly this trade on the inbound
side when it chose `inHandAt` over `heldAt` for the drain:

> **Act on an intention where the failure mode is self-correcting; refuse where
> it destroys value.**

That sentence is the durable part of this issue, and it is what makes the two
neighbouring decisions look inconsistent until you read it:

- Staging into room freed by a pickup that never happens costs **a rerouted
  trip** — the load arrives, does not fit, and `bankWithSpill` forwards the
  excess to the camp. Self-correcting, but paid in a walk.
- A drain acting on an intention that never arrives **removes real goods that
  never needed to move**. Not self-correcting: the units come back only through
  staging against a real demand.

So the inbound suggestion (net `plannedOutAt` into `room`) buys latency back
with an occasional overflow, and the outbound suggestion (bound the discount by
stock still takeable) raises occupancy, dispatches more drains, and destroys
value whenever the fetching hauler *does* take its full amount after all.
Neither is obviously an improvement, which is why neither was taken under time
pressure.

**And they were both known before the increment's measurement task ran.** §1.2
and §4.3 exist to stop a dispatch formula changing immediately before the task
that measures it. Spec §4.2 point 7 records the inbound half as one of two
things the measurement task wanted to change and did not.

## Suggested resolution

**Take the two together or take neither** — they are the same quantity read in
mirrored directions, and fixing one alone makes the asymmetry harder to see
rather than easier.

If they are taken:

- **The outbound clamp must be per-resource and on the *sum*, not per trip.**
  Two haulers each clamping to `min(6, 6)` still discount 12 against 6 units
  available, and a per-trip clamp that tracked remaining stock as it iterated
  would be **order-dependent**, which §2.6 forbids by name. `plannedOutAt` is
  resource-agnostic while stock is per-resource, so a correct version sums
  `min(sum of claims on r, stock of r)` over resources. That is a real design
  change, not a `Math.min`.
- **The inbound one needs the overflow priced.** Netting the pickup into `room`
  is arithmetically trivial; what it needs is a fixture that shows the load
  arriving into room the pickup did not free, and a decision about whether
  `depositArrival`'s recheck is enough to make the spill acceptable.
- **Measure before and after on the corner chain and the staged chain.** Both
  terms are dispatch formulas that §4.2's headline figures are read off; either
  change invalidates the +81 / +126 / +222 / +343 table until it is re-taken.
