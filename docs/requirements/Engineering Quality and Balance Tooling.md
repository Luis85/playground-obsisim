---
type: Epic
parent:
order: 50
status: Open
tags:
  - game-design
  - engineering
started: ""
horizon: ""
start: ""
due: ""
finished: ""
---

# Engineering Quality and Balance Tooling

The work that doesn't change what the player does but decides whether the rest of this backlog can be trusted: a save-migration seam proven before it was needed, tests that have actually been seen to fail, a balance harness that measures a colony instead of guessing at it, and quality gates that refuse to let a baseline get quietly worse. Increment 1.5 built the engineering half of this — hardening, before Increment 2's save fields made the alternative expensive. Increment 5 built the balance half — the harness Increment 6 later depended on to catch its own birth-threshold regression before players did.
