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
- `nearestSiteWithRoom(col, row, sites, heldAt, amount)` — where a hauler
  carrying `amount` should unload. **The load size is a parameter, and that is
  load-bearing:** a predicate that only skips sites already *full* will happily
  send twelve units to a depot holding 55 of 60, and the arrival then splits the
  load — the partial-overflow defect this reservation design exists to remove,
  reintroduced in the signature. The test is
  `heldAt(site.id) + amount <= site.capacity`. `heldAt(siteId)` supplies current occupancy **plus what haulers
  already headed there have reserved** (§2.6), which is what makes a load fit
  on arrival rather than needing a rule for when it does not; a site with
  `capacity: null` always has room, so the camp is the guaranteed fallback and
  this
  function can never return null while the camp exists.
- `sitesHolding(sites, unclaimedAt)` — every site with unclaimed
  stock of a resource, for the supply pairing in §2.6. An earlier draft
  deliberately omitted this, on the grounds that a supply trip loaded where the
  hauler already stood; removing the hauler's base is exactly what makes it
  necessary, and what makes every site's stock reachable by construction rather
  than by a rule.

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
   the named site and **forward the shortfall to the camp**, which has no
   capacity and so refuses nothing a colony can actually produce. Callers get
   no remainder to mishandle.

   One exception, stated because the invariant above is otherwise an
   overclaim: the camp is unbounded in *game* terms but every stock still
   saturates at `MAX_SAVED_COUNTER`, so that the engine can never write a save
   its own guard would reject. With the camp at that ceiling — around 9×10¹⁵
   units, organically unreachable, and only arrivable at through a hand-edited
   `data.json` — a forwarded shortfall is dropped rather than banked. That is
   not a new loss this increment introduces: `Stockpile.bank` has saturated
   silently since increment 1, and per-site saturation keeps every site's
   amount inside what the v6 guard accepts. It does mean §2.9's "conservation
   is exact" holds *below the serialization ceiling*, which is the only regime
   play can reach. Without this, every caller has to remember the overflow rule —
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

   **Restoration is the one caller exempt from this**, and the exemption is
   narrow. A save can be taken while a *stocked* storehouse is mid-relocation,
   and §2.3 keeps a store in transit out of the site list — so loading that
   colony has contents to reconstruct and no `StoreSite` to bank them against.
   The restore path therefore seeds a site directly rather than banking into
   one (`seedSite`, §2.9). That is not a hole: seeding reconstructs a state the
   engine itself previously wrote, records no delivery, and runs once per
   building at load. What the invariant forbids is *play* creating a site with
   no building — and it still does.
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

### 2.5 Haul trips gain a kind, and a leg that fetches

**Haulers belong nowhere.** That is the decision this section rests on, and it
is a reversal: an earlier draft of this spec gave every hauler a *base site*
and let a supply trip load only from that base. It bought a tidy two-leg trip
and cost four things in succession — a reachability deadlock (a depot's stock
was unreachable by anyone not already standing at it, which included every
hauler after a reload, after a depot's last hauler died, and on the day any
depot was built), a `rebasing` phase to escape it, a priority rule to make the
rebase actually fire, and a claim so a fleet of haulers would not all rebase at
once. All four are deleted here along with the base. A supply job is chosen
across **every** site, and the trip simply begins with a walk to wherever the
goods are.

One consequence worth naming immediately: **`haulerCapacity` goes back to
measuring a hauler's commute from the camp**, exactly as increment 6 shipped
it. The base-relative version was collateral from the base, and reverting it
means increment 6's measured commute figures — and §4 q1's control, which
requires a raw producer's gradient to be unchanged — are not disturbed by this
increment at all.

`HaulTrip` gains, all runtime-only like the rest of it:

- `kind: HaulKind`, where `HaulKind = 'collect' | 'supply'`;
- `atCol` / `atRow` — **where the hauler physically is** when it is not on a
  leg. A position, not a site id: there is no membership to dangle when a
  storehouse is demolished, and nothing to repair at the top of a tick. Two
  things about it are easy to get wrong and are therefore stated rather than
  left to a default:
  - **It initialises to `CAMP_TILE`, not to `(0, 0)`.** Every other numeric
    field on `HaulTrip` defaults to zero, so a hauler spawned fresh or restored
    from a save would otherwise begin at the map's corner — pricing and drawing
    its first leg from a tile it has never stood on, and shifting the very
    raw-producer control §4 q1 depends on. Both spawn paths set it, per
    `buildingComponents`/`colonistComponents`'s single-list rule.
  - **A cancelled trip updates it before resetting.** `atCol`/`atRow` name the
    leg's *origin* while a leg is running, so simply preserving them across a
    cancellation would jump the hauler backwards over every tile it had already
    walked. On cancel, its position is derived from the leg's frozen endpoints
    and `legProgress(ticksLeft, legTicks)` — the same interpolation the renderer
    already uses to place the dot, so the hauler stops exactly where the player
    last saw it. It may land between tiles; nothing requires this to be integral,
    since it is only ever a distance origin. This works for all three leg kinds
    **only because every leg freezes both its endpoints** (above); the first
    version of this rule read endpoints that only the return leg ever set.

    **Every path that ends a trip goes through this**, without exception — the
    rule is worth stating that way because the paths that forget are the ones
    written later, by someone following the surrounding code rather than this
    paragraph. The fetch-arrival cancellations (§2.5 step 2) are the case in
    point: they fire *after* the hauler has walked its whole leg, so the correct
    position is `legTo` while the fields still hold `legFrom`, and skipping the
    update teleports the hauler back across the leg it just finished.
- `sourceSiteId` and `plannedAmount` — the site a supply trip is fetching from,
  and how much it intends to take. The quantity is its own field rather than a
  reuse of `amount`, for a reason that only shows up at save time: a fetching
  hauler carries nothing until it arrives, while `buildSaveFromWorld` banks
  `amount` into the save as real cargo (increment 4's mid-trip simplification,
  §2.9). Folding a planned take into `amount` would therefore either hide the
  pending quantity from the claim map — so two haulers both plan the last six
  wheat — or **duplicate goods on a save taken mid-fetch**, banking them into
  the stockpile while they still sit at the source. `amount` keeps meaning
  cargo in hand; `plannedAmount` becomes 0 the moment `takeAt` returns;
- `destSiteId` — where the load is going, and the reservation of room there;
- `legFromCol` / `legFromRow` and `legToCol` / `legToRow` — **both endpoints of
  whichever leg is running, frozen when that leg begins.** Every leg, not only
  the return: a `fetching` or `outbound` trip can be cancelled part-way and
  needs the same interpolation to say where its hauler stopped, so endpoints
  populated for one leg kind only would leave the other two reading a default
  or a stale tile.

  These replace `pickupCol` / `pickupRow`, which existed for the return leg
  alone (OBS-5-01) and whose name stops being true the moment a `fetching` leg
  uses them — nothing is picked up at its origin. `legTo` is a **tile**, not a
  site id, for OBS-5-01's own reason: a leg must be measured against the
  journey the simulation is running, not against a tile re-read from a building
  that has since moved.

  Together with `legProgress`, these two pairs describe *any* leg completely,
  which is what lets both the cancellation rule below and the renderer drop
  their per-phase special cases;
