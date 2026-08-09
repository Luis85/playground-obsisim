---
type: Feature
parent: "[[World and Spatial Play]]"
order: 20
status: Open
increment: 3
tags:
  - game-design
started: ""
horizon: ""
start: ""
due: ""
---

# Increment 3 - Building Placement

The world view becomes interactive: arm a building in the World tab's palette, a ghost preview follows the cursor (accent = buildable, red = blocked), click to place, and placement stays armed for repeat building. Any building on the canvas can be selected, moved (workers walk after it, batch intact), or demolished (confirmed, full cost refund, workers walk home). Positions become sim truth on a fixed 24x16 map, persisted as save v2 with a migration that derives layout for every existing v1 colony. Tables keep full economic parity throughout.

## Documentation

- Spec: `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md`
- Plan: `docs/superpowers/plans/2026-07-30-increment-3-building-placement.md`
