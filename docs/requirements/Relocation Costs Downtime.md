---
type: PBI
parent: "[[Relocation Pricing]]"
order: 10
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Relocation Costs Downtime

Moving a building now costs distance-scaled ticks of downtime, at half a hauler's tiles-per-tick — carrying a building is harder than carrying goods — instead of being instant and free. A `relocating` state on the canvas and a downtime column in the Buildings table make it visible. Free relocation had let a player cluster everything at the camp and never pay Increment 4's haul gradient at all.

Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.3