- `pickedUp: boolean` — whether the load in hand came out of a building's
  output buffer. It is the discriminator §2.4's flow table needs: a hauler
  walking home holding six flour is either delivering goods the ledger has
  never counted (`pickedUp`, bank with `addAt`) or carrying back a supply
  remainder the colony already owned (bank with `refundAt`), and nothing about
  the load itself distinguishes them.

**Anything true when a trip is dispatched may be false when it arrives**, and
this spec has now been caught assuming otherwise three times: destination room
(fixed by reserving it), source stock (fixed by reconciling against what
`takeAt` actually returned), and the target's staffing (below). A leg takes
ticks, and the world moves during them. Any condition a dispatch decision rests
on is therefore either **reserved**, so nothing else can invalidate it, or
**rechecked on arrival** — and the rule for a recheck that fails is always the
same: the load stays in hand and becomes an undelivered remainder, which step 4
already knows how to route. Adding a fourth such condition without picking one
of those two is the mistake this paragraph exists to stop.

`HaulPhase` becomes `'idle' | 'fetching' | 'outbound' | 'returning'`. A collect
trip is two legs, exactly as increment 4 shipped it; a supply trip is the same
trip with one leading leg to pick the goods up. That is the whole difference:

1. **Idle** → claim a job (§2.6).
   - `supply` → phase `fetching`, leg from `atCol`/`atRow` to the source site's
     tile. The stock it intends to take is claimed now, so a second hauler is
     not sent at the same last six wheat.
   - `collect` → phase `outbound`, leg from `atCol`/`atRow` to the building.
2. **Fetching** → on arrival, **recheck both ends** before taking anything —
   the source by *tile*, not by id, since a storehouse that relocates keeps its
   id and moves, and §2.3 drops it from the site list only while it is in
   transit; a hauler arriving after the move completes would otherwise draw
   goods out of a building standing somewhere it is not. And **recheck that the
   target building still exists**: the demolition handler cancels trips
   *outbound to* a building, and a fetching hauler is walking to a source, so
   nothing else catches this. Taking the stock anyway would carry it to a
   building already known to be gone and tie up both until the arrival path
   disposes of them. Nothing has been picked up yet, so a fetching trip always
   cancels clean — no load, no disposal, no remainder. (This is the first
   application of the rule above: the target's existence is a dispatch-time
   condition, so it is either reserved or rechecked, and it cannot be
   reserved.)

   Otherwise `takeAt` the load from the source site (recording nothing — the
   goods are in transit, not gone: §2.4). Phase `outbound`, leg
   from the source tile to the building.
3. **Outbound** → on arrival:
   - **staffing is rechecked here, not only at dispatch.** A building's last
     worker can be unassigned, retire or die while a hauler walks, and none of
     those cancels the trip the way a demolition does. Unloading regardless
     would park goods in a processor that cannot use them and will lose them if
     it is demolished — precisely what §2.6's staffing rule exists to prevent,
     defeated by a few ticks of travel. An unstaffed target is simply not
     unloaded into: the load stays in hand with `pickedUp` false, which makes it
     an undelivered remainder, and step 4 already sends those home to their
     source. No new mechanism, no new state.
   - a `supply` load is put into the building's `InputBuffer` — whatever fits,
     recording consumption for what lands, since that is the moment the goods
     leave the colony's store for good. Any remainder stays in hand with
     `pickedUp` still false and rides home, so no unit is destroyed and none is
     later miscounted as a delivery;
   - **then, for both kinds**, a hauler with empty hands loads from that
     building's `OutputBuffer` — `fullestResource`, up to its capacity — and
     sets `pickedUp`. A supply trip that finds nothing waiting returns empty,
     which is the honest cost of a one-directional errand. **This is the round
     trip the increment is named for**, and it survives the base's removal
     untouched.
   - Phase `returning`, destination resolved and its room reserved, both
     endpoints frozen.
4. **Returning** → the destination was chosen when this leg began, and for an
   **undelivered supply remainder** it is that load's own source site, whenever
   the source is still live and has room for all of it. Sending a remainder to
   whatever site happens to be nearest the building would let camp wheat become
   depot stock without ever being consumed — the storehouse-to-storehouse
   transfer §2.13 excludes, arrived at sideways, and the opposite of what §2.7
   does when the same trip is cancelled rather than merely rebuffed. The
   discriminator already exists: a hauler only loads output with empty hands
   (step 3), so `!pickedUp && amount > 0` is exactly "carrying an undelivered
   remainder". The walk back may be long; that is the honest price of a
   delivery that failed, and it should be rare.

   On arrival the load **fits by construction**, because
   choosing the destination reserved room for it (§2.6) and reserved room is
   reserved against every bank, including refunds. So the ordinary path is
   simply: bank (`addAt` when `pickedUp`, `refundAt` when not), set
   `atCol`/`atRow` to where it now stands, go `idle`.

   **The one case reservation cannot cover is a destination that stops
   existing** — demolished, or sent into transit by a move. Then the hauler
   re-resolves and **walks on**: a fresh `returning` leg from the frozen tile it
   has arrived at to the newly resolved site, carrying its whole load the entire
   way, because goods are carried and never forwarded while a hauler is standing
   there to carry them (§2.4). The camp is unbounded and cannot vanish, so the
   walk terminates.

**A site can stop existing under a `fetching` hauler too**, and it needs no new
rule: the trip cancels, exactly as an outbound trip cancels when its building is
demolished (§2.7). Nothing was taken yet, so nothing needs disposing of.

**What this costs.** A supply trip is now three legs where the base model made
it two, and a hauler that fetches from the camp to a near mill walks a leg it
would previously have skipped. That is the honest price of the goods being
somewhere: the base model did not remove that walk, it hid it, by only ever
letting haulers take jobs whose walk had already been paid. §4 q3 measures the
fetch leg's share of hauler-ticks.

**On the save.** Nothing here is persisted; a reloaded hauler stands at the
camp with its cargo banked there, which is increment 4's simplification
unchanged. That is not the same as resuming identically, and this spec said
otherwise in an earlier draft. It cannot: a colony saved with an idle hauler
beside a far depot comes back with that hauler at the camp, so its next trip's
first leg differs. What holds, and what the tests should check:

- **conservation is exact** — not one unit is created or destroyed across a
  save and load, wherever it was standing or being carried;
