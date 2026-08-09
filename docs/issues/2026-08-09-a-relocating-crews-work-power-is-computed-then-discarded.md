---
id: OBS-6-08
title: A relocating crew's work power is computed and discarded on the engine side, and reaches zero a different way on the snapshot side
status: open
severity: minor
area: engine
increment: 6
created: 2026-08-09
source: increment-6 OBS-6-06 fix pass (`4a338ce`) — noticed while making the snapshot's relocating-crew zero explicit and measured; left standing because the engine already reaches the correct answer, just not through anything the snapshot's fix could reuse
affects:
  - src/engine/systems/production-system.ts
  - src/engine/snapshot-builder.ts
  - tests/engine/systems/snapshot-system.test.ts
---

# A relocating crew's work power is computed and discarded on the engine side, and reaches zero a different way on the snapshot side

## What happens

Nothing observable — this is a code-shape finding, not a behavioural one. Both
sides currently report the same number. What differs is *how* they get there,
and that difference is not enforced by anything shared.

`ProductionSystem.sumWorkPower` (`src/engine/systems/production-system.ts`)
accumulates every assigned worker's contribution by building id, with no
relocation check at all:

```ts
function sumWorkPower(
  workers: Iterable<{ job: JobAssignment; efficiency: Efficiency; coverage: ToolCoverage; home: Home }>,
  tileById: ReadonlyMap<number, TileRef>,
): Map<number, number> {
  const powerByBuilding = new Map<number, number>();
  for (const { job, efficiency, coverage, home } of workers) {
    if (job.buildingId === null) continue;
    const factor = placementFactorOf(home.buildingId, job.buildingId, tileById);
    const contribution = workerWorkPower(efficiency.value, coverage.remainingTicks, factor);
    powerByBuilding.set(job.buildingId, (powerByBuilding.get(job.buildingId) ?? 0) + contribution);
  }
  return powerByBuilding;
}
```

A worker assigned to a relocating building gets a real, non-zero
`contribution` computed and stored in `powerByBuilding` exactly like anyone
else's. The value is thrown away one call site later, in the per-building
loop that runs after `sumWorkPower` returns:

```ts
if (relocation.ticksLeft > 0) {
  relocation.ticksLeft--;
  continue;
}
...
const workPower = powerByBuilding.get(building.id) ?? 0;
```

The `continue` fires before `powerByBuilding.get(building.id)` is ever
reached for that building, so the computed contribution is never read,
`production.progress` never advances, and the crew banks nothing — correctly.
But the correctness comes from control flow discarding a real number, not
from the number being zero.

The snapshot side reaches the same zero a different way. `deliveredWorkPowerOf`
(`src/engine/snapshot-builder.ts`, added resolving OBS-6-06, fixed for this
exact case by `4a338ce`) checks set membership *before* computing anything:

```ts
function deliveredWorkPowerOf(w: ColonistFacts, factor: number, relocatingIds: ReadonlySet<number>): number | null {
  if (w.buildingId === null) return null;
  if (relocatingIds.has(w.buildingId)) return 0;
  return workerWorkPower(w.efficiency, w.toolTicks, factor);
}
```

