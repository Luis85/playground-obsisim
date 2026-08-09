---
type: PBI
parent: "[[Increment 2 - Excalibur World View]]"
order: 10
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Live 2D Tile World Rendering

A new World tab renders the same engine snapshots the tables already consumed, as a 2D tile world via Excalibur, behind an injected renderer seam so the sim stays UI-agnostic. Read-only at first: no vitest test may import the renderer (Excalibur throws outside a browser), so its only coverage is the Playwright-driven `npm run smoke:world` harness.

Spec: `docs/superpowers/specs/2026-07-30-increment-2-excalibur-world-view.md` §2.1-2.2, §2.5
