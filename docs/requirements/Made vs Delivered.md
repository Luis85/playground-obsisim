---
type: PBI
parent: "[[Increment 5 - Validated Balance]]"
order: 40
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Made vs Delivered

The Economy view's `Prod/t` column actually reported deliveries, not production (OBS-4-06) — a building could look idle while it was really just waiting on a hauler. It's now two columns, `Made/t` and `Delivered/t`, and the gap between them is exactly the per-stage haul backlog.

Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.5
