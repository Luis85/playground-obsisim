---
id: OBS-5-01
title: Moving a building desyncs the dot of a hauler already returning from it
status: resolved
severity: minor
area: world
increment: 5
created: 2026-08-01
resolved: 2026-08-08
source: Codex review on PR
affects:
  - src/shared/snapshot.ts
  - src/shared/haul.ts
  - src/engine/components.ts
  - src/engine/snapshot-builder.ts
  - src/app/world/layout.ts
tags:
  - rendering
  - game-feel
type: Issue
order: 60
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Moving a building desyncs the dot of a hauler already returning from it

`haulSpot` (`src/app/world/layout.ts`) derives **both** endpoints of a haul leg
and the leg's full length from the building's *current* tile:

```ts
const door = haulerSpot(cell);
const travelled = legProgress(w.haulTicksLeft, haulTicks(cell.col, cell.row, BALANCE.haulTilesPerTick));
const from = w.haulPhase === 'outbound' ? CAMP_ANCHOR : door;
```

The engine does not agree with that for a returning hauler. `handleMoveBuilding`
(`src/engine/systems/command-handlers.ts`) recomputes `ticksLeft` for
**outbound** trips only, and says why:

> A returning hauler is unaffected — it walks to the camp, which did not move.

So after a move, a returning hauler's `haulTicksLeft` is still counting down the
leg it actually started — from the building's **old** tile — while the renderer
measures both its route and its duration from the **new** one.

## Failure scenario

A forester sits 4 tiles from the camp. A hauler loads and starts back; two of
its four ticks remain. The player moves the forester to the far corner, 13 ticks
out.

- The simulation keeps charging the original 4-tick leg. The delivery lands on
  schedule, unchanged.
- The layout computes `legProgress(2, 13)` = `0.846`, so the dot reads as 85%
  home when the trip is really halfway.
- `from` becomes the new far-corner door, a point the hauler was never at, so
  the dot jumps across the map and finishes the leg on a line it never walked.

Nothing is lost and no delivery is affected — the artifact is visual, ends when
the leg does, and `legProgress` clamps to `[0, 1]`, so the dot can never leave
the camp↔building segment. That clamp is why this is minor rather than
important.

Worth noting: `legProgress`'s own doc comment already carries a hedge for the
symptom without naming the cause — *"A leg that somehow reports more ticks left
than its length clamps to 0 rather than running backwards past the camp."* The
`somehow` is this.

## Why it exists

Both halves are correct in isolation and were written by different tasks.
Increment 4 established that a returning trip must not be retargeted, because
the goods are already in hand and bound for a camp that did not move. Increment
5's OBS-4-09 fix made the dot derive its position from `haulTicksLeft` so the
drawn walk and the cost model share one clock. Neither task could see that a
mid-leg relocation breaks the assumption the second one rests on — stated
explicitly in `legProgress`'s comment as *"recomputed from the building's tile
rather than stored, since `haulTicks` is deterministic."* It is deterministic
*given a tile*, and a relocation changes the tile under a leg already in flight.

## Proposed fix

Stop re-deriving in the renderer what the engine already knows. `HaulTrip`
computes the leg's length when the leg starts (`haul-system.ts`, and again in
`handleMoveBuilding` for outbound trips); it should keep it, and the snapshot
should publish it, so `haulSpot` reads the leg total instead of recomputing it.

That alone fixes the *sustained* error — progress interpolates against the
duration the simulation actually charged. The one-off positional jump needs the
pickup point published too (an origin tile on the trip, fixed when the leg
begins), which is the fuller version of the same idea: a leg's endpoints and
duration are facts the engine owns, not things a renderer should infer.

**No save migration is required.** `HaulTrip` is not persisted — `src/shared/save.ts`
stores only `hauling: boolean`, and trip state is rebuilt on load. This is a
snapshot-contract change, not a save-format one.

## Verification note

`src/app/world/layout.ts` is pure and unit-testable, so the leg-total half of
this is straightforwardly testable — unlike the `renderer.ts` pacing it feeds,
which no vitest test may import. A test would set a `haulTargetId` building at
one tile, publish a returning hauler whose `haulTicksLeft` exceeds that tile's
`haulTicks`, and assert the dot's position. That test fails today.

## Resolved

Fixed in `2db6d2e`. `HaulTrip` now freezes `legTicks` and the return leg's pickup
tile at each of the three sites that begin or retarget a leg, and the snapshot
publishes them; `haulSpot` reads them instead of recomputing anything from the
building's live tile. The outbound endpoint is unchanged — the engine does
retarget an outbound trip on a move, so renderer and simulation still agree there.

Confirmed no save migration was needed, as this note predicted: `HaulTrip` is not
persisted.

The load-bearing test in `tests/app/world-layout.test.ts` was run against the old
code first and failed (5.3077 against the expected 5.25) before the fix made it
pass — the test this note asked for, shown failing for the reason it names.
