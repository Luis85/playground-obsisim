---
id: OBS-5-03
title: Demolish-and-rebuild bypasses the priced relocation entirely, for an empty building
status: Open
severity: minor
area: engine
increment: 5
created: 2026-08-09
source: Codex review on PR #11 — caught while structuring the shipped work into the product backlog, not during increment 5 or 6
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - game-design
  - balance
type: Issue
parent: "[[Increment 5 - Relocation Pricing]]"
order: 40
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Demolish-and-rebuild bypasses the priced relocation

## What happens

`handleMoveBuilding` (`src/engine/systems/command-handlers.ts`) charges distance-scaled downtime on every move — the entire point of Increment 5's relocation pricing. `handleDemolishBuilding` refunds the building's full construction cost via `stockpile.refund(def.cost)`; `handleConstructBuilding` charges that exact same `def.cost` again to build elsewhere.

For an empty, unstaffed building, demolishing it and building a fresh one at the destination is therefore:

- **Net-zero on resources** — the refund exactly cancels the new construction cost.
- **Zero downtime** — neither `handleDemolishBuilding` nor `handleConstructBuilding` charges any ticks; only `handleMoveBuilding` does.

A player who wants to relocate an empty building pays nothing extra by demolishing and rebuilding instead of moving, and skips the downtime Increment 5 exists to charge.

## Why it wasn't caught at the time

Increment 5's spec (§2.6) confirmed the demolition refund "keeps its full refund" as an explicit, deliberate decision — but what was checked was whether the refund itself should change, not whether the refund, combined with the *new* move-downtime cost from the same increment, opened a way around that cost. Two mechanics that were each individually correct on their own combined into a gap neither task's review surfaced.

## Why it is `minor`, not `important`

It only zeroes out for a building with nothing to lose: an empty buffer, no batch in progress, no assigned workers. Demolition still destroys the buffer's contents (OBS-4-07 — deliberately not refunded) and drops any batch progress, and a rebuilt building starts unstaffed, so the player has to walk workers back over and reassign them by hand — `moveBuilding` keeps all three intact automatically. For a building actually in use, that loss is real friction a min-maxing bypass would have to accept. The gap is exploitable in full only for the specific case — an idle, empty, unstaffed building — where a player might reasonably want to relocate anyway before staffing it.

## Suggested resolution

Not decided here — a balance/game-design call, not a one-line fix:

- **Price it anyway.** Charge relocation-equivalent downtime (or some cost) on a demolish immediately followed by a construct that reads as the same relocation — hard to define precisely, and risks penalizing a player who genuinely wanted to bulldoze one building and build something unrelated.
- **Accept it as-is.** The bypass only pays off for an idle building nobody has invested in yet; that may be a reasonable freebie rather than a hole worth the complexity of detecting "this construct is really a relocation."
- **Leave the mechanic, keep the loss visible.** If the buffer/batch/staffing loss is judged the real intended cost of demolishing, leave the resource-and-downtime gap alone — it already surfaces via the buffer-loss notice from OBS-4-07.

Whichever is chosen: `docs/requirements/Increment 5 - Relocation Pricing.md` and `docs/requirements/Demolition Keeps Its Full Refund.md` record the mechanic accurately as of this note; update them again if the mechanic itself changes.
