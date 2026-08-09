---
type: PBI
parent: "[[Increment 1 - Economy Core]]"
order: 30
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Hunger-Driven Worker Efficiency

Workers are individual entities with hunger climbing 1/tick; at hunger ≥ 50 they eat from the stockpile (bread first, berries as fallback). Efficiency slides linearly from 1.0 fed to 0.2 fully starving — soft pressure, not a fail state, since nobody dies in Increment 1 (Increment 6 later made starvation lethal and renamed the worker a colonist). Recruiting is capped at one worker per 30 ticks so food pressure stays meaningful.

Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md` §3.5