- **the colony converges** — every site's stock stays reachable (which, with no
  base, is now true by construction rather than by a rule), and work resumes
  within a bounded number of ticks;
- **determinism still holds within a run** — identical world state yields
  identical claims, which is the property job selection actually guarantees.

That is weaker than increment 4's promise, honestly stated, and it buys keeping
`HaulTrip` out of the save format and its guards entirely — increment 4's own
trade, still worth making.

### 2.6 Which job, and in what order

Two candidate sets are built each tick from live components, and both are pure
functions of world state — no memory between ticks, no iteration-order
dependence, tie-breaks ending at an id.

**Collect candidates** — unchanged from increment 4 except for who counts as a
claimant (below): buildings with unclaimed buffered output, ordered by
`compareHaulCandidates` (most claimable first, then nearest, then lowest id).

**Supply candidates** — a building and a source site, **paired**, and the pair
is the candidate: a building suppliable from both the camp and a depot produces
two of them. That is not a modelling nicety — the ordering below ranks on the
hauler→source→building route and tie-breaks on the site id, and neither is
expressible if a candidate names only its building. A candidate that dropped
its source would let dispatch pick a remote depot with a nearer stocked site
standing available, which is precisely the behaviour §4 q2 is measuring.

A pair qualifies when:

- its recipe has inputs, it is not relocating, and **at least one colonist is
  assigned to it**. The staffing condition is not an optimisation: goods in an
  `InputBuffer` are out of the spendable ledger, and §2.7 destroys an input
  buffer on demolition — so without it, supply-first dispatch would truck
  scarce wheat and planks into buildings that cannot use them and cannot give
  them back. A colony short of adults would watch its stock drain into an
  unstaffed mill with no way to recover it but staffing the mill. Deliveries
  are gated, not the goods already inside: a building whose crew died keeps
  what it holds and consumes it if it is ever staffed again;
- some site holds the resource it is shortest of (ties by catalog order,
  mirroring `OutputBuffer.fullestResource`);
- `movable = min(capacity, inputBufferCap − inputBuffered − claimed deliveries,
  unclaimed stock at that site)` is at least `BALANCE.minSupplyUnits`, **or is
  everything that site holds of that resource**. Without the second clause the
  threshold strands the tail: every recipe today consumes one unit per batch, so
  a depot holding exactly one flour can feed a bakery but can never produce a
  candidate, and that unit would sit there for the rest of the game while the
  ledger and the UI keep counting it. The threshold exists to stop a
  thirteen-tile walk for a *top-up*, not to make the last of something unusable.

Ordered by `movable` descending, then by the **whole trip** — the hauler's tile
to the source, plus the source to the building — ascending, then by building
id, then by site id. Ranking on the whole trip rather than on either leg is
what stops a hauler crossing the map to fetch from a depot when the camp behind
it holds the same goods.

**Supply is offered first.** A building waiting on inputs produces nothing at
all, while a building with a full output buffer has already produced and its
goods are standing safe where they were made. The obvious objection is
deadlock — every hauler supplying, nobody collecting, the ledger drained — and
it is self-limiting for a structural reason worth stating rather than hoping
for: a supply job requires stock *somewhere*, and only collection puts it
there. As the ledger empties, supply candidates disappear and collection
resumes on its own. §4 question 3 measures that rather than trusting this
paragraph.

**The claim invariant.** Claims are recomputed every tick from live components —
that is what makes dispatch a pure function of world state and keeps it
independent of entity order. It follows that **any intent a hauler holds must
be reconstructible from that hauler's own components at the start of the next
tick.** An intent recorded nowhere is not a claim, however firmly the prose says
it is. This spec broke that rule twice in earlier drafts, so it is stated once
here and the four claims below all follow from it:

- **output**, against a building's `OutputBuffer`: counted for haulers of
  *both* kinds heading there, since a supply hauler also loads output on
  arrival. Without it two haulers are sent at the same six units.
- **input**, against a building's remaining input room: a building already
  being supplied has the pending delivery subtracted from its deficit, or every
  idle hauler in the colony leaves for the same empty mill on the same tick.
- **source stock**, against a site's holdings, held by a `fetching` hauler in
  `sourceSiteId`: two haulers must not both plan to take the same last six
  wheat.
- **destination room**, against a bounded site's capacity, held in
  `destSiteId`: this is what makes a load fit on arrival rather than needing a
  rule for when it does not. It binds *every* bank at that site, a
  cancellation's `refundAt` included — a refund landing in space another hauler
  is already walking toward leaves that hauler arriving with a load that no
  longer fits, which is the split-and-forward reservation exists to remove.

  **A trip releases its own reservation before resolving a new destination.**
  Otherwise a cancellation double-counts itself: a returning hauler carrying
  six to a depot holding 54 of 60 has already reserved that six, so a
  reservation-aware lookup reports 60, adding its six again exceeds capacity,
  and the depot is rejected in favour of the camp — for a load whose room was
  reserved for exactly this purpose. Releasing costs nothing to implement,
  because §2.6's claim invariant makes reservations a projection of live
  components: clearing `destSiteId` *is* releasing the reservation. Clear it
  first, resolve second. Every *other* trip's reservation must of course still
  be counted.

  **Honouring it is the caller's job, not the banking call's.** `addAt` and
  `refundAt` see a site's *physical* contents and know nothing of what has been
  promised, and giving them reservation awareness would mean teaching the
  ledger about haul trips — which the rest of this design keeps out of it. So
  every caller resolves its destination through `destinationFor` — the load's
  own **source site first** where that is still live and has room for all of
  it, then `nearestSiteWithRoom(…, heldAt, amount)` — with the **same
  reservation-aware `heldAt`** dispatch uses, and banks only into what that
  returns. Naming only `nearestSiteWithRoom` here, as an earlier draft did,
  contradicts §2.5 step 4 two sections above: routing a remainder onward turns
  camp wheat into depot stock without it ever being consumed, which is the
  store-to-store transfer §2.13 excludes. The reservation-aware `heldAt` is
  what this paragraph is actually about, and it binds either way.
  The camp's unbounded capacity is what
  makes that resolution always succeed, and a refund that still cannot fit
  takes the last-resort route there — correct precisely because no hauler is
  left to walk it anywhere.

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
  dies mid-trip.

  **They split two ways, and the split is whether a hauler is left to walk.**
  Banking the load immediately is right only for the paths where nobody
  remains: `unassignHauler` and `standDown`, where the colonist stops being a
  hauler or stops being alive. In the other two — the target demolished, or
  found already gone on arrival — the hauler is still a hauler, still standing
  somewhere on the map, and perfectly able to carry what it holds. Banking
  there would teleport the cargo out of its hands from mid-route, which is the
  thing §2.4 forbids and which understates haul time in exactly the direction
  that flatters §4's measurements. A surviving hauler therefore starts a
  `returning` leg carrying its load — to the load's source if it is an
  undelivered remainder, to the nearest site with room if it is collected
  output — and `pickedUp` already tells the two apart. That last one runs *before* `HaulSystem` in the tick and banks
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
  leg from **where that hauler actually started it**, not from the camp. `handleMoveBuilding`
  today calls `haulTicks(to.col, to.row, …)`, which is camp-relative and was
  correct while the camp was the only origin; once §2.5 dispatches from
  the hauler's own tile, a hauler standing at a remote depot would be charged a
  camp-to-target walk it is not walking. That is precisely the OBS-5-01 failure — a leg length
  disagreeing with the leg the sim is actually running — and it desyncs the
  drawn dot the same way, since the renderer derives its position from
  `legTicks`. Measure from **where the hauler actually is**, not from the leg's
  frozen origin: derive its current position from the leg's endpoints and
  `legProgress`, freeze *that* as the new origin, and price only the remaining
  walk. Measuring from the original origin re-charges the distance already
  covered and jumps the drawn dot backwards — the same defect, in the opposite
  direction, as the one this bullet exists to fix.
