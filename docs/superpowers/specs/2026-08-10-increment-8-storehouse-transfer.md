# Spec: Increment 8 — Storehouse-to-Storehouse Transfer

**Status:** Draft
**Predecessor:** `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md`
**Backlog Feature:** `docs/requirements/Storehouse-to-Storehouse Transfer.md`
**Issues closed:** OBS-7-01 (in scope, first). OBS-7-02 is measured, not moved.

---

## 1. Why this increment exists

Increment 7 shipped the storehouse and then measured it, and §4.3 records that
the two disagree. §1 sold a depot as an investment. It measures as a **one-off
buffer**: +26 / +24 / +28 planks at 600 / 1,200 / 2,400 ticks — flat in
absolute terms, so as a *rate* it decays to zero. Beside a camp-fed processor it
is a 10% net loss.

The cause named there is structural rather than a magnitude: **a store site can
be filled by a building's output but never emptied.** `destinationFor` resolves
source-first and `remainderHome` routes an undelivered load back to its own
source, both deliberately, so nothing in the game moves goods from one store
site to another. A depot beside a chain silts up with that chain's finished
good, reaches 60 of 60, and stops participating. No value of
`storehouseCapacity` creates a movement that does not exist — 240 was tried and
the depot is full at 240 too.

This increment supplies the missing flow.

### 1.1 What a storehouse actually becomes, stated so it can be falsified

Increment 7's §1 called a storehouse "a second place to put things". That
framing is why §4.3 could not find the value it promised, and it is replaced
here rather than repeated.

**A storehouse is a pipeline stage.** It earns its keep at both ends of a
chain, and in both cases by *decoupling a short hop from a long haul*:

- **Outbound.** A producer's output goes into the depot on a short hop, so the
  producer stops sitting in `outputFull` waiting for a hauler to come back from
  the camp. The long depot → camp leg is then amortised behind it, on a hauler
  that is not blocking anything.
- **Inbound.** Camp stock is staged into the depot on the long haul, and the
  depot → consumer hop is short and turns over fast. The consumer is fed
  **without occupying in-tray concurrency** — which is precisely OBS-7-02's
  finding, that a far processor is "capped by its in-tray rather than by its
  haulers". `inputBufferCap: 12` allows two loads in flight to a building; a
  depot beside it holds 60 that are not in flight.

**The prediction, and §3 makes it an acceptance criterion:** if a depot is a
pipeline stage rather than a buffer, its advantage over no depot must **grow
with the horizon**. §4.3's 26 / 24 / 28 is what a buffer looks like. If this
increment's numbers are also flat, the mechanic did not land, and §4 will say so
in §4.3's own manner rather than retuning a constant until the percentage looks
better.

The mechanism, not only the outcome, is instrumented: `StageResult.stalledTicks`
(ticks in `outputFull`) and `waitingForInputTicks` already exist, so "the
producer stopped stalling" and "the consumer stopped starving" are separately
observable from the throughput number they are supposed to explain.

### 1.2 Product decisions taken for this increment

- **The fairness floor (OBS-7-01) is in scope, and it lands first.** Not
  because it is adjacent, but because it eats this feature's value. The staging
  half exists to relieve the in-tray cap; the in-tray cap is OBS-7-02; OBS-7-02
  is blocked on OBS-7-01. Shipping transfer on a ranking that hands every trip
  to the nearer consumer means the far building's depot never gets staged, the
  feature measures as a wash, and the wash is attributed to the feature.
  §2.1 specifies it and §4.1 measures it **on its own, with no transfer code in
  the tree**, so the two changes have one variable each.
- **The trigger is pull, with exactly one push**, and the push is
  direction-asymmetric. §2.4.
- **Both halves ship.** Pull-toward-demand alone leaves a depot silting up with
  finished goods that crowd out the staging it exists for — capacity is measured
  across every resource, so the §4.3 defect survives a pull-only increment in a
  slower form. Push alone leaves the far consumer starving.
- **`inputBufferCap` does not move.** OBS-7-02 asks for a retune; this
  increment answers it with a measurement instead. If transfer makes the cap
  non-binding, that issue closes on a finding rather than on a constant.
- **The camp-fed-processor loss is measured, not rescued.** §4.2 keeps the
  configuration that lost 10% and reports whatever it shows, including worse.
  Its named cause — a depot strands haulers far from the stock, so the next
  fetch leg lengthens (2–8% → 17–20% of working hauler-ticks) — is if anything
  aggravated by giving haulers more reasons to end a trip out there. No rule is
  added to rescue it; §4.3 will record it.

### 1.3 What this makes harder, deliberately

- **A third kind of work competes for one pool of haulers.** §2.6 answers this
  structurally rather than by tuning — and *which* structure it uses changed
  once the increment was measured, which §2.6 records rather than smooths over.
  **Staging**, the half nobody is waiting for, is offered **last**, so it spends
  only hauler-ticks that would otherwise be idle. A **drain** is offered ahead
  of collect, because for that one class something *is* waiting: a bounded site
  below its free floor cannot take the short-hop deposits that are its entire
  outbound value (§1.1). That is still a structural answer rather than a tuned
  one, because the promotion is **bounded and self-extinguishing** — `drainNeed`
  is netted against the removals already scheduled, so a saturated depot
  schedules exactly the units that restore its floor and then stops being a
  candidate at all. Nothing is set to a share; the condition ends.

  **A reserved share of hauler-ticks was the considered alternative, and it was
  rejected.** It is a constant to tune rather than a condition that terminates,
  and it buys the drain its ticks by also letting *staging* — the speculative
  class — compete with work somebody is blocked on. Promoting the one class with
  a real blockage behind it costs less and can be argued to a stop.

  What transfer still costs is *occupancy* — a hauler mid-transfer is
  unavailable for a supply job that arises next tick — and §2.6 names that cost
  rather than denying it.
- **Two store sites and a camp are a machine for moving goods in circles**
  unless the rule forbids it. §2.4 makes circles inexpressible rather than
  unattractive, and states the argument.
- **The guarantee §2.5 of increment 7 rests on is exactly the one a transfer
  looks like violating.** §2.5 below is entirely about keeping it.

---

## 2. Requirements

### 2.1 The fairness floor, and the state it may not use

`compareSupplyCandidates` ranks on movable stock, then the whole
hauler → source → building route, then building id, then site id. There is no
fairness term and no ageing, so while the nearer hungry building can still take
a load it wins every comparison and takes every trip. Measured: a bakery at leg
8 behind a mill at leg 6 makes **zero** bread in 600 ticks; exchange the tiles
and it makes 108.

**OBS-7-01's own suggested resolution is partly wrong, and the correction is
load-bearing.** The issue offers ageing as the classic fix and says it "could be
derived rather than stored: `waitingForInputTicks` is already a live component
field and already published." It is not. `waitingForInputTicks` is an
accumulator in the *balance harness* (`StageResult`), summed by sampling
snapshot status each tick. No component carries how long a building has been
waiting, and adding one would be memory between ticks — which §2.6 of increment
7 forbids by name, because it is what keeps dispatch a pure function of world
state and independent of entity iteration order.

So the fix is the issue's second shape, a starvation term derived entirely from
live state:

> **A candidate is *starving* when delivering it this resource, right now, would
> start a batch — and nothing is already on its way.** Concretely: the building
> holds zero of the resource that candidate would deliver, has no batch in
> progress, has output room for another batch, and has no supply delivery
> already claimed toward it. *Topping up* otherwise. Starving outranks topping
> up, ahead of every existing term. Within a band nothing changes.

Derived from `InputBuffer.amounts`, the resource `needOf` already chose,
`Production.batchActive`, `OutputBuffer.room` against `batchOutputUnits`, and
`Claims.input`. No new state, no new component, no iteration-order dependence,
and the tie-break chain still ends at a site id.

**Read the four clauses as one idea, not as an accumulation.** Three of them are
exactly `startBatch`'s own preconditions (production-system.ts): it returns
early if a batch is already running, returns early if the output buffer lacks
room for another batch's worth, and otherwise starts only if `payFrom` finds the
inputs. The fourth is the reservation. So the rule is not four conditions that
happened to survive review — it is a single question, *would a load land and
immediately do something*, asked against the function that actually decides,
plus *is a load already coming*. Anything `startBatch` checks belongs here by
construction, and anything it does not check does not.

**The second clause is not a refinement, and an earlier draft of this section
was wrong without it.** That draft ranked on the empty in-tray alone and
justified it with "a building that holds zero of its input cannot start a batch
at all; one that holds some is producing while it waits." Both halves are
backwards on the code. `payFrom` (production-system.ts) draws a batch's inputs
out of the in-tray **at the moment the batch starts** — `startBatch` calls it
before setting `batchActive`, and `completeBatches` calls it again to chain — so
holding zero is the *ordinary* state of a building that is producing perfectly
well, for the whole length of its current batch. A mill on a three-tick batch
holds no wheat for three ticks out of every three. Holding *some* does not mean
"producing while it waits"; it means runway banked for the batch after this one.

So the one-clause rule promotes a healthy producer, mid-batch, ahead of a
consumer that has been blocked for six hundred ticks — and does it on the tick
after every delivery, which is exactly when the fairness floor is supposed to be
protecting the blocked one. `batchActive` is what tells the two apart, it is a
live component field (`Production`), and reading it costs this rule nothing it
was not already paying: `HaulSystem`'s building query gains `Production`, which
is an existing component, so §2.3's "no new component" holds.

**The third clause is this section's own §2.4 rule, applied to itself.** A draft
with only the first two derived `starving` entirely from physical state — an
in-tray and a batch flag, neither of which moves when a hauler is *dispatched*.
Dispatch runs every idle hauler within one tick, so the second hauler reads the
same empty tray as the first and is promoted to the same building, and the
third after it. `Claims.input` bounds the damage at `inputBufferCap / capacity`
— two haulers at today's constants — because `needOf` returns null once the
tray's room is fully claimed. Bounded is not the same as intended: the guarantee
below says the promotion "ends the moment a single load lands", and without this
clause that sentence is simply false.

**The output-room clause closes the mirror-image hole.** A processor that
finishes a batch into a full output buffer with an empty in-tray leaves
`batchActive` false, so the first three clauses call it starving — but
`startBatch` cannot begin work no matter what arrives, because it returns on
output room before it ever reaches `payFrom`. That building is blocked on
*collection*, not on input, and the thing that unblocks it is a collect trip. On
three clauses the floor promotes it ahead of a processor that would resume the
instant a load landed, and spends a supply trip on a building that cannot use
it. This is the far-processor `outputFull` stall that `StageResult.stalledTicks`
counts, so it is the common case rather than a corner one.

Apply this spec's own test, the one §2.4 opens with and Task 12 puts in
`docs/process/agent-workflow.md`: *if ten idle haulers were dispatched on the
same tick, would this have stopped the tenth?* A term computed from physical
state would not, and `starving` was such a term. It is the one bound in this
increment that nobody thought to check, in the increment whose central process
lesson is that every bound must be reservation-aware — which is the reason it is
written up here at length rather than quietly fixed.

With all three clauses the rule says what the prose always meant: **this
building cannot turn anything into anything right now, has nothing to start
with, and has nothing already coming.** A building mid-batch is not starving,
however empty its tray; neither is one with a load already walking toward it.

**Today this is indistinguishable from "the in-tray is empty", and the
distinction is still the one to implement.** Every recipe in
`src/engine/content/buildings.ts` has zero or one input, so `shortestOf` always
returns that one input and the two phrasings coincide. Stating the rule
per-candidate rather than per-building costs nothing now and is what stops it
quietly meaning the wrong thing the first time a recipe gains a second input —
at which point "holds zero of *any* input" would rank a building starving on the
strength of a resource this particular candidate is not carrying.

The new order in `compareSupplyCandidates`:

1. **starving before topping up** — new
2. `movable` descending
3. whole hauler → source → building route ascending
4. building id
5. site id

**Why this is a floor and not merely a different priority.** A building with an
empty tray and no batch running cannot turn anything into anything until
somebody brings it something; one that is mid-batch is already working, and one
that holds stock has runway. The rule promotes only the first, and the promotion
ends the moment a single load lands — after which the building is in band 2 and
the ordinary route term decides again. It cannot pin a hauler to a distant
building indefinitely, because the condition it ranks on is extinguished by
serving it once.

All four clauses are needed for that argument to hold, and each fails it a
different way. Without `batchActive` the condition is *not* extinguished by
serving the building once — it returns on the tick the next batch starts and
every batch after it — so what looks like a floor becomes a term that fires on
and off for every consumer in the colony, and the band stops distinguishing
anything. Without the claim clause the promotion is not extinguished until a
load physically *lands*, several legs later, so every hauler idle on the
dispatch tick is promoted to the same building and "serving it once" is not what
happens at all. Without the output-room clause serving the building does not
extinguish the condition either, because the delivery cannot start a batch: the
load sits in the tray, the building stays blocked on collection, and the trip
bought nothing.

**The risk this takes, stated because §4 must measure it in both directions.**
The failure mode opposite to starvation is a hauler crossing the map past a
building it could have served on the way, which the whole-route term exists to
prevent. Two things bound it: within the starving band the ordinary terms still
decide, so the band promotes without also rearranging what is inside it; and
only a starving-versus-satisfied comparison can invert on distance. §4.1
measures the mill/bakery fixture in **both** tile orders and the existing
distance gradient, and a fix that moves the first while wrecking the second is
not a fix.

**A qualification, because an earlier draft over-claimed it.** That draft said
"within the starving band the route term still decides, so among starving
buildings the nearest is served", and that is false as written. The order is
starving, then `movable` descending, then route — so route decides only among
starving candidates with **equal** movable stock. Where movable differs, a
farther starving building with six units still outranks a nearer starving
building with a two-unit tail, and a hauler does cross the map.

