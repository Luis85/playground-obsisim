---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 50
status: New
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Roads and Pathfinding

Every distance in the game is a straight line. `haulTicksBetween` is `Math.hypot` over two tiles divided by `haulTilesPerTick`, with a floor of one tick, and a hauler walks through anything in its way. There is no terrain, no route, and nothing a player can build to make a journey shorter that is not a building at the other end of it.

**Deferred for the third time — Increment 4's out-of-scope item, deferred again by Increments 5 and 7 — and now with a reason rather than a shrug.** Increment 7 §2.13 puts it explicitly behind the storehouse in value: a depot shortens a trip more than a road would, and the depot shipped. This note exists so the deferral stays a judgement instead of quietly becoming an omission; it was bundled inside [[Two-Way Haul and Storage Buildings]] until that feature shipped its other two parts.

## What it would take

- A tile layer that is not a building — terrain, or road, or both — and a save version to carry it.
- A distance function that is a *route* rather than a formula. `src/shared/haul.ts` owns the spatial law of hauling today and imports nothing, which is what makes it cheap to test; a pathfinder is the first thing that would put real state behind that boundary, and where it lives is the design decision this feature turns on.
- A cost for laying a road, and a reason to lay one somewhere rather than everywhere.
- Everything measured in Increments 5 and 7 is expressed in *legs*: one hauler serves a raw producer to leg 4, two by leg 8, three by leg 13, and a processor about half as far. Roads would move every one of those numbers, so this feature owns re-taking the sweep rather than inheriting it.

## Why it keeps losing

The value it adds is a shorter leg, and the game already has two cheaper answers to a long leg: move the building (priced since Increment 5) or build a depot beside it (Increment 7). What roads add that neither does is a *player-shaped map* — a colony whose layout is chosen rather than merely occupied — which is a world-and-spatial-play argument rather than a logistics one, and worth taking on those terms when it is taken.

## Documentation

- `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` — the original out-of-scope entry
- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.13 — the third deferral and its reasoning
- See also: [[Two-Way Haul and Storage Buildings]], [[World and Spatial Play]]
