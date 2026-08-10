---
id: OBS-7-01
title: The supply ranking has no fairness floor, so the farther of two consumers is starved permanently rather than served late
status: Open
severity: important
area: engine
increment: 7
created: 2026-08-10
source: increment-7 task 14 (measure), section 4.1 q3 — found while measuring whether dispatch thrashes, which it does not
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
  recomputed every tick from live components, and an age is state. It could be
  derived rather than stored: `waitingForInputTicks` is already a live component
  field and already published, and it is exactly "how long has this building been
  unable to work".
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
