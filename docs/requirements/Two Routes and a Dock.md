---
type: PBI
parent: "[[The World Screen]]"
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

# Two Routes and a Dock

The router drops from five routes to two: `/` is the world, `/ledger` is the tables. Everything that was a tab becomes zero or one panel in a dock, held in UI state rather than in the route — selecting a building auto-opens the Inspector, opening another panel never clears the canvas selection. The canvas's Excalibur engine and WebGL context are torn down on exactly one round trip (the `/ledger` visit) instead of four, via the same `keep-alive` and `onActivated`/`onDeactivated` pair `WorldView` used before the split. Escape is a ladder — cancel an armed mode, then clear the selection, then close the dock — and an armed move never outlives the selection or the Inspector that armed it, across all four routes that can end it: Escape, the selection being demolished, the selection changing to a different subject, and the dock switching to another panel. Below a pane-width threshold, driven by a `ResizeObserver` flag rather than a media query, the dock overlays the canvas and the rail collapses to a single Build popover.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md` §2.1, §2.6
