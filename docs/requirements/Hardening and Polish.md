---
type: Feature
parent: "[[Engineering Quality and Balance Tooling]]"
order: 10
status: Open
increment: 1.5
tags:
  - game-design
  - engineering
started: ""
horizon: ""
start: ""
due: ""
---

# Increment 1.5 - Hardening and Polish

No new game mechanics, by design. Closes out Increment 1's multi-perspective review: a save-migration seam (migrate, then validate) so Increment 2's first new save fields don't corrupt every existing save; the three "killer tests" the review found survived deletion of the feature they guard; consolidated entity-fact gathering with a gated per-tick refresh; a bound on the command queue while paused; and a batch of UX cheap wins (success notices, humanized labels, hunger coloring, a starter hint).

## Documentation

- Spec: `docs/superpowers/specs/2026-07-30-increment-1.5-hardening-and-polish.md`
- Plan: `docs/superpowers/plans/2026-07-30-increment-1.5-hardening-and-polish.md`
- Source review: `docs/superpowers/reviews/2026-07-03-increment-1-multi-perspective-review.md`
