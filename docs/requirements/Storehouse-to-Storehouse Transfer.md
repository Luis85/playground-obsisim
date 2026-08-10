---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 40
status: New
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Storehouse-to-Storehouse Transfer

Goods move site → building → site, and a hauler never rebalances two stores. Nothing ever pushes camp stock outward into a depot, and nothing ever brings a depot's stock back to the camp: `destinationFor` and `remainderHome` deliberately refuse to route a load onward to another site, so a load either lands in a building or goes back where it came from.

**Descoped from Increment 7 (§2.13), and this note is the record — with the measurement that turned it from an omission into the increment's clearest follow-on.**

## Why the measurement matters

Increment 7's §1 sells a storehouse as an investment: a second place to put things that turns a distant cluster from a mistake into a plan. §4.2 and §4.3 record what it actually measures as, and the gap is this feature's whole justification.

A store site can only ever be **filled** by a building's output, and never **emptied**. So a depot beside a chain silts up with that chain's finished good — planks, which nothing consumes — and once full it can neither take another deposit nor stage another input. Measured on a corner chain with three haulers, depot against no depot:

| ticks | no depot | depot | advantage | `storedAtEnd` |
| ---: | ---: | ---: | ---: | ---: |
| 600 | 204 | 230 | +12.7% | 60 of 60 |
| 1,200 | 416 | 440 | +5.8% | 60 of 60 |
| 2,400 | 840 | 868 | +3.3% | 60 of 60 |

The absolute gain is 26 / 24 / 28 planks — flat. Between tick 600 and tick 2,400 the two runs produced 638 and 636 planks: after the first 600 ticks the depot contributes nothing at all. And beside a camp-fed processor it is a **net loss** of 10% at three haulers, because it can never shorten that building's input leg while it does lengthen the hauler's next fetch — the fetch leg's share of working hauler-ticks goes from 2–8% without a depot to 17–20% with one.

**The defect is a missing flow, not a magnitude.** Raising `storehouseCapacity` to 240 buys a proportionally bigger one-off (954 planks against 868 at 2,400 ticks) and the depot is full at 240 too. No value of a capacity creates a movement that does not exist.

## What it would take

- A transfer job kind, or a generalisation of the supply job whose consumer is a site rather than a building — a hauler that takes stock from an over-full store toward one that is short.
- **A rule for when a transfer is worth walking**, which is the hard half and the reason this was not folded in. Without one, two depots and a camp are a machine for moving goods in circles: every ranking that makes a transfer attractive also makes the reverse transfer attractive the moment it completes. The `minSupplyUnits` threshold is the existing precedent for "don't walk thirteen tiles for one unit", and it is not sufficient on its own.
- A claim against the *source* of a transfer as well as its destination, so a fleet of haulers does not empty one depot at once — both already exist for supply jobs (§2.6) and generalise.
- Per-resource storehouse filters or priorities become interesting the moment this exists, and are their own decision (§2.13 excludes them too).

## What it would fix

The measured one: a depot would stop being a one-off buffer and start being the sustained investment §1 describes. Camp stock could be staged outward toward a distant cluster's in-trays instead of only ever arriving there in a hauler's hands from the camp, which is the leg the fetch-share measurement shows a depot currently lengthening.

## Documentation

- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.13 (the descoping), §4.1 q2 and §4.3 (the measurement)
- See also: [[Two-Way Haul and Storage Buildings]]
