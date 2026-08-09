---
id: OBS-6-01
title: A demolished tile is still occupied for the rest of the drain
status: open
severity: minor
area: engine
increment: 6
created: 2026-08-08
source: increment-6 review (automated PR review on
affects:
  - src/engine/systems/command-handlers.ts
  - tests/engine/systems/command-system.test.ts
type: Issue
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
**Status:** open. Not fixed in increment 6: pre-existing and unrelated to that
increment's mechanics, on a branch already carrying thirty-odd commits.

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
