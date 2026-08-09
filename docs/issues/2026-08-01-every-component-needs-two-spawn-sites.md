---
id: OBS-4-02
title: Every component must be attached in two places, and forgetting one is silent
status: Done
severity: important
area: engine
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 Tasks 2 and 4 (both bitten during implementation)
affects:
  - src/engine/spawn.ts
  - src/engine/world.ts
  - src/engine/systems/command-handlers.ts
tags:
  - architecture
  - tech-debt
  - footgun
type: Issue
parent: "[[Logistics]]"
order: 20
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Every component needs two spawn sites

An entity can enter the world by two independent paths, and each one builds its
component set from scratch:

- **Restore from a save** — `spawnBuilding` / `spawnWorker` in
  `src/engine/world.ts`
- **Created live by a command** — `handleConstructBuilding` /
  `handleRecruitWorker` in `src/engine/systems/command-handlers.ts`

Adding a component means editing both. Nothing enforces it, and the failure is
silent: the entity exists, most systems tolerate the missing component, and the
symptom appears somewhere unrelated.

## Evidence

This bit twice inside a single increment.

1. **`OutputBuffer`** was added to the restore path only. Buildings constructed
   during play had no buffer.
2. **`HaulTrip`** was added to `spawnWorker` only. Workers recruited during play
   were missing it, and the consequence surfaced far from the cause — they
   **vanished from snapshots entirely**, because the snapshot builder's query
   requires the component.

Both were caught by implementers during the increment rather than by a test.

## Current mitigation

A component-completeness invariant test now compares a recruited worker against
a restored one and asserts they carry the same component set. It is real
coverage — it was validated by breaking `HaulTrip` off the recruit path and
confirming the test fails.

Two gaps remain:

- There is **no buildings-side companion** to that test. The constructed-vs-
  restored building comparison was noted during the increment and never written.
- The test pins *worker* parity only. A third spawn path, or a component added
  to neither side, is still invisible.

## Why it keeps happening

The duplication is structural, not accidental. Both paths legitimately need to
build a complete entity, and they differ in where their initial values come from
(save records vs. command arguments). So the obvious fix — "just call the same
function" — needs the value sources separated from the component wiring first.

## Proposed fix

Give each entity kind **one** function that attaches its components, taking a
plain descriptor of initial values, and have both paths call it. The save path
fills the descriptor from a save record; the command path fills it from the
command. Component wiring then exists once, and adding a component is one edit.

Until that lands, at minimum add the buildings-side completeness test so both
entity kinds are pinned, and treat "did you edit both spawn sites?" as a
standing review question for any change touching `src/engine/components.ts`.

## Resolution

Took the structural fix, not the mitigation. **`src/engine/spawn.ts`** now holds
one function per entity kind — `buildingComponents(spec)` and
`workerComponents(spec)` — each returning the complete component list from a
plain descriptor. Both paths call them:

- `spawnBuilding`/`spawnWorker` (world.ts) fill the spec from a save record and
  attach the result to a preptime entity via a new `attach` helper.
- `handleConstructBuilding`/`handleRecruitWorker` fill it from the command and
  spread it into `ctx.spawn(...)`.

The paths still differ, because they genuinely must: one builds at preptime
through `prep.buildEntity().with(...)`, the other at runtime through
`ctx.spawn`. What they no longer differ in is *which* components an entity gets.
Adding a component is one edit in `spawn.ts` (plus appending the type to
`COMPONENT_TYPES` for save round-tripping).

### A third mirror, not mentioned in the note

`buildInitialSnapshot` in world.ts duplicated the balance-coupled **clamps** —
hunger, tool ticks, batch progress, buffer cap — with comments saying "mirror
spawnWorker's clamp" and "same balance-coupled clamp as spawnBuilding". It does
not spawn entities, so it was not one of the two spawn sites, but it had to stay
in step with them by hand or the seeded snapshot would disagree with the world
it describes. The four clamps moved into `spawn.ts` as named functions
(`clampedHunger`, `clampedToolTicks`, `clampedProgress`, `clampedBuffer`) and all
three callers now share them.

### Coverage

The buildings-side parity test the note asked for is now in
`tests/engine/systems/command-system.test.ts`, beside the worker one: it restores
a building from a save, records which of `COMPONENT_TYPES` it carries, constructs
a second one live, and asserts the constructed one carries the same set. It
asserts the expected set is non-empty first, so an empty comparison cannot pass
vacuously.

Seven mutations were confirmed to fail the suite. Dropping a component from a
shared list now breaks *both* paths loudly — `OutputBuffer` fails 74 tests,
`HaulTrip` 62 — which is the structural win: the failure is no longer confined
to one path. Dropping any of the three clamps fails 1–3 tests. The two that
matter most reproduce the original bugs exactly, by re-inlining a hand-written
list on the command path only:

- building list minus `OutputBuffer` → *"constructed building is missing
  OutputBuffer"*
- worker list minus `HaulTrip` → *"recruited worker is missing HaulTrip"*

### What it cost, and why that is now affordable

Extracting the module cost `command-handlers.ts` 0.7 MI (84.8 → 84.1) purely
through `fan_out`, and moved the `src/` mean 90.02 → 89.98. That is exactly the
decomposition penalty OBS-4-01 documented — a new below-average file plus a
`fan_out` charge to each importer, for a change that unambiguously improves the
code. It is now a printed number rather than a gate, which is why this fix was
takeable at all: under the mean floor, increment 4 reverted a comparable
extraction rather than fight it.
