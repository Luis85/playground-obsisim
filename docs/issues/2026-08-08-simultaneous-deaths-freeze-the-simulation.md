---
id: OBS-6-02
title: Two colonists dying on the same tick freeze the whole simulation for a tick each
status: open
severity: important
area: engine
increment: 6
created: 2026-08-08
source: increment-6 Task 12 (population balance harness) — found by running, not by reading; the autosave consequence added at Task 13 close-out, after PR #9's bot reached the same defect independently
affects:
  - src/engine/systems/population-handlers.ts
  - src/engine/game-engine.ts
  - src/engine/world.ts
  - tests/engine/fixtures.ts
---

# Two colonists dying on the same tick freeze the whole simulation for a tick each

**Found:** 2026-08-08, building the population balance harness (Task 12). The
first draft of `runPopulationScenario` reported `deathsByStarvation: 9` for a
colony of three, which is how this surfaced.
**Introduced:** not by any commit here — it is sim-ecs 0.6.4 behaviour that the
engine has never had reason to trip until colonists could die.
**Status:** open. Not fixed in increment 6: the remedy is in how the engine
removes entities, the branch already carries thirty-odd commits, and Task 12's
job was to measure the balance rather than change the engine underneath it.

## What happens

Remove more than one entity in a single tick — which, since increment 6, means
any famine or any synchronised die-off — and:

1. Exactly **one** entity is actually removed on that tick.
2. On each subsequent `step()`, one more is removed and **no system runs at
   all**. Not `HungerSystem`, not `PopulationSystem`, not `SnapshotSystem`.
   Colonists do not age, buildings do not produce, haulers do not walk, and
   `SnapshotStore.latest` is left untouched from the tick before.
3. Once the queue has drained, the next `step()` behaves normally.

So `n` simultaneous deaths cost `n - 1` frozen ticks. `SimClock.tick` still
advances across them (`GameEngine.runStep` and `stepTick` both increment it
before stepping), so the clock and the simulation silently diverge.

## Evidence

Three colonists spawned at `hunger: hungerMax`, `starvingTicks:
starvationDeathTicks - 1`, plus one fed survivor whose only expected change is
its age. Stepping six times:

```
clock=1 snapTick=1 entities=3 survivorAge=1001
clock=2 snapTick=1 entities=2 survivorAge=1001   <- frozen
clock=3 snapTick=1 entities=1 survivorAge=1001   <- frozen
clock=4 snapTick=4 entities=1 survivorAge=1002
clock=5 snapTick=5 entities=1 survivorAge=1003
clock=6 snapTick=6 entities=1 survivorAge=1004
```

The survivor's age is the tell: it does not move on the frozen ticks, so this
is not a snapshot-publishing quirk — the tick genuinely did not happen.

## Why

`PopulationSystem` removes through `actions.commands.removeEntity(entity)`, and
sim-ecs defers the whole batch to the sync point at the end of the tick. There,
the second removal throws:

```
TypeError: Cannot read properties of undefined (reading 'addComponent')
    at removeEntity (sim-ecs/src/world/runtime/runtime-world_entities.ts:78:61)
    at command      (sim-ecs/src/world/runtime/commands/commands.ts:126:45)
    at executeAll   (sim-ecs/src/world/runtime/commands/commands.ts:75:23)
    at handler      (sim-ecs/src/world/runtime/runtime-world.ts:245:41)
    at executeOnSyncHandlers (sim-ecs/src/scheduler/pipeline/sync-point.ts:37:19)
```