That is the pre-existing movable-first policy, not something this band
introduces: the identical trade-off has always governed the topping-up band and
is the reason `movable` sits ahead of route at all. It is left exactly where it
is. **Reordering movable and route inside one band would be a real balance
change**, made in the same increment whose §4.1 is supposed to measure the
starvation term alone — which is the one thing §1.2 is emphatic that this
increment must not do. So the guarantee is narrowed to what is true rather than
the code being changed to match a sentence, and the unequal-movable case gets a
test so the actual behaviour is pinned instead of assumed. If §4.1 shows the
crossing is expensive, that is a finding and a successor, not a quiet retune.

**`inputBufferCap` stays at 12.** §4.2 of increment 7 established that the cap
is currently the dispatcher's only fairness floor and an accidental one. This
section supplies a deliberate one; moving the constant in the same increment
would make it impossible to say which one did the work. OBS-7-02 is answered by
§4.4's measurement.

### 2.2 A site's demand, derived from the buildings nearest to it

A store site has no recipe, so it cannot be asked what it needs. `needOf`
answers "what does this *building* need". The generalisation is:

> **A site's demand for a resource is the demand of the staffed, consuming
> buildings for which it is the nearest live store site.**

Concretely, per tick and from live components only:

- For each building with recipe inputs that is staffed and not relocating,
  resolve `nearestSite(building.col, building.row, sites)` — the function
  already exported from `src/shared/haul.ts` and currently unused by dispatch.
- That site's demand for each of the recipe's input resources gains
  `BALANCE.siteStagingTarget` units.
- Every other site's demand for that resource is 0 from that building.

A site's **deficit** of a resource is `max(0, demand − unclaimedAt − inbound)`
and its **surplus** is `max(0, unclaimedAt − demand)`, where `unclaimedAt` is the
site's stock of that resource less what fetching haulers have already planned to
take out, and `inbound` is what transfers are already walking toward it (§2.7).
**Both are net of claims in both directions, and §2.4 explains what goes wrong
when either is not.**

**The deficit is claimed-net on the OUTGOING side too, and an earlier draft
wrote it `demand − held − inbound`, which is not.** That asymmetry is visible
the moment the two formulas sit side by side: surplus subtracted outgoing claims
and deficit did not, for no reason either could state. Concretely, a depot
holding exactly its 12-unit target with a supply hauler already fetching six of
them reports a deficit of **zero** until that hauler physically arrives, so no
second hauler can stage the replacement concurrently and the refill waits a full
trip. That is latency in the pipeline stage this feature exists to keep full —
not a lost unit, which is why it is easy to miss, and exactly the value §1.1
claims a depot delivers.

Writing both through `unclaimedAt` also removes the special vocabulary: there is
one claimed-net holding, and demand is measured against it from either side.
Stock already spoken for by a departing hauler no longer counts as satisfying
local demand, because it is leaving.

**A site can never be both a source and a sink for the same resource**, because
deficit and surplus are computed from one comparison of the site's *claimed-net*
holding against its demand, and at most one of them is positive. The claimed-net
part is load-bearing rather than a refinement: compare physical `held` against
demand and a site's surplus can be over-committed within a single tick until it
lands below its own demand — a source that has just made itself a sink, which is
this property failing rather than being approximated. This is the whole termination argument for
the pull half, and it makes circles *inexpressible* rather than merely
unattractive — which is what the backlog Feature asks for when it says "every
ranking that makes a transfer attractive also makes the reverse transfer
attractive the moment it completes."

Three properties worth stating because each is a place this could go wrong:

- **The camp participates as an ordinary site.** A building beside the camp has
  the camp as its nearest site, so the camp acquires a real demand and a depot
  holding wheat a camp-side mill needs may legitimately transfer *inward*. The
  camp is not special in the pull rule; it is special only in the push rule
  (§2.4) and in being unbounded.
- **Nearest, not "within range".** No radius constant. A building's inputs are
  staged at whatever site is closest to it, which is the camp when no depot is
  closer — the same "nearest, then id" law `closer` already implements, so the
  answer never depends on array order.
- **Demand is per-resource and additive across buildings.** Two mills nearest
  the same depot make its wheat demand `2 × siteStagingTarget`. A depot that is
  nearest to nothing has zero demand for everything, which is exactly the
  corner-chain depot in §4.3's measurement and exactly the case the push rule
  is for.
- **Additive demand can exceed what a bounded site should hold, and staging —
  not demand — is what gets bounded.** Five staffed mills nearest one 60-unit
  depot make its wheat demand `5 × 12 = 60`. Nothing in the staging formula
  stopped that: `roomAt(D)` is `capacity − heldAt(D)`, so staging could fill the
  depot to 60 of 60. Every unit is then demanded, `surplus` is zero everywhere,
  and §2.4's drain refuses to remove anything below demand — so the depot sits
  saturated, cannot accept the short-hop collect deposits that are its entire
  outbound value, and the `storehouseFreeFloor` it is supposed to keep is
  unreachable by any rule. That is the §4.3 silting-up defect again, arriving
  through the staging door this time.

  **Two bounds are required, and neither is sufficient alone.** A first
  correction bounded only staging, on the argument that demand is an honest
  statement of what the consumers around a site want and should not be clamped.
  That closes one door: it stops *staging* from filling the depot past its
  floor. It does not stop the depot getting there, because **collect does not
  consult demand at all** — a producer's output goes to the nearest site with
  room, so the depot still reaches 60 of 60, and at that point
  `surplus(wheat) = unclaimedAt(60) − demand(60) = 0` and the drain is as stuck
  as before. Same dead end, reached through the other door.

  So:

  - **A bounded site's total demand is capped at `capacity − storehouseFreeFloor`.**
    This is what guarantees a positive surplus exists whenever the site is above
    its floor, and therefore that the drain can always restore it. When the
    summed demand exceeds the cap, each resource's share is scaled proportionally
    and floored to an integer — deterministic, independent of iteration order,
    and under-allocating by a unit or two is the safe direction, since an
    unallocated unit is simply not demanded by anyone.
  - **Staging may not consume the free floor**: for a bounded destination the
    staging term is `capacity − storehouseFreeFloor − heldAt(D)`, floored at
    zero, rather than `capacity − heldAt(D)`.

  **The pair is not redundant and the difference is worth stating, because
  otherwise someone deletes one of them.** The demand cap makes the drain always
  *able* to restore the floor. The staging cap makes staging never the *cause* of
  the floor being breached. The first is about whether a remedy exists; the
  second is about not needing it. The camp is unbounded and keeps no floor, so
  neither bound touches it.

  **The floor is the room a depot keeps for the short-hop collect deposits that
  are its outbound value**, and staging is its other job. One job may not eat the
  other's reserve, and the drain exists for exactly the stock that arrives by the
  door demand cannot see.

### 2.3 The transfer trip: the supply trip minus the building

`HaulKind` gains a third member: `'collect' | 'supply' | 'transfer'`.

A transfer is structurally **simpler** than a supply trip, not an addition to
it. A supply trip is three legs — `fetching` to a source site, `outbound` to a
building, `returning` to a store site. A transfer is the same trip with the
middle leg removed:

| leg | supply | transfer |
| --- | --- | --- |
| `fetching` | hauler → source site | hauler → source site |
| `outbound` | source → building | — |
| `returning` | building → store site | source → destination site |

`targetId` is `null` for the whole trip; a transfer names no building. Both
arrival handlers already exist (`fetchArrival`, `depositArrival`) and both
already do most of what a transfer needs.

**The alternative was considered and rejected.** Expressing a transfer as a
supply trip whose target happens to be a store site is less new vocabulary but
more new machinery: it forces `needOf` — which reads a building's recipe and
in-tray — to answer for a thing that has neither, and it puts a site id into
`targetId`, which every existing recheck, the demolition handler and the
snapshot all read as a building id. The third kind is the cheaper change, and it
is cheaper than it looks for one specific reason: **the save does not persist
trip state.** `buildSaveFromWorld` banks a mid-trip load into the camp stock and
writes no trip, so haulers restart idle on load and a third `HaulKind` needs
**no save version bump and no migration**. `LATEST_SAVE_VERSION` stays 6.

### 2.4 Which transfers are legal: pull, and exactly one push

**Every term in a `movable` formula must be reservation-aware, and this rule is
stated before the formulas because it is the one this spec kept getting wrong.**

Dispatch runs many haulers within a single tick, and physical stock does not
move until a hauler *arrives* — several legs later. So any term computed from raw
`getAt`/`totalAt` is identical for every hauler dispatched in that tick, and the
quantity it bounds is silently spent as many times as there are idle haulers.
Three separate drafts of §2.4 shipped that bug in three different terms
(destination room, source surplus, drain headroom), each time because a *neighbouring*
term happened to be reservation-aware and looked like it composed. **It does not
compose: a claim on one quantity bounds that quantity and no other.**

The test to apply to any term added later: *if ten idle haulers were dispatched
on the same tick, would this term have stopped the tenth?* If it is computed
from physical state, it would not.

Two candidate classes. The numbering below is the **ranking order within one
candidate list** — `compareTransferCandidates`'s first term — and **not** the
order the two classes are offered at dispatch, which is the opposite way round:
§2.6 offers a drain *ahead* of collect and staging *behind* it.

**1. Staging (pull).** Source `S`, destination `D`, resource `r`, where
`D.deficit(r) > 0` and `S.surplus(r) > 0` and `S ≠ D`.

```
S.surplus(r) = max(0, unclaimedAt(S, r) − S.demand(r))          ← NOT held(r) − demand(r)
D.deficit(r) = max(0, D.demand(r) − unclaimedAt(D, r) − inboundAt(D, r))
movable      = min(haulerCapacity, D.deficit(r), S.surplus(r), roomAt(D))
```

Both sides are claimed-net in both directions (§2.2): the deficit subtracts what
is already leaving `D` as well as what is already arriving, so a depot at its
target with a supply hauler mid-fetch can be restaged concurrently instead of
waiting a whole trip to notice the hole.

**Surplus is defined *through* `unclaimedAt`, not beside it.** Sizing it from
physical `held` while listing `unclaimedAt` as a separate term in the `min` is
the shape that fails: the two bound different quantities and neither constrains
the other. A site holding 20 wheat against a demand of 12 has a surplus of 8. At
capacity 6, the first hauler claims 6 and `unclaimedAt` drops to 14 — but surplus
recomputed from `held` is *still 8*, so a second hauler claims 6 more. Twelve
units leave against a surplus of 8, the source lands on 8 against a demand of 12,
and it is now a **sink for the resource it was just a source of** — which is
precisely the state §2.2 calls inexpressible and rests its whole termination
argument on. Defining surplus through `unclaimedAt` gives the second hauler a
surplus of 2 and a load of 2, and the source lands exactly on its demand.

The redefinition also **removes** the separate `unclaimedAt` term, which is now
redundant: `surplus ≤ unclaimedAt` always. One fewer term to remember, and the
composition is correct by construction rather than by a fourth bound someone has
to keep in step.

Terminating for the reason in §2.2: once `D` holds its target its deficit is 0,
and it cannot have become a source for `r` on the way there.

**`roomAt(D)` is a separate term from `D.deficit(r)` and neither implies the
other.** A deficit is measured in *demand for one resource*; room is measured in
*total occupancy across every resource*, which is what `StoreSite.capacity`
bounds. A depot holding **44** wood in 60 units of capacity, with a wheat demand
of 12 and no wheat, has a deficit of 12 and a room of 4 — the free floor takes
12 of the 60, so room is `60 − 12 − 44`. Sizing a load on the
deficit alone dispatches a full hauler into four units of space, and
`bankWithSpill` then forwards the excess **to the camp** — a silent teleport of
goods that had a hauler standing right there to walk them, which is precisely
what §2.9 and the plan's "goods are carried, never teleported" constraint
forbid, and which would flatter the depot exactly where §4.2 is measuring it.

`roomAt` is the reservation-aware occupancy `heldAt` already computes, corrected
per §2.7 — and for a **bounded** destination it stops at the free floor rather
than at the capacity:

```
roomAt(D) = max(0, D.capacity − storehouseFreeFloor − heldAt(D))   ← bounded
roomAt(camp) = unbounded
```

§2.2 has the reasoning. In short: additive demand can reach a bounded site's
whole capacity (five mills nearest one 60-unit depot demand 60), and staging to
`capacity − heldAt` would then fill it completely, leaving no surplus anywhere,
no drain able to fire, and the free floor unreachable by any rule — the §4.3
silting-up defect through the staging door. The floor is the room a depot keeps
for the short-hop collect deposits that are its outbound value; staging is its
inbound job and may not eat the other job's reserve.

**2. Drain (push), bounded → unbounded only.** Source `S` is a **bounded** site
whose free space has fallen below `BALANCE.storehouseFreeFloor`; destination is
the **camp**, and only the camp. The resource drained is the one with the
largest `S.surplus(r)` — **claimed-net stock above local demand** — with ties by
catalog order, mirroring `fullestResource`.

**Not "the resource it has no demand for", which an earlier draft said and which
reintroduced the exact defect this increment exists to remove.** A depot fills
from two directions, and only one of them is bounded by demand. Staging stops at
the deficit, so it cannot overfill; but *collect* banks a producer's output at
the nearest site with room, and nothing about that consults the site's demand at
all. A depot beside a farm and a mill therefore reaches 60 wheat against a wheat
demand of 12 in the ordinary course of play. Under the no-demand filter, wheat
is excluded because its demand is nonzero, no other resource is present to
drain, and the depot sits saturated for the rest of the game — silting up with
one chain's good and refusing every short-hop deposit, which is §4.3 of
increment 7 word for word, surviving the increment written to fix it.

