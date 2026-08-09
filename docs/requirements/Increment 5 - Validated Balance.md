---
type: Feature
parent: "[[Engineering Quality and Balance Tooling]]"
order: 20
status: Done
increment: 5
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Increment 5 - Validated Balance

A headless balance harness runs a scenario through the real engine and reports what a building made, delivered, and lost to stalls or relocation — replacing guesswork with a measured distance/hauler sweep. The harness's own first finding corrected Increment 4's stated hauler gradient. Moving a building now costs distance-scaled downtime instead of being free and instant, saved rather than runtime-only. The Economy view's misleading `Prod/t` column (it reported deliveries, not production — OBS-4-06) becomes two honest columns, `Made/t` and `Delivered/t`.

## Documentation

- Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md`
- Plan: `docs/superpowers/plans/2026-08-01-increment-5-validated-balance.md`
