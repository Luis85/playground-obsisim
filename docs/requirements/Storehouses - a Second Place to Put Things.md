---
type: PBI
parent: "[[Two-Way Haul and Storage Buildings]]"
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

# Storehouses - a Second Place to Put Things

A third kind of building — 20 wood and 10 planks, no crew, holding 60 units — and the first thing in the game that is neither a producer nor a shelter. A building def now does exactly one of three things: produces, shelters, or stores. The camp stays unbounded and a storehouse does not; a load that no longer fits walks on to the camp rather than being split at the door. A depot in transit is not a store site, the same way a relocating house provides no beds, and demolishing one moves its contents to the camp instead of destroying them — those goods are already in the ledger and the player has already banked them.

## "A second place to put things" is the wrong name for it, and the measurement is why

**A storehouse is a pipeline stage.** This title was increment 7's framing, and §4.3 of that increment could not find the value it promised: a depot beside a chain measured as a flat +26 / +24 / +28 planks at 600 / 1,200 / 2,400 ticks — an advantage that does not grow, which as a *rate* decays to zero. The cause was structural rather than a magnitude. A place to put things can be filled and never emptied, so the depot silted up with the chain's finished good, reached 60 of 60, and stopped participating. No value of `storehouseCapacity` creates a movement that does not exist; 240 was tried, and the depot is full at 240 too.

Increment 8 replaced the framing rather than repeating it, and made the replacement falsifiable. A storehouse earns its keep at **both ends of a chain**, and in both cases by *decoupling a short hop from a long haul*:

- **Outbound.** A producer's output goes into the depot on a short hop, so the producer stops sitting in `outputFull` waiting for a hauler to come back from the camp. The long depot → camp leg is amortised behind it, on a hauler that is not blocking anything.
- **Inbound.** Camp stock is staged into the depot on the long haul, and the depot → consumer hop is short and turns over fast — feeding the consumer **without occupying in-tray concurrency**.

**The prediction, and it held.** If a depot is a pipeline stage rather than a buffer, its advantage must *grow with the horizon*. With [[Storehouse-to-Storehouse Transfer]] shipped it does: +81 / +126 / +222 planks at the same three horizons, and +343 at 4,000 — a one-off term of about 34 planks **plus a sustained rate** of 0.078 planks/tick. The mechanism is separately visible rather than inferred from the throughput: the consumer's `waitingForInputTicks` falls 51–53% → 30–32% and stays there, while the producer's `stalledTicks` improvement decays with the horizon. Spare room is finite and is consumed early; what persists is the shorter leg.

The building described above did not change. What changed is what it is *for*, and this note is renamed in intent rather than in title so that the increment-7 phrasing stays findable.

Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.2, §2.3, §2.7; the reframing and its measurement are `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md` §1.1 and §4.2
