---
id: OBS-8-05
title: storehouseFreeFloor at 24 buys a 43% larger headline advantage and was deliberately not moved, on one fixture family's evidence
status: Open
severity: minor
area: engine
increment: 8
created: 2026-08-11
source: increment-8 task 11 (measure), spec §4.2 point 6 and §4.3 — the constant sweep, recorded and left alone; §4.3 names the retune as a successor and this note is that successor
affects:
  - src/engine/content/balance.ts
  - tests/engine/balance.test.ts
type: Issue
parent: "[[Storehouse-to-Storehouse Transfer]]"
order: 290
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The free-space floor that would improve the headline was not moved

## What happens

`BALANCE.storehouseFreeFloor` ships at 12. Swept on the corner chain at 2,400
ticks, it is **the one constant in this increment that would improve the number
§1.1 rests on**:

| value | planks @600 | planks @2,400 | staged chain | camp-fed | transfers |
| ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 230 | 868 | 192 | 277 | **0** — inert |
| 6 | 230 | 863 | 192 | 249 | 1 |
| **12 (shipped)** | 285 | 1,062 | 192 | 243 | 145 |
| 24 | **300** | **1,157** | 192 | 243 | 195 |

At 24 the advantage over no depot at 2,400 ticks is **+317 planks against the
shipped value's +222 — 43% larger**. The depot also ends at 39 of 60 rather than
57, so it is turning over harder rather than merely holding less.

The cost is real and bounded: 3,041 drain hauler-ticks against 2,239. The
camp-fed processor is **unchanged** at 243, so the higher floor does not pay for
its own gain in the configuration that is already losing (OBS-8-03).

The sweep also answers §4's own question "is buying room worth a walk at all?"
with an unambiguous yes, from the other end: at 0 the mechanic is inert exactly
as `minTransferUnits: 8` makes it — no drains, depot at 60 of 60, back to
increment 7's 230 and 868.

## Why it is filed rather than moved

**One fixture family, one hauler count.** The sweep is the corner chain at three
haulers. That is enough to raise the question and not enough to answer it, and
this repository has a specific reason to distrust a constant moved on that
evidence: increment 7 §4.2 recorded `inputBufferCap` as the one constant with a
measured case for change and declined to move it, because the fixture that made
the case was not the fixture that would pay the cost.

A larger free floor means a depot holds less. Three things measured elsewhere in
this repository are sensitive to that and were **not** re-taken at 24:

- **The crossover sweep** (`CROSSOVER_CHAINS`, five chains × four hauler counts).
  §4.1's crossover distance is the leg beyond which a depot beats another
  hauler, and a depot that holds less should move it outward. Nobody looked.
- **The population curve.** A depot that keeps 24 units free is a depot holding
  24 fewer units of food within reach of a hungry colony. The population harness
  has a depot fixture and it was not run at 24.
- **The stress colony**, where drain hauler-ticks rising 36% is a per-tick cost
  paid by every hauler in a large fleet, not by three.

## Suggested resolution

Re-take those three before moving anything, then move it or write down why not.

The measurement that would make this decisive is the one the sweep does not
have: **a second fixture family whose depot is food-bearing rather than
plank-bearing**, because that is where a higher floor's cost lands and the corner
chain cannot express it — planks are consumed by nothing in reach, so holding
fewer of them costs that fixture nothing at all. A sweep that only ever measures
the benefit will keep recommending 24.

If it does move, `storehouseFreeFloor` and `minTransferUnits` should be swept
**together** rather than one at a time. They are not independent: the floor sets
how much a drain needs to move and the threshold sets the smallest move allowed,
and §4.2 point 5 already found `minTransferUnits` has a hard ceiling (at 8 the
mechanic is inert) that is a function of hauler capacity. A floor of 24 with a
threshold of 8 is a combination nobody has measured, and the shipped pair was
chosen by two independent one-dimensional sweeps.
