---
type: Feature
parent: "[[Engineering Quality and Balance Tooling]]"
order: 30
status: Active
tags:
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Quality Gates and CI Infrastructure

The ratchet system that gates every change: lint, an LOC ratchet, a CSS `!important` ratchet, a fallow-driven quality ratchet (dead code, cycles, boundary violations, clone groups, complexity), typecheck, tests, coverage floors, and a build/artifact smoke test. Adopted greenfield at Increment 1's Task 18 — every baseline started at zero, nothing grandfathered — and reshaped twice since by what it broke: the maintainability floor moved from an all-files mean (which fell whenever an increment merely added tests) to a floor on the single worst `src/` file, and the gate's own comparison logic was hardened after five separate ways were found to pass it while a counter was silently switched off. Still gaining deliberately deferred slices rather than finished outright.

## Documentation

- `docs/build-ci/quality-gates.md` — the living reference: ratchet mechanics, the maintainability floor's history, boundary zones, coverage floors, and its own "Next slices"
