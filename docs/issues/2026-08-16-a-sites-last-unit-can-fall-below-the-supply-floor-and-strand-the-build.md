---
id: OBS-9-01
title: A site whose last unit falls below minSupplyUnits is never delivered, so the building can never be finished
status: Open
severity: important
area: engine
increment: 9
created: 2026-08-16
source: increment-9 task 11 (measure), spec §4.1's second question — found by the cost sweep, which reported the sawmill site as the only def in the catalog that never completes at any distance or hauler count
affects:
  - src/engine/systems/haul-dispatch.ts
  - src/engine/content/balance.ts
  - src/engine/content/buildings.ts
type: Issue
parent: "[[Construction as Work]]"
order: 310
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A site's last unit can fall below the supply floor and strand the build

## What happens

A **sawmill can never be built.** Its site fills to 24 of its 25 wood and stops
there for the rest of the game, with the missing unit sitting at the camp.

Measured on the balance harness, one site ordered at tick 0 with wood
inexhaustible at the camp, at leg 1 and at leg 13, at one and at two haulers:
the order is accepted, the in-tray reaches **24/25**, `constructionTicks` never
decrements, and 956 of the 1,000 seeded wood is still standing at the camp when
the run ends. Every other def in the catalog completes in the same fixture.

**The mechanism is a threshold, not a claim leak.** A site's room for one
resource is `cost[r] − held[r]` (`inputRoomOf`, `haul-construction.ts`), and
dispatch sizes a claim at `min(room, haulerCapacity)`. So room descends in
whole hauler-loads until it reaches `cost[r] mod capacity`. `worthMoving`
(`haul-dispatch.ts:171`) then refuses the trip:

```ts
function worthMoving(movable: number, held: number): boolean {
  return movable > 0 && (movable >= BALANCE.minSupplyUnits || movable >= held);
}
```

With `movable: 1` and `minSupplyUnits: 2`, the first clause is false. The second
clause is the exemption written for exactly this shape — its comment says a
threshold "strands the tail" and must not — but `held` there is the **source's**
unclaimed stock of that resource, not the site's remaining need. A camp holding
956 wood is not doing its best; it simply has plenty. So the exemption fires for
a nearly-empty depot and never for a nearly-full site.

**It is wider than one def.** The condition is `cost[r] ≡ 1 (mod capacity)`, and
`haulerCapacity` is `max(1, round(haulCarryCapacity × commuteFactor))`, which is
6 for a housed hauler and **3** for a homeless one or one at the commute floor.
Measured with two homeless haulers: a **gatherer's hut** (10 wood, 10 = 3×3 + 1)
sticks at 9/10 forever, while the farm ordered beside it finishes normally. So
the set of unbuildable defs is a function of who is doing the hauling.

## Why it matters

- **A shipped building is unbuildable in an ordinary colony.** Not slow —
  unbuildable, at every distance, with any number of haulers, with the materials
  in hand. The player is given no explanation: the site publishes "needs 1 wood"
  and the colony has hundreds.
- **It is a livelock, and §2.2 of the spec named this exact class** while
  discussing the in-tray cap — "a livelock rather than a shortfall: the site
  never completes and the haulers never stop trying". That door was closed
  (`inputRoomOf` measures against `cost`); this is the same failure arriving
  through `minSupplyUnits` instead.
- **Cancellation recovers the goods but not the build.** §2.6's refund returns
  the 24 wood in full, so nothing is lost — but the only way to get a sawmill is
  to not want one.
- **Increment 10 makes it more reachable, not less.** A request model invites
  long queues, and every site in a queue reaches its own remainder eventually.

## What is *not* true of it

- **Not a claims defect.** The claim ledger is correct throughout; the site's
  room really is 1 and nothing is double-counted. The conservation sentinel
  reads 0 across every run that reproduces it.
- **Not caused by construction.** `worthMoving` is increment 8's, and a finished
  building can meet the same floor — but it recovers, because a recipe consumes
  its in-tray and the room jumps back above the floor on the next batch. A site
  never consumes anything, so its room only ever shrinks: construction is what
  makes the threshold permanent rather than momentary.
- **Not fixed by raising the in-tray cap or the carry capacity.** Any capacity
  leaves some cost with a remainder of 1; changing the constants moves which
  defs are affected rather than removing the class.

## Suggested resolution

Not taken here: increment 9 deliberately does not touch dispatch (§2.4), and
this was found by the measurement task, whose brief is to record rather than to
fix. Two candidates, in order of preference:

1. **Give the exemption the target's side of the question.** `worthMoving`
   already exempts "this is everything the source has"; the missing half is
   "this is everything the target still needs". A load that would complete a
   site's material is worth the walk whatever its size, and that reading is a
   property of the candidate, which `supplyCandidates` already has in hand.
2. **Exempt sites from the floor entirely.** Simpler, and defensible on the same
   grounds §2.7.1 exempts them from the staffing gate — a site's tray is a bill
   rather than a buffer — but it also sends haulers on 13-tile walks for single
   units, which is what the floor exists to prevent.

Whichever is taken, the fixture is the one this was found on: a `sawmill` site
at any tile, which must complete, and a `gatherersHut` site with homeless
haulers, which must complete too — the second is what stops a fix keyed on one
def's cost rather than on the arithmetic.
