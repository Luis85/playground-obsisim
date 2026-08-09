---
id: OBS-6-01
title: A demolished tile is still occupied for the rest of the drain
status: Done
severity: minor
area: engine
increment: 6
created: 2026-08-08
resolved: 2026-08-09
source: "increment-6 review (automated PR review on #9) — a pre-existing increment-3 defect surfaced while reviewing this increment"
affects:
  - src/engine/systems/command-handlers.ts
  - tests/engine/systems/command-system.test.ts
type: Issue
parent: "[[Positions as Sim Truth - the Fixed Map and Save v2]]"
order: 120
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A demolished tile is still occupied for the rest of the drain

**Found:** 2026-08-08, during increment 6 review (automated PR review on #9).
**Introduced:** `b4f9677`, 2026-07-31 — increment 3, player-chosen construction tiles.
**Status:** resolved 2026-08-09 (`f27e9fe`), exactly as suggested below. See
[Resolution](#resolution-f27e9fe).

## What happens

Queue `demolishBuilding` and then `constructBuilding` at the freed tile while
paused. Both drain in the same tick. The construction is refused with
`Cannot build there.`, and the same applies to a `moveBuilding` onto that tile.

## Why

`occupiedTiles` in `src/engine/systems/command-handlers.ts` builds the drain's
occupancy from every live building row plus this drain's own claims:

```ts
function occupiedTiles(ctx: CommandContext): TileRef[] {
  return [
    ...ctx.buildings.map((row) => ({ col: row.position.col, row: row.position.row })),
    ...ctx.claimedTiles,
  ];
}
```

sim-ecs defers entity removal to the post-step sync, so a building demolished
earlier in this same drain is still in `ctx.buildings`. Its tile is therefore
still counted as occupied, and `isTileBuildable` refuses the later command.

The machinery to fix it already exists and is already used — by the function
immediately below:

```ts
function findBuilding(ctx: CommandContext, buildingId: number): BuildingRow | null {
  if (ctx.demolishedIds.has(buildingId)) return null;
  ...
}
```

`ctx.demolishedIds` exists for exactly this hazard. `occupiedTiles` simply
does not consult it.

## Why it matters beyond the one symptom

This is the third instance found in this codebase of a single family: **an
exclusion applied at some call sites and not at others.** The other two were
found and fixed during increment 6:

- `PendingChanges.demolished` was consulted live inside `spareBeds` and
  `shelterWithRoom`, while `ShelterRow.relocating` was frozen at context
  construction — so a nomad could be seated in a house already relocating.
- `PopulationSystem`'s shelter list folded in `PendingChanges.constructed`,
  while `CommandSystem`'s did not — so a house built mid-drain housed nobody
  until the next tick.

Each was a one-line omission with a several-line consequence, and each was
invisible to tests that exercised one command at a time. The general remedy
is the one increment 6 arrived at for beds: give the exclusion a single
function that owns it, and pass that function the state rather than a
pre-computed answer.

## Suggested fix

Filter `ctx.demolishedIds` when collecting building tiles:

```ts
...ctx.buildings
  .filter((row) => !ctx.demolishedIds.has(row.building.id))
  .map((row) => ({ col: row.position.col, row: row.position.row })),
```

## Test that would catch it

Queue `demolishBuilding` for a building and `constructBuilding` at that exact
tile in one drain; assert the construction succeeds and the notice board shows
no rejection. A second case should move a building onto the freed tile.

Note that the per-command tests cannot catch this — the defect only exists in
the *interaction*. Increment 6 added a mixed-drain round-trip test
(`pin the reject rules against what the live engine can actually write`) for
the same structural reason; extending that pattern to tile occupancy is
probably the cheaper long-term answer than a bespoke case.

## Resolution (f27e9fe)

Fixed exactly as suggested. `occupiedTiles` (`src/engine/systems/command-handlers.ts`)
now filters `ctx.demolishedIds` before mapping building rows to tiles — the
same exclusion `findBuilding` already applied immediately below it. One change
covers both call sites, `handleConstructBuilding` and `handleMoveBuilding`,
since both read tile occupancy through this one function rather than through
two separate lookups.

`tests/engine/systems/command-system.test.ts` gained the mixed-drain case the
note asked for. The existing test that had pinned the buggy same-drain
rejection as expected behaviour — renamed from "a tile freed by demolition is
buildable again on the NEXT tick" to "...in the SAME drain" — now asserts both
commands succeed with no rejection anywhere on the notice board, not merely
that a second, later attempt succeeds. A new sibling, "a tile freed by
demolition is a valid MOVE target in the same drain", covers the
`handleMoveBuilding` twin the note called out separately.

This was the third and last open instance of the family the note named — "an
exclusion applied at some call sites and not others." The other two the note
cites (bed-seating reading `PendingChanges.demolished` live while freezing
`ShelterRow.relocating`; `PopulationSystem`'s shelter list folding in
`pending.constructed` while `CommandSystem`'s did not) were already fixed
earlier in increment 6, per the note's own account — this was the one still
standing.
