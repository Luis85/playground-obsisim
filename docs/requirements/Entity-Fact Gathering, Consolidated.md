---
type: PBI
parent: "[[Increment 1.5 - Hardening and Polish]]"
order: 30
status: Done
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Entity-Fact Gathering, Consolidated

The per-tick refresh that gathers facts about entities for the UI is consolidated behind one shared path and gated so it doesn't run when nothing changed — closing out a duplication the Increment 1 review flagged as only partly fixed post-merge.

Spec: `docs/superpowers/specs/2026-07-30-increment-1.5-hardening-and-polish.md` §2.3
