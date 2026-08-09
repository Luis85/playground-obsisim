# Spec: Increment 7 — Two-Way Haul & Storage

**Date:** 2026-08-09
**Status:** Approved scope, pre-implementation
**Predecessor:** Increment 6 (survival & population, PR #9 and #10, merged)

---

## 1. Why this increment exists

Increment 4's thesis was one sentence: *"Goods stop teleporting."* Half of it
shipped. A building banks what it makes into its own `OutputBuffer` and a
hauler carries it to the camp — but `ProductionSystem` still pays a recipe's
inputs straight out of the global `Stockpile`, from anywhere on the map, in the
tick the batch begins:

```ts
// src/engine/systems/production-system.ts
if (stockpile.pay(recipe.inputs)) { production.batchActive = true; production.progress = 0; }
```

So a bakery in the far corner walks its bread thirteen tiles home and its flour
arrives by teleport. Distance is priced on the way out and free on the way in.
That asymmetry is not a rounding error in the design — it is half the map game.
Increment 5 measured the outbound gradient precisely (one hauler serves a
building out to leg ~4, two by leg 8, three by leg 13) and every one of those
numbers describes a *raw* producer, because a raw producer is the only kind
whose real cost the simulation currently charges. A mill, a bakery, a sawmill
and a workshop are all sited today as though they were foresters.

This increment charges the other half, and then gives the player something to
do about it.

**The something matters more than the charge.** Input delivery on its own is
not a good change: it roughly doubles haul demand, makes every processing
building strictly worse the further it sits from the camp, and collapses the
answer to "where do I build?" back to *"on the camp band"* — which is exactly
the degenerate play increment 5 removed when it made free relocation cost
downtime. So the storehouse ships in the same increment: a second place goods
may be dropped and picked up, which turns a distant cluster from a mistake into
an investment. The two halves are one decision, and the backlog has always
named them together (`docs/requirements/Two-Way Haul and Storage Buildings.md`).

### 1.1 Product decisions taken for this increment

- **Inputs are physically delivered.** The alternative — an input-side
  efficiency multiplier scaled by distance — was rejected for the same reason
  increment 4 rejected an abstract haul-capacity coefficient: it leaves the
  cost invisible and the dots decorative.
- **One ledger, many places.** The colony's goods stay a single spendable
  total. A storehouse does not own a separate economy; it holds part of the
  same one, at a different tile. Meals, construction costs, refunds and
  `colonyWealth` are unchanged — goods still do not change *what they are*,
  only *where they must be fetched from*. This is Banished's model, and it is
  what keeps the change affordable: every existing reader of `Stockpile` keeps
  its exact API and meaning.
- **The camp is unbounded; a storehouse is not.** Making the camp finite would
  add a colony-wide failure mode (store full → haulers idle → buffers fill →
  everything stalls) that no surface currently explains and that the opening
  colony could hit by accident. A storehouse's cap is local and forgiving:
  overflow walks on to the camp.
- **A supply trip and a collect trip are the same trip.** A hauler that carries
  flour out to the bakery and comes back empty is doing half a job. The return
  leg loads whatever that building has waiting, so a well-sited pair of
  buildings gets two-way haulage out of one round trip. This is the mechanic
  the increment is actually named for.
- **Supply outranks collect.** A building with no inputs produces *nothing*; a
  building with a full output buffer has already produced, and its goods are
  safe where they stand. §2.6 states the rule and why the obvious deadlock it
  invites cannot happen.
- **Construction still teleports.** Materials for a new building are paid out
  of the ledger and the building appears finished. Making construction a job —
  a site, delivered planks, a builder role — is the natural successor and is
  named as such in §2.13, not folded in here. It would roughly double an
  increment that is already fifteen tasks, and it depends on exactly the
  input-delivery machinery this one builds.

### 1.2 What this makes harder, deliberately

Every processing building in the colony gets worse the day this ships, and that
is the point. A player whose mill, bakery and workshop are scattered across the
map will watch them sit `waitingForInput` while their haulers walk. The three
answers available are all real decisions: move the buildings together, staff
more haulers, or build a storehouse and pay 20 wood and 10 planks to shorten
every trip in that corner.

Increment 5's measured haul gradient is expected to move for input-consuming
buildings and to stay put for raw producers. §4 measures both rather than
assuming either: a raw producer's gradient shifting would mean this increment
broke something it did not intend to touch.

---

## 2. Requirements

### 2.1 Inputs come from the building, not the colony

- New component `InputBuffer`, structurally identical to `OutputBuffer`
  (amounts per resource, capped by `BALANCE.inputBufferCap` **counted as the
  total across all resources**, for the same reason the output cap is).
  It is attached to every building — a house or a storehouse simply never has
  anything put in it — so `buildingComponents` stays one list (OBS-4-02).
- `ProductionSystem` pays a batch's inputs out of the building's own
  `InputBuffer`. It no longer touches `Stockpile` at all, in either direction.
  Both payment sites move: the `startBatch` guard and the chain-into-the-next
  -batch call at the end of `completeBatches`.
- A staffed building with a recipe it cannot start for want of local inputs
  reports `waitingForInput`. **That state already exists in the union and is
  already published** — today it means "the batch is not active", which for a
  building drawing on a global store is almost always a transient tick. From
  this increment it is a real, persistent, explicable condition, and it is the
  headline diagnostic of the whole change.
- Buildings whose recipe has no inputs (gatherer's hut, farm, forester) are
  untouched by any of this: nothing is ever delivered to them, and they never
  wait. This is why §4 expects their gradient to be unchanged.
- **`inputBufferCap` is per building, not per resource.** No recipe today has
  more than one input; the total rule keeps the cap meaningful if one ever
  does, and matches the output side exactly.

### 2.2 Store sites: the camp stops being the only one

`src/shared/haul.ts` owns the spatial law of hauling and imports nothing. It
grows the concept the rest of this increment is built on:

- `CAMP_SITE_ID = 0`. Entity ids start at 1 (`IdCounter`'s default), so zero is
  permanently free and needs no reservation logic.
- `interface StoreSite { id: number; col: number; row: number; capacity: number | null }`
  — `null` capacity means unbounded, which is the camp and only the camp.
- `haulTicksBetween(from, to, tilesPerTick)`, the two-point generalisation of
  today's `haulTicks(col, row, tilesPerTick)`. `haulTicks` **stays**, defined as
  `haulTicksBetween(CAMP_TILE, tile, …)`, because the camp-relative distance is
  still what `haulerCapacity` and the commute charge measure from.
- `nearestSite(col, row, sites)` — fewest tiles, ties by site id, so the choice
  never depends on iteration order.
- `nearestSiteWithRoom(col, row, sites, heldAt)` — where a loaded hauler should
  unload. `heldAt(siteId)` supplies current occupancy **plus what haulers
  already headed there have reserved** (§2.6), which is what makes a load fit
  on arrival rather than needing a rule for when it does not; a site with
  `capacity: null` always has room, so the camp is the guaranteed fallback and
  this
  function can never return null while the camp exists.
- `nearestSiteHolding(col, row, sites, amountAt, resource)` — reserved for a
  future increment that lets a hauler walk to a source; **not used this
  increment** (§2.5's supply trips load where the hauler already stands) and
  therefore **not added**. Named here only so a reader knows the omission is
  deliberate.

The balance constants stay in `BALANCE` and arrive as arguments, preserving the
rule that `src/shared/**` imports nothing outside itself.

### 2.3 The storehouse

- A third kind of building. `BuildingDef` gains `storage: number` — units it
  can hold, `0` for everything that is not a store — beside `beds` and the
  nullable `recipe`.
- The content invariant generalises from increment 6's *"exactly one of a
  recipe or beds"* to **exactly one of: produces, shelters, stores**. A def
  with none of the three does nothing; a def with two is two mechanics in one
  entry. Pinned by a content test, as the two-way version already is.
- `storehouse`: cost `{ wood: 20, planks: 10 }`, `workerSlots: 0`,
  `recipe: null`, `beds: 0`, `storage: BALANCE.storehouseCapacity`. It needs
  no staff — it is a shed, not a job.
- `BuildingState` gains `'storing'`, mirroring `'housing'`: a building with no
  recipe has no batch to be `producing` or `unstaffed` about.
- The build palette derives from `BUILDING_IDS`, so the storehouse appears in
  the World tab and in the table's construct control with no extra wiring.
- **A relocating storehouse is not a store site.** It is in transit; there is
  nowhere to put anything. This mirrors `beds.total` excluding relocating
  houses (increment 6, `buildEntitySections`) and is the same principle:
  a building mid-move provides none of its service.

### 2.4 One ledger, held in several places

`Stockpile` keeps its name, its role as the colony's single ledger, and every
aggregate method it exposes today. What changes is that it stops being one map
and becomes a map per site.

- Internally: `Map<siteId, Map<ResourceId, number>>`, with `CAMP_SITE_ID`
  always present.
- **Unchanged, and this is the load-bearing property:** `get`, `total`,
  `canAfford`, `pay`, `take`, `refund`, `add`, `resetTickFlows`,
  `producedThisTick`, `consumedThisTick`. Every existing caller — hunger meals,
  construction cost, demolition refund, `colonyWealth`, `StatsSystem`, the
  save — keeps working against the aggregate with no edit. A goods total is a
  goods total wherever it stands.
- **Draw order for aggregate spends is camp first, then sites by ascending
  id.** Deterministic, and it drains the unbounded site before the bounded
  ones, which leaves local depots stocked for the haulers that need them.
- New site-aware API, used only by `HaulSystem`, the command handlers and the
  save:
  - `getAt(siteId, resource)` / `totalAt(siteId)`
  - `addAt(site: StoreSite, resource, amount)` — banks at that site, recording
    a delivery (`producedThisTick`) exactly as `add` does today.
  - `refundAt(site: StoreSite, resource, amount)` — banks without recording a
    delivery, for the same reason `refund` exists (`Stockpile.refund`'s own doc
    comment).
  - `takeAt(siteId, resource, amount): number` — takes up to `amount` from one
    site, returns what was taken.
  - `spillTo(siteId, from)` — move a whole site's contents into another.
    Used by demolition (§2.7) and by load-time clamping (§2.9).
  - `siteJSON(siteId)` — one site's contents, for serialization.

**Two invariants the banking calls enforce rather than document**, because
every way of getting them wrong loses goods silently:

1. **A bank never partially fails.** `addAt` and `refundAt` put what fits at
   the named site and **forward the shortfall to the camp**, which is
   unbounded and therefore cannot refuse. Callers get no remainder to
   mishandle. Without this, every caller has to remember the overflow rule —
   and the ones most likely to forget are the cancellation paths (§2.7), which
   run once in a rare branch and are exactly where a dropped remainder would go
   unnoticed.

   **This is a last resort, not the normal overflow path**, and the difference
   matters for measurement rather than for conservation. Goods forwarded this
   way move without anyone walking them — so a hauler arriving at a depot that
   filled while it walked must *carry on to the camp* (§2.5 step 3), not have
   its load teleported there while it stands at the depot. §1.1 promises
   overflow "walks on to the camp" and it should be literally true: §4 q2 asks
   whether a depot pays for itself, and free depot-to-camp transport would
   flatter exactly the number being measured. The forward-to-camp guarantee is
   what catches the cases where **no hauler remains to do the walking** — a
   cancelled trip, a stand-down, a load-time spill.
2. **No site entry may exist without a live building behind it.** This is why
   both take a resolved `StoreSite` rather than a bare id: a `StoreSite` can
   only come from `storeSitesOf` (§2.3), which returns only live, non-relocating
   stores, so banking into a demolished storehouse is not expressible. It has to
   be impossible rather than merely avoided, because a storehouse's contents are
   serialized *off its building record* (§2.9) — an orphaned site's goods would
   count in `colonyWealth`, be unreachable by any hauler, and then vanish at the
   next save with nothing reporting it. A save-time sentinel asserts the same
   invariant from the other end: every ledger site other than the camp names a
   building in the save.
- `toJSON()` returns the **camp's** contents, which is what makes the save
  migration in §2.9 a no-op for a v5 colony: a v5 stockpile *was* the camp.
  **`toJSON()` is therefore no longer sufficient to serialize the ledger** —
  §2.9 says what the live producer must write instead.

**Flow accounting, which this increment can quietly get wrong.** `Delivered/t`
is `producedThisTick` and `consumptionRate` is `consumedThisTick`; increment 4
already had to rename one column because it reported the wrong quantity
(OBS-4-06), and goods now move through four places. The rule, stated once:

| moment | records |
| --- | --- |
| a supply trip loads at a site (`takeAt`) | **nothing** — the goods are in transit, not gone. The store's total dips by what haulers carry, which is the same fiction a collect trip already runs in reverse: goods in hand are not in the store yet. |
| a supply load enters a building's `InputBuffer` | **consumption** — this is the moment they leave the colony's store for good, and it is the honest successor to the consumption `ProductionSystem` used to record when it paid a recipe from the stockpile. |
| a collect load is banked at a site (`addAt`) | **a delivery** — goods that were never in the ledger have arrived in it. Unchanged from increment 4. |
| an **undelivered supply remainder** is banked on the return (§2.5) | **nothing** (`refundAt`). The colony already owned these goods; recording a delivery would report banked inputs as newly delivered output and inflate `Delivered/t` for a round trip that produced nothing. |

The last row needs a discriminator the trip must carry, because by the time the
load reaches a site the two cases look identical: see `pickedUp` in §2.5.
- Saturation at `MAX_SAVED_COUNTER` stays, per site, for the reason it exists
  today: the engine must never write a save its own guard would reject.

### 2.5 Haul trips gain a kind, and a return leg that always earns

`HaulTrip` gains, all runtime-only like the rest of it:

- `kind: HaulKind`, where `HaulKind = 'collect' | 'supply'`;
- `atSiteId: number` — the site the hauler is currently standing at
  (`CAMP_SITE_ID` when idle at the camp, which is where every hauler starts and
  where every reloaded hauler stands, per §2.9);
- `pickedUp: boolean` — whether the load in hand came out of a building's
  output buffer. It is the discriminator §2.4's flow table needs: a hauler
  walking home holding six flour is either delivering goods the ledger has
  never counted (`pickedUp`, bank with `addAt`) or carrying back a supply
  remainder the colony already owned (bank with `refundAt`), and nothing about
  the load itself distinguishes them.

**A hauler's `atSiteId` may name a site that no longer exists.** A storehouse
can be demolished, or sent into transit by a move, while haulers are based at
it — and §2.3 removes a relocating store from the site list, so this is not
only a demolition case. `HaulSystem` therefore **re-resolves every hauler's
base against the live site list at the top of each tick**, falling back to
`CAMP_SITE_ID`, rather than each command handler repairing haulers it happens
to think of. One place, covering demolition, relocation and load together; the
alternative is a hauler stranded at a site that cannot be resolved to a tile,
which is either a null dereference or a hauler who never dispatches again.

**An idle hauler with nothing to do at its site walks to one where there is.**
This rule is not a refinement; without it the rest of §2.5 deadlocks. A supply
job loads at the hauler's own site, and a hauler only changes site by
*depositing* at one — so a depot holding wheat, beside a mill with no output to
collect, is unreachable by a hauler standing at the camp. Nothing ever sends
one there. The colony stalls permanently, and three ordinary events produce
exactly that state: **a reload** (§2.9 puts every hauler at the camp), **the
death or retirement of a depot's last based hauler**, and **the first hauler a
new depot ever needs**, since a freshly assigned hauler starts at the camp.

So `HaulPhase` gains `'rebasing'`: an idle hauler with no supply job **at its
own site** walks, empty-handed, to the site holding the best supply job it
could take from somewhere else — arriving with `atSiteId` set to it and
dispatching from there next tick. The walk is priced like any other; nothing
here is free.

**Rebasing outranks collect, and gating it on "no collect job anywhere" would
have been useless.** A colony almost always has *something* to collect — one
forester beside the camp produces forever — so a lowest-priority rebase would
never fire in any colony that was actually running, and the deadlock above
would survive in exactly the ordinary case while passing a test fixture built
without a producer. The reason it outranks collect is the same reason supply
does: a building with no inputs produces nothing at all, and if the only way to
feed it is to walk to where its inputs are, that walk is worth more than
another collect trip.

**What stops every hauler walking off at once is the claim, not the priority.**
A rebasing hauler claims the supply job it is travelling toward, exactly as an
outbound hauler claims the output it is going to fetch (§2.6), so a depot with
one job's worth of wheat attracts one hauler and the rest keep collecting. Any
tendency to thrash is a measurement, not an argument: §4 question 3 reports the
split of hauler-ticks across all three outcomes.

This is **not** storehouse-to-storehouse transfer (§2.13): no goods move, a
hauler does.

Given this, `atSiteId` still stays out of the save — but **not** because a
reloaded colony resumes identically, which is a claim this spec made in an
earlier draft and which is false. It cannot: §2.9 puts every hauler at the camp
with its cargo banked there, so a colony saved with a hauler based at a depot,
or mid-trip, comes back with different claims, different travel times and a
different distribution across sites, and rebasing reconstructs *a* sensible
base a few ticks later rather than the one it had.

Increment 4 could promise identical resumption because there was one site, so
"everyone at the camp" *was* the state. With several sites that promise is
gone, and what remains is worth stating precisely because it is what the tests
should check:

- **conservation is exact** — not one unit is created or destroyed across a
  save and load, wherever it was standing or being carried;
- **the colony converges** — every site's stock stays reachable, and work
  resumes within a bounded number of ticks rather than stalling;
- **determinism still holds within a run** — identical world state yields
  identical claims, which is the property job selection actually guarantees.

That is a weaker guarantee than increment 4's, honestly stated, and it is
bought in exchange for keeping `HaulTrip` out of the save format and its guards
entirely — increment 4's own trade, still worth making.

A trip is still exactly two legs, and the **return leg is identical for both
kinds**, which is what keeps this a small change to `HaulSystem` rather than a
second system:

1. **Idle at a site** → claim a job (§2.6). For a `supply` job, load
   `min(capacity, deficit, held at this site)` of the chosen resource out of
   `atSiteId` *now*, before walking. For a `collect` job, walk empty.
   Phase `outbound`, `ticksLeft = haulTicksBetween(site tile, building tile)`.
2. **Outbound** → decrement. On arrival:
   - a `supply` load is put into the building's `InputBuffer` (whatever fits,
     recording consumption for what lands; the remainder stays in hand and
     rides home with `pickedUp` still false, so no unit is ever destroyed and
     none is later miscounted as a delivery);
   - **then, for both kinds**, a hauler with empty hands loads from that
     building's `OutputBuffer` — `fullestResource`, up to its capacity — and
     sets `pickedUp`. A supply trip that finds nothing waiting returns empty,
     which is the honest cost of a one-directional errand.
   - Phase `returning`, destination `nearestSiteWithRoom(building tile, …)`,
     `ticksLeft` computed from the building's **current** tile (a building
     moved mid-trip charges the walk actually walked — the existing rule), and
     `legTicks` / `pickupCol` / `pickupRow` frozen here exactly as today
     (OBS-5-01).
3. **Returning** → decrement. **The load fits on arrival by construction**:
   choosing `destSiteId` reserved room for it (§2.6's claim invariant), and no
   other hauler can take reserved space, so the ordinary case is simply bank,
   set `atSiteId`, go `idle`. Reservation is what makes this the ordinary case
   — an earlier draft checked for room only at pickup, so two haulers could
   both aim at a depot with room for one, and a *partially* full depot was
   worse still: the load would split, part banked and part forwarded to the
   camp without anyone walking it.

   **The leg's destination tile is frozen when the leg begins**, in
   `destCol`/`destRow`, exactly as `pickupCol`/`pickupRow` freeze its origin
   and for exactly the reason OBS-5-01 established: a leg must be measured
   against the journey the simulation is actually running, not against a tile
   re-read from a building that has since moved. `destSiteId` alone cannot say
   where the hauler physically arrives — if the destination storehouse
   relocates mid-leg, the same id resolves to a *new* tile and the hauler would
   deposit at a place it never walked to; if it is demolished, the id resolves
   to nothing and there is no origin left to price the onward leg from. The
   frozen tile answers both, and it is also what `haulSiteCol`/`haulSiteRow`
   (§2.10) should publish for a returning hauler, so the drawn walk and the
   simulated one stay the same walk.

   **The one case reservation cannot cover is a destination that stops
   existing** — demolished, or sent into transit by a move. Then the hauler
   re-resolves and **walks on**: a fresh `returning` leg from the frozen tile
   it has arrived at to the newly resolved site, carrying its whole load the
   entire way. The camp is unbounded and cannot vanish, so the walk
   terminates.

A hauler therefore migrates naturally to wherever the work is: deposit at a
remote storehouse and you are standing at it next tick, ready to supply the
buildings around it from what you just dropped off.

**A hauler's commute is charged from home to `atSiteId`**, not to the camp.
`haulerCapacity(homeTile)` becomes `haulerCapacity(homeTile, siteTile)`: the
distance term is the walk from bed to base, which is what it always modelled —
increment 6 measured it to `CAMP_TILE` because the camp was the only base there
was. A colonist housed beside a remote depot and based there is a good hauler;
one housed at the camp and based at the depot is not. Every site that reserves
or takes capacity must keep calling the same function with the same arguments
(the reservation/load mismatch `haulerCapacity`'s doc comment warns about is
now two arguments wide instead of one).

### 2.6 Which job, and in what order

Two candidate sets are built each tick from live components, and both are pure
functions of world state — no memory between ticks, no iteration-order
dependence, tie-breaks ending at the building id.

**Collect candidates** — unchanged from increment 4 except for who counts as a
claimant (below): buildings with unclaimed buffered output, ordered by
`compareHaulCandidates` (most claimable first, then nearest, then lowest id).

**Supply candidates** — a building qualifies when all of these hold:

- its recipe has inputs, it is not relocating, and **at least one colonist is
  assigned to it**. The staffing condition is not an optimisation: goods in an
  `InputBuffer` are out of the spendable ledger, and §2.7 destroys an input
  buffer on demolition — so without it, supply-first dispatch would truck
  scarce wheat and planks into buildings that cannot use them and cannot give
  them back. A colony short of adults would watch its stock drain into an
  unstaffed mill with no way to recover it but staffing the mill. Deliveries
  are gated, not the goods already inside: a building whose crew died keeps
  what it holds and consumes it if it is ever staffed again;
- the resource it is shortest of (ties by catalog order, mirroring
  `OutputBuffer.fullestResource`) is held at **this hauler's** site;
- `movable = min(capacity, inputBufferCap − inputBuffered, held at this site)`
  is at least `BALANCE.minSupplyUnits`, **or is everything that site holds of
  that resource**. Without the second clause the threshold strands the tail:
  every recipe today consumes one unit per batch, so a depot holding exactly
  one flour can feed a bakery but can never produce a candidate, and with no
  store-to-store transfer that unit sits there for the rest of the game while
  the ledger and the UI keep counting it. The threshold exists to stop a
  thirteen-tile walk for a *top-up*, not to make the last of something
  unusable. (It is only unusable to production — `pay` still spends it on
  construction and meals, since that draws across all sites — which is why this
  is a wart rather than a hole, and why one clause is the right size of fix.)

Ordered by `movable` descending, then nearest to the hauler's site, then lowest
building id.

**The dispatch order is supply from here, then rebase toward supply elsewhere,
then collect.** A building waiting on inputs produces nothing at all, while a
building with a full output buffer has already produced and its goods are
standing safe where they were made — so supply outranks collect, and the walk
that makes a supply job possible inherits that ranking rather than sitting
below the work it enables (§2.5).

The obvious objection to supply-first is deadlock — every hauler supplying,
nobody collecting, the ledger drained — and it cannot happen, for a structural
reason worth stating rather than hoping for: a supply job requires stock *at
the hauler's own site*, and only collection puts it there. As the ledger
empties, supply candidates disappear and collection resumes on its own. §4
question 3 measures that rather than trusting this paragraph.

**The claim invariant, which two earlier drafts of this section broke in the
same way.** Claims are recomputed every tick from live components — that is
what makes dispatch a pure function of world state and keeps it independent of
entity order. It follows that **any intent a hauler holds must be
reconstructible from that hauler's own components at the start of the next
tick.** An intent recorded nowhere is not a claim, however firmly the prose
says it is. Two consequences, each of which was a real defect before it was a
rule:

- **A rebasing hauler keeps the building id it is travelling to serve** in
  `targetId`. An earlier draft set it to `null` — reasonable-looking, since a
  rebase has no building destination — and thereby made the supply claim
  unreconstructible, so every idle hauler in the colony would rebase toward the
  same depot on the same tick. That is precisely the fleet-wide thrash the
  claim was introduced to prevent, asserted in prose and absent from the state.
- **A loaded hauler's destination reserves room there** from the moment it is
  chosen. `destSiteId` is that reservation, and `nearestSiteWithRoom` counts
  reservations against a site's capacity exactly as `claimableAt` counts
  claims against a building's buffer. This is what makes the load *fit* on
  arrival rather than needing a rule for what to do when it does not (§2.5).

  **Reserved room is reserved against everyone, not only against the next
  dispatch.** Every bank at a bounded site — including a cancellation's
  `refundAt`, which has no hauler behind it — must respect outstanding
  reservations, or a refund lands in space someone else is walking towards and
  the promise above quietly stops holding. A refund that cannot fit takes the
  last-resort route to the camp (§2.4), which is correct precisely because
  there is no hauler left to walk it anywhere.

**Claims count both kinds.** `buildClaimMap` today counts outbound haulers
against the output they will take. A supply hauler now also loads output on
arrival (§2.5 step 2), so it claims too — otherwise two haulers would be sent
at the same six units. The mirror is also needed: a building already being
supplied has its pending delivery subtracted from its deficit, or every idle
hauler in the colony leaves for the same empty mill on the same tick.

### 2.7 Goods, and the buildings that hold them

Three interactions, each of which has a precedent this increment follows rather
than re-litigates:

- **Demolishing a producer.** Its `OutputBuffer` dies with it, as decided in
  OBS-4-07, and its `InputBuffer` dies with it for the same reason: neither is
  in the ledger, and a building left full of goods should be expensive to
  bulldoze. The notice names both losses.
- **Demolishing a storehouse.** Its contents **move to the camp**, and the
  notice says so. This is the opposite call from the buffers above, and the
  distinction is exactly OBS-4-07's own reasoning applied to a different fact:
  buffered goods are *not yet* colony wealth, while a storehouse's contents
  **are** — they are in the ledger, they count in `colonyWealth`, the player has
  already banked them. Destroying them would drop a published wealth figure
  under a notice reading "cost refunded". `spillTo`, using `refundAt`, so the
  move does not inflate `Delivered/t` for goods nobody hauled.
- **Moving a storehouse.** Contents travel with it: they are inside. The site's
  tile changes, and the site stops existing (§2.3) until the relocation
  countdown expires. Any hauler `outbound` to it retargets exactly as today;
  any hauler `returning` **to** it re-resolves its destination on arrival
  rather than at dispatch, so a storehouse that went into transit mid-leg sends
  the load on to the camp instead of into a hole.
- **A cancelled supply trip is carrying goods**, unlike every cancellation
  increment 4 had to handle. Four paths end a trip that may hold an undelivered
  load, and `HaulTrip.reset()` clears it: demolishing the target, unassigning
  the hauler, arriving at a building that is already gone, and — the one that
  is easiest to miss because it lives in another system entirely —
  **`standDown` in `PopulationSystem`**, when a hauler retires, starves or
  dies mid-trip. That last one runs *before* `HaulSystem` in the tick and banks
  with `stockpile.add` today, which records a delivery. Correct while every
  carried load was collected output; wrong the moment a hauler can be carrying
  goods the colony already owned. All four route through `pickedUp` (§2.4):
  `addAt` for collected output, `refundAt` for a supply load. **Which site**
  a refund goes back to is where this gets sharp: the source
  storehouse may have filled while the hauler was walking, or may itself have
  been demolished earlier in the same drain. Neither loses a unit, because
  §2.4's invariants make the load either land at the resolved site or fall
  through to the camp, and make "bank into a storehouse that no longer exists"
  inexpressible.
- **Retargeting an outbound hauler when its building moves** must recompute the
  leg from **the hauler's own base**, not from the camp. `handleMoveBuilding`
  today calls `haulTicks(to.col, to.row, …)`, which is camp-relative and was
  correct while the camp was the only origin; once §2.5 dispatches from
  `atSiteId`, a hauler based at a remote depot would be charged a camp-to-target
  walk it is not walking. That is precisely the OBS-5-01 failure — a leg length
  disagreeing with the leg the sim is actually running — and it desyncs the
  drawn dot the same way, since the renderer derives its position from
  `legTicks`. Use `haulTicksBetween(base tile, new tile, …)`.
- **Haulers based at a store that stops being one.** Both cases above strand
  every hauler whose `atSiteId` names that store — and so does a load, where
  `atSiteId` is not persisted at all. This is handled once, in `HaulSystem`,
  by re-resolving a hauler's base against the live site list each tick (§2.5),
  rather than in the two command handlers that happen to cause it. A handler-
  side repair would have to be written twice, would still miss the relocation
  case (nothing is demolished there), and would leave the invariant depending
  on every future caller remembering it.

### 2.8 System order

Unchanged: `CommandSystem → HungerSystem → PopulationSystem → EfficiencySystem
→ ProductionSystem → HaulSystem → StatsSystem → SnapshotSystem`.

One consequence, stated rather than discovered: `HaulSystem` runs *after*
`ProductionSystem`, so **an input delivered on tick t is consumed at t+1**.
This is the exact mirror of output being claimable on the tick it is made, and
it costs one tick per delivery, not per batch. Reordering to close that tick
would put haulage before production and cost a tick on the output side instead
— the same tick, moved. It stays where it is.

### 2.9 Save v6

- `SavedBuilding` gains two fields, both **always present and `{}` when
  empty**, which is the uniform shape that keeps each guard a single
  unconditional check (the doctrine `buffer` established in v3):
  - `inputBuffer: Partial<Record<ResourceId, number>>`
  - `stored: Partial<Record<ResourceId, number>>` — a storehouse's share of the
    ledger; `{}` for everything else.
- `SaveGameV6.stockpile` is **the camp's contents**. For a v5 colony that is
  precisely what its stockpile already was, which is what makes the migration
  trivial.
- **The live producer must be changed with the format, and this is the trap of
  the whole task.** `buildSaveFromWorld` (`src/engine/game-engine.ts`) writes
  `Stockpile.toJSON()` — now camp-only — and maps buildings through
  `savedBuildingOf`, which knows nothing about either new field. Adding two
  required fields to `SavedBuilding` is satisfied by writing `{}` for both,
  which typechecks, migrates, round-trips and passes every guard test while
  **silently deleting every storehouse's contents and every input buffer on
  save**. The producer must write `siteJSON(building id)` and the input buffer,
  and the round-trip test must use a colony with goods in *both* the camp and a
  storehouse — a fixture whose camp is empty proves nothing here.
- **And the same trap on the reading side.** `buildInitialSnapshot`
  (`src/engine/initial-snapshot.ts`) derives stock, wealth, meals per head and
  therefore affordability from `save.stockpile` alone — which this increment
  redefines as camp-only. Its own doc comment says why that matters: *"a
  restored engine starts PAUSED — so this is not a placeholder that a tick will
  shortly correct, it is what the player looks at for as long as they leave the
  game paused."* A colony reopened with its planks in a depot would show a
  wealth figure short of the truth, a meals-per-head the birth gate does not
  agree with, and a build palette refusing buildings it can afford, until the
  player unpauses. The initial snapshot must aggregate the camp with every
  building's restored `stored` map, and clamp input buffers the way
  `buildingFactsOfSaved` already clamps output buffers — the seeded snapshot
  must equal what the spawned world holds, which is the invariant
  `clampedProgress`, `clampedBuffer` and `clampedRelocation` all exist to keep.
- `LATEST_SAVE_VERSION` becomes 6, with the same self-policing literal type:
  `SaveGameV6.version` being the literal `6` is what makes the bump fail
  typecheck at both producers until the type moves with it.
- **Migration v5→v6:** every building gains `inputBuffer: {}` and
  `stored: {}`. Nothing else moves. A v5 colony was exactly a v6 colony with no
  storehouses and every input already paid.
- **Clamped at load, never rejected**, per the standing rule that values
  coupled to tunable balance numbers are clamped so retuning down never orphans
  a valid save:
  - an `inputBuffer` over `inputBufferCap` is trimmed;
  - `stored` over the def's `storage` — including *any* `stored` on a building
    whose def has `storage: 0` — **spills to the camp** rather than being
    trimmed away. The camp is unbounded, so conservation stays exact and no
    hand-edited or down-tuned save loses banked goods.
- `isSaveGameV6` validates both maps structurally (safe non-negative integer
  amounts, `MAX_BUFFER_KEYS`); `isLoadableSave` adds the cross-field check that
  needs the catalog — every named resource id must exist — exactly as it does
  for `buffer` today.
- **`HaulTrip` still never enters the save.** A hauler caught mid-trip banks
  its load into the camp, whichever kind of trip it was and whichever leg it
  was on, and stands at the camp on load with `atSiteId = CAMP_SITE_ID`. This
  is increment 4's deliberate simplification, unchanged: conservation is exact,
  the trip needs no guard or migration, and job selection is deterministic from
  persisted state, so a reloaded colony resumes identically.

### 2.10 Snapshot and surfaces

**Snapshot:**

- `BuildingSnapshot` gains `inputBuffered: number` (units held for its own
  recipe), `stored: number` (units held as a store), and `storage: number`
  (its capacity, 0 for a non-store).
- `BuildingState` gains `'storing'`.
- `ColonistSnapshot` gains `haulKind: HaulKind | null` — null when not on a
  trip. `carrying` keeps its meaning (units in hand) and now moves on the
  outbound leg of a supply trip, which it never did before.
- `ColonistSnapshot` also gains **`haulPickedUp: boolean`**, and it — not
  `haulKind` — is what drives the carrying-in/carrying-out marker below.
  `haulKind` is the *job* the hauler was dispatched on, frozen at dispatch, and
  it stops describing the cargo the moment §2.5's round trip works as intended:
  a `supply` trip that unloads and then collects output is carrying goods
  *out* while still labelled `supply`, and a `supply` trip returning with an
  undelivered remainder is carrying goods *in*. So the headline case in
  acceptance criterion 2 — the round trip this increment is named for — is
  precisely the one a `haulKind`-driven marker would draw backwards. Publish
  the cargo's origin, which `pickedUp` already is (§2.4).
- `ColonistSnapshot` gains **`haulSiteCol` / `haulSiteRow`** — the tile of the
  *site end* of this hauler's current situation: where they stand while idle,
  the frozen origin while outbound, the destination while returning. Without
  it the canvas cannot draw this increment at all: `haulSpot`
  (`src/app/world/layout.ts`) hardcodes `CAMP_ANCHOR` as both the outbound
  origin and the return destination, and `atSiteId`/`destSiteId` are
  runtime-only, so every depot trip would be drawn walking to and from the camp
  tent. This is the same fix, for the same reason, as `haulPickupCol/Row` in
  OBS-5-01 — the app cannot re-derive an endpoint the sim froze — and one pair
  of fields covers all three states because in each of them the question is the
  same: where is the site end of this walk?
- Aggregates the app would otherwise recompute in two places derive in the
  store, not the snapshot: units short across the colony, and how many
  buildings are idle for want of inputs.

**No-WebGL parity holds** — the whole colony must stay playable from the
tables, the promise made in increment 3 §1.1 and kept ever since:

- **Buildings table:** an `In` column beside the existing `Waiting`, and
  `Waiting for input` in the state column. A storehouse's row shows its fill as
  `held / capacity`.
- **Selection panel:** the selected building's input buffer and output buffer;
  for a storehouse, its contents against capacity.
- **Economy view:** the input backlog, symmetric with the output backlog it
  already names — units short and how many buildings are idle waiting for them.
  This is the answer to "why is my bakery stopped?", and it is in scope.
- **World view:** a storehouse glyph with a fill ring; the `storing` and
  `waitingForInput` state colours; a hauler carrying *in* drawn distinguishably
  from one carrying *out*, so flow direction reads at a glance.
- **Legend:** an entry for each of the three additions above. The legend
  explains every encoding — that has been true since increment 2 and this
  increment does not get to be the exception.

### 2.11 Testing and gates

- `src/shared/haul.ts`'s additions get exhaustive unit tests, as its existing
  law has: two-point tick rounding (including the never-free minimum),
  nearest-site ties, and room resolution with an unbounded camp among bounded
  sites.
- `ProductionSystem` gets local-input cases: a building with a stocked
  `InputBuffer` produces, one with an empty buffer and a full colony stockpile
  reports `waitingForInput` and produces nothing. **That second test is the
  whole increment in one assertion** and its fixture must discriminate — a
  full stockpile, so a pass cannot come from there being no flour anywhere.
- `HaulSystem` gets tick-by-tick trips of both kinds, the supply-then-collect
  round trip, and explicit determinism tests: identical world state yields
  identical claims across runs and across a save/load cycle.
- These edge cases are pinned by tests, not discovered later:
  - a supply hauler arriving at a building whose input buffer filled meanwhile
    — the remainder rides home rather than vanishing;
  - a storehouse demolished while a hauler is `returning` to it;
  - a storehouse relocated mid-leg (the destination re-resolves on arrival);
  - a storehouse demolished, and separately relocated, while a hauler is
    **idle at it** — that hauler must dispatch normally the following tick
    rather than being stranded (§2.5);
  - a supply remainder banked on the return leg, asserting that
    `Delivered/t` does **not** move for it while a collect load of the same
    size does — one fixture, two runs, and the difference is the assertion;
  - a supply trip **cancelled while another hauler has reserved** the remaining
    room at its source depot: the refund must not consume that reservation, and
    the returning hauler must still find its load fits;
  - a destination storehouse **relocated mid-return**: the hauler arrives where
    it was walking to, not at the depot's new tile;
  - two haulers loading for a depot with room for **one** load, and a third for
    one with room for **part** of a load: each ends up somewhere its whole load
    fits, and no unit is banked anywhere a hauler did not walk it. The
    partial-room case is the one a room-check-at-pickup design gets wrong most
    often, because it looks handled;
  - three idle haulers and **one** remote supply job: exactly one rebases. A
    rebasing hauler that forgot its target would send all three;
  - a supply trip cancelled while its source storehouse is **full**, and again
    while that storehouse has been **demolished in the same drain** — the
    colony's total is unchanged in both, and no ledger site survives without a
    building behind it (§2.4);
  - a building moved while a hauler **based at a remote depot** is outbound to
    it: the recomputed leg matches `haulTicksBetween(depot, new tile)`, not the
    camp-relative figure, and a fixture where those two differ is the only kind
    that proves anything;
  - a hauler who **retires, starves or dies** mid-supply-trip: the load is
    refunded, not delivered, and `Delivered/t` does not move;
  - a **v6 colony reopened paused** with goods in a depot: stock, wealth and
    meals per head read the same before the first tick as after it. Distinct
    camp and depot balances, or an aggregation that ignores one of them passes;
  - **the reachability case, three ways** (§2.5): a colony reloaded with inputs
    in a depot and no collectible output beside it delivers those inputs within
    a bounded number of ticks; the same after the depot's last based hauler
    dies; and the same for a newly built depot no hauler has ever stood at. All
    three are one rule and one test fixture with three entry points — and each
    one deadlocks forever without `rebasing`, so the assertion is that the mill
    eventually produces, not that a hauler moved;
  - **the same, with a busy forester beside the camp.** This is the fixture
    that discriminates, and the one whose absence would have let a
    lowest-priority rebase rule ship: a colony with permanent collect work
    available must *still* reach the remote depot. Without §2.5's priority the
    three cases above pass and this one deadlocks, which is a test suite
    agreeing with a rule rather than checking it;
  - **an unstaffed processor is never supplied**, while an identical staffed
    one beside it is — two buildings, one fixture, and the difference is the
    assertion;
  - **a depot holding one unit still supplies it**, while a depot holding one
    unit *and* being topped up past the threshold behaves as before;
  - **a hauler arriving at a depot that filled while it walked carries on to
    the camp**, and the ticks it takes are the depot-to-camp walk — asserting
    only that the goods reached the camp would pass for a teleport, which is
    the thing this rule exists to prevent;
  - **save and load guarantees exactly what §2.5 now claims**: conservation
    across the cycle, every site's stock still reachable, and work resuming
    within a bounded number of ticks. Not tick-identical resumption — that is
    no longer true and the test must not assert it;
  - a storehouse demolished with goods inside — `colonyWealth` is unchanged
    across the tick, which is the assertion that actually tests §2.7;
  - the deadlock §2.6 argues away: a colony whose ledger is empty and whose
    buildings all want inputs must still collect.
- Save v6 gets round-trip, v5→v6 migration, guard-rejection, and both clamp
  cases — including `stored` on a def with `storage: 0`, where the assertion is
  that the *aggregate* is conserved, not that the field survived.
- The browser smoke test gains a supply leg: a dot leaves a site carrying,
  reaches a building, and returns. Mutation-tested the same way as every other
  smoke check — disable the feature in `renderer.ts` or `layout.ts` and confirm
  that named check, and only that check, goes red.
- **All existing gates hold**: `npm run check:all` green (fallow counters
  pinned at zero, maintainability floor unmoved), coverage floors unchanged
  (`src/engine/**`, `src/shared/**`, `src/app/stores/**` at 90/85/90/90), every
  file under 500 nonblank lines, no new `!important`, no new dependencies,
  artifact budgets untouched, boundary zones intact — `src/shared/**` imports
  nothing outside itself, the app never imports `sim-ecs`, engine and shared
  never import `vue`/`excalibur`/`obsidian`.
- **The line budget is a design constraint this time, not a formality.** Five
  files this increment must touch are already close to the 500-line cap:
  `world.ts` 478, `renderer.ts` 445, `snapshot-builder.ts` 438,
  `command-handlers.ts` 426, `resources.ts` 387. The plan names a split for
  each rather than leaving it to whoever trips the gate first. No baseline is
  loosened to accommodate this increment.

### 2.12 Two carried-forward issues, resolved here

Both are open, both are minor, and both live in exactly the code this
increment rewrites — which is the only reason they are in scope:

- **OBS-5-03** — demolish-and-rebuild bypasses the priced relocation entirely,
  for an empty building. Increment 5 priced moving a building; demolishing it
  and building it elsewhere costs only the (fully refunded) construction and
  arrives instantly.

  This increment does not merely *touch* that issue, it **changes its
  severity**, and the change is the reason it is in scope. The note argues the
  bypass is minor because it only pays off for a building with nothing to lose:
  demolition destroys the output buffer, drops batch progress, and unstaffs the
  crew, so a building in real use pays for the trick in friction. **A
  storehouse has none of that friction.** It has no crew (`workerSlots: 0`), no
  batch, and — by §2.7's own spill-to-camp rule, which exists for good reasons
  — no goods to lose either. So for the one building a player most wants to
  reposition as the colony spreads, the bypass becomes free and frictionless,
  and the note's "why it is minor" reasoning no longer applies.

  **What this increment owes is the decision, not a particular fix.** The note
  offers three resolutions and explicitly declines to choose; the new fact
  above is what the choice should now be made against. One candidate is ruled
  out in advance because it does not work: charging downtime only when a
  construct lands on the *same tick* as a matching demolish is bypassed by
  waiting one tick, and adds a one-tick tax to an exploit instead of closing
  it. "Accept it, and record why" remains a legitimate outcome — but it has to
  be reached with the storehouse case in view, and the note updated to say so.
- **OBS-6-08** — a relocating crew's work power is computed then discarded on
  the engine side and reaches zero a different way on the snapshot side. The
  duplication becomes a third path the moment a relocating *store* has to be
  excluded from site lists, so it is collapsed now rather than triplicated.

### 2.13 Explicitly out of scope

- **Construction as work.** Materials are still paid from the ledger and the
  building appears finished. This is the named successor to this increment, for
  the reason given in §1.1: it needs a construction-site entity, a builder
  role, and delivered materials — all of which sit on top of the input
  delivery built here.
- **Roads, terrain and pathfinding.** Straight-line distance only, still —
  increment 4's own out-of-scope item, deferred a third time and now clearly
  behind the storehouse in value: a depot shortens a trip more than a road
  would.
- **Storehouse-to-storehouse transfer.** Goods move site → building → site. A
  hauler never rebalances two depots.
- **Per-resource storehouse filters or priorities.** A storehouse takes
  whatever arrives. Filters are a UI and a scheduling problem that only becomes
  interesting once there are several depots worth specialising.
- **A bounded camp**, and every failure mode that would come with it (§1.1).
- **Carts, vehicles, or any haul capacity that is not a colonist.**
- **Hunger or age affecting walk speed.** Still increment 4's deferral.
- **Seasons, weather, firewood.** Still increment 6's deferral, and now the
  strongest candidate for increment 9.
- **The tick-interval sync seam** stays deferred (OBS-4-09's note, deferred by
  increments 5 and 6 as well).
- **Multiple storehouse tiers.** One def.

---

## 3. Acceptance criteria

1. A staffed mill with an empty input buffer and a colony stockpile full of
   wheat produces nothing and reports `waitingForInput`; the same mill produces
   normally once a hauler delivers wheat to it.
2. Assigning a hauler to a colony with a stocked camp and a starved bakery
   produces exactly one notice; the hauler leaves the camp **carrying**,
   reaches the bakery, unloads, and returns with whatever bread was waiting —
   visible as a single round trip on the canvas.
3. A storehouse built beside a distant cluster measurably raises what that
   cluster delivers per tick, through the same number of haulers, against the
   identical colony without it.
4. With zero haulers assigned, every input-consuming building eventually stops,
   and the Economy view states how many are idle for want of inputs and how
   many units are short — separately from the output backlog it already names.
5. Job selection is deterministic across both kinds: the same world state
   produces the same claims across runs and across a save/load cycle.
6. A v5 save loads as a v6 colony with empty input buffers, no storehouses, and
   its stockpile intact at the camp — buildings exactly where increment 6 left
   them, colonists exactly as old.
7. Demolishing a storehouse holding goods leaves `colonyWealth` unchanged
   across that tick and says where the goods went; demolishing a producer holding
   goods loses them and says so.
8. Moving or demolishing any building mid-trip, of either kind, resolves without
   losing or duplicating a single unit of goods.
9. The colony remains fully playable from the tables with no canvas:
   storehouses constructible, input backlog visible, both buffers legible.
10. `npm run check:all` is green with no baseline loosened, and every touched
    file is under 500 nonblank lines.

---

## 4. Balance values

**Starting points, not claims.** Per increment 5's thesis — a constant
justified by prose rather than measurement is a guess — this table records
where the increment starts, and **§4 is to be rewritten with what the harness
measured before this increment is called done.** "Validated, unchanged" is a
legitimate outcome for any row.

| constant | start | reasoning to be checked |
| --- | ---: | --- |
| `inputBufferCap` | 12 | Mirrors `outputBufferCap`, so a building's in-tray and out-tray are the same size and a hauler's round trip is symmetric. At one input per batch this is 12 batches of runway — ~36 ticks for a mill, comfortably longer than the 13-tick worst-case one-way walk. |
| `storehouseCapacity` | 60 | Five full output buffers, so one depot serves a cluster of four or five producers for several trips before it backs up. |
| `minSupplyUnits` | 2 | Don't walk thirteen tiles to deliver one unit. Low enough that a small colony is not locked out of supply entirely, which a higher floor would do. |
| `storehouse` cost | 20 wood, 10 planks | Between a forester (10 wood) and a mill (20 wood, 10 planks): a real decision in the early game, trivially affordable once the plank chain runs. |

### 4.1 What the harness must answer

Three questions, and the instruments that answer them. Both harnesses need
extending; that extension is a task in the plan, not an afterthought.

**1. What did two-way haul do to increment 5's measured gradient?**

Increment 5 measured that one hauler serves a building out to leg ~4, two by
leg 8, three by leg 13. Re-run that sweep, and add a second one for an
input-consuming building (a sawmill fed by a forester). Two things must be
read, not one:

- the **raw producer's** gradient should be **unchanged**. It has no inputs,
  nothing is ever delivered to it, and a shift there means this increment broke
  something it did not intend to touch. This is the control, and it is the more
  important of the two readings.
- the **processor's** gradient is expected to be roughly halved in reach. If it
  is not, find out why before believing it.

**2. Does a storehouse pay for itself, and from what distance?**

The same two-stage chain at a range of distances, with and without a depot
beside it, at each hauler count. The answer wanted is a *crossover distance*:
the leg beyond which 20 wood and 10 planks buys more throughput than another
hauler does. If there is no such distance — if the depot never wins, or wins
everywhere — the storehouse is mistuned and `storehouseCapacity` or the cost is
where to look first.

**3. Does the dispatch order thrash, and is the deadlock self-resolving in
practice?**

§2.6 argues the deadlock away structurally. Measure it: run a colony with a
deliberately drained ledger and every building wanting inputs, and confirm that
collection resumes rather than the colony sitting still. Report the split of
hauler-ticks across **all three** outcomes — supply, rebase and collect — over a
long run, and how often a supply trip returns loaded; the round-trip mechanic in
§2.5 is only worth its complexity if that number is not near zero. **Rebase
ticks are the ones to watch for thrash.** They are pure overhead, justified
only by the supply work they unlock, so a run where they are a large share of
the total means the claim in §2.5 is not holding haulers in place the way it is
supposed to.

**A fourth reading, taken for free and worth having:** the population harness
staffs but **cannot build** (increment 6 §4.1). Increment 6 flagged that as a
conservative control; with a storehouse in the game it becomes a distortion,
because a colony that cannot build a depot cannot play this increment. The
harness extension should let a scenario place one, and the 12,000-tick chain
run should be repeated with and without — if the retuned `birthFoodPerHead: 12`
holds in both, that is a result worth recording beside increment 6's curve.
