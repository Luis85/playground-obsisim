---
type: PBI
parent: "[[Two-Way Haul and Storage Buildings]]"
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

# Inputs Are Delivered, Not Teleported

Every producing building has an input buffer beside its output buffer, and a recipe's inputs are paid out of that buffer rather than out of the colony's ledger from anywhere on the map. A staffed building with an empty in-tray produces nothing and reports **Waiting for input** — a state that already existed and meant "not this tick", and now means something a player can act on. Buildings whose recipe has no inputs are untouched: a forester, a farm and a gatherers' hut never wait, which is why their measured haul gradient is unchanged.

Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.1, §2.8
