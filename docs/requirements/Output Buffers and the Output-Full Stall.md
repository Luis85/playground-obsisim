---
type: PBI
parent: "[[Increment 4 - Logistics]]"
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

# Output Buffers and the Output-Full Stall

Every building now banks what it produces into its own output buffer instead of teleporting straight to the stockpile. A full buffer stalls the building ("Output full") until a hauler clears it — the first place the game makes storage and transport, not just production, something the player has to manage.

Spec: `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` §2.1