- **A hauler `fetching` from a store that stops being one** simply cancels,
  the same way an outbound trip cancels when its building is demolished:
  nothing has been picked up yet, so there is nothing to dispose of and the
  hauler is dispatched afresh next tick from wherever it stands. There is no
  base to repair — haulers hold a tile, not a site membership (§2.5), which is
  what removes this whole class rather than handling it.

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
  was on, and stands at the camp on load. This is increment 4's deliberate
  simplification, unchanged: conservation is exact and the trip needs no guard
  or migration.

  **It does not mean the colony resumes identically**, and an earlier draft of
  this paragraph claimed it did. Increment 4 could promise that because the
  camp was the only site, so "everyone at the camp" *was* the state; with
  several sites a colony saved with an idle hauler beside a depot, or with
  cargo in flight, comes back with different claims and different travel times.
  §2.5 states the three guarantees that do survive — exact conservation, every
  site's stock still reachable, and work resuming within a bounded number of
  ticks — and acceptance criterion 5 is scoped to identical *live* world state
  for the same reason.

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
- `ColonistSnapshot` publishes **`haulLegFromCol` / `haulLegFromRow`,
  `haulLegToCol` / `haulLegToRow`, and `haulAtCol` / `haulAtRow`** — the running
  leg's two frozen endpoints, plus where an idle hauler stands. A single
  "site end" pair, which an earlier draft published, cannot describe this: a
  leg can begin from an *arbitrary* position (the fractional tile a
  cancellation leaves behind), and an idle hauler has no site end at all, so
  both the after-cancellation and the idle-at-a-depot states would be
  unrenderable. Publishing both ends also removes the last per-phase case from
  the layout — `legFrom`, `legTo` and `legProgress` place a dot in any phase,
  and `at` places it when no leg is running. Without
  it the canvas cannot draw this increment at all: `haulSpot`
  (`src/app/world/layout.ts`) hardcodes `CAMP_ANCHOR` as both the outbound
  origin and the return destination, and the trip's own endpoints are
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
  identical claims **across runs**. Not across a save/load cycle — §2.5 says
  why that is no longer true, and a test asserting it would either fail or be
  weakened until it asserted nothing. Save and load is covered by the
  conservation-and-convergence contract instead.
- These edge cases are pinned by tests, not discovered later:
  - a supply hauler arriving at a building whose input buffer filled meanwhile
    — the remainder rides home rather than vanishing;
  - a storehouse demolished while a hauler is `returning` to it;
  - a storehouse relocated mid-leg (the destination re-resolves on arrival);
  - a storehouse demolished, and separately relocated, while a hauler is
    **`fetching` from it** — the trip cancels with nothing to dispose of, and
    the hauler dispatches normally next tick;
  - a supply remainder banked on the return leg, asserting that
    `Delivered/t` does **not** move for it while a collect load of the same
    size does — one fixture, two runs, and the difference is the assertion;
  - a supply trip **cancelled while another hauler has reserved** the remaining
    room at its source depot: the refund must not consume that reservation, and
    the returning hauler must still find its load fits;
  - a destination storehouse **relocated mid-return**: the hauler arrives where
    it was walking to, not at the depot's new tile;
  - two haulers destined for a depot with room for **one** load, and a third
    for one with room for **part** of a load: each ends up somewhere its whole
    load fits, and no unit is banked anywhere a hauler did not walk it. The
    partial-room case is the one this design has got wrong most often, because
    it looks handled — it survived two separate fixes before the load size
    became a parameter of the site choice at all;
  - three idle haulers and **one** remote supply job: exactly one fetches it,
    because the source stock is claimed (§2.6);
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
  - **the reachability cases, which are now expected to be dull** (§2.5): a
    colony reloaded with inputs in a depot and no collectible output beside it;
    the same after that depot's haulers have all died; the same for a
    newly-built depot; and the same again with a busy forester beside the camp
    providing permanent collect work. Every one of these deadlocked under the
    discarded base model and needed a rule of its own. With no base they are
    ordinary supply jobs whose first leg happens to be long, and they are kept
    **because** they are dull now — each is a regression sentinel against
    reintroducing a base by accident. The assertion is that the mill eventually
    produces;
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

### 2.12 Two carried-forward issues, settled here

Both are open, both are minor, and both live in exactly the code this
increment rewrites — which is the only reason they are in scope. One is fixed;
the other is decided and deliberately not fixed.

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

  **Decided: accepted, not fixed.** The note offered three resolutions and
  declined to choose; this increment chooses the third, with the storehouse
  fact above on the table. Pricing the bypass needs *persisted demolition
  history* — a new save field, in an increment that already adds one — because
  the cheap version does not work: charging downtime only when a construct
  lands on the *same tick* as a matching demolish is bypassed by waiting a
  tick, and taxes the exploit rather than closing it. That is a real cost to
  close a gap worth a few ticks and two extra clicks to the player who bothers.
  So the section header above is slightly wrong for this one: it is *resolved*
  here in the sense that the decision is taken and written down, not in the
  sense that code changed. §2.13 records it as an accepted quirk, and the issue
  note carries the reasoning.
- **OBS-6-08** — a relocating crew's work power is computed then discarded on
  the engine side and reaches zero a different way on the snapshot side. The
  duplication becomes a third path the moment a relocating *store* has to be
  excluded from site lists, so it is collapsed now rather than triplicated.

### 2.13 Explicitly out of scope

