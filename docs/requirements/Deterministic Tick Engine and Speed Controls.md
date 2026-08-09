---
type: PBI
parent: "[[Economy Core]]"
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

# Deterministic Tick Engine and Speed Controls

A sim-ecs world ticks the colony forward with pause, 2x and 4x speed, and single-step — 2 ticks/second at 1x. Every rate in the game is defined per tick, so N ticks produce identical state at any speed; there is no randomness in Increment 1. This determinism is what later increments' balance harness (Increment 5) and reproducible tests depend on.

Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md` §3.7, §4.4
