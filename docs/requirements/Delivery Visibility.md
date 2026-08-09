---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 30
status: Open
increment: 5
tags:
  - game-design
started: ""
horizon: ""
start: ""
due: ""
---

# Increment 5 - Delivery Visibility

The Economy view's `Prod/t` column actually reported deliveries, not production (OBS-4-06) — a building could look idle while it was really just waiting on a hauler. Increment 5's balance harness needed gross production plumbed through the snapshot anyway, which made the honest fix affordable: two columns, `Made/t` and `Delivered/t`, with the gap between them exactly the per-stage haul backlog.

## Documentation

- Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.5
- Plan: `docs/superpowers/plans/2026-08-01-increment-5-validated-balance.md`
- Parent increment: [[Validated Balance]]
