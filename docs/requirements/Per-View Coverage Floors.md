---
type: PBI
parent: "[[Quality Gates and CI Infrastructure]]"
order: 40
status: New
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
