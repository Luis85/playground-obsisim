---
id: OBS-7-06
title: A tick after every delivery arrival, the Economy view (and four other surfaces) contradict themselves — full in-tray, reported as starved
status: Open
severity: minor
area: engine
increment: 7
created: 2026-08-10
source: whole-branch review, measured with a probe reading buildingState against ProductionSystem and HaulSystem's ALL_SYSTEMS order
affects:
  - src/engine/snapshot-buildings.ts
type: Issue
parent: "[[Seeing Goods Move Both Ways]]"
order: 240
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Economy view reports "input satisfied" and "starved" in the same breath

## What happens

`ALL_SYSTEMS` runs `ProductionSystem → HaulSystem → StatsSystem →
SnapshotSystem` (`src/engine/world.ts`), and `buildingState`
(`src/engine/snapshot-buildings.ts:81-90`) derives its last rung from
`batchActive` alone:

```ts
return batchActive ? 'producing' : 'waitingForInput';
```

On any tick where a delivery lands, the order runs against the reader:
**Production** declines to start a batch because the in-tray was still empty
when it ran (`batchActive` stays `false`) → **Haul** unloads the delivery,
filling the in-tray *after* Production already decided → **Snapshot** publishes
the tick's truth as `batchActive: false, inputBuffered: 3`. The Economy view
then renders **"0 units short — 1 building waiting for input"** for a building
that, in the very same snapshot, holds a full batch's worth of input.

A probe reading `buildingState`'s inputs across a running colony measured this
on **30 separate ticks at a regular 13-tick cadence** — one hit on every
delivery arrival, not an edge case a fixture has to hunt for. It lasts exactly
one tick, because the next tick's `ProductionSystem` pass sees the now-full
buffer and starts the batch. But the engine can be paused, and a player who
pauses on that tick is looking at the contradiction for as long as they leave
it paused — roughly a 1-in-13 chance on any given pause.

## Why it matters

`unitsShort`'s own doc comment in `src/app/stores/game-store.ts` calls
`waitingForInput` "the engine's own verdict, not a re-derivation from
buffers" — and trusts it precisely because every other rung of
`buildingState`'s ladder is a genuine blocker (`unstaffed`, `outputFull`,
`relocating`). The last rung breaks that pattern: it is not "no blocker
remains", it is "no batch happens to be running right now", and those are the
same thing everywhere except this one tick a delivery just landed on.

Five surfaces read this one field and five over-report on the same tick:
the Economy view's `buildingsWaitingForInput` count and its `unitsShort`
total, `DefStaffing.starved` (and the chain view's "⚠ starved" label that reads
it), the Buildings table's State column, and the canvas state ring
(`theme.stateRing.waitingForInput`). None of them is wrong about the data they
were handed — `buildingState` handed them the wrong verdict.

## Suggested resolution

**The fix belongs in `buildingState`, not in a store getter**, and that
matters more than it looks. `src/app/stores/game-store.ts` could special-case
this — e.g. treat `waitingForInput` with `inputBuffered` at a full batch as
"producing" for the Economy view alone — and the Economy sentence would stop
contradicting itself. But the Buildings table reads `b.state` directly, so
that fix would leave the table showing **"Waiting for input" beside "In: 3"
on the same row**, which is the identical contradiction in a more prominent
place: the Economy view is one aggregate sentence, the table is the row the
player is looking at when they ask why.

Every other rung of `buildingState`'s ladder asks "is there a blocker": no
staff, no output room, mid-relocation. The last rung should ask the same
question — does the in-tray afford one batch of this recipe — rather than
"is a batch running". That predicate already exists: `payFrom`
(`src/engine/systems/production-system.ts`) is the affordability check
`ProductionSystem` itself pays batches with, though it mutates the buffer as
it goes and so cannot be called as-is from a snapshot builder; a
non-mutating `canAfford` read of the same comparison, shared by both call
sites, closes this without adding a second rule that has to be kept in step
with the first.

One more effect worth recording rather than rediscovering: `BuildingFacts.inputBuffer`
is per-resource, so a fix keyed on it checks every input a multi-input recipe
needs, not only the total `inputBuffered` figure `unitsShort` reads today.
That shrinks the known total-versus-per-resource gap `unitsShort`'s own
comment already flags, rather than widening it.

The test is a fixture that reproduces the arrival tick directly: a staffed,
unblocked building with `batchActive: false` and an in-tray already holding a
full batch's worth of input — the state `HaulSystem` leaves behind for exactly
one tick before `ProductionSystem` next runs. Assert `buildingState` reports
`producing`, not `waitingForInput`, for that snapshot.
