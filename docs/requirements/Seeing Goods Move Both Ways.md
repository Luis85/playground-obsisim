---
type: PBI
parent: "[[Two-Way Haul and Storage Buildings]]"
order: 60
status: Done
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Seeing Goods Move Both Ways

The answer to "why is my bakery stopped?" is in the game rather than in the spec. The Buildings table gains an **In** column beside Waiting and a `Waiting for input` state; a storehouse's row reads `held / capacity`; the selection panel shows both of a building's buffers; and the Economy view names the **input backlog** — units short, and how many buildings are idle for want of them — symmetrically with the output backlog it already named.

On the canvas: a storehouse glyph with a fill ring, the `storing` and `waitingForInput` state colours, and a hauler carrying goods *in* drawn distinguishably from one carrying goods *out*, so flow direction reads at a glance. What drives that marker is where the cargo came from, not which job the hauler was dispatched on — a supply trip that unloads and then collects is carrying goods out while still labelled supply, which is exactly the round trip a job-driven marker would draw backwards. Every addition has a legend entry, and the whole colony stays playable from the tables with no canvas at all.

Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.10
