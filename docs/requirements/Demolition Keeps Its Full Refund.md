---
type: PBI
parent: "[[Increment 5 - Relocation Pricing]]"
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

# Demolition Keeps Its Full Refund

Confirmed as still correct rather than changed: demolishing a building keeps its full construction-cost refund even now that relocation carries a downtime cost. The combination was not revisited, and for an empty, unstaffed building it means demolish-and-rebuild is strictly cheaper than a priced move — same net resources, zero downtime. What still favors a real move is everything demolition does not preserve: the building's buffer contents (OBS-4-07 — deliberately not refunded), batch progress, and worker assignments, all of which `moveBuilding` keeps intact.

Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.6
