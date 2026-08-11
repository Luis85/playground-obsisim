---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 40
status: Done
increment: 8
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Storehouse-to-Storehouse Transfer

A hauler now rebalances two stores. A **transfer** is the supply trip minus its middle leg — `fetching` to a source site, `returning` to a destination site, `targetId` null throughout — and it comes in two classes: **staging** pulls camp stock outward toward the demand of the buildings around a depot, and a **drain** pushes a bounded site's surplus back to the camp when it has fallen below its free-space floor. Before this, `destinationFor` and `remainderHome` deliberately refused to route a load onward to another site, so a load either landed in a building or went back where it came from — and a store site could be filled but never emptied.

**Shipped as Increment 8 (2026-08-11).** Descoped from Increment 7 (§2.13); the measurement below is what turned it from an omission into that increment's clearest follow-on, and §4.2 of the increment-8 spec is what it measures as now.

## What it measures as

The same corner chain, re-run on the shipped mechanic. The depot turns over instead of silting up (`storedAtEnd` 54 / 51 / 57 of 60, peak 60, at capacity for 2% of ticks) and its advantage grows with the horizon instead of staying flat:

| ticks | no depot | depot | advantage | before this feature |
| ---: | ---: | ---: | ---: | ---: |
| 600 | 204 | 285 | **+81** | +26 |
| 1,200 | 416 | 542 | **+126** | +24 |
| 2,400 | 840 | 1,062 | **+222** | +28 |
| 4,000 | 1,402 | 1,745 | **+343** | — |

Fitted through the two clean end points, that is a one-off term of about **34 planks plus a sustained rate of 0.078 planks/tick** — 22% of the no-depot arm's own throughput. The rate is the whole of what this feature added; the flat 26 / 24 / 28 above is what a buffer looks like, and the sweep reproduces it in this tree the moment the mechanic is made inert.

**Two costs are recorded rather than rescued.** A depot beside a *camp-fed* processor is a bigger loss than it was — 17% at three haulers, against increment 7's 10% (`OBS-8-03`) — because the fetch leg lengthens and no rule declines a trip for it. And `OBS-7-02`'s in-tray cap is un-relieved: staging fires twice in 600 ticks there, which is not often enough to be measured against the cap at all.

## Why the measurement mattered — the case as it stood before the increment

*Everything from here down is the note as it was written while this was still a backlog item, kept because it is the prediction the increment was judged against.*

### Why the measurement matters

Increment 7's §1 sells a storehouse as an investment: a second place to put things that turns a distant cluster from a mistake into a plan. §4.2 and §4.3 record what it actually measures as, and the gap is this feature's whole justification.

A store site can only ever be **filled** by a building's output, and never **emptied**. So a depot beside a chain silts up with that chain's finished good — planks, which nothing consumes — and once full it can neither take another deposit nor stage another input. Measured on a corner chain with three haulers, depot against no depot:

| ticks | no depot | depot | advantage | `storedAtEnd` |
| ---: | ---: | ---: | ---: | ---: |
| 600 | 204 | 230 | +12.7% | 60 of 60 |
| 1,200 | 416 | 440 | +5.8% | 60 of 60 |
| 2,400 | 840 | 868 | +3.3% | 60 of 60 |

The absolute gain is 26 / 24 / 28 planks — flat. Between tick 600 and tick 2,400 the two runs produced 638 and 636 planks: after the first 600 ticks the depot contributes nothing at all. And beside a camp-fed processor it is a **net loss** of 10% at three haulers, because it can never shorten that building's input leg while it does lengthen the hauler's next fetch — the fetch leg's share of working hauler-ticks goes from 2–8% without a depot to 17–20% with one.

**The defect is a missing flow, not a magnitude.** Raising `storehouseCapacity` to 240 buys a proportionally bigger one-off (954 planks against 868 at 2,400 ticks) and the depot is full at 240 too. No value of a capacity creates a movement that does not exist.

### What it would take — and all four landed

- A transfer job kind, or a generalisation of the supply job whose consumer is a site rather than a building — a hauler that takes stock from an over-full store toward one that is short.
- **A rule for when a transfer is worth walking**, which is the hard half and the reason this was not folded in. Without one, two depots and a camp are a machine for moving goods in circles: every ranking that makes a transfer attractive also makes the reverse transfer attractive the moment it completes. The `minSupplyUnits` threshold is the existing precedent for "don't walk thirteen tiles for one unit", and it is not sufficient on its own.
- A claim against the *source* of a transfer as well as its destination, so a fleet of haulers does not empty one depot at once — both already exist for supply jobs (§2.6) and generalise.
- Per-resource storehouse filters or priorities become interesting the moment this exists, and are their own decision (§2.13 excludes them too).

The `kind: 'transfer'` job, the two-class rule (§2.4), the source claims `unclaimedAt` and `plannedOutAt` (§2.7) all shipped. Per-resource filters and priorities were excluded again (§2.13).

### What it would fix — half of it did

The measured one: a depot would stop being a one-off buffer and start being the sustained investment §1 describes. Camp stock could be staged outward toward a distant cluster's in-trays instead of only ever arriving there in a hauler's hands from the camp, which is the leg the fetch-share measurement shows a depot currently lengthening.

**The buffer became a rate**, as predicted. **The staged-outward half did not carry its weight**: staging is a small fraction of transfer hauler-ticks on every fixture measured — 0% of the corner chain, 1–5% elsewhere — and the fetch leg the last sentence names is exactly the one that still lengthens (`OBS-8-03`).

## Documentation

- `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md` — §2.4 (the two classes and the rule for when a transfer is worth walking), §2.5 (telling a transfer from a remainder), §2.6 (where the two classes sit in the dispatch order), §2.7 (the claims), §4.2 (the measurement)
- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §2.13 (the descoping), §4.1 q2 and §4.3 (the measurement that motivated it)
- Open afterwards: `OBS-8-02` (two mirrored latencies), `OBS-8-03` (the camp-fed processor), `OBS-8-04` (small-hauler fleets)
- See also: [[Two-Way Haul and Storage Buildings]], [[Storehouses - a Second Place to Put Things]]