`relocatingIds` is built by `relocatingBuildingIds`, a set comprehension over
`BuildingFacts` keyed on `relocatingTicks > 0` — a second, independently
written test of the same underlying fact `ProductionSystem`'s `relocation.ticksLeft
> 0` already tested a few lines earlier in the same tick.

## Why it matters, and why it is only `minor`

Today the two guards agree, and — checked, not assumed, see below — a drift
between them is currently caught. So this is not a live risk. It is recorded
because it is the same family `OBS-6-01` named — "an exclusion applied at some
call sites and not others" — with a twist: there, one call site *forgot* the
exclusion. Here, both call sites *have* it, independently, in two different
shapes (control flow that discards a computed value vs. a value check that
skips the computation), for a boundary subtle enough that this project has
gotten it wrong twice before (`snapshot-builder.ts`'s own doc comment: "task
6's `> 0` vs `> 1`").

What ties the two together today is test coverage, not shared code. The tests
`4a338ce` added run `ProductionSystem` and `SnapshotSystem` in the same world
on purpose, and assert on both the engine's own state (`Production.progress`)
and the snapshot's (`deliveredWorkPower`, `workPower`) from the same fixture —
which is exactly what makes a boundary mismatch between the two visible. That
is a real defence, but it is a defence a filtered run (`-t`, the exact hazard
`OBS-6-04` records elsewhere in this project) or a future test author editing
only one file could weaken without anyone deciding to. The wasted computation
itself is free (`workerWorkPower` is two multiplications and a ternary), so the finding is
the duplicated, independently-maintained boundary check — not performance.

**Verified by mutation**, both directions, restored byte-identical after each:

| mutation | result |
| --- | --- |
| `snapshot-builder.ts`'s `relocatingBuildingIds` filter, `> 0` → `> 1` (engine untouched) | `SnapshotSystem > publishes zero delivered work power for a crew whose building is mid-move` fails: `expected 1 to be +0` |
| the same filter, `> 0` → `> -1` (engine untouched) | 5 tests fail across `snapshot-system.test.ts`, every relocation/work-power case, on the same `+0`-vs-real-number shape |
| `production-system.ts`'s own gate, `ticksLeft > 0` → `ticksLeft > 1` | caught too, but by an engine-only assertion (`progressOf(moving)).toBe(0)`) before any snapshot field is even reached — this direction doesn't isolate cross-system disagreement, because the same `if` that decides "skip" also does the decrementing |

So the claim this note first drafted — "nothing pins the two guards together"
— does not hold, and is corrected here rather than left standing: something
does pin them together, today. What is accurate is narrower: the pin is two
tests that happen to exercise both systems together, not a boundary that
cannot be expressed twice.

## Why filed rather than fixed

`sumWorkPower` is deliberately shaped as a full pass over `workers` that
returns a completed map, split out of the run function specifically to keep
its own CRAP score under the quality gate (its doc comment says so, "same
principle as `startBatch`/`completeBatches`"). Skipping relocating workers
inside it would need the same `relocatingIds` set `snapshot-builder.ts`
builds — cheap to add, since `ProductionSystem` already materializes
`buildingRows` before calling `sumWorkPower` and could derive the set from
those rows the same way `relocatingBuildingIds` does — but it would still
leave two independently-maintained sets in two files answering the same
question, just with one fewer wasted multiplication. Unifying the two for
real would mean the engine publishing `deliveredWorkPower` itself as a
per-worker fact and the snapshot reading it rather than recomputing it, which
is a bigger change than this finding justifies on its own, and touches the
same `ColonistFacts`/`buildEntitySections` boundary `OBS-6-06` already spent a
resolution pass on this branch. Left standing rather than folded into that
work.

## Suggested fix

Smallest honest version: have `ProductionSystem` build its own
`relocatingIds` set from `buildingRows` before calling `sumWorkPower`, and
have `sumWorkPower` skip a worker whose `job.buildingId` is in it — the same
shape `relocatingBuildingIds` already uses, so the two guards at least *read*
as the same check even though they remain two implementations. That removes
the compute-then-discard step but not the duplication.

The fuller fix is the one gestured at above: publish `deliveredWorkPower`
(or the `powerByBuilding` map itself) as something `SnapshotSystem` reads
rather than recomputes, the way `PendingChanges` already lets one system's
pending state be read by another without each recomputing it independently.
That would make the relocation boundary a single piece of state instead of
two coordinated checks, at the cost of a resource the engine did not
previously need to publish.

## Test that would catch it

Already exists, and is already run: `tests/engine/systems/snapshot-system.test.ts`'s
`publishes zero delivered work power for a crew whose building is mid-move`
and `overstates by exactly one tick on the landing tick, and is exact read
forwards` — see the mutation table above. This note's remaining ask is not a
missing test; it is the suggested fix above, which would make the agreement
structural instead of coincidental. If that fix is ever made, re-run the same
three mutations first: the `> 1`/`> -1` ones should become *inexpressible*
(there would be only one boundary left to mutate), and that is the signal the
fix actually unified the two rather than just relocating the duplication.