- **Construction as work.** Materials are still paid from the ledger and the
  building appears finished. Descoped deliberately and **written down rather
  than dropped**: `docs/requirements/Construction as Work.md` is the backlog
  Feature, and it is the named successor to this increment for the reason given
  in §1.1 — it needs a construction-site entity, a builder role, and delivered
  materials, all of which sit on top of the input delivery built here.
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
- **Closing the demolish-and-rebuild relocation bypass** (OBS-5-03). Decided
  and accepted rather than deferred by omission — §2.12 has the reasoning, and
  the issue note carries it forward so a later increment inherits a judgement
  rather than a silence.

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
5. Job selection is deterministic across both kinds: the same **live** world
   state produces the same claims across runs. Deliberately **not** across a
   save/load cycle — `HaulTrip` is not persisted (§2.9), so an idle hauler
   beside a depot reloads at the camp and carried cargo is banked there, and
   the reloaded colony can legitimately choose different claims. §2.5 states
   what survives a reload instead: exact conservation, every site's stock still
   reachable, and work resuming within a bounded number of ticks. Requiring
   equal claims here would fail a correct implementation.
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

**Measured, and rewritten.** The table this section shipped with recorded where
the increment started and promised that §4 would be rewritten with what the
harness measured before the increment was called done. This is that rewrite.
Every figure below comes from the instruments committed in
`tests/engine/balance.test.ts`; reproduce any of it with `npm run
balance:report` and `npm run balance:population`.

**No constant moved**, and that is not the same as nothing having been learned.
One constant had a clear measured case for a change, was retuned, and was
measured back out again on a second fixture — §4.2 records that trial in full,
because the trial is the evidence. Two of the readings argue against a
*mechanic* rather than against a magnitude, and §4.3 says which of them
contradicts §1 rather than quietly editing §1 to agree.

| constant | value | outcome | the measurement behind it |
| --- | ---: | --- | --- |
| `inputBufferCap` | 12 | **Validated — for a reason the shipped comment did not give, and against a retune that measured better on one fixture and worse on another.** | It is not runway, it is *concurrency*: a supply hauler claims its whole load against the target's in-tray, so `inputBufferCap / haulCarryCapacity` is how many loads may be walking toward one building at once. At 12 that caps a far processor at **72%** of ceiling however many haulers are hired; at 24 the same run reads **92%**. It is also, today, the dispatcher's only fairness floor — §4.2. |
| `storehouseCapacity` | 60 | **Validated as a magnitude. The mechanic it sizes is incomplete.** | The depot is full — 60 of 60 — in every measured run, and its benefit is a one-off: **+26 / +24 / +28** planks at 600 / 1,200 / 2,400 ticks. At capacity 240 it is full at 240 and the one-off is proportionally bigger (+114 planks at 2,400 ticks). Raising a capacity does not create the flow that is missing (§4.3). |
| `storehouse` cost | 20 wood, 10 planks | **Validated, unchanged.** | A crossover against hiring another hauler does exist — **leg ≈ 11, and only from the third hauler onward** — so the depot neither never-wins nor wins-everywhere. The window is narrow, and cutting the price would only make a mechanic that stops paying after 600 ticks cheaper to buy. |
| `minSupplyUnits` | 2 | **Validated, unchanged.** | Not the binding term in any reading taken: the far processor's plateau is in-tray concurrency, the depot's decay is a missing flow, and q3's starvation is the ranking. Nothing measured here moves it. |
| `birthFoodPerHead` | 12 | **Validated, unchanged — now measured with a live depot in the colony.** | Peak 40, final 39, trough 34, 73 births, **0 starvation deaths**, minimum 9.8–9.9 meals/head, across all four 12,000-tick runs, depots or none. Identical to increment 6's recorded curve. |
| `outputBufferCap` / `haulCarryCapacity` / `haulTilesPerTick` | 12 / 6 / 2 | **Untouched, and measured untouched.** | Increment 5's sixteen-row sweep is byte-identical at `main`, at the pre-increment commit `237b3b3`, and at this branch's HEAD. |

### 4.1 What the harness measured

**1. What did two-way haul do to increment 5's measured gradient?**

**The control holds, and it is the clean reading of the whole increment.**
Increment 5's sweep was re-run at three commits — `main` (end of increment 5),
`237b3b3` (end of increment 6, the pre-flight for this one), and this branch's
HEAD. **All sixteen rows are identical at all three, digit for digit:**

```
tile        leg  haulers  delivered  %ceiling  stalled%  idle
( 3, 0)     1        1        398       100         0   200
( 8, 4)     4        1        394        99         0    67
(15, 8)     8        1        210        53        50    36
(15, 8)     8        2        390        98         0   141
(23,15)    13        1        132        33        68    23
(23,15)    13        2        258        65        38    54
(23,15)    13        3        384        96         0    94
```

(seven of the sixteen; the rest are in the captured run). One hauler to leg 4,
two by leg 8, three by leg 13 — exactly as increment 5 recorded. A raw producer
has no inputs, nothing is ever delivered to it, and a shift here would have
meant this increment broke something it did not intend to touch. It did not.

**The processor's gradient is halved at one hauler and softens above it.**
Measured on a **single-stage camp-fed sawmill** — increment 5's own sweep with
exactly one thing changed, a recipe that has an input to walk in. Crew 2 and
`ticksPerBatch` 3 are the forester's own, so `ceiling` is the same 400 and
`share` is comparable row for row. `StageResult.ceiling`'s caveat covers a
`workshop` and a stage *fed by another stage*, and this is neither, which is why
the processor half is measured this way rather than as the second stage of a
chain.

| leg | forester %ceiling (1/2/3/4 haulers) | sawmill %ceiling (1/2/3/4 haulers) |
| ---: | --- | --- |
| 1 | 100 / 100 / 100 / 100 | 99 / 99 / 99 / 99 |
| 4 | 99 / 99 / 99 / 99 | **89** / 98 / 98 / 98 |
| 8 | 53 / 98 / 98 / 98 | 48 / 80 / 97 / 97 |
| 13 | 33 / 65 / 96 / 96 | 30 / 55 / **71** / **72** |

Reach at the 95% bar, reading the two extra tiles (legs 2 and 6) the same
fixture was run at:

| haulers | raw producer | processor | ratio |
| ---: | ---: | ---: | ---: |
| 1 | leg 4 | leg 2 | 0.50 |
| 2 | leg 8 | leg 6 | 0.75 |
| 3 | leg 13 | leg 8 | 0.62 |
| 4 | leg 13 | never reaches 13 | — |

So §4.1's expectation of "roughly halved" holds at one hauler and softens above
it, and **the softening has a cause: the round trip §2.5 added.** 92–99% of
supply trips in this sweep come home loaded, so the collect job rides home on
the supply job and the second half of the work is nearly free once the first is
being done.

