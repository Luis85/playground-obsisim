---
id: OBS-7-01
title: The supply ranking has no fairness floor, so the farther of two consumers is starved permanently rather than served late
status: Done
severity: important
area: engine
increment: 7
created: 2026-08-10
source: increment-7 task 14 (measure), section 4.1 q3 — found while measuring whether dispatch thrashes, which it does not
resolved: increment-8 task 1 — a starvation band at the front of `compareSupplyCandidates`, measured on its own in spec §4.1 with no transfer code in the tree
affects:
  - src/shared/haul.ts
  - src/engine/systems/haul-dispatch.ts
type: Issue
parent: "[[The Supply-and-Collect Round Trip]]"
order: 190
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The farther consumer starves outright

## What happens

A mill at (12,6) — leg 6 — feeding a bakery at (15,9) — leg 8 — with one hauler,
over 600 ticks. The mill makes 254 flour. **The bakery makes zero bread and
spends 100% of its ticks in `waitingForInput`.**

Exchange the two tiles. Same two buildings, same crews, same single hauler, same
run length. The bakery makes 108.

| layout | haulers | mill leg | bakery leg | flour | bread | mill wait% | bakery wait% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill near, bakery far | 1 | 6 | 8 | 254 | **0** | 43 | **100** |
| mill far, bakery near | 1 | 8 | 6 | 114 | 108 | 75 | 79 |
| both beside the camp | 1 | 2 | 3 | 397 | 144 | 2 | 72 |
| mill near, bakery far | 2 | 6 | 8 | 313 | 150 | 28 | 71 |
| mill far, bakery near | 2 | 8 | 6 | 229 | 210 | 49 | 59 |

The cause is `compareSupplyCandidates` (`src/shared/haul.ts:283`). It ranks on
movable stock, then on the whole hauler → source → building route, then on
building id, then on site id — **with no fairness term and no ageing.** While
the nearer hungry building can still take a load it wins every comparison, so
it takes every trip. `needOf` only stops offering it once its in-tray room minus
pending deliveries reaches zero, and a building that is *consuming* never stays
there for long.

This is not the deadlock §2.6 argues away, and it is not thrash — §4.1 q3
measured both and neither happens. It is a strict priority with no floor.

## Why it matters

It is gameplay-visible and it is silent. A player who builds a mill and then a
bakery slightly further out gets a bakery that never bakes, in a colony whose
haulers are working (idle 42 of 600 ticks) and whose mill is producing well.
Nothing in the game says "this building is at the back of a queue it will never
reach the front of". The Buildings table says `Waiting for input` and the
Economy view's input backlog counts it as one building short of some units,
which is true and is not the explanation.

It also gets **worse as the colony gets richer**, which is the wrong direction:
the more hauling capacity the nearer consumer can absorb, the longer it holds
the queue. §4.2 measured that directly — doubling `inputBufferCap` to 24 lets
the nearer mill absorb four concurrent loads instead of two, and the far
bakery's output at two haulers falls from 150 loaves to 79.

That coupling is the sharpest reason to file this rather than tune around it:
**`inputBufferCap: 12` is currently the dispatcher's only fairness floor, and it
is an accidental one.** The constant that most wants to move cannot move until
this has a deliberate one. See `OBS-7-02`.

## Suggested resolution

Not "rank on need" — the nearer building genuinely does need it, which is why
the current ordering keeps choosing it. Two shapes are worth weighing, and both
are cheap enough that the choice should be made on behaviour rather than on
cost:

- **Ageing.** Carry how long a building has been a supply candidate without
  being served, and let that beat route distance past some threshold. This is
  the classic fix and it fits the existing comparator, but it violates §2.6's
  "no memory between ticks, no iteration-order dependence" property — claims are
  recomputed every tick from live components, and an age is state.

  > **Correction (increment 8, task 1).** This bullet originally continued: "It
  > could be derived rather than stored: `waitingForInputTicks` is already a
  > live component field and already published." **That is false**, and the
  > correction is load-bearing rather than pedantic, because the sentence is
  > what made ageing look free. `waitingForInputTicks` is an accumulator on
  > `StageResult` in `tests/support/balance-harness.ts`, summed by sampling the
  > published building *state* each tick; `grep` finds it in exactly two places,
  > both in that file. No component in `src/` carries how long a building has
  > been waiting, and the engine publishes only the instantaneous state
  > (`snapshot-buildings.ts` derives `'waitingForInput'` fresh each tick). An
  > age would therefore have to be **added** as memory between ticks — which is
  > the property §2.6 forbids by name, so ageing is not derivable and this
  > option was never the cheap one it reads as.


