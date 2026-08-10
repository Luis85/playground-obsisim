---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 30
status: New
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Construction as Work

A building still appears finished the tick it is ordered. `handleConstructBuilding` (`src/engine/systems/command-handlers.ts`) pays the def's cost out of the colony ledger and spawns a complete, working building at the target tile — no site, no materials carried there, no labour, no time. It is the last place in the game where goods teleport and work happens for free.

**Descoped from Increment 7 deliberately, and this note is the record.** That increment's §1.1 and §2.13 name it as the natural successor rather than folding it in: it would roughly double a fifteen-task increment, and every part of it sits on top of machinery Increment 7 builds first.

## Why it belongs to Logistics rather than to World and Spatial Play

The interesting half is not "buildings take time" — it is that a construction site is **a building-shaped thing with an input buffer and no output**. Once Increment 7 ships, haulers already deliver a recipe's inputs to a building that needs them, respect reservations, claim what they are fetching, and price every leg. A construction site is that same machinery pointed at a different consumer: planks and wood carried to a tile, banked locally, consumed as the build progresses.

Doing it before two-way haul would have meant inventing a second, parallel delivery mechanism for materials. Doing it after means it is largely a content and lifecycle problem.

## What it would take

- A construction-site entity: a tile, a target def, an input buffer, and progress — the `BuildingDef` role vocabulary (produces / shelters / stores) gains a fourth arm, or a site is a distinct entity kind.
- A **builder** role, staffed the way haulers are, whose work advances the site instead of a recipe. Commute and hunger apply as they do to any other work.
- Materials **delivered**, not paid: the cost leaves the ledger when a hauler picks it up, and a half-built site holds real goods that a cancelled build has to account for.
- Cancellation, and what happens to what has already arrived.
- A save version: sites, their buffers and their progress are persistent state.
- Surfaces: the site on the canvas and in the tables, and the Economy view naming a build backlog beside the input and output backlogs it will already name.

## What it would close for free

`[[Demolish-and-rebuild bypasses the priced relocation]]` (OBS-5-03), accepted-not-fixed in Increment 7. Pricing that bypass on its own needs persisted demolition history to detect "this construct is really a relocation". If a construct costs delivered materials and a builder's time regardless, rebuilding elsewhere stops being free and the exploit closes without any bookkeeping at all — which is the strongest argument for doing this increment before revisiting that issue.

## Documentation

- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §1.1, §2.13 — the descoping and its reasoning
- `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md` — the issue this would close as a side effect
