---
id: OBS-4-02
title: Every component must be attached in two places, and forgetting one is silent
status: open
severity: important
area: engine
increment: 4
created: 2026-08-01
source: increment-4 Tasks 2 and 4 (both bitten during implementation)
affects:
  - src/engine/world.ts
  - src/engine/systems/command-handlers.ts
tags:
  - issue
  - architecture
  - tech-debt
  - footgun
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
