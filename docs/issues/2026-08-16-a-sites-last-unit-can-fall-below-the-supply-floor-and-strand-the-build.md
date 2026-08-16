---
id: OBS-9-01
title: A site whose last unit falls below minSupplyUnits is never delivered, so the building can never be finished
status: Done
severity: important
area: engine
increment: 9
created: 2026-08-16
resolved: 2026-08-16
source: increment-9 task 11 (measure), spec §4.1's second question — found by the cost sweep, which reported the sawmill site as the only def in the catalog that never completes at any distance or hauler count
affects:
  - src/engine/systems/haul-dispatch.ts
  - src/engine/systems/haul-construction.ts
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

## Resolution (4c08bfa)

**Candidate 1**, the target's side of the question. `worthMoving` gains a third
clause and the rule it needs lives with the other site rules:

```ts
export function finishesSiteMaterial(
  row: HaulBuildingRow, resource: ResourceId, claims: Claims, movable: number,
): boolean {
  if (!isUnderConstruction(row.construction.ticksLeft)) return false;
  return movable >= inputRoomOf(row, resource) - claims.input(row.building.id, resource);
}
```

with `worthMoving(movable, held, finishesNeed)` reading
`movable > 0 && (finishesNeed || movable >= BALANCE.minSupplyUnits || movable >= held)`.
The two escapes are now one argument seen from both ends of the leg: a source
that is doing its best, and a target that will never ask again.

It is deliberately **not** candidate 2. On today's numbers the two are
behaviourally identical — a hauler's carry has a floor of 3
(`max(1, round(6 × 0.5))`), so at a site the only way `movable` can fall under
`minSupplyUnits` while the source holds more is for the site's remaining room to
*be* that load — but they stop being identical the moment any hauler can carry
one or two units, and then candidate 2 is the one that sends thirteen-tile walks
for single units into a site that has twenty more to go. The strict form says
what is actually being claimed.

**Nothing about dispatch ORDERING moved.** `src/shared/haul.ts`,
`nextSupplyTarget` and `compareSupplyCandidates` are untouched; this is the
threshold that decides whether a candidate EXISTS, and it stays where it always
was. `minSupplyUnits` keeps its value and keeps applying in full to every recipe
consumer — `finishesSiteMaterial` asks `isUnderConstruction` first — because
those are the numbers §4.1 and increment 10 are sized against.

### Tests

The fixture this note asked for, and two more:

- `construction-system.test.ts`, 'a sawmill site completes, though its last unit
  is below `minSupplyUnits`' — the headline. Asserts COMPLETION, and that 25
  units really left the camp.
- ...'a site short of a single unit for any other reason completes too' — a mill
  site owing one plank of ten, where the shortfall comes from the tray rather
  than from `cost mod capacity`. This is what stops a fix keyed on that
  arithmetic.
- ...'a gatherer's hut completes for homeless haulers' — the second fixture this
  note named, with the farm beside it as the control, since which defs are
  affected is a property of the hauler.
- `haul-dispatch.test.ts`, 'the load that finishes a material is dispatched
  however small it is' — the decision itself: one unit owed, thirty at the camp,
  `plannedAmount: 1`, and it lands.
- `haul-dispatch.test.ts`, 'a FINISHED building's last unit of room is still
  refused' — the leak guard, with a two-unit control that dispatches. Without it
  the exemption could be written as "always true".

Three mutations, each reddening a different set: removing `finishesNeed ||`
(i.e. the code as this note found it) reds all four site cases; returning `true`
for a finished building reds only the leak guard; keying the exemption on
`cost[r] % haulCarryCapacity` rather than the room left reds the mill and hut
cases while leaving the sawmill green.

### What it did to the published numbers

§4.1's second reading changes: `sawmill | 25 | 1 | never | never` becomes
`11 / 71` delivery ticks, near and far — identical to the mill's, because with
two haulers both are three waves and the sawmill's last wave carries one unit.
Every other figure in §4.1 was re-taken and none moved; §4.4 of the spec is the
audit.
