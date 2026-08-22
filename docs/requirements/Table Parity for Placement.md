---
type: PBI
parent: "[[Building Placement]]"
order: 40
status: Superseded
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Table Parity for Placement

Players without WebGL keep full economic parity: construct auto-places new buildings on the pre-Increment-3 pattern, a Tile column shows where each one landed, and a Demolish action sits per row — the table UI stays a complete way to play, not a fallback.

Spec: `docs/superpowers/specs/2026-07-30-increment-3-building-placement.md` §2.7

**Superseded by `[[The Ledger Fallback]]`.** `moveBuilding` never had a table, so this promise was already not quite true; Increment 11 §1.2 restates the contract rather than retracting it — a complete read surface with a control for every verb, offered as a fallback rather than an equal path — and ships the table control this PBI lacked.
