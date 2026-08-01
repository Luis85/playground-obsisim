---
id: OBS-4-07
title: Demolishing a building destroys everything in its output buffer, under a notice that says "cost refunded"
status: open
severity: important
area: engine
increment: 4
created: 2026-08-01
source: increment-4 final whole-branch review (Important #4)
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - issue
  - game-design
  - needs-decision
---

# Demolition destroys the output buffer

`handleDemolishBuilding` (`src/engine/systems/command-handlers.ts:175-196`)
refunds the building's construction cost and drops the entity. Anything sitting
in its `OutputBuffer` — up to `outputBufferCap`, currently **12 units** — goes
with it.

This is deliberate, not an oversight: it is consistent with the neighbouring
rule that an in-flight batch's progress "is simply lost with the entity", and a
test pins it (`tests/engine/systems/haul-system.test.ts:228` asserts the
stockpile ends at exactly the 10-wood refund, with a comment noting the 9
buffered units did not make it out). It was verified end to end during review: a
mill with 5 buffered flour, demolished, leaves zero flour anywhere.

It is logged because it is a **goods-destruction path that increment 4
introduced and the spec never addresses**.

## Why it needs a decision rather than a shrug

Three things pull against each other:

1. **The spec's acceptance criterion 7** reads "Moving or demolishing a building
   mid-trip resolves per §2.8 without losing or duplicating a single unit of
   goods." That clause is about the *trip*, and the trip is genuinely correct.
   But a reader would reasonably expect it to cover the building's own stock.
2. **The notice is misleading.** `command-handlers.ts:195` says
   `Demolished the {name} — cost refunded.` True of the construction cost,
   silent about the up-to-12 units that just evaporated.
3. **Before increment 4 this could not happen.** Goods went straight to the
   stockpile, so demolishing a building never destroyed inventory. The buffer
   created the hole.

The mitigations are real: the selection panel shows `Waiting: N` directly beside
a two-step Demolish button, and the buildings table has a `Waiting` column. A
player who looks can see what they are about to lose.

## Options

- **Refund the buffer along with the cost.** `handleDemolishBuilding` already
  loops `ctx.stockpile.add` for the construction cost; adding the buffer's
  contents is about three lines. Most forgiving, and consistent with "demolition
  is fully refunded".
- **Keep destroying it, and say so.** Change the notice to name the loss —
  `Demolished the {name} — cost refunded, N units lost.` Cheapest honest fix,
  and arguably better game design: a building full of uncollected goods *should*
  be expensive to bulldoze, since that is exactly the pressure haulers exist to
  relieve.
- **Refuse to demolish a non-empty building** without a distinct confirmation.
  Most protective, most friction.

Not decided here because it is a balance and game-feel call, not a correctness
one. Whichever is chosen, the notice and the spec should stop disagreeing with
the code.
