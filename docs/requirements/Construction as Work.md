---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 30
status: Active
tags:
  - game-design
started: 2026-08-11
finished: ""
horizon: ""
start: ""
due: ""
---

# Construction as Work

A building still appears finished the tick it is ordered. `handleConstructBuilding` (`src/engine/systems/command-handlers.ts`) pays the def's cost out of the colony ledger and spawns a complete, working building at the target tile — no site, no materials carried there, no labour, no time. It is the last place in the game where goods teleport and work happens for free.

**Descoped from Increment 7 deliberately, and this note is the record.** That increment's §1.1 and §2.13 name it as the natural successor rather than folding it in: it would roughly double a fifteen-task increment, and every part of it sits on top of machinery Increment 7 builds first.

## Why it belongs to Logistics rather than to World and Spatial Play

The interesting half is not "buildings take time" — it is that a construction site is **a building-shaped thing with an input buffer and no output**. Once Increment 7 ships, haulers already deliver a recipe's inputs to a building that needs them, respect reservations, claim what they are fetching, and price every leg. A construction site is that same machinery pointed at a different consumer: planks and wood carried to a tile, banked locally, consumed as the build progresses.

Doing it before two-way haul would have meant inventing a second, parallel delivery mechanism for materials. Doing it after means it is largely a content and lifecycle problem.

## What it would take

- A construction-site entity: a tile, a target def, an input buffer, and progress — the `BuildingDef` role vocabulary (produces / shelters / stores) gains a fourth arm, or a site is a distinct entity kind.
- A **builder** role, staffed the way haulers are, whose work advances the site instead of a recipe. Commute and hunger apply as they do to any other work.
- Materials **delivered**, not paid: the cost leaves the ledger when a hauler picks it up, and a half-built site holds real goods that a cancelled build has to account for.
- Cancellation, and what happens to what has already arrived.
- A save version: sites, their buffers and their progress are persistent state.
- Surfaces: the site on the canvas and in the tables, and the Economy view naming a build backlog beside the input and output backlogs it will already name.

## What it would close for free

`[[Demolish-and-rebuild bypasses the priced relocation]]` (OBS-5-03), accepted-not-fixed in Increment 7. Pricing that bypass on its own needs persisted demolition history to detect "this construct is really a relocation". If a construct costs delivered materials and a builder's time regardless, rebuilding elsewhere stops being free and the exploit closes without any bookkeeping at all — which is the strongest argument for doing this increment before revisiting that issue.

## It is being built as two increments, not one

This note was written as one feature and specced as one increment. **It ships as
two**, and the seam is worth recording because it was not obvious in advance.

- **Increment 9 — Construction as Work.** Materials are carried to a site and
  building takes time. A site occupies its tile, provides nothing, is delivered
  to by the existing haul machinery, completes on a countdown, cancels with a
  full refund, and round-trips through a save. **The affordability rule does not
  change**: you still cannot order what you cannot pay for.
- **Increment 10 — A Build Queue That Converges.** A build order becomes a
  *request*: the affordability check comes out of the engine and all four UI
  surfaces, and dispatch is reordered oldest-site-first so the resulting queue
  converges instead of crawling.

**Why there.** The two halves of increment 10 are one change — removing the check
is what makes long queues possible, and age-first dispatch is what stops those
queues crawling — and neither is needed to make building *work*. Eleven rounds of
review on the combined spec landed six of their findings inside those two
sections and nowhere near the rest, which is what the seam was drawn from.

**What the split costs, stated because it is real.** Increment 9 ships with
several sites filling round-robin, so a player who orders three buildings at once
sees them finish late and together. That is bounded by the affordability check —
a queue is limited to what the colony could have paid for at the moment each
order was accepted — and increment 9 §4.1 measures how bad it is, which is the
sizing input for increment 10.

**Bounded is not the same as guaranteed, and the difference is deliberate.** The
check is order-time only: it writes nothing down and reserves nothing, so goods
it counted can leave for a meal or a producer before a hauler collects them, and
an accepted site can be left short. Increment 9 §2.3 says so explicitly and
declines to fix it with a reservation, because reserving strongly enough to
guarantee completion would mean holding materials against food. A stalled queue
is recoverable — cancelling a site returns its materials for another to use —
and increment 9 §4.1 Step 2b measures how often the stall actually happens,
which is what increment 10 needs before it removes the check.

The **builder role** listed under "What it would take" above is in neither
increment. Both complete a site on materials plus a fixed time; labour as a
constraint on building is deferred, and increment 9 §2.12 records what that
defers.

## What increment 9 shipped, and what it measured (2026-08-16)

The first of the two increments above is **done**. Ordering a building creates a
site that occupies its tile and provides nothing; its cost is carried there by the
haulers increment 7 built; a countdown then runs and the building appears.
Cancellation refunds what arrived, the whole thing round-trips through save v7,
and the conservation sentinel reads zero across every balance scenario including
ones that complete a site.

**`[[Demolish-and-rebuild bypasses the priced relocation]]` (OBS-5-03) closed as
predicted** — by construction, with no persisted demolition history, exactly as the
section above argued it would.

**One defect was found by the measurement rather than by the tests**, and it is
the kind this note should carry: `[[A site's last unit can fall below the supply
floor and strand the build]]` (OBS-9-01). A sawmill costs 25 wood, haulers carry 6,
and the last unit fell below `minSupplyUnits` — so the site sat at 24 of 25
forever and **a shipped, player-selectable building could not be built at any
distance or hauler count.** Fixed in increment 9. It is worth remembering that
every unit test passed while this was true; the cost sweep found it.

**§4 says the countdown is the larger half of the price, and the flat rate is
wrong.** Beside the camp a house is 7 ticks of delivery and 30 of countdown — 81%
of the wait — and only past leg ~10 does delivery dominate. Delivery already
scales with cost almost linearly; the countdown does not, so a mill costing three
times a hut takes 25% longer to appear. `[[Build Time That Scales]]` records that
finding and the two levers available. It also notes the finding a player feels
most directly: **the countdown is the one part of the price that logistics cannot
buy off** — four haulers cut a far-corner house's delivery from 99 ticks to 15 and
leave the 30 untouched.

**What is left is increment 10**, and §4 sharpened its case rather than confirming
it. The order-time affordability check that bounds increment 9's queue measures as
**a lottery on timing**: with a staffed consumer eating the same resource, three
sites accepted against a genuine 60-wood ledger spent 98% of a 900-tick run short,
in one unbroken stretch of over 800 ticks — while the same colony with no opening
pile *refuses* the order outright. It prevents a queue starting impossible and
does nothing about it becoming impossible one tick later.

## Documentation

- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §1.1, §2.13 — the descoping and its reasoning
- `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md` — sites, delivery, the countdown, cancellation, save v7
- `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md` — the request model and the queue ordering
- `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md` — the issue this would close as a side effect
