---
id: OBS-5-03
title: Demolish-and-rebuild bypasses the priced relocation entirely, for an empty building
status: Open
severity: minor
area: engine
increment: 5
created: 2026-08-09
source: Codex review on PR
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - game-design
  - balance
type: Issue
parent: "[[Relocation Pricing]]"
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

## What the Increment 7 spec changes about this (2026-08-09)

The paragraph above rests on friction: the bypass only pays off for a building with nothing to lose, and anything in real use pays for the trick in a destroyed buffer, dropped batch progress and a crew that has to be walked over and reassigned.

**The `storehouse` that Increment 7 specs has none of that friction.** It has no crew (`workerSlots: 0`), no recipe and so no batch, and by §2.7 of that spec its contents move to the camp on demolition rather than being destroyed — deliberately, because unlike an output buffer those goods are already in the ledger and counted in `colonyWealth`. So for the one building a player most wants to reposition as their colony spreads, demolish-and-rebuild becomes free, instant and lossless, and the "why it is `minor`" reasoning above does not apply to it.

This does not by itself decide the resolution below; it is the fact the decision should now be made against. One candidate is ruled out: charging downtime when a construct lands on the *same tick* as a matching demolish is bypassed by waiting one tick, since the same-tick ledger is gone by then — it taxes the exploit rather than closing it. Anything in that family needs persisted demolition history, which is a save field.

## Suggested resolution

Not decided here — a balance/game-design call, not a one-line fix:

- **Price it anyway.** Charge relocation-equivalent downtime (or some cost) on a demolish immediately followed by a construct that reads as the same relocation — hard to define precisely, and risks penalizing a player who genuinely wanted to bulldoze one building and build something unrelated.
- **Accept it as-is.** The bypass only pays off for an idle building nobody has invested in yet; that may be a reasonable freebie rather than a hole worth the complexity of detecting "this construct is really a relocation."
- **Leave the mechanic, keep the loss visible.** If the buffer/batch/staffing loss is judged the real intended cost of demolishing, leave the resource-and-downtime gap alone — it already surfaces via the buffer-loss notice from OBS-4-07.

Whichever is chosen: `docs/requirements/Increment 5 - Relocation Pricing.md` and `docs/requirements/Demolition Keeps Its Full Refund.md` record the mechanic accurately as of this note; update them again if the mechanic itself changes.
