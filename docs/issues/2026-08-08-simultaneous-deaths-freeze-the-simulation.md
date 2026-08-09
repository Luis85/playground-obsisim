---
id: OBS-6-02
title: Two colonists dying on the same tick freeze the whole simulation for a tick each
status: resolved
severity: important
area: engine
increment: 6
created: 2026-08-08
resolved: 2026-08-09
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
**Status:** resolved 2026-08-09 (`6916cb3`), by candidate 1 below. See
[Resolution](#resolution-6916cb3).

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

## Resolution (6916cb3)

Candidate 1, as written above and as an independent reviewer proposed
separately. `RemovalLedger` carries the entities instead of a `dirty` flag,
and `applyRemovals` (`src/engine/world.ts`) drains it after `world.step()`
resolves — one `removeEntity` per call, which is the case sim-ecs handles.
Both drivers of a tick call it immediately after the step: `GameEngine.runStep`
and `tests/engine/fixtures.ts`'s `stepTick`.

Four things beyond the mechanical move are worth recording.

**The throw is not conditional on there being a second removal.** The "Why"
above says the *second* removal throws; running it says every removal of a
prep-time entity throws, and always has. The first one simply had nothing
queued behind it to abandon. Two consequences follow that the original note did
not name. A single death on a tick that also queued something else — the
common case being `tryBirth`, which runs after both death phases in the same
system — deferred that other command by a step too, so **one** death could cost
a frozen tick if a birth landed with it. And because the drain must still call
sim-ecs's `removeEntity`, the throw did not go away with the batching: it is
caught in `detach`, which re-throws unless `world.hasEntity` confirms the
entity is genuinely gone. Tolerating a known post-removal throw is a claim with
a postcondition; the postcondition is checked, which is the one thing the sync
point's blanket `catch` never did.

**The `dirty` flag is gone rather than kept.** The drain's own count is the
refresh signal the flag stood in for, so `refreshEntitySections` still fires on
a tick that only removes something — but a new removal site cannot forget to
raise it, because the signal comes from the removal itself. That was the
"helper wired to one caller instead of to the invariant" shape this codebase
has produced six defects from. Both death causes now go through one `die()`
that stands the colonist down, queues the entity and marks the id dead
together.

**Three test harnesses drove time with a bare `world.step()`** and therefore
stopped removing anything at all the moment removals left the command queue.
They failed loudly rather than drifting: `tests/engine/integration.test.ts` now
uses `stepTick`, and `command-system.test.ts`'s two local tickers call
`applyRemovals` directly — not `stepTick`, whose snapshot refresh would erase
the same-tick deferrals a dozen of that file's cases assert on. This is exactly
the divergence the note warned about, and it is worth noting that `stepTick`
alone was not the whole of it.

**What did not change.** Removal is still invisible for the rest of the tick,
so `standDown` and `PendingChanges.demolished` remain load-bearing; drain order
is ledger order, which is ascending colonist id for deaths and drain order for
demolitions, so nothing became less reproducible. Neither the haul sweep nor
the §4.1 population curves moved.

**Tests.** Two written to fail first and watched doing it, assertion by
assertion:

- `PopulationSystem — a die-off of more than one colonist` — three colonists
  starve on one tick beside a fed survivor. Before: roster `[2,3,4]` instead of
  `[4]`, snapshot ticks `1,1,1,4,5,6`, survivor ages `1001,1001,1001,1002,…`,
  and **nine** starvation notices for three colonists.
- `GameEngine — a save written on the tick after a die-off holds nobody the
  colony has already killed` — the autosave at tick 100, one tick after the
  die-off at 99, carried colonist #4 after the snapshot had announced it dead.

Plus `applyRemovals` unit cases pinning that all three entities go in one call
and that a throw leaving the entity present is re-thrown, and
`frozenSteps === 0` asserted on the starvation-warning scenario — the only run
in the report that ever lost steps (2 of them). Each was re-checked by mutating
the fix: draining one entity per call kills three cases, dropping the
`try/catch` kills ten, and dropping the `hasEntity` postcondition kills one.

`frozenSteps` **can no longer be non-zero** and is re-documented as a
regression sentinel rather than a live signal. It stays because the detector
behind it is four lines and the failure it catches — a measurement quietly
short of the ticks it claims — is silent by nature.
