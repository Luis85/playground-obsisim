---
type: PBI
parent: "[[The World Screen]]"
order: 40
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Ledger Fallback

Supersedes `[[Table Parity for Placement]]`, which promised "no-WebGL play stays whole" — already not quite true, since `moveBuilding` had never had a table. This PBI restates the promise rather than retracting it, and completes what it always claimed:

> The Ledger is a complete **read** surface — every number any panel shows is also in a table — and carries a plain control for every verb the engine accepts. It does not promise to be pleasant. When the renderer fails to boot or fatals later, the app switches to the Ledger and says why.

`moveBuilding` gets a table control for the first time, taking typed tile coordinates — deliberately worse than dragging a ghost, because it exists so the fallback is complete rather than so it is nice. A renderer failure, whether at boot (the injected factory throws) or mid-session (the factory succeeds and later invokes `onFatal`), navigates to `/ledger` and shows a persistent banner naming the failure; both paths are distinct because `onFatal` is only registered after the factory succeeds, so a boot-only test cannot reach the second one. `LedgerView` composes the four existing table views rather than restating their figures.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md` §1.2, §2.5
