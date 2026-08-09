---
type: PBI
parent: "[[Quality Gates and CI Infrastructure]]"
order: 10
status: Done
tags:
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Quality Gate Ratchet System

Eight gates across six CI jobs gate every change: `lint` runs lint itself plus an LOC ratchet (500 nonblank lines/file) and a CSS `!important` ratchet; `quality` runs a fallow ratchet; `typecheck`, `test`, and `coverage` (floors on the engine/shared/store layers) are their own jobs; `build` runs the build plus an artifact smoke test. Shrink-only counters may only fall, pinned-at-zero counters must stay exactly 0, and the maintainability floor — now the single worst-scoring `src/` file rather than a mean over every file — may only rise. `--update` refuses to lock a value that loosens the ratchet without an explicit `--allow-regression`, and pinned-at-zero breaches have no escape hatch at all.

Spec: `docs/build-ci/quality-gates.md`
