---
type: PBI
parent: "[[Two-Way Haul and Storage Buildings]]"
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

# Save v6 - Input Buffers and Stored Goods

Every saved building carries its input buffer and its share of the ledger, and the save's stockpile becomes the camp's contents — which is exactly what a v5 stockpile already was, so a v5 colony loads as a v6 one with empty in-trays, no depots and its goods where it left them. Values coupled to balance numbers are clamped at load rather than rejected: an over-full in-tray is trimmed, and stored goods beyond a building's capacity spill to the unbounded camp, so retuning a constant downward never orphans a valid save or loses a unit.

A reopened colony reads right *while still paused*, which is the part that is easy to get wrong: stock, wealth and meals per head aggregate the camp with every building's stored goods before the first tick, so a colony with its planks in a depot does not show a wealth figure short of the truth and a build palette refusing buildings it can afford.

Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.9
