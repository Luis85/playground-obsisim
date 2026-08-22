---
type: PBI
parent: "[[The World Screen]]"
order: 20
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The Inspector and Its Verbs

`SelectionPanel` becomes the Inspector, and all eight engine commands now dispatch from the world screen without a Ledger visit — the five that could not before (`assignWorker`, `unassignWorker`, `assignHauler`, `unassignHauler`, `recruitWorker`) land in the Inspector, the resource strip and the Population panel respectively. A discriminated `Selection` (`building` / `colonist` / `none`) and a new `setHighlight` carry the click rule that unifies every panel: a row naming one building selects it, a row naming a colonist selects it, a row naming several colonists or a def's stage highlights the set with nothing selected, and a row naming only a resource selects nothing at all — a resource has no subject on the map. A control the engine would refuse is disabled with its reason stated in the panel, never only in a `title` attribute, extending the convention `SelectionPanel` already set for Move.

Spec: `docs/superpowers/specs/2026-08-16-increment-11-the-world-screen.md` §2.2, §2.3
