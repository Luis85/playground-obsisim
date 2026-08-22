---
type: Feature
parent: "[[Interface and Play]]"
order: 10
status: Done
increment: 11
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The World Screen

The colony gets one screen instead of five tabs. The router drops from five routes to two — `/` is the world, `/ledger` is the tables — and everything that was a tab (Dashboard, Buildings, Population, Economy) becomes a panel in a dock held in UI state, opened without leaving the canvas. All eight engine commands now dispatch from the world screen; before this feature, staffing a building, assigning a hauler and welcoming a nomad were each reachable from exactly one table and nowhere else, so the screen that showed you the colony was not the screen that ran it. A new Attention panel is the first surface built to answer "what is wrong" rather than "what is true", every row a sentence over a field the snapshot already publishes. The Ledger is completed as a fallback rather than kept as a second equal path — `moveBuilding` gets a table control for the first time — and a renderer failure, at boot or mid-session, now lands the player there with a banner naming why instead of a dead canvas. No camera work: a grown map's readability is filed (`OBS-11-01`) rather than fixed, deliberately, because a usable answer is four coupled pieces none of which is unit-testable.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md`
Plan: `docs/superpowers/plans/2026-08-16-increment-11-the-world-screen.md`