- **A starvation term in the ranking.** Rank a building that has been at zero
  input above one that merely has room, before route distance is consulted at
  all. Derived entirely from live state, so §2.6's purity survives untouched. The
  risk is the opposite failure — a hauler crossing the map past a building that
  could have been served on the way — which the whole-route term exists to
  prevent, so any such term needs measuring against the same fixture in both
  directions.

**The test to write is the one that already exists as a measurement.**
`tests/engine/balance.test.ts`, *"collection resumes, but the farther consumer
can be starved outright"*, runs the same two buildings with their tiles
exchanged and asserts `made === 0` for the far bakery. That assertion is the
finding today; when this is fixed it becomes the regression guard, inverted —
and it discriminates, because a dispatcher that shared haulers puts both above
zero and a dispatcher that starved the second stage regardless of position puts
both at zero. Whatever fix lands must move the first bound and leave the second
one meaningful.

Do not simply relax `inputBufferCap` in its place. That is the accidental floor,
not a fix, and §4.2 measured what removing it costs.

## What landed, and what it cost

**The second shape, exactly as this section framed it.** Increment 8 §2.1 put a
`starving` band at the front of `compareSupplyCandidates`, derived entirely from
live state: the building holds **zero** of the resource this candidate would
deliver, has no batch in progress (`Production.batchActive`), has output room
for another batch, and has no supply delivery already claimed toward it
(`Claims.input`). Three of the four clauses are `startBatch`'s own
preconditions, so the rule is one question — *would this load land and
immediately do something* — asked against the function that decides, plus *is
one already coming*. No new component, no memory between ticks, and the
tie-break chain still ends at a site id.

Two of those clauses were added during review and are recorded in §2.1 because
each one alone is a defect:

- **`batchActive`.** `payFrom` empties the in-tray *at the moment a batch
  starts*, so holding zero is the ordinary state of a building producing
  perfectly well. A one-clause rule promotes a healthy mid-batch producer ahead
  of a consumer blocked for six hundred ticks.
- **`Claims.input`.** A `starving` term computed from physical state alone does
  not move when a hauler is *dispatched*, so every idle hauler on the tick reads
  the same empty tray and is promoted to the same building. The bound in this
  issue's own §2.4 — *if ten idle haulers were dispatched on the same tick,
  would this have stopped the tenth?* — is the one that catches it.

**The guard this issue asked for exists and is inverted.**
`tests/engine/balance.test.ts`, now *"collection resumes, and the farther
consumer is served late rather than never"*, runs the same two buildings with
their tiles exchanged at **one** hauler and asserts both layouts above 50 loaves
and their ratio above 0.85. It still discriminates in both directions, as this
section required: a dispatcher that starves the second stage regardless of
position puts both at zero, and one that merely moves the starvation fails the
ratio. The one-hauler count is itself a discrimination point — at three haulers
the fixture reads identically before and after the floor, so a guard taken there
would stay green against a dispatcher with no floor at all.

**The price, measured in §4.1 and recorded rather than netted out.** The near
mill loses where the floor fires: 254 → 115 flour at one hauler (−55%), 313 →
260 at two. The chain's end product gains everywhere: bread 0 → 108, 150 → 189,
144 → 250. The mechanism is in the hauler-tick split — the same working ticks
buy 43 → 38 supply round trips at 13.0 → 14.8 ticks each, because a trip to the
leg-8 building is longer than a trip to the leg-6 one. Fewer, longer trips is
what serving the far consumer costs, and it is charged in the intermediate good.

**`inputBufferCap` still did not move**, which is what keeps `OBS-7-02`'s
sequencing intact: the deliberate floor now exists, so that issue's re-measure
is unblocked — see its own carry-forward note.
