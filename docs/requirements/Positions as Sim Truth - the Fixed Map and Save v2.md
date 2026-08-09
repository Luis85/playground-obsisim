---
type: PBI
parent: "[[Increment 3 - Building Placement]]"
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

# Positions as Sim Truth - the Fixed Map and Save v2

A fixed 24x16 map (camp band on the left) holds every building's position as sim state, not cosmetics — Increment 4 later priced haul distance off it, and Increment 6 priced commute the same way. Save v2 persists positions; every v1 colony migrates onto exactly the layout Increment 2 had derived for it, so nobody's colony visibly rearranges on load. The placement rule that decides what tile is buildable exists in exactly one place, shared by the renderer's ghost preview and the sim's own validation.

Spec: `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md` §2.1, §2.3-2.4
