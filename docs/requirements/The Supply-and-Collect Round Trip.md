---
type: PBI
parent: "[[Two-Way Haul and Storage Buildings]]"
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

# The Supply-and-Collect Round Trip

A hauler belongs nowhere. It stands where its last trip left it, and a supply job is a collect trip with one leading leg that fetches: walk to whichever site holds the goods, carry them to the building, unload what fits, then load whatever that building has finished and carry it home. This is the mechanic the increment is named for, and it is why input delivery did not simply double the colony's haul demand — measured, 88–98% of supply trips come home loaded, so the second half of the work is nearly free once the first is being done.

Supply outranks collect, because a building with no inputs produces nothing while a building with a full output buffer has already produced. The deadlock that invites cannot happen: a supply job needs stock somewhere, and only collection puts it there. Measured, collection never stops — it rides home on the supply trips.

Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.5, §2.6; measurements in §4.1 q3
