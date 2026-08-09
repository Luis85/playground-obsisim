---
type: Epic
parent:
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

# Economy Simulation Core

The deterministic, headless simulation at the center of ObsiSim: resources with real value, two production chains that turn raw goods into finished ones, and workers whose hunger and tool coverage decide how fast that happens. Everything else in the game — the world view, logistics, population — is built on top of this core and inherits its determinism: the same commands over the same ticks produce the same state, at any speed.

Delivered in full by Increment 1 (Economy Core). Later epics extend it — Logistics prices distance into production, Population replaces the abstract "worker" with a colonist who is born, ages and can die — but the tick loop, the ECS world, and the two chains defined here have not changed shape since.

Source: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md`