**The plateau at the far corner is not a hauler shortage.** At leg 13 the
processor sits at 71–72% of ceiling and a fourth hauler buys one point, while
those four haulers are idle only 5% of their ticks and the sawmill waits for
input 30% of its own. `Claims.input` counts a fetching hauler's `plannedAmount`
and an outbound hauler's `amount` against the target's in-tray room, so at most
`inputBufferCap / haulCarryCapacity` = 2 loads can be walking toward one
building at a time. Two loads of 6 over a 1 + 13 + 13 = 27-tick round trip is
0.44 units per tick against a 2-worker sawmill's demand of 0.67 — 66% of
ceiling. Measured 72%: the arithmetic and the reading agree. §4.2 is what
follows from that.

**2. Does a storehouse pay for itself, and from what distance?**

Measured on a chain that stays haul-bound at every distance — forester crew 3
feeding sawmill crew 2, five leg pairs from (5,2)/(8,4) out to (20,12)/(23,15),
the depot between the two buildings, haulers 1–4, 600 ticks. `storedAtEnd` is
57–60 in every with-depot run and **0 in every control**, so no row below is a
run compared against itself.

Planks made (gross, from `ProductionLedger`):

| legs (A/B) | no depot 1/2/3/4 | depot 1/2/3/4 |
| --- | --- | --- |
| 2 / 4 | 233 / 388 / 392 / 393 | 261 / 394 / 394 / 394 |
| 4 / 6 | 154 / 303 / 327 / 386 | 191 / 320 / 355 / 391 |
| 6 / 8 | 114 / 228 / 285 / 351 | 156 / 255 / 342 / 361 |
| 9 / 11 | 84 / 162 / 242 / 270 | 132 / 207 / 269 / 301 |
| 11 / 13 | 66 / 132 / 204 / 224 | 120 / 186 / 230 / 261 |

**The depot's own contribution grows monotonically with distance** — at one
hauler and at four: +12% / +0.3% at leg 2-4, +24% / +1% at 4-6, +37% / +3% at
6-8, +57% / +12% at 9-11, **+82% / +17%** at 11-13.

**The crossover against another hauler**, which is the question this section
actually asked — depot-at-*h* against no-depot-at-*h+1*:

| legs | h=1→2 | h=2→3 | h=3→4 |
| --- | --- | --- | --- |
| 2 / 4 | hauler (261 vs 388) | depot (394 vs 392) | depot (394 vs 393) |
| 4 / 6 | hauler (191 vs 303) | hauler (320 vs 327) | hauler (355 vs 386) |
| 6 / 8 | hauler (156 vs 228) | hauler (255 vs 285) | hauler (342 vs 351) |
| 9 / 11 | hauler (132 vs 162) | hauler (207 vs 242) | tie (269 vs 270) |
| 11 / 13 | hauler (120 vs 132) | hauler (186 vs 204) | **depot (230 vs 224)** |

**The crossover distance is leg ≈ 11, and only from the third hauler onward.**
Below that, and at any distance while the colony has fewer than three haulers
on the chain, another colonist beats 20 wood and 10 planks. The two rows at leg
2-4 where the depot wins are ties at ceiling, not wins. (A *slacker* chain — a
crew-1 sawmill, which saturates by leg 8 — has the depot edging the hauler from
two upward, but by 1–3 planks out of ~195, because both sides are already at
ceiling. That fixture cannot answer the question and is not the one quoted.)

**And the depot pays once and then stops.** Corner chain, 3 haulers, depot
against none, at three run lengths:

| ticks | no depot (planks / per tick) | depot (planks / per tick) | depot advantage | `storedAtEnd` |
| ---: | --- | --- | ---: | ---: |
| 600 | 204 / 0.340 | 230 / 0.383 | +12.7% | 60 |
| 1,200 | 416 / 0.347 | 440 / 0.367 | +5.8% | 60 |
| 2,400 | 840 / 0.350 | 868 / 0.362 | +3.3% | 60 |

The absolute gain is 26 / 24 / 28 planks — **flat**. Between tick 600 and tick
2,400 the depot run produced 638 planks and the control 636: after the first 600
ticks the depot contributes nothing whatever. It is full in every run. §4.3 says
what that means for §1's framing of the mechanic.

Two consequences follow, both measured. **Raising `storehouseCapacity` buys a
proportionally bigger one-off, not a rate**: the same corner chain at 2,400
ticks makes 840 planks with no depot, 868 at capacity 60 and 954 at capacity
240, with `storedAtEnd` at the full capacity in both. And **a depot beside a
camp-fed processor is not worth building**: a solo sawmill at (23,15) with a
depot at (13,8) makes 294 planks without it and **266 with it** at three haulers
(−10%), 296 without and 306 with at four. The depot can never shorten that
building's input leg, and moving the deposit off the camp leaves the hauler's
next fetch starting further from the only site that holds wood.

**3. Does the dispatch order thrash, and is the deadlock self-resolving?**

**What was measured is an *opening*-drained ledger, not a mid-run drain**, and
the distinction is stated rather than glossed because no instrument in this
repository can stage the second one. The fixture is a mill (seeded wheat →
flour) feeding a bakery (flour → bread): `seededResourcesFor` withholds every
resource a stage produces, so at t=0 there is no flour at any site in the colony
and the bakery's input must be manufactured before it can ever be delivered.
That is §2.6's deadlock shape, taken from the opening rather than from the
middle of a run.

**There is no deadlock and no thrash — the opposite.** Hauler-tick split over
600 ticks, as percentages of working (non-idle) hauler-ticks:

| fixture | haulers | made₀ | made₁ | idle | working | collect% | supply% | fetch% | out% | return% | supply returns | loaded% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill→bakery | 1 | 254 | **0** | 42 | 558 | 0 | 100 | 8 | 46 | 46 | 43 | 98 |
| mill→bakery | 2 | 313 | 150 | 80 | 1120 | 0 | 100 | 7 | 47 | 46 | 78 | 96 |
| mill→bakery | 3 | 335 | 319 | 122 | 1678 | 0 | 100 | 7 | 47 | 46 | 113 | 97 |
| mill→bakery | 4 | 394 | 375 | 175 | 2225 | 0 | 100 | 7 | 47 | 46 | 151 | 98 |
| + depot (13,8) | 2 | 309 | 210 | 91 | 1109 | 0 | 100 | **20** | 44 | 36 | 89 | 96 |
| + depot (13,8) | 4 | 383 | 357 | 200 | 2200 | 1 | 99 | **17** | 45 | 39 | 165 | 98 |
| forester→sawmill, corner | 1 | 84 | 66 | 23 | 577 | 46 | 54 | 2 | 50 | 48 | 12 | 92 |
| forester→sawmill, corner | 4 | 246 | 224 | 126 | 2274 | 41 | 59 | 2 | 49 | 48 | 49 | 88 |

`conservationError` is 0 in every one of these runs.

**Collection resumes; it never stops.** In a chain where every building wants
inputs the collect *job kind* is dispatched on 0–1% of hauler-ticks — and both
stages still produce, because collection happens on the return leg of supply
trips. §2.6's structural argument that the deadlock cannot happen is sound.

