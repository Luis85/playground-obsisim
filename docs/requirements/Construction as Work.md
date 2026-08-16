---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 30
status: Done
tags:
  - game-design
started: 2026-08-11
finished: 2026-08-16
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

## What increment 10 shipped, and what it measured (2026-08-16)

**Both increments are now done, so this note is.** A build order is a *request*:
`handleConstructBuilding` no longer checks affordability, and the gate came out of
all four surfaces that read it — the palette, `WorldView`'s tile predicate, the
Buildings table button and the `affordableDefs` getter itself. `affordableDefs`
was **not deleted**: it stopped gating and started informing, so a player who
queues past the ledger still gets told what is missing, as advice rather than as a
refusal.

**Dispatch was reordered so the resulting queue converges.** `nextSupplyTarget` is
two-phase — the oldest site first, then that site's own best source by the
comparator increments 7 and 8 already built — and `compareSupplyCandidates` gained
exactly one term: a site is never in the starvation band. No new component, no new
system, no new save version, and no age term inside the comparator, which would
have made it non-transitive.

**The measurement says it worked, and the size of it is worth carrying.** N house
sites ordered on the same tick at leg-4 tiles:

- **The first completion is now constant in N** — 65 ticks at one hauler and 35 at
  four, at every queue length from one to eight. Increment 9 published that same
  column as 65 / 95 / 125 / 155 / 215 / 275 (up to **4.2×**) and 35 / 45 / 55 / 65
  / 75 / 95 (up to **2.7×**). The whole of that table is now 1.00× at every row.
- **The last completion did not move by a single tick** — 185 at N=4 and 345 at
  N=8 at one hauler; 65, 85 and 105 at N=4, 6 and 8 at four. Every ordered site
  completed in every run. So this is a **pure redistribution**: the ordering
  bought no throughput and spent none.
- Useful buildings now arrive **throughout** a queue instead of at the end of it.
  At one hauler and N=8 the spread is 280 ticks of a 345-tick wait (**81%**) where
  round-robin left 70 of 345 (20%).

**Two things measured against what was predicted, and both are recorded rather
than smoothed.** Increment 9's sizing input — "three sites is fine and six is
where it turns" — **no longer describes anything**, because there is no N at which
the first building arrives later than it would have alone; the guidance was right
about increment 9 and is now obsolete rather than wrong. And §1.1.1's warning
held: *do not expect a producer to recover throughput*. It did not. Under the
stall sweep a sawmill's output **falls 20%** as the queue lengthens.

**`buildTicks` stays unretuned.** The queue moved completion ORDER and left the
per-site countdown alone, so it sits outside every difference measured, and
increment 9's decision to keep the value while withdrawing its stated rationale
stands.

**Re-taking the measurement is priced in minutes, and the two timings taken
disagree.** `npm run test:balance` ran **757 s** on the review machine — read
there as roughly triple the "already four minutes" the plan cited as its reason
for skipping the two- and three-hauler columns — and **239 s** on the fix pass's,
where it is 239 of a 268-second `check:all`. No before/after exists on one box,
so the threefold growth is the review's reading rather than a reproduced fact;
what stands either way is that a sweep costs minutes. Nothing was trimmed to buy
that back.

**Four issues: one from the measurement, two from the final review, and one
carried.**

- `[[A queue of sites takes the wood its own planks are made of]]` (OBS-10-01),
  filed with its number: the producer protection is one load deep, and at the
  worst fixture measured a queue of ten delays the first building **1.65×**
  (113 → 186) while still completing every site. It is a delay, not the stall
  §2.3 named. The same sweep found the mechanism **inverted** at a camp-adjacent
  producer — nothing completes at any queue length *including one* — which is
  producer contention rather than a queue effect and which rules out one of the
  three remedies §2.3 recorded.
- `[[Nothing reddens if the pending construction ledger stops being cleared]]`
  (OBS-10-02): deleting the order-time affordability check took the only reader
  of `PendingChanges.constructed` **and** the only test that reddened when
  `clear()` stopped emptying it. The field is dead but inert, and removal reaches
  comments in four other systems and hand-built context fixtures, so the
  situation is recorded rather than patched.
- `[[haul.ts has four nonblank lines left, and that is a gate rather than headroom]]`
  (OBS-10-03): `src/shared/haul.ts` is at **496 of a hard 500**. Splitting the
  supply-selection functions out was deliberately NOT done here — a pure move
  would have churned the two functions the review had just verified — and it
  should be the **first commit on the next branch that touches supply**.
- `[[The staging half of transfer is correct, and almost never worth a trip]]`
  (OBS-8-06) is **measured and still open**, and now carries a named follow-up
  (F1) rather than a paragraph: site staging costs 22–44 extra hauler-ticks a
  run, parks 12–24 units nothing draws back, and moves **zero** completion ticks.
  Shipping the `demandSourcesOf` instrument on regardless was the repo owner's
  decision, taken because §2.5/§4.2 scope this increment to measuring OBS-8-06
  rather than acting on it. The remote consumer it said this
  repository lacked is a construction site, and that fixture now exists: staging
  fires (2–4 dispatches) and does not pay — identical completion ticks with and
  without the depot, 22 to 44 extra non-idle hauler-ticks, and 12 or 24 units
  parked at a depot nothing ever drew from. The reason is the triangle
  inequality, so it is arithmetic rather than tuning.

**No Feature note was raised for build priority or queue reordering**, and the
reading is why. §2.5 deferred it and asked for a note if the queue-cost
measurement argued for one; that measurement found the first completion constant
in N and the last unchanged from round-robin, so **the total is fixed and only its
distribution is in play.** A priority UI cannot make a colony grow faster — it can
only choose which building arrives first, which age already gives the player for
free by the order they click. It becomes interesting when a queue wants reordering
for a reason other than latency, and nothing measured here is that reason.

**The builder role is still in neither increment.** Labour as a constraint on
building remains deferred; both increments complete a site on materials plus a
fixed countdown.

## Documentation

- `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` §1.1, §2.13 — the descoping and its reasoning
- `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md` — sites, delivery, the countdown, cancellation, save v7
- `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md` — the request model and the queue ordering; §4.1 and §4.2 are every number quoted above
- `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md` — the issue this would close as a side effect
- `docs/issues/2026-08-16-a-sites-last-unit-can-fall-below-the-supply-floor-and-strand-the-build.md` — the defect the increment-9 measurement found, fixed in increment 9
- `docs/issues/2026-08-16-a-queue-of-sites-takes-the-wood-its-own-planks-are-made-of.md` — the §2.3 stall, priced by increment 10 and left unfixed
- `docs/issues/2026-08-11-the-staging-half-of-transfer-is-correct-and-almost-never-worth-a-trip.md` — measured at the remote fixture it asked for, and still open