sim-ecs catches that error itself and publishes it to its own event bus
(`runtime-world.ts`'s `catch (o) { await this.eventBus.publish(o) }`). Nothing
subscribes, so it is silent. The commands that had not run yet stay queued, and
the throw propagates far enough to abort the rest of that scheduler execution —
which is why the following `step()` produces no systems, only one more drained
removal.

It reproduces identically under the default `executionFunction` and under
`runSynchronously`, so it is not a scheduling artefact of the test harness.

## Why it matters

- **Notices are re-readable.** `SnapshotStore.latest` is the same object across
  the frozen ticks, so any consumer that tallies `snapshot.notices` per tick
  counts each death once per frozen tick. That is exactly the false measurement
  Task 12 hit (`deathsByStarvation: 9` for three colonists), and the Obsidian
  view's notice feed is a second consumer with the same shape.
- **A famine is the common case.** Colonists that starve together started
  starving together; a synchronised cohort dies of old age together too. The
  frozen window is proportional to how bad the disaster is, so the simulation
  stutters hardest exactly when the player is watching.
- **A save can be written mid-freeze, advertising colonists who are already
  dead.** `GameEngine.runStep` autosaves on `clock.tick % autosaveEveryTicks
  === 0`, inside the same `try` that stepped the world, and the clock crosses
  that boundary during a freeze like any other tick. `serialize()` then walks
  the live entities — which still include everyone whose `removeEntity` is
  stuck in the queue — so the file contains colonists the simulation has
  already killed.

  The sharp edge is that **nothing rejects it**. Those records are
  structurally well-formed: a real id, a real age, a `homeId` naming a real
  house. `isLoadableSave` accepts the save, and the two death causes then
  diverge — neither in the player's favour:

  - **A starvation victim is restored alive and dies on tick 1.**
    `clampedStarving` clamps to `BALANCE.starvationDeathTicks` *inclusive*, and
    `resolveStarvation` fires on `>=`, so the colonist loads at exactly the
    threshold and is killed by the first tick the player runs — a death whose
    cause happened before the save was written.
  - **An old-age victim never loads at all.** The past-own-lifespan guard
    (`257acf6`) drops them during restore, so the colony silently comes back
    smaller than the file describes, with no notice and nothing in the log.

  Both are the same wrong from opposite ends: the file records a population the
  simulation had already revoked.

  This is the third arrival of one principle in this increment: **the seed must
  not advertise a state tick 1 revokes.** The other two — the homing phase
  running before the first tick rather than after, and refusing to restore a
  colonist already past their own lifespan — were both closed. This one is
  open, and it is the same defect with the freeze standing in for the missing
  guard. Fixing the removal batching (below) closes it at the root; a
  `deadIds`-aware `serialize()` would only paper over it.

- **It silently inflates every tick-indexed measurement.** `SimClock.tick`
  advances across frozen steps, and the snapshot published after a drain
  carries that inflated tick — so a quoted "by tick 7,800" would mean fewer
  than 7,800 ticks of actual simulation whenever a freeze occurred. Increment
  6's published long curves happen to report `frozen steps 0` (the id-derived
  lifespan spread desynchronises deaths), so their labels are exact, but that
  is luck rather than protection. `runPopulationScenario` publishes
  `frozenSteps` so a future measurement cannot be quoted without checking it.

  The starvation-warning scenario is the one that *does* freeze: three
  colonists with no food at all die within two ticks of each other and the run
  loses **2 steps**, both inside the single gap tick 199 → 202. Because that
  gap is after the first death, the 99-tick warning window §4.1 q2 quotes spans
  no frozen step and is exact — but the figure has to be *read* to know that,
  and until the increment-6 fix pass it was printed nowhere: `frozenSteps`
  reached the report only through `curveLines`, and this is the one scenario
  that does not go through it. Publishing a number on a type and never emitting
  it is the same as not publishing it.

## Suggested fix

Two candidates, in order of preference:

1. **Do not batch removals through `commands`.** `PopulationSystem` already
   defers *logically* via `ctx.deadIds`; the physical removal could be applied
   after `world.step()` returns, from the same place `refreshEntitySections`
   runs (`GameEngine.runStep` / `tests/engine/fixtures.ts`'s `stepTick`), using
   a `RemovalLedger` that carries the entities rather than a dirty flag. That
   keeps one removal per `commands` batch — the case sim-ecs handles.
2. **Drain the queue explicitly.** Call the runtime world's `flushCommands()`
   in a loop after `step()` until the entity count stops changing. Cheaper to
   write, but it still relies on sim-ecs throwing once per extra command, and it
   leaves the swallowed `TypeError` in place.

Either way, subscribing something to sim-ecs's event bus so a swallowed
`TypeError` is not silent is worth doing on its own.

## Test that would catch it

Spawn three colonists one tick from starvation plus one fed survivor; step
once; assert all three are gone from the snapshot in that single step, that
exactly three `starved` notices were published in total across the next five
ticks, and that the survivor's `ageTicks` advances by one on every one of those
ticks. The existing `PopulationSystem` death tests all kill exactly one
colonist — including the one that deliberately gives two colonists different
lifespans so that only one dies — so none of them can see this.

A second test for the save consequence, which the first would not catch: run
the same simultaneous die-off with the clock positioned so `autosaveEveryTicks`
lands inside the freeze, capture what the autosave listener receives, and
assert its colonist roster does not contain anyone the snapshot has already
reported dead. Asserting only that the save *loads* passes today — the whole
problem is that it does.