Selecting on surplus removes the hole without weakening anything, because
`S.surplus(r) = max(0, unclaimedAt(S, r) − S.demand(r))` **already** refuses to
drain below demand. The 60-wheat depot has a surplus of 48 and drains six of it;
at 12 it has a surplus of 0 and is no longer a drain candidate for wheat. A
resource with no demand is simply the case where the whole claimed-net holding
is surplus — the old rule was a special case of the new one, and the special
case was the one that could not answer.

Termination is unaffected. A drain never takes a resource below the demand that
would stage it back, so the dead band of §2.4's closing paragraph still holds
and no drained unit can be pulled straight back in.

```
inHandAt(S)    = totalAt(S) + the loads RETURNING to S   ← heldAt without its intention term
occupancyAt(S) = inHandAt(S) − plannedOutAt(S)           ← every resource, not one
drainNeed(S)   = max(0, storehouseFreeFloor − (S.capacity − occupancyAt(S)))
movable        = min(haulerCapacity, S.surplus(r), drainNeed(S))
```

**`drainNeed` is both the trigger and the cap**, and it has to be, because
occupancy does not fall until a fetching hauler *arrives*. Without it every idle
hauler in the colony reads the same "below the floor" condition and dispatches
independently: a full 60-unit depot with a 12-unit floor and ten haulers
schedules **all 60 units** for removal instead of the 12 that restore its
headroom — emptying the pipeline stage the whole feature exists to build, and
then obliging staging to refill it. That is the goods-in-circles machine the
backlog Feature warns about, arriving through the push door rather than the pull
one. `unclaimedAt` does not prevent it: it stops two haulers claiming the *same*
units, not ten haulers claiming *all* the units.

With `plannedOutAt` folded in, the sequence self-limits: at 60/60 with a floor of
12, `drainNeed` is 12, the first hauler takes 6, the second takes 6, and the
third finds `drainNeed` at 0 and no candidate at all.

**`plannedOutAt(siteId)` is the resource-agnostic twin of `unclaimedAt`** —
headroom is measured across every resource, so a per-resource claim cannot bound
it. §2.7 specifies it; the two share one traversal.

**`occupancyAt` is not `totalAt`, and that distinction is the whole point of
calling this reservation-aware.** An earlier draft wrote `totalAt`, which counts
the removal a drain has scheduled but not the arrival a returning hauler has
already reserved — reservation-aware in one direction only. A depot at 54 of 60
with a six-unit fetch leaving and a six-unit collect return inbound then reads
occupancy 48, free space 12, and `drainNeed` 0; but once both land it is back at
54 with six units of headroom, below the floor. The drain waits a full trip for
a condition that was already determined at dispatch. A returning load is already
in a hauler's hands, so counting it needs no new claim: `60 − 6 = 54`, free 6,
`drainNeed` 6, and the drain goes out on the tick the answer is knowable.

**But `occupancyAt` is not `heldAt` either, and the two must not be collapsed
into one expression.** `heldAt` carries a second inbound term — a *fetching*
transfer's `plannedAmount` against the destination it reserved at dispatch — and
that term is an **intention**, not a load. The drain may not count it. A fetching
transfer can arrive with **zero**: `takeAt` returns what is actually at the
source, which `Stockpile.pay` spends camp-first for a build or a meal, and which
a demolition can remove outright. Worked: a depot physically holding 42, a
six-unit staging transfer *fetching* toward it and a six-unit collect
*returning* to it reads `heldAt` 54 — free space 6 against a floor of 12 — and a
six-unit drain goes out. If the fetch then takes nothing, the collect lands the
depot on 48, exactly the ceiling the floor reserves, and the drain has removed
six real units that never needed to move. **The drain answers for removals it
has scheduled and for loads already in a hauler's hands, not for intentions
aimed at it** — so its occupancy is `inHandAt`, and `Claims` carries that
accessor beside `heldAt` rather than changing what `heldAt` means.

**The drain's occupancy and staging's `roomAt` are therefore different
quantities, and the two similar-looking expressions are not a tidying
opportunity.** `roomAt` asks *how full might this site be* and must count every
intention aimed at it: without the fetching term, two staging transfers
dispatched on the same tick book the same headroom and the second one's overflow
is forwarded to the camp on arrival (the teleport `roomAt` exists to prevent).
Over-reserving room costs nothing — the worst case is a load not dispatched.
`occupancyAt` asks *what will certainly be there* and must count no intention at
all, because acting on one **removes real goods**. Same site, same tick, two
honest answers; anyone who folds them back into a single `heldAt` reintroduces
the overbooking bug on one side or the phantom drain on the other.

Coupling the drain to inbound staging in the other direction — *subtracting*
`inboundAt`, so a depot being staged into drains less — is also refused, and for
a separate reason: a depot simultaneously below its floor and being staged into
is a placement problem, and chasing inbound staging couples the two rules in the
one direction that could oscillate.

**No `roomAt` term here, and the absence is a consequence rather than an
omission:** a drain's destination is always the camp, the camp is unbounded, and
that is the same property §2.9's last resort and increment 7's
`nearestSiteWithRoom` both terminate on. It is worth stating because the two
formulas otherwise look inconsistent, and because the day a drain is allowed a
bounded destination is the day it needs the term — which is one more reason
§2.13 excludes depot → depot.

**Never camp → anywhere as a push, and never depot → depot as a push.** The
asymmetry is the termination proof: the camp has no free-space floor to breach
because it is unbounded, so it never pushes, so nothing the drain moves can come
back by the same rule. The only way a drained good returns to a depot is
staging, which requires a real consumer's demand — a different rule, a different
direction, and bounded by consumption.

**The free-space floor is what makes this a purposeful trip rather than
tidying.** A drain buys *room*, and room is worth walking for only when it is
scarce. Below the floor a depot cannot accept the short-hop deposits that are
its entire outbound value, so a hauler walking its dead stock to the camp is
restoring the pipeline stage. Above the floor there is nothing to buy and the
candidate does not exist. Whether the floor is set anywhere useful is a §4
question, not an assertion here.

**Both classes are additionally gated on `BALANCE.minTransferUnits`**, the
`minSupplyUnits` precedent: do not walk thirteen tiles to move three units.
Deliberately a **separate and larger** constant than `minSupplyUnits` — and that
argument is **staging's**, not transfer's as a whole: a supply trip serves a
building that is blocked right now and a *staging* transfer serves one that
might be blocked later, so the speculative job takes the stricter threshold. It
does not extend to a drain, which §2.6 now offers *ahead* of collect precisely
because something is waiting for it. The constant's size remains staging's
question; the exemption below is a question about which candidates the gate
applies to, and it does not move the number.

For staging there is **no "or it is everything the site holds" escape hatch**
here, unlike `worthMoving`: that clause exists so a lone unit at a depot can
still reach a consumer that would otherwise never see it, and staging keeps that
route open through the ordinary supply job. A tail too small to stage is not
stranded; it is simply left where it is, and supply can still fetch it.

**A drain is exempt from the threshold exactly when `S.surplus(r) <
minTransferUnits` *and* `S.surplus(r) < drainNeed(S)`, and the exemption is
necessary because a drain buys room rather than a
delivery.** "Supply can still fetch it" is staging's escape and is no escape
here: by construction a drainable holding sits *above* every nearby building's
demand, so no supply candidate exists for it either. What a refused drain
strands is not the units; it is the site's headroom, and no other rule restores
it.

Without the exemption a saturated site whose surplus is *split* across several
resources can never drain, because the drain picks **one** resource. Four
staffed consumers of four different inputs nearest one 60-unit depot make its
demand `4 × 12 = 48`; the depot holds 15 of each of the four (60 of 60); every
surplus is 3, none reaches 4, and the depot is saturated for the rest of the
game — it can neither accept a collect deposit nor stage anything. That is §4.3
of increment 7 word for word, arriving through a third door, and it became
reachable only when §2.6's reversal let a drain run on a busy chain at all.
§2.4's own argument for the demand cap is that "the drain can always restore
[the floor]"; here it could not.

**The exemption is *the site doing the best it can*, and the two clauses are the
two halves of that sentence.** `movable = min(haulerCapacity, S.surplus(r),
drainNeed(S))`, and the surplus is the only one of those three terms that is a
property of the *site* rather than of the hauler or of how far the site has
slipped. `S.surplus(r) < minTransferUnits` says the site cannot offer a
full-sized load of even its fullest resource; `S.surplus(r) < drainNeed(S)` says
that handing over all of it still would not restore the floor. Together they say
it is giving everything it can spare and the floor is *still* not restored —
which is the state where refusing means refusing forever.

**Neither of the other two terms earns the exemption, and each of them can bind
below the threshold**, so dropping either clause is a different rule.

`haulerCapacity` is **not** the flat `BALANCE.haulCarryCapacity`: it is that
constant scaled by the commute factor, so a hauler with no bed or a long commute
carries `round(6 × 0.5)` = **3**, below a threshold of 4. When that term binds,
the exemption deliberately does **not** fire: a small hauler is not a stuck site
— the site can still offer a full load, and the next hauler with a bed takes it.
Such a hauler simply makes no sub-threshold transfer of either class, exactly as
it makes no sub-threshold staging one.

`drainNeed(S)` binding means the trip **finishes the job**, so a sub-threshold
`movable` means the site is within `minTransferUnits − 1` of its floor and
therefore has at least `storehouseFreeFloor − minTransferUnits + 1` = **9** units
of *headroom* — more than a hauler carries. Headroom, **not necessarily free
space**: `drainNeed` is netted against `plannedOutAt`, so those nine can be zero
free units with nine already booked outbound, which is exactly the fourth hauler
at the split-surplus depot above. Either way nothing is silting up — the room is
there, or it is on its way out in trips already dispatched — and walking those
last one-to-three units to the camp is exactly the trivial trip the threshold
exists to refuse. Nor can that refusal become permanent: deposit into the site
and `drainNeed` rises past the surplus, at which point the exemption fires.

The trigger is still `drainNeed`, still netted against `plannedOutAt`, so a
reduced drain spends the headroom it books exactly as a full one does: in the
split-surplus depot above, three drains of 3 go out and the fourth hauler finds
`S.surplus(r) = drainNeed(S) = 3`, so the second clause is false and there is no
candidate.

Together, `minTransferUnits` on each side of the target gives the pull rule a
dead band `2 × minTransferUnits` wide. Oscillation inside it requires a consumer
to actually eat the difference, which is the only motion this feature exists to
enable.

### 2.5 Telling a deliberate transfer from a remainder dumped onward

This is the question the increment turns on, and the answer is that **the two
are not distinguishable at the site, and were never meant to be.**

