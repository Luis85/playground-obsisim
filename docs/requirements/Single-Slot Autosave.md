---
type: PBI
parent: "[[Economy Core]]"
order: 50
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Single-Slot Autosave

The colony persists into the plugin's own `data.json` via Obsidian's `loadData()`/`saveData()`, one slot, no manual save step. This is also where the save-versioning story starts: Increment 1.5 added the migration seam this format needed before Increment 2 could add its first new save fields.

Spec: `docs/superpowers/specs/2026-07-03-colony-sim-plugin-design.md` §4.5, §7
