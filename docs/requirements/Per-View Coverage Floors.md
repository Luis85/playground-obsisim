---
type: PBI
parent: "[[Quality Gates and CI Infrastructure]]"
order: 40
status: Done
tags:
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Per-View Coverage Floors

`src/app/views/**` and `src/app/components/**` aren't coverage-gated yet — they're covered indirectly today via the LOC guard and targeted interaction tests (`BuildingsView`, `TopBar`). Deferred until the view layer's test strategy is settled.

Spec: `docs/build-ci/quality-gates.md` — Next slices

**Closed by Increment 11 §2.8.** `src/app/components/**` and `src/app/views/**` now carry an 80/70/80/80 statements/branches/functions/lines floor, checked per file (`thresholds.perFile: true` in `vitest.config.ts`) rather than as an aggregate — a glob average would let a well-covered file carry a barely-tested sibling over the line, which is exactly what "per-view" was meant to rule out.