Increment 7 already solved this shape one level down. When a load reaches a
site, a genuine delivery and an undelivered supply remainder are
indistinguishable — so `pickedUp` is a *field on the trip*, set at the moment
the difference is real, rather than a judgement each banking site makes for
itself (`bankLoad`'s own doc comment says exactly this). The same move applies
one level up.

> **A trip's destination is chosen at dispatch, reserved at dispatch, and only
> *rechecked* on arrival — never *discovered* there.** A remainder is a supply
> trip that failed and is falling back. A transfer is a trip that was ranked,
> claimed and reserved as a site → site move before a tile was walked.

Mechanically it is one clause. `remainderHome` today fires on
`!pickedUp && amount > 0 && source is live`; it gains `kind === 'supply'`:

```ts
if (trip.kind !== 'supply' || trip.pickedUp || trip.amount === 0 || source === undefined) return null;
```

That clause **is** the guarantee §2.13 of increment 7 was protecting. Routing a
remainder onward would turn camp wheat into depot stock without it ever being
consumed — motion that looks like progress and produces nothing. A transfer
moves goods because a consumer's demand or a depot's exhausted headroom made it
worth moving, and it says so in `kind` before it sets off.

**The clause needs its own fixture.** `docs/process/agent-workflow.md`'s third
recurring failure mode is exactly this shape: mutating the *whole* condition
stays red on the existing supply cases and proves nothing about the new clause.
The discriminating test is a transfer with `!pickedUp && amount > 0` and a live
source that must still **not** go back to its source.

**What is reconstructible.** Everything the rule reads is a component:
`kind`, `sourceSiteId`, `destSiteId`, `plannedAmount`, `amount`, `pickedUp`,
`staging`. A transfer's intent survives a tick boundary with nothing remembered,
which is what §2.6 of increment 7 demands of any intent a hauler holds.

`staging` is the one field this increment adds to `HaulTrip`, and no engine rule
reads it: it records **which of §2.4's two classes** a transfer was dispatched
as, for §4.2's instruments alone. It is here rather than derived because the
class is genuinely unrecoverable afterwards — the snapshot publishes neither
site id, and §2.2's decision to make the camp an ordinary site in the pull rule
means a depot → camp move is legitimately either class with the same source,
destination and resource. `pickedUp` is the precedent exactly: a field written
at the moment a difference is real, rather than a judgement reconstructed later
from state that no longer distinguishes the cases. `HaulTrip` is runtime-only,
so this changes nothing about §2.11.

**Where `destinationFor` is and is not consulted.** A transfer that fetches
successfully begins its return leg **straight to the destination it reserved at
dispatch**, without going through `destinationFor` at all — re-resolving would
discard the reservation the claim in §2.7 is built on. `destinationFor` is
reached by a transfer in exactly one branch: `depositArrival` finding its
destination gone (demolished, or moved mid-leg). There, with `remainderHome`
gated off, it resolves nearest-with-room from where the hauler stands, which is
correct: the goods are legitimately in motion and walking them all the way back
to the source is the worst available answer.

### 2.6 Dispatch: the two transfer classes sit on opposite sides of collect

`chooseJob` offers **supply, then drain, then collect, then staging.**

**This section shipped saying "supply, then collect, then transfer", and the
reversal below was forced by a measurement taken after that shipped rather than
predicted before it.** The original argument is kept in full, because it was
correct about staging and it is *why* staging did not move. It read:

> **Transfer last, and this placement is load-bearing:**
>
> > A transfer moves goods that nothing is currently waiting for. If a building
> > were waiting and servable, supply would have won this hauler; if a producer
> > were stalled, collect would have. **So a transfer can only ever consume
> > hauler-ticks that would otherwise have been idle, and it cannot starve
> > either existing kind.**
>
> That is the structural answer to §1.3's worry about a third competitor, and it
> is also what makes the feature measurable: `haulerIdleTicks` is the budget a
> transfer spends, and §4.3 asks whether the spend bought anything.

**That argument is sound, and it was falsified as a design by measurement rather
than by reasoning.** The safety property and the feature turned out to be one
knob. The budget the ordering leaves is **zero exactly where a depot
saturates**: a chain busy enough to fill a depot is busy enough that a collect
candidate exists on every dispatch tick, so `chooseJob` returned at the collect
branch and the drain candidates were never consulted. On the
corner chain (`cornerChain(3, [CORNER_DEPOT], ticks)`) that produced **zero
transfers and zero transfer hauler-ticks** at 600 / 1,200 / 2,400 ticks, with
the depot at 60 of 60 and an advantage over no depot of **26 / 24 / 28** planks
— increment 7's §4.3 flat one-off buffer, digit for digit, surviving the
increment written to remove it. Idle hauler-ticks were not the budget the
argument assumed: 120 / 190 / 331 of 1,800 / 3,600 / 7,200, and essentially all
of them were dispatch ticks rather than genuinely-nothing-to-do ticks. §4.2 has
the readings and the after figures.

The premise of the quoted argument is *"a transfer moves goods that nothing is
currently waiting for"*, and for exactly one candidate class it is false.

**Supply first** is unchanged and its reasoning is unchanged: a building waiting
on inputs produces nothing, while one with a full output buffer has already
produced and its goods are safe where they stand.

**Drain second, ahead of collect, and this is the reversal.** A drain candidate
exists only for a **bounded** site whose free space has fallen below
`BALANCE.storehouseFreeFloor` (§2.4). Something *is* waiting for that move. A
depot without room cannot take the short-hop collect deposits that are its
entire outbound value (§1.1), so every collect near it silently reverts to the
long walk to the camp — the leg the depot was placed to remove. The goods are
safe; the **pipeline stage** is blocked, and the drain is the only rule that
unblocks it.

**It cannot starve collect, and the bound is structural rather than a tuning.**
`drainNeed` is netted against `plannedOutAt`, so removals already scheduled
count against the floor being restored: at a floor of 12 and a hauler capacity
of 6, the first two haulers dispatched take drains and the third reads a
`drainNeed` of zero and finds no candidate at all. **The promotion is
extinguished by acting on it** — the same shape as §2.1's starving band, which
is why it is a floor rather than a rival priority, and why §1.3 can still call
the answer structural after the order changed. A reserved share of hauler-ticks
would have been the tuned answer, and §1.3 records why it was refused.

**Collect third** is unchanged in its reasoning, and now has one of its own
worth writing down: a full output buffer *does* stall a building — `outputFull`
is what `StageResult.stalledTicks` counts — so collection unblocks production
too, just less urgently than supply does. It gives way only to a drain, and only
to a drain from a site that is out of room.

**Staging last, and the quoted argument above is its argument, untouched.** A
staging load is one nobody is waiting for, ranked against a collect trip that
frees an output tray about to stall its producer *right now*. Nothing measured
here bears on staging's placement, and it did not move.

**The cost this does not deny: occupancy.** A hauler that begins a transfer is
unavailable for a supply job that arises on the next tick. Priority at dispatch
does not undo commitment during a trip, and no ordering could, because dispatch
cannot see a tick ahead. The order above bounds the cost to one trip per hauler
— a staging transfer is never *started* while real work exists, and a drain is
never started when there is no room to buy — and `minTransferUnits` keeps
trivial transfers from being started at all. Promoting the drain **spends this
cost more often than the shipped order did**, which is the honest price of the
reversal; §4.2's hauler-tick split, now with transfer as a fourth category,
measures whether it bit.

**Ranking within one candidate list, which is no longer where the two classes
are separated:**

1. **staging before drain** — a real consumer's demand outranks freeing room
2. `movable` descending
3. whole hauler → source → destination route ascending, measured from where the
   hauler is standing, exactly as `supplyRouteDistance` does
4. source site id
5. destination site id
6. resource, by catalog order

Selection is independent of candidate order — the same guarantee
`compareHaulCandidates` and `compareSupplyCandidates` give.

**Term 1 no longer decides anything at dispatch, and saying so is the point of
this paragraph.** The two classes are now separated at the *offer* level:
`chooseJob` asks `drainCandidates` and `stagingCandidates` at two different
priorities, and each list it ranks is single-class, so
`compareTransferCandidates`'s class term is constant across every comparison it
actually performs and terms 2–6 decide. The term is **not** removed. It remains
correct for any caller handed a mixed list, it is what makes the comparator a
total order over `TransferCandidate` rather than over one class of it, and it
stays unit-tested on a mixed list for that reason — but a reader tracing why one
transfer beat another in a running colony will not find the answer here, because
the class question was settled one level up. Terms 2–6 are the live path, and
term 6 is the one that keeps selection order-independent (below).

The split also changes what each half must cost, which §2.4 does not say and a
reader of the list would not guess. A drain is offered on **every** dispatch
tick, so it is asked cheaply — one `drainNeed` per site, zero for the camp and
for every bounded site above its floor, reaching the per-resource search only
for a site that is genuinely saturated. Staging is the quadratic half and is
still asked only when nothing else is left to do.

**Unlike `compareHaulCandidates` and `compareSupplyCandidates`, this chain
cannot end at an id, and the difference is not
stylistic.** `needOf` picks one resource per building, so a (building, site)
pair yields exactly one supply candidate and a site id fully distinguishes them.
`stagingCandidates` iterates resources: one source and one destination can
produce several candidates differing only in *what is being moved*, and with
equal `movable` those tie on class, route, source id and destination id
together. A chain ending at a destination id returns 0 for a real pair of
distinct candidates, and the winner becomes whichever the builder emitted first
— the array-order dependence this list exists to rule out, reintroduced by an
omission rather than by a decision. Catalog order is the tie-break
`fullestResource` and `shortestOf` already use for the same reason, and it is
available because the comparator lives engine-side rather than in
`src/shared/**`.

### 2.7 Claims: three that already work, one that must change, one that is new

Increment 7's claim invariant governs: claims are recomputed every tick from
live components, so any intent a hauler holds must be reconstructible from its
own components. Which of the existing claims survive contact with a third kind
is worth verifying rather than assuming — and one of them does not:

- **source stock** (`unclaimedAt`) counts `phase === 'fetching' && sourceSiteId === s && resource === r → plannedAmount`.
  A transfer's fetch leg is identical to a supply trip's. Works unchanged.
- **destination room** (`heldAt`) counts `phase === 'returning' && destSiteId === s → amount`,
  and **this one must change.** A transfer reserves its destination at *dispatch*
  (§2.5), but for the whole fetch leg it is `phase === 'fetching'` with
  `amount === 0`, so it contributes **nothing** to `heldAt` — the reservation the
  design rests on does not exist for the leg during which it matters most. Two
  transfers are then dispatched into the same headroom, and the second one's
  overflow is forwarded to the camp on arrival.

  `heldAtOf` gains a second term, gated on kind so supply is untouched:

  ```ts
  trip.kind === 'transfer' && trip.phase === 'fetching' && trip.destSiteId === s
    ? trip.plannedAmount : 0
  ```

  The two terms are disjoint — `plannedAmount` is zeroed the moment `takeAt`
  returns a real figure, and `amount` is zero until then. The kind gate matters:
  a *supply* trip's `destSiteId` is `CAMP_SITE_ID` throughout its fetch leg
  (`beginTrip` sets it and `turnForHome` resolves it for real only on the return),
  so an ungated clause would have every supply fetch reserving room at the camp.
  Harmless, because the camp is unbounded — and therefore exactly the kind of
  wrong-but-invisible that survives to become load-bearing.

  **`heldAt` and `inboundAt` do different jobs and neither substitutes for the
  other.** `inboundAt` is per-resource and bounds *demand*: do not over-satisfy a
  deficit. `heldAt` is resource-agnostic and bounds *room*: do not overbook a
  capacity. Two concurrent transfers of *different* resources into one depot are
  invisible to each other under `inboundAt` and must not be under `heldAt`.

  The same split exists on the outgoing side, and for the same reason:
  `unclaimedAt` is per-resource and bounds *stock*, while `plannedOutAt` is
  resource-agnostic and bounds *headroom*. **Four claims, four quantities, in two
  mirrored pairs** — inbound/outbound × per-resource/whole-site. A term sized
  against any one of them is bounded in that quantity alone.
- **output** counts haulers `fetching` or `outbound` with `targetId === buildingId`.
  A transfer's `targetId` is `null`, so it never matches any building. Works
  unchanged **by accident of the null**, which is precisely why it needs an
  explicit test rather than a comment: a transfer must never be counted as
  claiming a building's output buffer, and nothing but `null` currently says so.
- **input** counts supply trips against a building's in-tray room. A transfer
  targets no building. Works unchanged.

**Three new claims are required.**

```ts
inHandAt(siteId: number): number
// stockpile.totalAt(siteId) + sum over trips: phase === 'returning' && destSiteId === siteId
//   → amount. `heldAt` WITHOUT its fetching-transfer term — see §2.4

inboundAt(siteId: number, resource: ResourceId): number
// sum over trips: kind === 'transfer' && destSiteId === siteId && resource matches
//   → plannedAmount + (phase === 'returning' ? amount : 0)

plannedOutAt(siteId: number): number
// sum over trips: phase === 'fetching' && sourceSiteId === siteId → plannedAmount
//   ACROSS EVERY RESOURCE — this is `unclaimedAt` with the resource filter removed
```

`inHandAt` exists because the drain acts on its answer by removing real goods,
so it may count only what will certainly be at the site: physical stock and the
loads already in a hauler's hands. It is deliberately a *second* accessor rather
than a correction to `heldAt` — staging's `roomAt` needs the intention term that
this one drops, and §2.4 has the worked example of what each choice costs the
other rule.

`inboundAt` exists because a site's deficit must subtract transfers already
walking toward it, or every idle hauler in the colony transfers into the same
deficit on the same tick — the identical failure `Claims.input` exists to prevent
for buildings, and it takes the identical shape. Its two terms are disjoint by
construction: `plannedAmount` is zeroed the moment `takeAt` returns a real figure,
and `amount` is zero until then.

`plannedOutAt` exists because **headroom is measured across every resource and
`unclaimedAt` is per-resource**, so no per-resource claim can bound it. It is what
makes §2.4's `drainNeed` fall as drains are scheduled instead of staying pinned at
the value it had when the first hauler read it. It counts *all* fetching trips, not
only transfers: a supply hauler fetching from a depot removes exactly as much
occupancy as a transfer does, and a drain that ignored it would schedule removals
for room that is already on its way to being freed.

**The dispatch/arrival rule, applied to the new kind.** Every condition a
dispatch rests on must be either *reserved* or *rechecked* on arrival. This was
violated and fixed three separate times in increment 7, so the new job's
conditions are enumerated here rather than left to the implementation:

| dispatch condition | reserved or rechecked |
| --- | --- |
| source site is live and non-relocating | **rechecked** in `fetchArrival`, by tile — a storehouse that relocates keeps its id and moves |
| source holds the stock | **rechecked**: `takeAt` returns what it actually got, never the claimed figure. `Stockpile.pay` spends camp-first across every site, so a build ordered mid-walk can legitimately have spent it |
| no other hauler has claimed that stock | **reserved** via `unclaimedAt` |
| destination site is live | **rechecked** in `depositArrival`, by tile |
| destination has room | **reserved** via the corrected `heldAt`, **and rechecked** in `depositArrival` — the one condition that gets both, for the reason below |
| destination still has a deficit | **reserved** via `inboundAt`, and deliberately **not** rechecked — see below |
| source is still in surplus | **neither**, and deliberately — see below |

**Room is the one condition that is both reserved and rechecked**, which looks
like belt and braces and is not. Reservation covers every *hauler*-driven way a
site fills, because every one of them goes through a claim. It does not cover a
path that banks into a site with no trip behind it. Such a path can consume
reserved room, and a transfer arriving to insufficient space would then have its
overflow forwarded to the camp by `bankWithSpill`: free transport, from a hauler
who is standing right there and could walk it. So `depositArrival` treats
"cannot take the whole load" exactly as it already treats "destination is gone"
— `turnForHome`, and walk it (§2.9).

**No such path exists today, and the branch ships anyway.** An earlier draft of
this section named `spillTo` as the example, and that was wrong on the code:
`spillTo(toSiteId, fromSiteId)` has exactly one caller
(`handleDemolishBuilding`, placement-handlers.ts) and it always passes
`CAMP_SITE_ID`, so a demolished storehouse's contents can only ever land at the
unbounded camp — never in a bounded site whose room a transfer had reserved. The
correction matters twice over: it is the difference between a branch that is
*rare* and one that is currently *unreachable*, and the plan's fixture for this
case was written around the `spillTo` story and could not have exercised it.

**The recheck asks "did something else eat my room", not "does my load fit".**
`heldAt` counts every returning trip's `amount` against its `destSiteId`,
including the amount carried by the trip now arriving — so the arriving load is
already in the figure and adding it again double-counts. A four-unit transfer
reaching a 60-capacity depot that physically holds 56 reads `heldAt === 60`, and
a recheck of the form `heldAt + amount > capacity` compares 64 against 60 and
turns away an arrival whose room was reserved for it exactly. Every exact fit
would fail, quietly, with the loads ending up at the camp — the very number §4.2
exists to measure. `destinationFor` already documents this double-count and
releases the trip's own reservation before resolving; this recheck must either
do the same or compare `heldAt` against capacity directly.

The boundary needs a fixture of its own, at exact fit. A roomy arrival passes
under both forms and an overfull one fails under both, so neither of §2.9's
other cases can distinguish them. That is not a hypothetical concern here:
increment 7 shipped this identical off-by-one twice, in `nearestSiteWithRoom`
and in `remainderHome`'s inline copy of it, and both were caught by review
rather than by a test.

Unreachable is not a reason to drop it. Increment 7's own precedent governs:
`buildingArrival`'s demolished-target branch has no live caller either and is
kept as defense-in-depth, because a vanished or overfull destination must never
be able to silently drop or teleport a load. The test constructs the state
directly — banking into the destination while the transfer walks its return leg
— which is the only honest way to cover a branch with no reachable trigger, and
is stated as such rather than dressed up as a scenario.

The remaining two are the ones an implementation would be tempted to recheck, so
the reasoning is recorded rather than left implicit. If the deficit is filled or
the surplus consumed while a hauler walks, the load simply arrives at a site that
has room and is banked there. Conservation holds, no goods are lost, and the
worst outcome is one trip's worth of goods positioned somewhere marginally less
useful than intended. Cancelling instead would strand a load mid-map and require
a second resolution — more machinery for a strictly worse outcome.

**Two arrival branches must become kind-aware**, and each is a compound
condition needing per-clause fixtures:

- `fetchArrival` cancels when `targetRowOf` is undefined. A transfer's
  `targetId` is `null`, so it resolves to undefined **always** — the guard must
  admit a transfer before it reaches the building lookup, or every transfer
  cancels on arrival at its source.
- `fetchArrival` ends by starting an `outbound` leg to `row.position`. A
  transfer has no row; it starts a `returning` leg to its reserved destination.
  A transfer whose `takeAt` returned **0** (the source was emptied while it
  walked) has nothing to carry and no building to go on to, so it **cancels**
  where it stands — the one case with no counterpart in the supply path, where
  a zero fetch carries on and finishes as an ordinary collect run.

### 2.8 Flow accounting: a transfer is not a delivery

§2.4 of increment 7's flow table gains one row, and the discriminator it needs
already exists:

| moment | records |
| --- | --- |
| a transfer loads at its source (`takeAt`) | **nothing** — goods in transit, exactly as a supply fetch |
| a transfer banks at its destination | **nothing** (`refundAt`) — the colony already owned these goods, and recording a delivery would inflate `Delivered/t` for a trip that produced nothing |

A transfer's load never came out of an output buffer, so `pickedUp` is `false`
throughout and `bankLoad` already routes it to `refundAt`. **No code change is
required for this row**, which makes it exactly the kind of correctness that
rots silently — so it needs the discriminating test increment 7 wrote for the
remainder row: the same fixture twice, once banking a transferred load and once
banking a collected load of the same size at the same tick and site, with
`deliveredRate` required to move in the second and not the first.

`recordConsumed` must also not fire. It is called only from `unload`, which a
transfer never reaches, so this too holds by construction and needs the
assertion rather than the comment.

### 2.9 Conservation, and the paths that end a trip

Goods live in four places — camp, storehouse, input buffer, output buffer —
plus a hauler's hands. Every path that ends a trip must put a load *somewhere*.
The new kind's paths:

- **Destination demolished or moved mid-return.** `depositArrival` already
  detects this by tile and starts a fresh leg through `turnForHome` rather than
  banking remotely. With `remainderHome` gated off (§2.5), the transfer resolves
  nearest-with-room from where it stands. The camp is unbounded and cannot
  vanish, so the walk terminates.
- **Destination filled below the reservation.** Were a site to gain stock with
  no trip behind it, reserved room could be consumed. §2.7 records that no such
  path exists today — `spillTo`'s only caller always targets the camp — so this
  is defense-in-depth rather than a live case, and it is listed here because
  this is the list an implementer audits conservation against. Same branch, same
  answer: bank nothing, `turnForHome`, walk it.
  **Not** bank-what-fits-and-forward-the-rest — that is `bankWithSpill`'s
  behaviour and it teleports the remainder to the camp past a hauler standing at
  the depot. §2.7 has the full reasoning; it is repeated here because this is the
  list an implementer reads when auditing conservation, and a path that loses the
  *carrying* guarantee while preserving the *conservation* one is exactly the
  kind that passes a total-based sentinel.
- **Source demolished while fetching.** A demolished storehouse's contents spill
  to the camp (`spillTo`). The fetching hauler's tile recheck fails and it
  cancels empty-handed. No load, no loss.
- **Source emptied while fetching.** `takeAt` returns 0; the transfer cancels
  where it stands (§2.7). No load, no loss.
- **Hauler unassigned or dies mid-transfer.** `bankCarriedLoad` runs, resolving
  through `destinationFor` from `legPositionOf` — the forward-to-camp guarantee,
  correct here precisely because no hauler is left to walk it anywhere.
- **`handleDemolishBuilding` walks outbound trips by `targetId`.** A transfer's
  `targetId` is `null`, so it is untouched — correct, because a transfer names no
  building, but it must be tested rather than assumed for the same reason the
  output claim must be.

**Goods are carried, never teleported.** The forward-to-camp guarantee exists
only where no hauler remains to do the walking. A transfer is a hauler walking,
and no transfer may be implemented as a ledger adjustment.

**Assert on colony-wide totals, not on the field just written.** The
conservation sentinel in `tests/support/goods-audit.ts` is the instrument;
`conservationError` must be 0 in every scenario, transfers in flight included.

### 2.10 Snapshot and surfaces

- `HaulKind` widens to include `'transfer'` in `src/shared/haul.ts`; the
  snapshot's `haulKind` field follows for free.
- **`haulPickedUp` remains the direction marker**, not `haulKind` — increment
  7's §2.10 decision. A transfer carries goods that came from a store, so
  `pickedUp` is false and the marker draws it as carrying goods *in*, which is
  what it is doing.
- `haulTargetId` is `null` for a transfer. Any surface that resolves it to a
  building name must render a transfer without one; the dot's position comes
  from the frozen leg endpoints and is unaffected.
- The world legend and the **population view's per-colonist job column** gain a
  transfer label. No new colour or glyph is required — this is a job kind, not a
  new entity.

  **Not the selection panel**, which an earlier draft named: it takes a
  `buildingId` and reads only `snapshot.buildings`, so no hauler and no
  `haulKind` is ever in its scope, and giving it one would mean inventing a
  colonist-selection flow §2.13 has no room for. `PopulationView`'s `jobLabel`
  already renders `'Hauling'` per colonist with the worker row in hand, which is
  the surface where the distinction belongs and the only one that can identify
  *which* hauler is transferring — a legend row alone cannot.

### 2.11 Save

**No version bump.** `LATEST_SAVE_VERSION` stays 6, `SAVE_MIGRATIONS` and
`SAVE_GUARDS` are untouched. Trip state is not serialized: `buildSaveFromWorld`
banks a mid-trip hauler's `amount` into the camp stock and writes no trip, so a
transfer in flight at save time round-trips as camp stock and the hauler restarts
idle. Storehouse contents are already serialized off the building record (§2.9 of
increment 7) and are unchanged by this increment.

This is worth stating rather than leaving to be discovered, because "a new
`HaulKind`" reads like a save concern and is not one.

### 2.12 Testing and gates

Everything in `docs/process/agent-workflow.md` applies. Three rules bind
unusually hard here:

- **Every clause of a compound boolean needs its own fixture.** Increment 7's
  whole-branch review found ten defects of this one shape. This increment adds
  clauses to `remainderHome` (§2.5) and to `fetchArrival`'s cancel guard (§2.7),
  and both sit inside conditions whose other clauses are already gated — the
  exact configuration in which a whole-condition mutation looks like coverage.
- **Mutation-test every test**, confirming the mutation applied by diffing
  against a backup copy, never `git checkout`.
- **Balance claims must be measured, not asserted.** §4 is not optional
  narration; it is where this increment's central claim (§1.1) is either
  confirmed or contradicted.

The three gates that already exist stay: `conservationError === 0`, the
frozen-step sentinel at stress colony size, and `npm run check:all` green at the
end of every task. No baseline may be loosened and no suppression added.

**The 500-nonblank-line cap per `src/` file is a design constraint here.** Named
owners for the splits this increment forces are in the plan's Global
Constraints; `src/engine/world.ts` is at 489 and its named contingency remains
extracting `initialSave`.

### 2.13 Explicitly out of scope

- **Per-resource storehouse filters and priorities.** Excluded again, and now
  with a better reason than "not yet": under §2.2 a site's target *is* its
  filter, derived from what stands near it. An authored filter would be a second
  source of truth for one number, and the two would disagree the first time a
  player moved a building.
- **Depot → depot push.** Only demand-pull, or bounded → unbounded. §2.4 is the
  termination argument and a second push direction voids it.
- **Changing `inputBufferCap` (OBS-7-02).** Measured in §4.4, not moved. §1.2.
- **A hauler repositioning while idle, and any rule that weighs a trip's effect
  on the *next* fetch.** This is the named cause of the camp-fed-processor loss
  and the obvious place to intervene; it is left alone deliberately so §4.2
  measures the transfer mechanic rather than a compensator bolted beside it.
  If §4 shows the loss worsening, that is the finding and the successor.
- **The structural fix to OBS-7-05** (lifespan jitter derived from entity id).
  The issue's own cheap guard — run a with/without pair below the turnover
  horizon and require them identical — is in scope; changing `lifespanFor` is
  not, because it would redefine every existing population figure.

  **The turnover horizon is tick 3,000, not tick 5,700, and an earlier draft of
  this bullet had it wrong.** 5,700 is an *age* — `lifespanTicks − spreadTicks`,
  the youngest a colonist can die. Founders are spawned at
  `BALANCE.startingAgeTicks`, which is 2,500, so the elapsed-tick figures are:

  | event | age | tick in a `runScenario` run |
  | --- | ---: | ---: |
  | retirement (`retireTicks`) | 5,500 | **3,000** |
  | earliest old-age death (`lifespanTicks − spreadTicks`) | 5,700 | **3,200** |
  | latest old-age death (`lifespanTicks + spreadTicks`) | 7,300 | 4,800 |

  So **2,400 is the longest horizon a default-aged fixture can measure
  cleanly**, and it is comfortably clean. Conflating an age with an elapsed
  tick count is what put a 4,800-tick reading in §4.2 as "still below the first
  old-age death", where in fact every founder has retired and died by then.
- **OBS-7-03, OBS-7-04, OBS-7-06.** Carried forward untouched.
- **Construction as work.** Still the named successor from increment 7 §1.1,
  and still deferred: it needs a construction-site entity and a builder role,
  and this increment's §4.3 debt was the louder claim on the branch.
- **Roads, terrain and pathfinding.** Deferred a fourth time.
- **Carts, vehicles, or any haul capacity that is not a colonist.**
- **Multiple storehouse tiers.** Still one def.
- **A bounded camp.** Unbounded is what makes §2.4's push terminate and §2.9's
  last resort always succeed.
- **The tick-interval sync seam** (OBS-4-09's note). Deferred by increments 5,
  6 and 7; deferred again.

---

## 3. Acceptance criteria

1. **The far consumer is served.** The mill/bakery fixture that measures
   `bread === 0` today puts the far bakery above zero, and the fixture with the
   tiles exchanged still puts both above zero. Both bounds stay meaningful: a
   dispatcher that starved the second stage regardless of position puts both at
   zero, and a dispatcher that shared haulers puts both above it.
2. **The existing distance gradient is undisturbed.** Increment 5's sweep and
   increment 7's processor sweep produce the same figures, or the change is
   named and justified in §4.
3. **A depot's advantage grows with the horizon.** On the corner-chain fixture
   from §4.3, the absolute advantage of a depot over no depot at 2,400 ticks
   **exceeds** the advantage at 600 ticks. Flat is the increment's failure
   condition, and §4 records it as such if it happens.
4. **A depot beside a chain no longer saturates.** `storedAtEnd` is below
   `storehouseCapacity` at every horizon measured, and the depot's stock over
   the run shows turnover rather than a monotone climb to 60.
5. **A transfer never inflates `Delivered/t`.** The discriminating two-run test
   in §2.8 passes: the same load banked by a transfer moves nothing, and banked
   by a collect trip moves the rate.
6. **Conservation is exact.** `conservationError === 0` across every balance
   scenario, including with transfers in flight at the final tick.
7. **A transfer's intent is reconstructible.** No new state is remembered
   between ticks; dispatch remains a pure function of world state and
   independent of entity iteration order, verified by the existing
   candidate-order tests extended to transfer candidates.
8. **No circles.** A property test over randomised site stocks and demands: no
   sequence of legal transfers returns the ledger to a previously visited
   per-site distribution without a consumption event in between.
9. **Transfer's place in the dispatch order, as four bounds a dispatcher can
   fail.** The single "no idle hauler is dispatched on a transfer" form this
   criterion carried is now **false as written** — with two idle haulers and a
   saturated depot the second takes a drain while a stalled producer waits — and
   §2.6 records why the order changed. What replaces it is what is still true
   and still worth guarding:
   1. **Supply is never displaced.** With a supply candidate available, no idle
      hauler is dispatched on a transfer of either class, or on a collect.
   2. **Staging never outranks collect.** With a stalled producer and a staging
      candidate both available, the hauler collects.
   3. **A drain outranks collect only from a site below its free floor.** With a
      stalled producer available and a bounded site holding transferable surplus
      but **at or above** `storehouseFreeFloor` free space, the hauler collects —
      no drain candidate exists for a site with room.
   4. **A drain is capped at `drainNeed` and extinguished by being acted on.** At
      a floor of 12 and a hauler capacity of 6, a saturated bounded site yields a
      drain to each of the first two haulers dispatched on one tick and **no
      candidate at all** to the third, so a saturated depot never schedules the
      removal of more than the floor it is restoring.

   Each bound names a dispatcher that fails it, which is what keeps the criterion
   from being vacuous: 1 fails for any order that offers transfer or collect
   ahead of supply; 2 fails for one that offers staging before collect (and would
   have been the whole of this criterion's old content); 3 fails for one that
   promotes drains on a bare "this site is bounded" test instead of on the floor;
   4 fails for one whose drain trigger is read from physical occupancy rather
   than netted against `plannedOutAt` — the ten-idle-haulers test of §2.4, which
   that dispatcher fails by scheduling all 60 units of a full depot for removal.
10. **`npm run check:all` green**, no baseline loosened, no suppression added,
    every `src/` file at or under 500 nonblank lines.
11. **The save is untouched.** `LATEST_SAVE_VERSION === 6`, and a v6 save
    written before this increment loads and plays.

---

## 4. Balance values

Three new constants, all in `src/engine/content/balance.ts`, all with a starting
value and a §4 question attached. None is asserted here.

| constant | start | what it means | the question |
| --- | ---: | --- | --- |
| `siteStagingTarget` | 12 | units of one input a site aims to hold per consuming building it is nearest to | does staging more than an in-tray's worth pay, or just move the stall? |
| `minTransferUnits` | 4 | the smallest transfer worth walking | stricter than `minSupplyUnits: 2` because a transfer is speculative — is 4 the right premium? |
| `storehouseFreeFloor` | 12 | free space a bounded site tries to keep, below which it drains | is buying room worth a walk at all? |

### 4.1 The fairness floor, measured alone

Taken **before any transfer code exists in the tree**, so the two changes have
one variable each. Recorded in §4 as its own table.

- The mill/bakery fixture in both tile orders, at one, two and three haulers.
  Acceptance criterion 1.
- Increment 5's distance sweep and increment 7's processor sweep, unchanged
  fixtures. Acceptance criterion 2 — the counter-direction the §2.1 risk
  demands.
- The hauler-tick split, to ask whether the fix converted throughput into
  walking. The answer is split: trip *shape* is unchanged, trip *length* is not.

**The readings, and the tree really was clean.** Every figure below is
`BALANCE_REPORT=1 vitest run --project balance` on the report blocks in
`tests/engine/balance.test.ts`, run twice: at this branch's HEAD, and at
`be4566c` — the commit immediately before Task 1's floor, whose `src/` is
increment 7's end state with nothing changed. No `HaulKind` has a third member
in either tree, no transfer candidate exists, and no constant in
`src/engine/content/balance.ts` differs between the two runs. **The only
variable is the starvation term**, which is the entire reason this measurement
is a task of its own.

**1. The mill/bakery fixture, both tile orders, one to three haulers.**
OBS-7-01's table in its own columns. **Both** halves of each cell are runs taken
here — the "before" is the `be4566c` run, not a quotation — and every row the
issue published comes back digit for digit, which is a check on the instrument
as much as on the fix. The two three-hauler rows are new; the issue stopped at
two. The near-camp row is a re-take: the tiles the issue used are not recorded
anywhere, so (5,2) and (6,3) were chosen on its two *legs*, and at `be4566c`
they reproduce its row exactly, so it is comparable after all.

| layout | haulers | mill leg | bakery leg | flour | bread | mill wait% | bakery wait% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill near, bakery far | 1 | 6 | 8 | 254 → **115** | **0 → 108** | 43 → 74 | **100 → 79** |
| mill far, bakery near | 1 | 8 | 6 | 114 → 114 | 108 → 108 | 75 → 75 | 79 → 79 |
| mill near, bakery far | 2 | 6 | 8 | 313 → 260 | 150 → **189** | 28 → 42 | 71 → 63 |
| mill far, bakery near | 2 | 8 | 6 | 229 → 230 | 210 → 210 | 49 → 49 | 59 → 59 |
| mill near, bakery far | 3 | 6 | 8 | 335 → 335 | 319 → 319 | 22 → 22 | 35 → 35 |
| mill far, bakery near | 3 | 8 | 6 | 310 → 310 | 292 → 292 | 25 → 25 | 41 → 41 |
| both beside the camp | 1 | 2 | 3 | 397 → **259** | 144 → **250** | 2 → 42 | 72 → 51 |

**Acceptance criterion 1 is met, and by the bound that discriminates.** The far
bakery goes from 0 to 108 loaves, the exchanged layout still reads 108, and the
answer therefore no longer depends on which of the two the player put farther
out — 108 against 108 is a ratio of 1.00, where the pre-floor tree and a
dispatcher that starved the second stage regardless of layout both read 0.

**It behaves as a floor rather than as a rival priority, which §2.1 asserted and
this is the measurement of.** The layout that was already being served does not
move: `mill far, bakery near` differs by one unit of flour at two haulers and
not at all at one or three. And at **three haulers every figure in both layouts
is identical before and after** — with that much hauling nobody is ever starved,
so the new band is empty and the old ordering decides in full. What that
supports is a narrow claim, and it is the only one this fixture licenses: **the
floor is inert where the far consumer was already being served**, most strictly
at three haulers, where the fixture is identical pre and post. It is *not* inert
wherever nothing is starving — the near-camp row starves nobody and still moves
397 → 259 flour and 144 → 250 bread. **Read point 5 before quoting this
paragraph**; the two belong together.

**2. Acceptance criterion 2 held — digit for digit, both sweeps, every column.**
Increment 5's sixteen-row distance sweep and increment 7's sixteen-row processor
sweep were re-run on unchanged fixtures at both commits and the two outputs are
**byte-identical**, including `delivered`, `%ceiling`, `stalled%`, `waiting%`,
`idle`, `supplyReturns` and `loaded`. The readings, since this is the acceptance
criterion and prose is not a reading — seven of the sixteen raw rows and four of
the sixteen processor rows, in the report block's own columns. **Every cell is a
single figure rather than a pair because every cell is the same figure at
`be4566c` and at HEAD**, which is the whole content of the criterion:

| tile | leg | haulers | delivered | %ceiling | stalled% | idle |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| ( 3, 0) | 1 | 1 | 398 | 100 | 0 | 200 |
| ( 8, 4) | 4 | 1 | 394 | 99 | 0 | 67 |
| (15, 8) | 8 | 1 | 210 | 53 | 50 | 36 |
| (15, 8) | 8 | 2 | 390 | 98 | 0 | 141 |
| (23,15) | 13 | 1 | 132 | 33 | 68 | 23 |
| (23,15) | 13 | 2 | 258 | 65 | 38 | 54 |
| (23,15) | 13 | 3 | 384 | 96 | 0 | 94 |

| sawmill tile | leg | haulers | delivered | %ceiling | waiting% | idle | supplyReturns | loaded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ( 8, 4) | 4 | 1 | 354 | 89 | 21 | 60 | 60 | 59 |
| (15, 8) | 8 | 2 | 321 | 80 | 23 | 68 | 66 | 64 |
| (23,15) | 13 | 3 | 282 | 71 | 33 | 82 | 63 | 61 |
| (23,15) | 13 | 4 | 286 | 72 | 30 | 121 | 84 | 82 |

Both blocks also still agree with what increment 7 §4.1 recorded: set these rows
against its raw-producer and sawmill `%ceiling` tables at the same tiles and
hauler counts. **No figure moved, so nothing needs justifying here.** That the
raw sweep is unmoved is close to structural — a forester has no inputs, so it is
never a supply candidate at all — but the processor sweep is a genuine test of
the term and it is unmoved for a
reason worth stating: with one consuming building and one resource, every
candidate carries the same `starving` value, so the new term is constant across
the comparison and the route ordering below it decides exactly as before.

**3. The hauler-tick split: the *shape* of a trip did not change, but a trip got
longer.** Percentages are of working (non-idle) hauler ticks. A cell without an
arrow read the same at both commits.

| fixture | haulers | idle | working | collect% | supply% | fetch% | out% | return% | supply round trips | loaded% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill→bakery | 1 | 42 → 37 | 558 → 563 | 0 → 0 | 100 → 100 | 8 → 7 | 46 → 47 | 46 → 46 | 43 → **38** | 98 → 95 |
| mill→bakery | 2 | 80 → 77 | 1120 → 1123 | 0 → 0 | 100 → 100 | 7 → 7 | 47 → 47 | 46 → 46 | 78 → 77 | 96 → 96 |
| mill→bakery | 3 | 122 → 122 | 1678 → 1678 | 0 → 0 | 100 → 100 | 7 → 7 | 47 → 47 | 46 → 46 | 113 → 113 | 97 → 97 |
| mill→bakery | 4 | 175 → 175 | 2225 → 2225 | 0 → 0 | 100 → 100 | 7 → 7 | 47 → 47 | 46 → 46 | 151 → 151 | 98 → 98 |
| mill→bakery + depot | 2 | 91 | 1109 | 0 | 100 | 20 | 44 | 36 | 89 | 96 |
| mill→bakery + depot | 4 | 200 | 2200 | 1 | 99 | 17 | 45 | 39 | 165 | 98 |
| forester→sawmill | 1–4 | 23 / 52 / 87 / 126 | 577 / 1148 / 1713 / 2274 | 41–47 | 53–59 | 2 | 49–50 | 48 | 12 / 23 / 34 / 49 | 88–97 |

The forester row's counted columns are per hauler, one to four, slash-separated;
its percentage columns were recorded as the range across those four counts and
are given as one, because that is the reading that exists.

**Trip shape is flat.** Within the collect/supply/fetch/out/return split no
column moves by more than a single point in any row — `fetch%` 8 → 7 and `out%`
46 → 47 at one hauler are the whole of it — so the haulers do not walk a
different *kind* of trip. Working ticks move by +5 of 558 at one hauler and +3
of 1,123 at two, under 1%, and idle ticks fall rather than rise, so the fix is
not paid for out of slack either.

**Trip length is not flat, and this paragraph must not be quoted as if it
were.** Two columns say the trips got longer. `loaded%` drops 98 → 95 at one
hauler, the one figure in the split that moves by more than a point. And the
same 43 → 38 supply round trips, over slightly *more* working ticks, is
558/43 = **13.0 → 563/38 = 14.8 ticks per supply round trip, +14%** — which is
walking further per delivery. Point 4 is where that is priced; the two points
are about different quantities and neither cancels the other.

**4. What the floor costs, which is not nothing, and the mechanism is in the
row above.** The near mill loses badly wherever the floor fires: **254 → 115**
flour at one hauler (−55%), 313 → 260 at two (−17%), 397 → 259 beside the camp
(−35%). Gross units across both stages fall too — 254 → 223 at one hauler
(−12%), 463 → 449 at two (−3%), 541 → 509 beside the camp (−6%) — and the
hauler-tick split says why: the same working ticks complete **43 → 38** supply
round trips, **13.0 → 14.8 ticks each (+14%)**, because a trip to the leg-8
building is longer than a trip to the leg-6 one. The two sides of that match:
trips fall **11.6%** (38/43) against gross units **12.2%** (223/254), so the
loss is in the number of deliveries a fixed budget of walking buys, not in
anything getting slower per tick. Fewer, longer trips is the honest price of
serving the far consumer, and it is charged in the intermediate good.

**What it buys is the thing the colony eats.** Bread rises in every
configuration where the floor fires at all: 0 → 108, 150 → 189, 144 → 250. A
loaf costs one flour, so at one hauler 108 of the 115 flour the mill made was
baked, against 0 of 254 before — the intermediate stopped accumulating at a camp
whose only consumer of it was never supplied. **§4 records the trade rather than
netting it out**: a chain's last stage gains, its first stage loses, and the two
are not the same quantity.

**5. A finding the fixture was not built to look for: the floor's reach is wider
than the pathology it was written for.** The near-camp row starves nobody —
before the change the bakery there already made 144 loaves — and it carries
**the largest movement in a row where nothing was starved** (bread +74%, flour
−35%). Not the largest in the table: row 1's flour falls 55%, and row 1's bread
goes 0 → 108, which has no percentage at all. What makes this row the
interesting one is that it needed no fixing. The cause is one step below the new
term, in `movable` descending. The mill's wheat is seeded at
1,000,000, so its `movable` is the whole tray room (12) on every tick its tray
is empty; the bakery's flour is only ever what the mill has already delivered,
so its `movable` is usually smaller and it lost that comparison whether or not
it was starving. The starvation term sits *above* `movable` and so corrects a
bias that had nothing to do with distance. That is within §2.1's guarantee — the
promotion is still extinguished by one delivery — but it means the term is
better described as **"an empty tray outranks a full pipeline"** than as a
purely distance-related fairness floor, and any later reading that assumes the
term only fires on far buildings will be wrong. Task 11 should not attribute
this movement to transfer.

**6. Nothing was tuned to produce any of this — but one bound was loosened, and
by how much.** No constant moved and no fixture was adjusted. One test bound did
change: `Math.abs(far - near) < 10` became
`Math.min(far, near) / Math.max(far, near) > 0.85`. That is **weaker, not merely
differently shaped**. At the magnitude these runs measure, 108, the old absolute
bound is a ratio floor of about 108/118 ≈ **0.915**, so 0.85 admits a gap of
roughly **16** loaves where **10** was admitted — about six ratio points of
loosening.

Why that is an acceptable trade: the absolute form was passing at a measured
difference of **zero** (108 and 108) with nothing in the file recording whether
10 was generous or a hair's breadth, so it made no statement about its own
margin; and both failure modes this guard exists to catch score 0/108 = **0**,
nowhere near either threshold, so the widening costs no discrimination.

The calibration carries a caveat that belongs in the record. 0.85 sits just
below **0.90 and 0.92** — the spreads the same *fixture family* shows at two and
three haulers — but the assertion is taken at **one** hauler, where the measured
ratio is 1.00 and there is no spread to calibrate against, precisely because
both layouts agree exactly there. So the tolerance is justified at the level of
the family rather than of the fixture it guards. That is defensible and it is
stated: a later change that shifts throughput asymmetrically reds here with a
message that reads as a tolerance to re-take rather than as a balance
regression, and whoever re-takes it now knows where the number came from.

### 4.2 The transfer mechanic, measured

**How every figure below was taken.** Each block is one report block in
`tests/engine/balance.test.ts`, run on this branch's HEAD with the dispatch
order §2.6 now describes (supply → drain → collect → staging) in the tree:

```
BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the §4.2 horizon readings'
BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the camp-fed processor and OBS-7-02 readings'
BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the hauler-tick split'
BALANCE_REPORT=1 npx vitest run --project balance -t 'prints the constant sweep fixtures'
```

Every number in §4.2–§4.4 is a reading taken here. Where a figure recorded
earlier in this branch's history is quoted for comparison it is labelled as
such and is never mixed into a row of fresh readings.

**Nothing was tuned to produce any of it.** The three new constants were swept
(point 6) by editing `src/engine/content/balance.ts`, taking a reading, and
restoring the shipped value; `git diff src/engine/content/balance.ts` is empty
at the commit that carries this section. No dispatch formula was changed. Two
places where a change would have improved a number are recorded in point 7
rather than acted on.

**1. The headline: the corner chain with and without a depot.** A leg-11
forester (crew 3) feeding a leg-13 sawmill (crew 2), three haulers, the depot at
(21,14) between them. `planks` is stage 1's gross output, `wood` stage 0's;
`st0` is the forester's stalled ticks and `wt1` the sawmill's waiting-for-input
ticks, each as a percentage of the run; `full%` is the share of ticks the depot
sat at `storehouseCapacity`; `turnover` is whether its stock ever fell.

| ticks | age | depot | planks | wood | st0 | wt1 | stored | peak | full% | turnover | transfers | staging | drain | idle | deaths | retirements |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 600 | default | no | 204 | 222 | 69 | 53 | 0 | 0 | 0 | false | 0 | 0 | 0 | 87 | 0 | 0 |
| 600 | default | **yes** | **285** | 303 | 55 | 32 | 54 | 60 | 2 | **true** | 40 | 0 | 40 | 183 | 0 | 0 |
| 1,200 | default | no | 416 | 438 | 69 | 52 | 0 | 0 | 0 | false | 0 | 0 | 0 | 156 | 0 | 0 |
| 1,200 | default | **yes** | **542** | 561 | 59 | 31 | 51 | 60 | 2 | **true** | 75 | 0 | 75 | 306 | 0 | 0 |
| 2,400 | default | no | 840 | 864 | 70 | 51 | 0 | 0 | 0 | false | 0 | 0 | 0 | 298 | 0 | 0 |
| 2,400 | default | **yes** | **1062** | 1083 | 60 | 30 | 57 | 60 | 2 | **true** | 145 | 0 | 145 | 553 | 0 | 0 |
| 4,000 | young | no | 1402 | 1427 | 70 | 51 | 0 | 0 | 0 | false | 0 | 0 | 0 | 486 | 0 | 0 |
| 4,000 | young | **yes** | **1745** | 1765 | 61 | 30 | 57 | 60 | 2 | **true** | 236 | 0 | 236 | 878 | 0 | 0 |

The 4,000-tick pair takes `ageTicks: BALANCE.lifeBands.matureTicks` in **both**
arms, so it is comparable with itself and **not** comparable digit for digit
with the three rows above it — a younger crew is a differently-jittered crew as
well as a longer-serving one. The `deaths` and `retirements` columns are
asserted zero by the test, not computed from the horizon; §4.5 says why that
distinction was worth a column.

**The advantage, absolutely and as a percentage, because the two disagree.**

| ticks | age | no depot | depot | advantage | advantage % | advantage per tick |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 600 | default | 204 | 285 | **+81** | +39.7% | 0.135 |
| 1,200 | default | 416 | 542 | **+126** | +30.3% | 0.105 |
| 2,400 | default | 840 | 1062 | **+222** | +26.4% | 0.093 |
| 4,000 | young | 1402 | 1745 | **+343** | +24.5% | 0.086 |

**Acceptance criterion 3 is met: 222 at 2,400 exceeds 81 at 600, and the
advantage is monotone across all three clean horizons.** That is the criterion
as it is written, and it is worth being clear that the bar is a low one — *any*
sustained rate advantage grows in absolute terms with the horizon, so criterion
3 separates a one-off buffer from a rate and does nothing finer. The percentage
column moves the other way, 39.7 → 30.3 → 26.4, and read alone it would say the
mechanic is getting worse.

**Both readings are explained by one decomposition, and it is the strongest
statement this fixture supports.** Fit a line to the two clean end points
(600, 81) and (2,400, 222):

> advantage ≈ **34 planks** + **0.078 planks/tick** × ticks

It predicts 128 at 1,200 against 126 measured, and 347 at 4,000 against 343
measured — the latter across a workforce change the fit knows nothing about. So
the depot's advantage is a **one-off buffer term of about 34 planks** *plus* a
**sustained rate of 0.078 planks per tick**, which is 22% of the no-depot rate
of 0.350. The one-off is the thing increment 7 measured and recorded as flat
(26 / 24 / 28 planks at these same three horizons); it is still there and it has
not grown. **What this increment added is the rate**, and the rate is the whole
of the difference between this table and increment 7's.

The same decomposition is why the percentage falls. The no-depot arm's
throughput is flat at 0.340 / 0.347 / 0.350 planks per tick; the depot arm's
*decays* — 0.475 / 0.452 / 0.443 — because a fixed 34-plank head start is spread
over a longer run. A percentage of a growing base therefore shrinks while the
thing it measures grows, which is exactly the failure mode §4.3 of increment 7
recorded in the opposite direction, and it is why this section reports the
absolute column first.

**2. The mechanism, confirmed separately from the throughput it explains.**
§1.1 claims a depot works by unstalling a producer and unstarving a consumer.
Both halves are visible in the `st0` and `wt1` columns above, and they behave
differently:

- **The consumer side is the durable half.** The sawmill's
  `waitingForInputTicks` falls from 51–53% of the run to **30–32%**, and that
  relief is flat across every horizon — 32, 31, 30, 30.
- **The producer side fades.** The forester's `stalledTicks` falls from 69–70%
  to 55% at 600 ticks, but the improvement decays with the horizon: 55 → 59 →
  60 → 61. By 2,400 ticks the depot has bought the producer ten points of stall
  where at 600 it bought fourteen.

That is the same shape as the one-off-plus-rate decomposition seen from the
other side: the depot's spare room is a finite thing that is consumed early, and
what persists is the shorter leg it puts between the two buildings.

**3. Turnover, and acceptance criterion 4.** `storedAtEnd` is **54 / 51 / 57**
of a 60-unit capacity at the three clean horizons and 57 at the fourth; the
series is non-monotone at every horizon; and the depot sits at capacity for
**2% of ticks** at every horizon measured. **Acceptance criterion 4 is met as it
is written** — below capacity at every horizon, and turnover rather than a
monotone climb to 60.

The nuance belongs in the record rather than in a footnote: **the depot does
still reach 60.** Its peak is capacity in every with-depot run. What changed is
that it no longer *stays* there. The pre-fix reading on this same fixture was 60
of 60 with zero transfers and a series that never fell once — a depot that
filled once and stopped. "No longer saturates" is true in the sense criterion 4
operationalises (it does not sit full) and false in the sense the phrase
suggests (it does touch full).

**4. The camp-fed processor — the configuration that lost, and lost by more.**
§1.2 committed in advance to reporting this configuration including worse, and
§2.13 puts the obvious remedy out of scope. A camp-fed sawmill at (23,15), crew
2, the same 400-unit ceiling as the raw sweep's forester, with and without the
same corner depot beside it. `%ceil` is `delivered / ceiling`; the percentage
columns are of working (non-idle) hauler ticks.

| haulers | depot | made | delivered | %ceil | wait% | in-tray | idle | fetch% | collect% | supply% | transfer% | transfers | staging | drain | staging ticks | drain ticks | stored |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | no | 232 | 220 | 55 | 28 | 0 | 42 | 4 | 0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2 | yes | 228 | 218 | 55 | 45 | 0 | 43 | 18 | 0 | 98 | 2 | 1 | 1 | 0 | 24 | 0 | 59 |
| 3 | no | **294** | 282 | 71 | 33 | 0 | 82 | 4 | 0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 3 | yes | **243** | 231 | 58 | 40 | 10 | 70 | 26 | 0 | 84 | 16 | 13 | 2 | 11 | 37 | 244 | 48 |
| 4 | no | **296** | 286 | 72 | 30 | 3 | 121 | 4 | 0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| 4 | yes | **276** | 269 | 67 | 35 | 0 | 117 | 26 | 0 | 80 | 20 | 22 | 6 | 16 | 122 | 326 | 56 |

**A loss of 17% at three haulers (243 against 294) and 7% at four (276 against
296).** Increment 7 recorded 10% at three and a *gain* of 3% at four for this
placement; this is worse on both counts, and it is reported rather than
rescued.

**The fetch leg is the mechanism, and the arithmetic closes.** At three haulers
the fetch share of working ticks goes **4% → 26%**. In ticks: 4% of
1,800 − 82 = 1,718 working ticks is ≈ 69, against 26% of 1,800 − 70 = 1,730,
which is ≈ 450. The fetch leg therefore grew by about **381 hauler-ticks, and it
buys nothing but position**. The transfer bucket over the same run is 281 ticks
(37 staging + 244 drain), so roughly 100 of those 381 ticks are extra fetch on
trips that are not transfers at all — a hauler that banked a load at the depot
starts its next fetch there, and the seeded wood this building eats exists only
at the camp. Supply's share falls 100% → 84%, which on 1,730 working ticks is
about 265 ticks taken out of the only job that feeds this building.

**The dispatch order change does not reach this fixture, and the split says
why.** `collect%` is **0** in every row of this table, with and without a depot:
this is a single building whose planks ride home on the return leg of the supply
trips that feed it (§2.5's round trip), so there is no collect candidate here
for a drain to be promoted ahead of. The figures above are digit for digit the
ones recorded on this fixture when transfer first ran (Task 6: 243 against 294,
13 transfers, 281 transfer hauler-ticks) and the ones read before the dispatch
order changed. This section did not re-run the pre-fix tree, so what is claimed
is the agreement of the readings plus a mechanism that makes the agreement
expected — not a controlled before/after.

**5. The hauler-tick split, with the two transfer classes apart.** Percentages
of working (non-idle) hauler ticks. `drain%` and `stag%` are a partition of
`transfer%`, asserted equal to it in the suite because the two are read from
different places — the bucket off the snapshot's published leg, the classes off
`HaulTrip.staging` on the live trip.

| fixture | haulers | made0 | made1 | idle | working | collect% | supply% | transfer% | drain% | stag% | fetch% | out% | return% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill→bakery | 1 | 115 | 108 | 37 | 563 | 0 | 100 | 0 | 0 | 0 | 7 | 47 | 46 |
| mill→bakery | 2 | 260 | 189 | 77 | 1123 | 0 | 100 | 0 | 0 | 0 | 7 | 47 | 46 |
| mill→bakery | 4 | 394 | 375 | 175 | 2225 | 0 | 100 | 0 | 0 | 0 | 7 | 47 | 46 |
| mill→bakery + depot | 2 | 276 | 227 | 86 | 1114 | 0 | 99 | 1 | 0 | 1 | 20 | 44 | 36 |
| mill→bakery + depot | 4 | 379 | 360 | 186 | 2214 | 1 | 94 | 5 | 3 | 2 | 19 | 42 | 39 |
| forester→sawmill | 3 | 222 | 204 | 87 | 1713 | 46 | 54 | 0 | 0 | 0 | 2 | 50 | 48 |
| forester→sawmill + depot | 1 | 156 | 142 | 62 | 538 | 43 | 22 | 35 | 35 | 0 | 7 | 43 | 50 |
| forester→sawmill + depot | 2 | 228 | 210 | 108 | 1092 | 35 | 32 | 32 | 32 | 0 | 15 | 37 | 48 |
| forester→sawmill + depot | 3 | 303 | 285 | 183 | 1617 | 35 | 27 | 38 | 38 | 0 | 14 | 37 | 48 |
| forester→sawmill + depot | 4 | 347 | 323 | 251 | 2149 | 31 | 39 | 29 | 29 | 0 | 16 | 38 | 46 |
| staged chain | 4 | 305 | 192 | 274 | 2126 | 20 | 55 | 25 | 20 | 5 | 21 | 56 | 24 |

**§2.6's "paid for out of idle time" is now a claim about staging alone, and
this table is where the two halves separate.**

- **A drain is not paid out of idle time, and it is not supposed to be.** On the
  corner chain at three haulers, adding the depot moves `collect%` 46 → 35 and
  `supply%` 54 → 27 to fund a `drain%` of 38. Those ticks come straight out of
  the other two jobs, which is what offering a drain ahead of collect *means*.
  §2.6's original argument does not cover it and no longer claims to.
- **And the displacement is not what it costs, because the trips got shorter.**
  Total working ticks *fall* 1,713 → 1,617 while idle ticks more than double, 87
  → 183 — and output rises 204 → 285 planks. The depot buys 40% more planks for
  6% *less* walking. A hauler-tick split that had only looked for displacement
  would have reported this fixture as a cost.
- **Staging is small everywhere it is reachable, and is consistent with the idle
  claim.** `stag%` is **0 in every corner-chain row** — that fixture dispatches
  drains and nothing else — 1–2% on mill→bakery + depot, and 5% on the staged
  chain, the one fixture in the file that reaches both classes. On the staged
  chain that is 112 staging hauler-ticks against 274 idle ones, so staging fits
  inside the slack §2.6 said it could only spend. That is consistency, not
  proof: the instrument cannot say what those haulers would have done with the
  ticks.
- **A third fixture, printed because it is neither of the two stories above.**
  The mill→bakery chain with a depot at (13,8) gains at two haulers — 227 bread
  against 189, +20% — and loses slightly at four, 360 against 375, −4%. Its
  `fetch%` goes 7 → 19–20 exactly as the camp-fed processor's does, but it has a
  second consumer for the depot to sit between, so the shorter legs pay for the
  longer fetch at the hauler count where hauling is scarce and stop paying when
  it is not. Recorded rather than analysed: no assertion rests on it.
- **The occupancy cost Task A's review named is visible and is bounded.** A
  drain outranks an adjacent collect regardless of route distance, and on the
  corner chain drains take up to 38% of working ticks. Supply is never
  displaced by it — `supply%` stays non-zero in every row and the ordering puts
  supply first — and no fixture here measures worse *because of* drains: the
  configuration that does measure worse (the camp-fed processor) dispatches no
  collect trips at all, so its loss is the fetch leg and not the promotion.

**6. The three new constants, swept and not tuned.** Each was set, measured, and
restored. The no-depot arm is absent by construction: all three constants are
read only through a bounded site, so a run with no storehouse cannot see any of
them. `corner 600` / `corner 2400` are planks made with the depot; the no-depot
controls are 204 and 840 from point 1.

| constant | value | corner 600 | corner 2400 | staged chain (planks) | camp-fed far, 3 haulers | transfers on the corner chain |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `siteStagingTarget` | 6 | 285 | 1062 | 192 | 245 | 40 drain / 0 staging |
| `siteStagingTarget` | **12 (shipped)** | 285 | 1062 | 192 | 243 | 40 drain / 0 staging |
| `siteStagingTarget` | 24 | 285 | 1062 | 192 | 255 | 40 drain / 0 staging |
| `minTransferUnits` | 2 | 275 | **831** | 192 | 240 | 164 drain / 0 staging |
| `minTransferUnits` | **4 (shipped)** | 285 | **1062** | 192 | 243 | 145 drain / 0 staging |
| `minTransferUnits` | 8 | 230 | **868** | 192 | 258 | **0** |
| `storehouseFreeFloor` | 0 | 230 | 868 | 192 | 277 | **0** |
| `storehouseFreeFloor` | 6 | 230 | 863 | 192 | 249 | 1 |
| `storehouseFreeFloor` | **12 (shipped)** | 285 | 1062 | 192 | 243 | 145 |
| `storehouseFreeFloor` | 24 | **300** | **1157** | 192 | 243 | 195 |

**`siteStagingTarget` changes nothing that matters, and that is a finding.**
Across 6 / 12 / 24 the corner chain is identical in every column — it dispatches
no staging at all, so the constant is not read. The staged chain's staging
volume does move (4 → 6 → 6 dispatches, 68 → 112 → 112 hauler-ticks) and its
output **does not**: 192 units of stage-1 product at all three values. The only
figure the constant moves is the camp-fed processor's, 245 / 243 / 255, and even
its best value there is 13% below the no-depot control of 294. **The §4 question
"does staging more than an in-tray's worth pay, or does it just move the stall?"
is answered: on every fixture this repository can express, staging more does not
pay, because it does not move enough goods to matter.** The successor is named
in §4.3.

**`minTransferUnits` has a hard ceiling nobody had written down, and 4 is
already near it.** At 8 the mechanic is **entirely inert**: zero transfers on
every fixture, the depot pinned at 60 of 60, and the corner chain reading 230
and 868 — an advantage of +26 and +28 planks over no depot, which is increment
7's flat one-off buffer digit for digit and is the same signature the pre-fix
tree produced. The reason is arithmetic and is not tuning: a drain above the
site-doing-its-best exemption must clear `minTransferUnits`, and a hauler
carries `haulCarryCapacity` = 6, so **any value above 6 makes a full-sized
transfer impossible to dispatch**. At 2 the mechanic runs harder and does worse:
164 drains instead of 145, 2,560 drain hauler-ticks instead of 2,239, and 831
planks against 1,062 — a 22% loss against the shipped value and *below* the
inert tree's 868. Walking for tails costs more than the tails are worth. The
shipped 4 is the best of the three measured and is bracketed on both sides by
measurements rather than by argument.

**`storehouseFreeFloor` is the one constant that would improve the headline, and
it was not moved.** At 0 the mechanic is inert on the corner chain in exactly
the way `minTransferUnits: 8` is — no drains, depot at 60 of 60, 230 and 868 —
which answers §4's question "is buying room worth a walk at all?" with an
unambiguous yes: a floor of zero never notices a depot silting up, and the
silted depot is worth a flat one-off buffer and nothing more. At 6 it is still
effectively inert (one drain in 2,400 ticks). At the shipped 12 it is 285 and
1,062. **At 24 it is 300 and 1,157** — an advantage over no depot of +317 planks
at 2,400 against the shipped value's +222, a 43% larger advantage, at a cost of
3,041 drain hauler-ticks against 2,239 and a depot that ends at 39 of 60 rather
than 57. The camp-fed processor is unchanged at 24 (243, identical to shipped),
so the higher floor does not pay for its gain there.

**That reading is recorded and deliberately not acted on**, and point 7 says
why.

**7. Two things this measurement wanted to change, and did not.**

- **`storehouseFreeFloor: 24` measures better than the shipped 12 on the fixture
  the increment's headline is read off.** Retuning a constant inside the task
  that measures it is precisely what §1.2 and §4.3 exist to prevent: the number
  it would improve is the number being reported. It is also a one-fixture
  reading — the corner chain dispatches drains only, and the crossover sweep,
  the population curve and the stress colony have not been re-taken at 24 — so
  it is not yet a retune anyone could sign off. Named as work in §4.3, with the
  measurement above as its evidence.
- **P-22, `SiteLedger.room` not subtracting `plannedOutAt`.** Known, real,
  latency-only and self-correcting. It was deliberately not changed before this
  measurement, for the same reason: changing a dispatch formula immediately
  before the task that measures it destroys the measurement's meaning. Filed as
  an issue rather than fixed.

### 4.3 What was written down whichever way it went

§4.3 of increment 7 is the model, and both directions of it were exercised here.

**Where §1 was confirmed.** The depot's advantage is no longer flat. It
decomposes into a 34-plank one-off buffer — increment 7's finding, unchanged —
plus a sustained 0.078 planks per tick, and the rate is what §1.1 predicted and
what the whole increment turns on. Acceptance criteria 3 and 4 both pass. §1.1's
mechanism is confirmed on both halves, with the consumer-side relief durable and
the producer-side relief decaying.

**Where §1 was contradicted, and the contradiction stands.** The camp-fed
processor is **worse than increment 7 recorded**: a 17% loss at three haulers
against 10%, and a 7% loss at four where increment 7 measured a 3% gain. §1.2
committed in advance to reporting this configuration including worse; it is
reported, the fetch-leg share above is the evidence, and nothing was retuned to
soften it. §2.13 keeps the obvious remedy out of scope, so the successor is
named rather than attempted: **a transfer's route should be able to lengthen a
hauler's next fetch and be declined for it** — today a drain is chosen on the
site's need alone, and on this fixture 381 hauler-ticks of extra fetch is the
price.

**Where a constant would have flattered the result.** `storehouseFreeFloor: 24`
buys a 43% larger advantage on the headline fixture than the shipped 12. It was
measured, recorded in §4.2 point 6, and left alone. The successor is a retune
task that re-takes the crossover sweep, the population curve and the stress
colony at 24 before moving anything — the sweep here is one fixture family and
one hauler count, which is enough to raise the question and not enough to answer
it.

**Where a constant turned out not to matter.** `siteStagingTarget` moves no
fixture's output across 6 / 12 / 24. The honest description of the staging half
of this mechanic, as measured, is that **it is reachable, correct, and almost
never worth a trip**: 0 dispatches on the corner chain, 1–6 on the camp-fed
processor, 4–6 on the staged chain, against 145 drains on the corner chain
alone. The mechanic that pays is the drain. That is not what §1.1 predicted —
§1.1's argument for a depot is staging goods toward a consumer — and it is
recorded here as a second disagreement with §1 rather than as a detail.

### 4.4 OBS-7-02, answered by measurement

**The cap is still binding, so the issue carries forward with a second
measurement.** The fixture is the one that established it: a camp-fed sawmill at
(23,15), crew 2, whose in-tray admits at most
`inputBufferCap / haulCarryCapacity` = 2 loads in flight at once. The rows are in
§4.2 point 4.

- **Without a depot, the plateau is exactly where the issue left it.** 71% of
  ceiling at three haulers and 72% at four, with the fourth hauler buying one
  point and the building waiting on its in-tray 33% and 30% of ticks. Those are
  the issue's own figures, re-taken with transfer live in the tree.
- **With a depot beside it — the arrangement that was supposed to relieve the
  cap — it is worse, not better.** 58% at three haulers and 67% at four, with
  waiting *up* to 40% and 35%. Staging fires 2 times in 600 ticks at three
  haulers and 6 at four. The one mechanism that could feed this building without
  occupying its in-tray does not fire often enough to be measured against the
  cap at all.
- **And `siteStagingTarget` does not rescue it.** Swept to 24 the same
  configuration reads 255 against a no-depot control of 294 — still a 13% loss.

**`inputBufferCap` does not move, and this measurement does not license moving
it.** What it adds to the issue is a sharper statement of what a retune would
have to buy: the cap is not merely un-relieved by transfer, it is un-relieved by
the *only* mechanism the design had for relieving it, so raising the cap is once
again the only lever — and OBS-7-02's own three conditions for that
re-measurement (a two-consumer fixture, the in-tray's end-of-run occupancy, and
the population curve) are all still unmet by anything measured here. The issue
carries forward unchanged in severity with these readings attached.

### 4.5 What these instruments cannot do

The balance harness runs no births and no deaths inside the horizons above, so
OBS-7-05's lifespan-jitter confound cannot reach these readings. The cheap guard
(a with/without pair below the turnover horizon, required identical) is added so
that stays true rather than remaining a fact about the chosen horizons. Any
future reading at generation length inherits the confound and must say so.

**This sentence was false for one of the horizons it covered, which is the
argument for asserting it rather than stating it.** §4.2 originally called for a
4,800-tick run "still below the first old-age death"; founders spawn at age
2,500, retire at tick 3,000 and die between ticks 3,200 and 4,800, so that run
sat entirely inside the turnover it claimed to avoid — and because adding a
depot shifts colonist ids and `lifespanFor` derives jitter from the id, the
with/without pair would have differed for reasons having nothing to do with
transfer. §4.2 now requires each horizon to report deaths and retirements in
window and assert both are zero. A prose claim about a horizon is exactly the
kind of thing that is true when written and false after a constant moves.

**The assertion exists and every horizon in §4.2 passes it**, including the
4,000-tick one, which is clean only because both its arms take
`ageTicks: lifeBands.matureTicks`. The counter is not vacuous: the same harness
at 3,900 ticks and the default starting age reports retirements and deaths above
zero, and reports both back at zero when handed the same override.

**Four things §4.2's readings still cannot say.**

- **Whether staging is genuinely paid out of idle time.** The staged chain
  spends 112 staging hauler-ticks against 274 idle ones, which is consistent
  with §2.6's claim and is not a test of it — no instrument here can say what a
  hauler would have done with a tick it did not spend.
- **Whether the drain's occupancy bound is per-tick or global.** §2.6 argues at
  most `ceil(storehouseFreeFloor / capacity)` haulers are on drains per site at
  once, and the hauler-tick split can see the aggregate share (up to 38% of
  working ticks on the corner chain) but not the per-tick concurrency. No
  fixture pins it.
- **Whether `storehouseFreeFloor: 24` is better in a colony.** The sweep is one
  fixture family, one hauler count, and one depot. The crossover sweep, the
  12,000-tick population curve and the stress colony were not re-taken at any
  swept value.
- **Whether the camp-fed loss would survive a route-aware transfer.** §4.3 names
  that successor from the fetch-leg arithmetic, which is an attribution rather
  than an experiment: nothing here ran a dispatcher that declines a transfer for
  lengthening the next fetch.