**The round trip is emphatically worth its complexity**, which is the verdict
§4.1 asked for and the one that was most at risk. 88–98% of supply trips turn
for home loaded, in every fixture and at every hauler count — 96–98% in the
two-consumer chain, and the 88% is the corner chain at four haulers, where a
hauler arriving at a sawmill whose out-tray a colleague has just emptied comes
home empty. Without the mechanic, 96–100% of the walk home in a two-consumer
colony would be an empty one. It stays.

**The fetch leg is cheap in a camp-only colony and expensive with a depot**:
2–8% of working hauler-ticks without one (2% on the corner chain, where the
source is the camp the hauler is already standing at), **17–20% with one** —
because a hauler that banked at a depot starts its next fetch there, and the
camp is the only site that will ever hold a seeded input. That is the same
defect §4.3 names, seen from the leg side rather than from the stock side.

**The real failure mode is neither of the two this question asked about.** With
one hauler the bakery at (15,9) produced **zero** bread in 600 ticks and spent
100% of its ticks in `waitingForInput`, while the mill at (12,6) made 254 flour.
Exchange the two tiles — same buildings, same crews, same single hauler — and
the bakery makes 108.

| layout | h | mill leg | bakery leg | flour | bread | mill wait% | bakery wait% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mill near, bakery far | 1 | 6 | 8 | 254 | **0** | 43 | **100** |
| mill far, bakery near | 1 | 8 | 6 | 114 | 108 | 75 | 79 |
| both beside the camp | 1 | 2 | 3 | 397 | 144 | 2 | 72 |
| mill near, bakery far | 2 | 6 | 8 | 313 | 150 | 28 | 71 |
| mill far, bakery near | 2 | 8 | 6 | 229 | 210 | 49 | 59 |

`compareSupplyCandidates` ranks on movable stock, then on the whole route, then
on ids — **with no fairness term and no ageing.** While the nearer hungry
building can still take a load it takes every one, so under hauler scarcity the
farther consumer is starved permanently rather than served late. That is not
thrash and it is not the deadlock §2.6 argued away; it is a strict priority with
no floor, and it is gameplay-visible as a bakery that never bakes. It is filed
as an issue against §2.6's ranking rather than papered over with a constant.

**The fourth reading: 12,000 ticks, with and without a depot.**

**Not obtainable at the fixture size §4.1 named, and the reason is arithmetic.**
`autoPlaceSequence` yields 40 plots (5 per row, odd rows from row 1) before
falling back to a row-major scan, and the population harness lays huts, then
houses, then depots. The chain fixture is 2 huts and 12 houses, so its depots
land at plots 15–16 — (12,5) is 11.2 tiles from the camp — while the two huts
sit on plots 1 and 2, (4,1) and (6,1), at 2.2 and 4.1 tiles. The camp is nearer
to both huts than any later plot can be, so **no depot the harness can place in
a two-hut colony is ever the nearest site to anything**, nothing is ever banked
in it, and a with/without comparison compares a run against itself:

| houses | depots | `storedAtEnd` |
| ---: | ---: | ---: |
| 12 | 2 | **0** |
| 30 | 2 | **0** |
| 40 | 2 | **120** |
| 78 | 2 | 118 |

At 40 houses the depots fall past the plot pass onto row 0 beside the camp band,
where they *are* the nearest site to the huts and fill to capacity. So the
reading is obtainable — at a different house count, and that substitution is
named here rather than the 12-house pair being quoted as though it had said
something. Taken at 40 houses, `chain` (2 huts, 2 haulers, 4 founders), 12,000
ticks, `sampleEvery: 200`:

| houses | depots | `storedAtEnd` | peak | final | trough (t≥3,000) | births | old age | starved | frozen | min meals/head |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 0 | 0 | 40 | 39 | 34 | 73 | 38 | **0** | 0 | 9.8 |
| 12 | 2 | 0 (dead depot) | 40 | 39 | 33 | 73 | 38 | **0** | 0 | 9.8 |
| 40 | 0 | 0 | 39 | 39 | 34 | 73 | 38 | **0** | 0 | 9.8 |
| 40 | 2 | **120 (live)** | 40 | 39 | 34 | 73 | 38 | **0** | 0 | 9.9 |

`birthFoodPerHead: 12` — **validated, unchanged**, now measured with the depot
increment 6's harness could not place. The curve is increment 6's own, to the
digit.

**A fifth reading, added by the plan: what does dispatch cost at scale?**

Wall clock per tick, same machine, same run length, one variable at a time. The
figures include the conservation sentinel's three probes, which walk every
building and every hauler per tick — so they overstate a production tick and
understate dispatch's share of one.

| case | buildings | haulers | ms/tick | `frozenSteps` | `storedAtEnd` |
| --- | ---: | ---: | ---: | ---: | ---: |
| realistic colony | 40 | 6 | 2.525 | 0 | 0 |
| realistic, 4 depots | 40 | 6 | 2.586 | 0 | 0 |
| stress, 8 depots | 100 | 4 | 2.879 | 0 | 67 |
| stress, 8 depots | 100 | 12 | 2.836 | 0 | 368 |
| stress, 8 depots | 100 | 40 | 3.240 | 0 | 475 |
| stress, 8 depots | 100 | 80 | **5.214** | 0 | 413 |

Two-way dispatch costs **0–5% of tick wall clock at every realistic size**,
which is inside run-to-run noise against the same colonies at `237b3b3`. The
cost *is* real and it *is* super-linear in hauler count, and it only becomes
visible when 40–80% of a 100-colonist colony is hauling, which no colony anyone
would staff does. At `baseTicksPerSecond: 2` the real-time budget is 500 ms per
tick; even the 80-hauler worst case spends **about 1% of it**. **Decision:
record the ceiling and leave the design alone** — the pre-index-source-claims-
by-site optimisation is not justified by any number this increment produced.
If a later increment makes hauler counts above ~30 in a 100-building colony
plausible, this is the measurement to re-take. `frozenSteps` is 0 at stress size
at every hauler count measured, including 80, and that is now asserted by a
committed test rather than only observed.

### 4.2 The one constant with a measured case for change, and why it did not move

`inputBufferCap` is the only constant this increment measured a causal case
against, and the case is strong. The shipped comment justified 12 as *runway* —
"12 batches, ~36 ticks for a mill, comfortably longer than the 13-tick
worst-case walk". That is not what the number does. Because a supply hauler
claims its whole load against the target's in-tray room, the cap sets how many
loads may be **walking toward one building at once**, and that is
`inputBufferCap / haulCarryCapacity` = 2. The measurement, taken by temporary
mutation and with the constant restored afterwards:

| `inputBufferCap` | leg 13, 4 haulers: %ceiling | waiting% | in-tray at end | leg 6, 4 haulers: %ceiling |
| ---: | ---: | ---: | ---: | ---: |
| **12 (shipped)** | 72 | 30 | 3 | 98 |
| 24 | **92** | 3 | 6 | 97 |
| 48 | 89 | 3 | 30 | 97 |

24 relieves it, 48 does not improve on 24 and parks 30 units of colony stock in
a single building's in-tray, where it is out of the spendable ledger and dies
with the building. The processor sweep at 24 confirms the shape rather than one
point of it: nothing anywhere gets worse, one hauler is unchanged at every
distance (a single hauler is the binding term, not the cap), and every gain
lands exactly where the in-tray was binding — leg 8 at two haulers 80 → **96**,
leg 13 at two/three/four 55/71/72 → **60/74/92**.

**And it was retuned to 24, on a branch, and measured back out.** The 31 balance
tests stay green at 24. Eight unit tests do not, and they fail for a reason that
is not fixture staleness. The clearest of them is
*"three haulers and three starved mills spread out rather than converging on
one"*: at a 12-unit in-tray one delivery claims a mill's whole room, so the
second hauler is forced to a different building; at 24 all three haulers leave
for the same mill. **`inputBufferCap` is currently the dispatcher's only
fairness floor**, and it is an accidental one.

That is not a test to retune. It is the same defect q3 measured, and doubling
the cap makes it worse — measured on the two-consumer chain, which is what a
colony actually looks like, rather than on the single camp-fed processor the
gradient instrument uses:

| haulers | bread at cap 12 | bread at cap 24 |
| ---: | ---: | ---: |
| 1 | 0 | 0 |
| 2 | 150 | **79** |
| 3 | 319 | **274** |
| 4 | 375 | 376 |

The mill — the nearer consumer — goes to its own ceiling (313 → 394 flour at two
haulers) by soaking up hauling the bakery needed, and the chain's end product,
the thing the colony eats, **falls by 47% at two haulers**. With a depot in the
same colony the picture is the same (210 → 198 bread at two haulers).

**So it stays at 12, and the reason is a sequencing one rather than a verdict on
the value.** Until §2.6's ranking has a deliberate fairness term, the in-tray
cap is doing that job by accident, and raising it removes the floor before the
replacement exists. The right order is: give the ranking a fairness floor, then
re-take this reading — at which point 24 may well be right, and the far
processor's 72% ceiling is a real cost being paid in the meantime. Both halves
are filed as issues against §2.6 and §2.1 so the pair is inherited as a
judgement rather than as a silence.

Two smaller notes on this reading, so a later increment does not have to
rediscover them. The gradient instrument is a **single-stage camp-fed sawmill**,
chosen because `ceiling` is exact there and `share` is comparable to increment
5's raw sweep row for row; it is a good instrument and a poor model of a colony,
and this retune is the case where the difference mattered. And the far-corner
balance test is a *reading*, not a guard: it fails when the constant moves, on
purpose, and its comment carries the numbers to rewrite it with.

### 4.3 Where §1 and the numbers disagree

**§1 sells the storehouse as an investment. It measures as a one-off buffer**,
and §1 was written before anyone measured. Both statements are left standing
rather than one being edited to match the other, because the disagreement is the
finding.

§1.1 says a storehouse "turns a distant cluster from a mistake into an
investment", and §1.2 offers it as the third of three answers a player has to a
badly sited processor. What the depot actually buys is 26 planks, once, and then
nothing: +12.7% over 600 ticks, +5.8% over 1,200, +3.3% over 2,400, with the
absolute gain flat at 26 / 24 / 28. Beside a camp-fed processor it is a **net
loss** of 10% at three haulers.

**The cause is structural, not a magnitude, which is why no constant in §4's
table fixes it.** A store site can only ever be filled by a building's output.
`destinationFor` and `remainderHome` deliberately refuse to route a load onward
to another site — that is the store-to-store transfer §2.13 excludes — so
nothing ever pushes camp stock outward into a depot and nothing ever brings a
depot's stock back to the camp. A depot beside a chain fills with the chain's
finished good (planks, which nothing consumes), and once full it can neither
take another deposit nor stage another input. "Can be filled but never emptied"
is a precise description of what was measured, and it is exactly what a transfer
mechanic would fix.

**This is not a removal case, and it was considered as one.** The depot does pay
in the one placement §1 argues for — a producer feeding a consumer, far from the
camp: +82% at one hauler and +17% at four, at leg 11-13 — and the crossover
against hiring another colonist exists at leg ≈ 11 from the third hauler onward.
So the mechanic wins somewhere real, on a narrow window, for a bounded amount.
What §4 records is that it is currently a **one-off buffer** rather than the
sustained investment §1 describes, and that the missing piece is a *flow*.
`docs/requirements/Storehouse-to-Storehouse Transfer.md` carries it forward with
these numbers as its justification.

The other §2.5 mechanic §4.1 invited a verdict on came out the other way and is
recorded here for symmetry: **the round trip stays.** 88–98% of supply trips
come home loaded, and in a chain where every building wants inputs it is doing
*all* of the collection. Increment 6 moved a shipped constant because a
measurement argued against it; this increment declines to remove a shipped
mechanic because a measurement argues for it. Both are the instrument working.

### 4.4 What these instruments cannot do

Three limits, recorded because each of them is a trap for the next increment
that measures this area, and one of them nearly put a false finding in this
document.

- **No mid-run drain was tested, and none can be staged today.** q3's fixture
  withholds a stage's product at t=0, so the ledger is drained at the *opening*
  and the bakery's input must be manufactured before it can ever be delivered.
  That is a genuine instance of §2.6's deadlock shape, but it is not the same
  experiment as draining a running colony, and nothing here should be read as
  though it were.
- **A with/without-depot comparison in the population harness is confounded over
  any horizon that outlives a founder.** The 12-house pair is byte-identical at
  4,000 ticks and *not* at 12,000: `lifespanFor(id, bands)` jitters each
  colonist's lifespan by entity id, and adding two storehouses shifts every
  colonist's id by two. Before the first old-age death — around tick 5,700 —
  that is invisible; after it, the two runs diverge for a reason that has
  nothing to do with the depot. The fourth reading above is honest because every
  figure it quotes agrees across all four runs, but a *tighter* comparison at
  that horizon would be measuring jitter. `PopulationScenario.storehouses`
  records this beside the placement trap it already carries.
- **The population harness's depot placement depends on the colony's size**, per
  the arithmetic in §4.1's fourth reading. A scenario that places depots and
  reads `storedAtEnd` as 0 has not measured a depot that did nothing; it has
  measured a run against itself. Every with-depot row in the captured report
  prints `storedAtEnd` for exactly this reason, so the distinction is visible
  from the output rather than having to be trusted.
