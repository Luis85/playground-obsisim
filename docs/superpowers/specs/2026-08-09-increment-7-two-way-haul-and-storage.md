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
  every caller resolves its destination through `nearestSiteWithRoom(…,
  heldAt, amount)` with the **same reservation-aware `heldAt`** dispatch uses,
  and banks only into what that returns. The camp's unbounded capacity is what
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
  `legTicks`. Use `haulTicksBetween(the leg's frozen origin, new tile, …)`.
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
  was on, and stands at the camp on load. This
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
hauler-ticks between the two kinds over a long run, and how often a supply trip
returns loaded; the round-trip mechanic in §2.5 is only worth its complexity if
that number is not near zero.

**The fetch leg is the overhead to watch.** A supply trip is three legs where
the discarded base model made it two, and the first leg buys nothing but
position. Report its share of hauler-ticks. If it is large, the ranking in §2.6
— which orders on the *whole* trip rather than on either leg — is not doing its
job of keeping haulers fetching from the nearest stocked site.

**A fourth reading, taken for free and worth having:** the population harness
staffs but **cannot build** (increment 6 §4.1). Increment 6 flagged that as a
conservative control; with a storehouse in the game it becomes a distortion,
because a colony that cannot build a depot cannot play this increment. The
harness extension should let a scenario place one, and the 12,000-tick chain
run should be repeated with and without — if the retuned `birthFoodPerHead: 12`
holds in both, that is a result worth recording beside increment 6's curve.
