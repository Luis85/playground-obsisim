---
type: PBI
parent: "[[Hardening and Polish]]"
order: 40
status: Done
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Bounded Command Queue

`CommandQueue.pending` gets a cap while the game is paused, closing the review's one remaining open security finding: an unbounded queue that a paused, idle session could otherwise grow without limit.

Spec: `docs/superpowers/specs/2026-07-30-increment-1.5-hardening-and-polish.md` §2.4
