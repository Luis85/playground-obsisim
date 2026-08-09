---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 20
status: New
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Two-Way Haul and Storage Buildings

Increment 4 shipped output-side haulage only: buildings push finished goods to the camp, nobody delivers inputs in. Both the Increment 4 and Increment 6 specs name this as the deliberate boundary and the same named successor — storage buildings with their own capacity, input delivery (two-way haul), and, per Increment 4's out-of-scope list, roads and real pathfinding in place of straight-line distance.

**Specced as Increment 7 (2026-08-09), not yet implemented.** Two of the three parts are in scope there: input delivery, and a `storehouse` as a second place goods may be dropped and picked up. Roads and pathfinding are deferred a third time, now explicitly behind the storehouse in value — a depot shortens a trip more than a road would. The spec's §1 argues that the two in-scope halves are one decision rather than two: input delivery alone roughly doubles haul demand and makes every processing building strictly worse the further it sits from the camp, which collapses the placement game back to "build on the camp band".

## Documentation

- `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` §1.1, §1.2
- `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` §2.15
- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` — the increment that takes it on
- `docs/superpowers/plans/2026-08-09-increment-7-two-way-haul-and-storage.md`
