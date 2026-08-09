---
type: PBI
parent: "[[Quality Gates and CI Infrastructure]]"
order: 20
status: New
tags:
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Perf Scaling Guards

specorator, the project this repo's gates were adapted from, gates hot-path scaling behavior; ObsiSim doesn't have an equivalent yet. The determinism and save/restore round-trip tests already pin exact simulation behavior, and there is no unbounded-input hot path to regress today — deferred deliberately until one exists, not forgotten.

Spec: `docs/build-ci/quality-gates.md` — Next slices
