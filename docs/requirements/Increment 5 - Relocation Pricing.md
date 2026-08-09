---
type: Feature
parent: "[[World and Spatial Play]]"
order: 30
status: Done
increment: 5
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Increment 5 - Relocation Pricing

Moving a building stops being free and instant: Increment 5's balance harness measured that free relocation let a player cluster everything at the camp and never pay Increment 4's haul gradient, so moving now costs distance-scaled ticks of downtime, saved as part of the colony rather than runtime-only. Demolition's full construction-cost refund was confirmed rather than revised alongside it, which was not a complete answer: for an empty, unstaffed building, demolish-and-rebuild pays the same net resources and no downtime at all, undercutting the price this increment just added to moving. What still makes a real move worth its downtime is what a rebuild does not preserve — the building's buffer contents (never refunded, by OBS-4-07's deliberate design), any batch in progress, and its worker assignments.

## Documentation

- Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.3-2.4, §2.6
- Plan: `docs/superpowers/plans/2026-08-01-increment-5-validated-balance.md`
- Parent increment: [[Increment 5 - Validated Balance]]
