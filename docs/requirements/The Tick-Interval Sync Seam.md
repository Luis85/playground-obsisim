---
type: PBI
parent: "[[Increment 4 - Logistics]]"
order: 60
status: New
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Tick-Interval Sync Seam

The renderer paces a hauler's dot by measuring the wall-clock gap between syncs, clamped to [50, 1000] ms, instead of being told the actual tick interval — a heuristic flagged when OBS-4-09 fixed the worse half of the same problem (the dot's *position*). Passing the interval down from the store, which already knows the speed multiplier, would remove the heuristic and make the pacing testable. Named as still-deferred in both the Increment 5 and Increment 6 specs' out-of-scope sections; not started.

Sources: `docs/issues/2026-08-01-hauler-animation-outruns-the-simulated-trip.md`; `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.8; `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` §2.15
