---
id: OBS-4-07
title: Demolishing a building destroys everything in its output buffer, under a notice that says "cost refunded"
status: Done
severity: important
area: engine
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 final whole-branch review (Important
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - game-design
type: Issue
order: 10
started: ""
finished: ""
horizon: ""
start: ""
due: ""
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

## Note (5d92ff0)

Still open, and still destroyed — but the destruction is now an explicit
`found.buffer.amounts.clear()` in `handleDemolishBuilding` rather than an
implicit consequence of the entity going away at the post-step sync. That was
needed for an unrelated reason (`HaulSystem` runs later in the same tick and
still sees the not-yet-removed building, so a full buffer had it dispatch a
hauler at a building already gone). Whichever option below is chosen, the
refund goes **above** that clear, not in place of it.

## Options

- **Refund the buffer along with the cost.** `handleDemolishBuilding` already
  loops `ctx.stockpile.add` for the construction cost, and now holds a live
  `found.buffer`; adding the buffer's contents is about three lines. Most
  forgiving, and consistent with "demolition is fully refunded".
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

## Resolution (def3ba4)

Decided: **keep destroying it, and say so** — the second option above, not the
first. `handleDemolishBuilding`'s stockpile arithmetic did not move: the
buffer still empties into nothing, the same as it always has, and the
pinned `tests/engine/systems/haul-system.test.ts` assertion that a demolished
forester with 9 buffered wood leaves the stockpile at exactly 10 still passes
untouched. What changed is the success notice, which now names what the
building's buffer held instead of a bare "cost refunded" that was only ever
true of the construction cost — `Demolished the Forester — cost refunded, 9
Wood lost.` An empty buffer keeps today's plain wording rather than gaining a
noisy zero-units clause.

The owner chose this over refunding the buffer for a game-design reason, not
a correctness one: a building left full of uncollected goods *should* be
expensive to bulldoze, since that is exactly the pressure haulers exist to
relieve. Refunding it would erase that pressure entirely. The third,
most-protective option (refuse demolition of a non-empty building, or force a
distinct confirmation) was passed over too — the player already has a
non-destructive way to keep a full buffer intact, `moveBuilding`, so a forced
confirmation would only add friction to a choice with a working escape hatch
already in the player's hands.

Two tests in `tests/engine/systems/command-system.test.ts` pin the new
behaviour: one demolishes a building with a buffered load and asserts both
the new wording and that the stockpile lands on exactly the construction
refund — the guard that this stayed a messaging fix and not a stockpile
change — and one demolishes an empty building and asserts the notice is
byte-identical to the old wording.
