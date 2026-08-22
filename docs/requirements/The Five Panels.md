---
type: PBI
parent: "[[The World Screen]]"
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

# The Five Panels

Inspector, Colony, Population, Economy and Attention, as the dock's five panels — Colony, Population and Economy are relocations of the Dashboard, Population view and Economy view rather than new derivations; Attention is genuinely new. Every rule an Attention row states — a stalled building, a construction shortfall, runway at or under 30 ticks, colonists with no bed, starvation, idle adults — is written as a getter in `src/app/stores/`, not inside the panel component, so it inherits the store's coverage floor and is checked once rather than being restated per surface. Where a figure appears in both a panel and the Ledger, the two share a store getter rather than a second derivation, following the precedent `PopulationSummary` already set.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md` §2.3, §2.4, §2.7
