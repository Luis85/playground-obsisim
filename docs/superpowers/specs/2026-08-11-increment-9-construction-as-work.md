# Spec: Increment 9 — Construction as Work

**Status:** Draft
**Predecessor:** `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md`
**Successor:** `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md`
**Backlog Feature:** `docs/requirements/Construction as Work.md`
**Issues:** closes OBS-5-03 by construction.

> **This spec was split.** An earlier draft also made ordering a building a
> *request* — no affordability check, queue as much as you like — and then needed
> a new dispatch ordering to stop that queue crawling. Eleven rounds of review
> landed six of their findings inside those two sections and nowhere near the
> rest, which is the clearest signal available that they are a second increment
> rather than two more requirements of this one. They now are: increment 10.
>
> What is left here is the part that stands on its own — **materials are carried
> to a site and building takes time** — with the affordability rule the game
> already has left exactly as it is. §2.4 records what that costs.

---

## 1. Why this increment exists

`handleConstructBuilding` pays a def's cost out of the colony ledger and spawns a
complete, working building at the target tile on the same tick. No site, no
materials carried there, no time. **It is the last place in the game where goods
teleport and work happens for free** — and "goods are carried, never teleported"
is the sentence increments 4, 7 and 8 were each written to make more true.

Increments 7 and 8 both named this as their successor. It is taken now because
the machinery it needs is finished: a building with an in-tray that haulers
deliver to, claims that stop two haulers serving the same room, a dispatch
ranking with a deliberate fairness term, and a conservation sentinel that proves
nothing was lost on the way.

### 1.1 A construction site is a phase, not a new kind of thing

The backlog note asks whether a site is a fourth `BuildingDef` role or a distinct
entity kind, and estimates the increment would "roughly double" increment 7. It
is neither, and the estimate is too high, because **the precedent already exists
and is already load-bearing.**

`Relocation` is a component on an ordinary `Building` that suspends that
building's service while it is in transit. A relocating house offers no beds
(`beds.total`), a relocating storehouse is not a store site (`storeSitesOf`), a
relocating building is not a supply target (`needOf`) and the snapshot reports it
as `'relocating'`. It exists, it occupies its tile, and it provides nothing.

**A construction site is that, with the countdown driven by deliveries rather
than by distance.** So:

- No new entity kind and no fourth role. The invariant that every def fills
  exactly one of produces / shelters / stores — pinned at
  `tests/engine/content.test.ts:80` — is untouched, because construction is a
  *phase* a building passes through, not a role a def fills.
- `InputBuffer` already exists and is already a supply target. A site's demand is
  its def's `cost`, so `needOf` generalises rather than forks into a parallel
  delivery mechanism.
- Demolition, tile occupancy, the snapshot and the save all already handle
  `Building`. `SavedBuilding` already carries `inputBuffer`, so a half-built
  site's materials round-trip today with no new field.

What is genuinely new is one component, one countdown, one ordering rule, and a
careful sweep of every place where "this building exists" currently means "this
building works".

### 1.2 Product decisions taken for this increment

- **The affordability rule does not change in what it promises**: you still
  cannot order what you cannot pay for. It changes in how it is computed — the
  payment becomes a delivery, and the check becomes cumulative over the existing
  queue, because payment was what used to make consecutive orders see each
  other. §2.3. Making an order a *request* instead is increment 10's whole
  subject, and it is deferred as a unit with the queue ordering it requires.
- **No builder role.** A site completes on materials plus a fixed build time. A
  fourth call on the same colonists would make this increment about labour
  allocation, and the thing that is actually missing is that materials are
  carried. §2.5, and §2.12 records what that defers.
- **Dispatch ordering is left alone**, and §2.4 records what that costs: several
  sites at once are filled round-robin and finish together rather than one at a
  time. That is a real cost, it is bounded here in a way it would not be under a
  request model, and buying it back is increment 10.

### 1.3 What this makes harder, deliberately

- **The affordability check has to be rebuilt to mean what it says.** Payment was
  what made a second order see the first one's cost gone; with `pay` removed, the
  naive check reads the same untouched ledger for every order and stops bounding
  anything. §2.3 replaces it with a cumulative one — stock must cover this cost
  *plus* what every existing site still needs — which is a derived walk over live
  components, not a reservation.
- **"A building was constructed" stops meaning "a building works."** Six places
  in the engine currently treat those as the same statement, and one of them
  (`pending.constructed`, which homing folds in so a colonist can be sheltered on
  the tick a house appears) would silently shelter someone in a building that is
  a hole in the ground. §2.7 enumerates them.

---

## 2. Requirements

### 2.1 Construction is a phase

A new component, mirroring `Relocation` field for field:

```ts
export class Construction {
  constructor(public ticksLeft = 0) {}
}
```

`isUnderConstruction(ticksLeft)` is `ticksLeft > 0`, exported from
`src/shared/placement.ts` beside `isRelocating` and for the same reason: the
snapshot publishes the state and `src/shared/**` may not import the engine.

A building is created **under construction** with `ticksLeft = BALANCE.buildTicks`.
It occupies its tile from that moment — a site is a real obstruction, not a
reservation — and provides none of its service until the countdown reaches zero.

**The countdown does not run until the materials are all there.** Each tick, a
site whose `InputBuffer` holds its def's full `cost` decrements `ticksLeft`; a
site short of any material holds. So a site's total build time is *delivery time
plus `buildTicks`*, and the delivery half is the part the player's logistics
actually determine.

**Whether the materials are complete is derived, never stored.** It is
`InputBuffer` compared against `BUILDINGS[defId].cost`, recomputed each tick from
live components — the same rule §2.6 of increment 7 imposes on every claim, and
for the same reason: a stored flag is a second source of truth that can disagree
with the buffer it summarises.

### 2.2 A site's demand is its def's cost

`needOf` today reads `BUILDINGS[defId].recipe` and answers "what input is this
building proportionally shortest of, and how much room is left". For a site it
must read `cost` instead, and the rest is unchanged: still the proportionally
shortest, still net of claims, still capped by hauler capacity.

Two differences that follow, and both matter:

- **A site's in-tray cap is its cost, not `BALANCE.inputBufferCap`.** A mill
  costs 20 wood and 10 planks; capping its site at 12 would make it
  undeliverable. Room is `cost[resource] − held[resource]`, per resource.

  **This cap lives in two places and both must change.** `needOf` sizes the
  candidate at dispatch, and `unload` (`haul-system.ts:222`) sizes what is
  actually placed on arrival — `Math.min(trip.amount, row.input.room(BALANCE.inputBufferCap))`.
  Changing only the first leaves a mill site accepting 12 of its 30 units while
  dispatch cheerfully offers the remaining 18 forever, which is a livelock rather
  than a shortfall: the site never completes and the haulers never stop trying.
  §2.7.1 carries this as one of the three conditions that must let a site in.
- **A site wants every material, not one.** `shortestOf` already handles a
  multi-input recipe by proportional shortfall, and this is the first content in
  the game that exercises it — every shipped recipe has zero or one input, a gap
  increment 8 had to work around with a fixture-local def. Construction costs
  make the multi-input path real, and §2.11 requires it be tested as such.

**The round trip itself is unchanged — a site is a building that needs things —
but "everything downstream is unchanged" was an earlier draft's claim and it is
false.** It is corrected here rather than deleted, because an implementer reading
only this paragraph would leave exactly the defects the sections below identify:

| downstream | why it is not unchanged |
| --- | --- |
| `supplyCandidates` | staffing gate skips a site before `needOf` is reached (§2.7.1) |
| `unload` | staffing recheck, and an `inputBufferCap` placement cap (§2.7.1) |
| `Claims.input` | sums across every resource, so wood in flight eats a site's plank room (§2.11) |
| `needOf`'s resource choice | `shortestOf` ignores claims, so a site can select a claimed-out material and drop out of dispatch entirely |
| `GoodsAudit` | no construction sink, so completing a site breaks conservation (§2.11) |
| `storeSitesFrom` / `HaulSystem`'s query | never read `Construction`, so the store-site exclusion has nothing to test (§2.7.2) |

What *is* unchanged is the shape: fetch, walk, unload, bank; the reservation
model; and the flow-accounting rules. No second delivery mechanism appears.

### 2.3 Ordering a building charges on delivery, not at the order

`handleConstructBuilding` **stops calling `stockpile.pay`** and instead resolves
the tile, takes an id, spawns the building with `Construction(BALANCE.buildTicks)`,
and records the notice as *started* rather than *built*.

- **The affordability check stays exactly where it is.** `canAfford` still
  refuses an order the colony cannot pay for, and the three UI surfaces that grey
  out unaffordable defs keep doing so. Nothing about what the player may order
  changes in this increment; what changes is *when the goods move*.
- **The cost leaves the ledger as materials are hauled**, at pickup, with
  consumption recorded at unload — the two moments criterion 1 keeps apart. This
  is not a new rule; it is §2.4 of increment 7's flow table applying unchanged to
  a new consumer.
- **The id-exhaustion and tile checks stay, and stay before the spawn.** They are
  the two rejections that must still happen at order time, because neither is
  recoverable later.

**The check must be CUMULATIVE, not instantaneous, and an earlier draft of this
section got that wrong.** Payment is what used to make a second order see the
first one's cost gone. With `pay` removed, an instantaneous `canAfford` reads the
same untouched ledger for every order in the drain — several commands in one tick
all pass against the same wood, and so does a second command the next tick,
before any hauler has reached a source. Fifteen wood then funds two houses that
each need fifteen, round-robin splits it, and neither finishes. That is precisely
the broken queue §2.4 claims cannot happen here.

So the rule is: **a build order is refused unless the colony holds its cost on
top of what every existing site still needs.**

```
outstanding[r] = Σ over sites of max(0, cost[r] − held[r])
affordable(new) ⟺ ∀r: colonyStock[r] ≥ outstanding[r] + newCost[r]
```

**Derived each time, never stored.** It is a walk over live components — the same
rule §2.1 imposes on "are the materials complete", and for the same reason. It is
not a reservation and adds no claim: nothing is held, nothing is written, and two
haulers racing for the same log are still resolved by the claim machinery that
already does that.

**It is deliberately conservative by the amount in transit.** A load already
picked up has left `Stockpile` *and* has not yet landed in `held`, so it is
counted as still-needed when it is in fact already paid for. The effect is that a
colony can occasionally be refused an order it could just afford. That is the
safe direction — it never permits a queue the colony cannot fund — and correcting
it would mean reaching for `claims.input` from the command handler, which is
dispatch state that has no business there. Increment 10 deletes the whole check,
so the drift has a short life.

**What this buys, stated exactly — and it is an ORDER-TIME guarantee, not a
completion one.** At the moment each order is accepted, the colony holds enough
for it and for every site already queued. That is the whole of the claim.

**It does not survive contact with the rest of the colony, and that is not
fixable here.** The check writes nothing down, so goods it counted can leave for
another consumer before a hauler collects them: a trip already dispatched to
fetch six wood for a sawmill has not yet called `takeAt`, so that wood is still in
`colonyStock` when the check reads it, and vanishes from under the accepted site
a few ticks later. Producer dispatches after acceptance do the same.

**Reserving would not close it either**, which is why this is a relaxed claim
rather than a missing feature. Colonists eat. Any reservation strong enough to
guarantee a site completes would have to hold materials against meals, and a
colony that starves its people to finish a warehouse is a worse game than one
whose build queue occasionally stalls.

So the honest statement is: **a queue can stall under contention, it is bounded,
and it is recoverable.** Bounded because the check caps it at what the colony held
when the orders were placed — not at nothing, which is what a request model
allows. Recoverable because cancelling a site refunds its materials in full and
they re-enter the ordinary supply path (§2.6, and Task 7 tests exactly that).
§4.1 reports whether it happens in practice rather than leaving it as a worry.

**Why not a reservation.** It is the third option — check *and* hold the
materials — and it is declined for both increments: it would be the fifth claim
in a system where four claims took four rounds of review to get right in
increment 8. Increment 10 revisits the question from the other side by removing
the check entirely.

### 2.4 Dispatch ordering is unchanged, and several sites at once will crawl

**Nothing in `compareSupplyCandidates` or `nextSupplyTarget` changes in this
increment.** A site is an ordinary supply target and competes for haulers on the
terms every other target already uses. This section exists to say what that
costs, because the cost is real and a reader who does not find it stated will
assume it was not noticed.

**What goes wrong.** `compareSupplyCandidates` ranks `movable` descending before
route, and `movable` is bounded by the room left in the target's in-tray. So a
site that is nearly complete has *little* room, therefore *small* `movable`,
therefore **loses** to a site ordered later that is still empty. Order three
houses at once and they fill round-robin: each one's last material arrives last,
and none of them finishes appreciably before the others.

**Why that is acceptable here and would not be under a request model.** §2.3's
check is cumulative, so a queue never contains more than the colony held when it
was ordered. Three sites ordered together are three the colony could pay for at
once; round-robin makes them finish *late and together* rather than *early and in
order*. Slow is a fair cost for an increment whose subject is that materials are
carried at all.

**The difference from a request model is bounded-versus-unbounded, not
stall-versus-no-stall.** §2.3 is explicit that an accepted site can still be left
short when another consumer spends the goods first, so a queue here *can* stall.
What it cannot do is start out impossible: twenty sites ordered against an empty
ledger, round-robin, none ever finishing, is unreachable while the check exists
and is the default under a request model. The recovery is the same in both —
cancel a site, its materials return — which is why increment 9 tests that path
(Task 7) and increment 10 leans on it.

**And it rests on the check being cumulative.** With an instantaneous one, N sites
share one building's materials from the very first tick and none completes. §2.3
says why the naive check does not survive the removal of `pay`.

Remove the check — increment 10 — and the same ordering stops being slow and
starts being broken: a queue of twenty sites the colony cannot afford round-robins
forever, and none of them ever completes. **The ordering fix and the removal of
the check are one change, and that is why they are one increment.**

**Two consequences to be honest about within this increment:**

- **A site competes with producers for the same goods.** A sawmill's wood and a
  site's wood come from the same ledger, and a site with a large empty in-tray
  can outrank a sawmill that needs one more log. The affordability check bounds
  how much can be sitting in sites at once, so this degrades throughput rather
  than deadlocking, and cancelling a site (§2.6) returns its materials in full if
  a player does manage to tie the colony up.
- **Nothing here promises completion order.** Sites complete roughly when their
  materials arrive, and §3 states no criterion about which finishes first. An
  implementation that happens to produce ordered completions has not satisfied a
  requirement, because there is not one.

**What increment 10 does about it** is recorded in its own spec rather than
sketched here: age-first selection as a separate phase rather than a comparator
term, a site never entering the starvation band, and a measured answer to how
badly a producer can be starved by sites that need what it makes. Every one of
those was worked out during this spec's review and moved across intact — none of
it is being rediscovered.

### 2.5 Completion

When a site's countdown reaches zero:

1. Its `InputBuffer` is **emptied**. The materials are gone — they were consumed
   the moment they entered (§2.3), so this removes goods the ledger has already
   stopped counting and must not record a second consumption.
2. The `Construction` component's `ticksLeft` stays at 0, which is what
   `isUnderConstruction` reads as finished. The component is not removed —
   removal mid-tick is the deferred-drain hazard `PendingChanges` exists for, and
   a zeroed countdown is exactly how `Relocation` signals the same thing.
3. The building begins producing, sheltering or storing on the **next** tick,
   through the ordinary systems, with no special case. A house completing this
   way is homed by the same `rehome` pass that seats a colonist in any other
   house.

`BALANCE.buildTicks` is one constant for every def in this increment. §4 asks
whether it should scale with cost and answers it with a measurement rather than
here.

### 2.6 Cancellation, and what happens to delivered materials

**Cancelling a site refunds its delivered materials and NOT its def's cost**, and
getting only the first half right mints goods out of nothing.

`handleDemolishBuilding` today refunds every entry in `def.cost` unconditionally
(`placement-handlers.ts:144`), which was correct while §2.3's `pay(def.cost)`
charged it at order time. **§2.3 removes that payment.** So without a branch here:

- cancelling a site with **nothing delivered** refunds a cost the colony never
  paid — goods created from nothing;
- cancelling a **partly supplied** site refunds the full cost *and* the in-tray —
  the same goods twice.

Both are conservation failures, and conservation is the invariant this increment
is most able to break. The rule:

| demolished | cost refund | in-tray |
| --- | --- | --- |
| a finished building | **yes**, unchanged | destroyed, unchanged (increment 7 §2.7) |
| a site | **no** — nothing was paid | **refunded** — it is the only thing that was spent |

The two rows are one branch on `isUnderConstruction` in an existing loop, not a
new path. The zero-delivery cancellation is the fixture that catches the minting
case, and it is the one an implementation reading only "sites refund their
materials" will not think to write.

The site refund goes through `refundAt` — not `addAt`, because nothing was
produced and a cancelled build must not inflate `Delivered/t` (§2.4 of increment
7's flow table, last row).

**This is deliberately asymmetric with a finished building's in-tray**, which
increment 7 §2.7 destroys on demolition, and the asymmetry is the point rather
than an inconsistency to tidy away: a working building consumed its inputs into
a service the player received, while a site never rendered any service at all.
OBS-4-07 is the precedent that this repository treats "demolition silently ate
goods" as a defect worth fixing rather than a rule worth keeping.

**The refund banks at the camp** — corrected during implementation, because this
clause originally said it resolves through `destinationFor` with the
reservation-aware `heldAt`, "exactly as every other banking path does", and both
halves of that were wrong.

`destinationFor` (`haul-sites.ts:148`) takes a live `HaulTrip` and mutates its
`destSiteId`; a demolition has no trip, so satisfying the clause would have meant
fabricating one purely to read a destination out of it. And the appeal to every
other banking path is backwards: the camp is where `refundCostOf` already returns
a finished building's cost, and where `spillTo` already sends a demolished
storehouse's entire stock. Camp is the single destination the engine uses for
everything a demolition hands back, so routing a site's tray to the nearest
storehouse would have made construction the exception rather than the rule.

The behavioural cost is real and accepted: materials returned from a site far
from the camp are banked further from where the next site may want them, which
can lengthen a later haul. That is exactly what demolishing a remote storehouse
already does today, and changing it belongs in a task that changes it for every
demolition path at once, not in the one that adds a fourth.

**A site cannot be relocated.** `handleMoveBuilding` refuses one, with a notice.
Moving a hole in the ground is meaningless, the relocation price is derived from
a working building's downtime, and the interaction between a move countdown and a
build countdown is two countdowns on one entity for no gameplay gain. §2.12.

### 2.7 Where a site must be excluded, and where it must be let in

**The rule, before the lists, because the lists have twice proved incomplete.**
Every shipped predicate and constant in this engine was written when a building
was one of exactly three things: a producer, a shelter, or a store. A
construction site is none of them, and **every place that assumed a fourth kind
could not exist is a defect this increment must find.** Two rounds of review
found six such places; enumerating them one round at a time is not a method.

Four proxies carry that assumption, and each is grep-able:

| proxy | what it silently means | where it has already bitten |
| --- | --- | --- |
| `BALANCE.inputBufferCap` | "an in-tray belongs to a recipe, so 12 is enough" | `needOf`, `unload`, **and `clampedInputBuffer` on restore** (§2.9) |
| `StaffedSet` / `staffed.has(id)` | "a building worth feeding has workers" | `supplyCandidates`, `unload`, `demandSourcesOf` (§4.2) |
| `relocatingTicks === 0` | "the only way a building exists without working is that it is moving" | `usableBeds` at restore (§2.9), and the §2.7.2 list |

`canAfford` / `affordableDefs` was a fourth row here while §2.3 removed the
check. It is not one now: the assumption "you cannot order what you cannot pay
for" **stays true** in this increment, so nothing needs auditing for it. It
returns as increment 10's opening move, and the four surfaces are enumerated
there rather than left half-listed here.

**The implementer's task is to grep for all three and justify every hit**, not to
work the two lists below and stop. The lists are what two reviews found; the
table is how to find the rest.

Two halves follow, and the second is the one an implementation misses because
§2.7's title only describes the first. **A site is not merely a building that
provides nothing — it is also a building that must be fed**, and three conditions
in the delivery path use staffing as a proxy for "is this a legitimate delivery
target". A site is never staffed and must be fed anyway.

#### 2.7.1 Three conditions that must let a site in

Without all three, **no material can ever reach a site and the feature cannot
work at all**:

| place | today | required |
| --- | --- | --- |
| `supplyCandidates` (`haul-dispatch.ts:172`) | `if (!staffed.has(id)) continue` — checked **before** `needOf`, so §2.2's branch is never reached for a site | a site is a candidate regardless of staffing |
| `unload` staffing recheck (`haul-system.ts:221`) | the arrival half of the same rule; a load bounces home as an undelivered remainder | a site accepts its delivery regardless of staffing |
| `unload` capacity (`haul-system.ts:222`) | `row.input.room(BALANCE.inputBufferCap)` — a mill site costing 30 units accepts **12** and can never complete, while dispatch keeps offering the rest | room is measured against the def's `cost`, per resource, exactly as §2.2 requires at dispatch |

**The exemption is principled rather than a special case, and the reason is the
thing to write into the code.** Increment 7 §2.6 gives the staffing rule's
rationale: goods in an `InputBuffer` are out of the spendable ledger and die with
the building, so without the gate a colony short of adults would watch its stock
drain into a mill that cannot use it and cannot give it back. **Neither half of
that holds for a site.** A site's materials *can* be given back — §2.6 refunds
them in full on cancellation — and the site *will* use them, because it completes
on delivery and time rather than on labour. The condition's reason is what
decides the exemption, not the condition itself.

That also makes the two rules verifiable against each other: if a later increment
adds a builder role, or removes §2.6's refund, this exemption has to be revisited,
and this paragraph is what tells that increment so.

**Dispatch and arrival must be exempted together.** §2.5 of increment 7 requires
every dispatch condition to be reserved or rechecked on arrival, and these two
are the same rule seen from both ends — `staffed` is derived once per tick and
handed to both readers precisely so they cannot drift. Exempting only the
dispatch half sends haulers to a site that then refuses the load, which is worse
than not dispatching: the goods walk both ways and the conservation sentinel
stays at zero throughout.

#### 2.7.2 Six conditions that must keep a site out

Each is a separate fixture, and the list is exhaustive by intent rather than by
search:

| place | what must change |
| --- | --- |
| `rehome` / `pending.constructed` | A house under construction offers **no beds**, including on its construction tick. `pending.constructed` is folded into homing precisely so a colonist can be sheltered the same tick a house appears — which would now shelter them in a hole. |
| `storeSitesOf` | A storehouse under construction is **not a store site**. It already excludes relocating and demolished; this is a third exclusion in the same filter. |
| `ProductionSystem` | A site runs **no recipe**, produces nothing, and consumes no inputs of its own. |
| `needOf` | A site **is** a supply target, but for its `cost` (§2.2) — the one entry in this table that generalises rather than excludes. |
| worker assignment | A site has **no worker slots**, so `assignWorker` refuses it. There is no builder role (§1.2), so a colonist cannot be put to work on a site at all. |
| `colonyWealth` / snapshot state | A site reports `'underConstruction'`, and its def's cost is not counted as colony wealth twice — once in the ledger it left and once in the building it has not become. |

**`storeSitesOf`'s exclusion has a second-order consequence worth stating**: a
storehouse under construction near a chain is not a destination, so loads route
past it to the camp exactly as they did before it was ordered. Nothing special is
needed, and that is the test that proves the exclusion works.

### 2.8 Flow accounting

One row is added to increment 7 §2.4's table, and it is the row an
implementation reaches for `addAt` on by reflex:

| moment | records |
| --- | --- |
| a material enters a site's in-tray | **consumption** — unchanged from any other in-tray delivery, and the moment the cost leaves the ledger |
| a site completes and its in-tray is emptied | **nothing** — these goods were consumed on arrival and counting them again double-counts the build |
| a cancelled site's materials are refunded | **nothing** (`refundAt`) — the colony owned them, and a refund is not a delivery |

### 2.9 Save v7

`LATEST_SAVE_VERSION` becomes 7. `SavedBuilding` gains one field:

```ts
/** Ticks of build time left; 0 for a finished building. The construction
 * twin of `relocatingTicks`, and guarded the same way. */
constructionTicks: number;
```

- **Migration v6 → v7 sets it to 0 for every building.** Every building in a v6
  save is finished by construction — the concept did not exist — so the migration
  is total and lossless, and needs no heuristic.
- **The guard** is `isTickCounter` (`save.ts:263`), the non-negative-safe-integer
  check `starvingTicks` and `ageTicks` already use (`save.ts:277-278`). **Not the
  one `relocatingTicks` uses** — that field is guarded by a bare
  `Number.isFinite((b as SavedBuildingV4).relocatingTicks)` (`save.ts:397`), which
  accepts negatives and fractions and is strictly weaker. Earlier drafts of both
  this spec and the plan claimed `relocatingTicks` used `isTickCounter`; it does
  not, and copying that framing would give `constructionTicks` the weaker guard
  and quietly fail the "a negative or fractional `constructionTicks` is rejected"
  test's whole purpose. **That is necessary and not
  sufficient**: `relocatingTicks` is *also* clamped on restore by
  `clampedRelocation` (`spawn.ts:67`) against the current `BALANCE.maxRelocationTicks`,
  because a save written under a larger constant must not restore a countdown
  longer than the game can now produce. `constructionTicks` needs the identical
  treatment — a `clampedConstruction` bounded by the current `BALANCE.buildTicks`
  — or a site saved before the constant was lowered keeps more build time than a
  freshly ordered one. **Both restore projections must apply it**, for the reason
  `clampedInputBuffer`'s own doc comment already gives about
  `buildInitialSnapshot`: the paused projection and the live component must agree.
  The fixture's saved countdown must exceed the current constant, or it passes
  unclamped.
- **No new field is needed for the materials, but the restore path must be made
  site-aware.** An earlier draft of this section claimed `SavedBuilding.inputBuffer`
  "already round-trips" and stopped there. **That claim is false above 12 units.**
  `buildingComponents` restores through `clampedInputBuffer`
  (`spawn.ts:113`), which is `clampedBuffer(saved, BALANCE.inputBufferCap)` — so a
  fully supplied mill site holding 30 units, saved mid-countdown, reloads holding
  **12**, and 18 units the ledger has already recorded as consumed are destroyed
  by a save/load round trip.

  The clamp must take the site's cost as its bound, exactly as `needOf` and
  `unload` do (§2.2), and **per resource rather than as one total** — the
  existing `clampedBuffer` spends a single aggregate cap in catalog order, which
  would let a site over-cost in one material sit inside an under-cost total. The
  round-trip fixture must hold **more than `inputBufferCap`**, or it passes
  against the unfixed clamp and proves nothing — which is why the field is not
  the problem and the fixture value is.

  **Whatever the clamp declines must go back to the ledger.** This is what makes
  the clamp a conservation rule rather than a display one, and it is the one
  place in this increment where the fix can itself destroy goods. A site's
  in-tray sits outside `Stockpile`, so trimmed units have nowhere to fall back
  to; every other `clampedBuffer` caller can drop silently because it trims
  against a cap that has not moved since the engine wrote the save, and this is
  the first bound that can legitimately *shrink* between save and load, because
  `cost` is content and content gets rebalanced. The excess is banked to the camp
  through the restore-only path that records no delivery, and the fixture asserts
  the **colony total across the round trip**, not the kept amount.
- **`clampedInputBuffer` is called from TWO restore projections**, and fixing one
  leaves them disagreeing. `buildingComponents` (`spawn.ts:140`) builds the live
  entity; `buildInitialSnapshot` (`initial-snapshot.ts:118`) builds the **paused
  snapshot the player sees before the first tick**. Fix only the first and a
  restored 30-unit site holds 30 while the screen says 12 until something
  refreshes it. Both must be site-aware, and the fixture must assert on the
  paused snapshot.
- **"An unfinished house has no beds" has FOUR call sites**, not one. This is what
  the §2.7 table's `relocatingTicks === 0` row is for, and a grep finds them all:

  | site | what it feeds |
  | --- | --- |
  | `command-system.ts:105` | `CommandContext.shelters` — runtime homing |
  | `population-system.ts:72` | `PopulationContext` — runtime rehome |
  | `restore.ts:123` (`usableBeds`) | load-time seating; without it a save with an unfinished house and homeless colonists seats them, and the **paused snapshot reports them housed** until the first tick evicts them |
  | `save-guard.ts:95` (`colonistTargets`) | whether a save's `homeId` reference is even loadable |

  `save-guard.ts` needs the workplace half too: `colonistTargets` adds every
  building with a recipe to `workplaces` regardless of construction, so a
  hand-edited v7 save can assign a worker to a site and pass the guard.
- **One hit of that proxy is deliberately left alone**, and it is recorded here so
  the next reader does not "fix" it: `save-migration.ts:156` filters
  `defId === 'house' && relocatingTicks === 0` while seeding v5 homes. It needs no
  construction term **because the v6 → v7 migration is total** — every building in
  a pre-v7 save is finished, so no migration step can ever see an unfinished one.
  That is the same fact that makes the migration lossless, used twice.

### 2.10 Snapshot and surfaces

- Building state gains `'underConstruction'`, ahead of `'relocating'` in the same
  precedence chain — a site cannot be relocating (§2.6), so the two are mutually
  exclusive and the order is a formality, but it is written down.

  **That exclusivity is enforced by the move command alone, which is not enough
  for a save.** `handleMoveBuilding` refuses a site, but a hand-edited or corrupt
  v7 file can carry a positive `constructionTicks` *and* a positive
  `relocatingTicks`, and per-field `isTickCounter` guards both accept it. Loading
  it gives a building whose two countdowns run at once and whose relocation is
  hidden behind `underConstruction` in the snapshot. **The save guard needs a
  cross-field invariant** — the two counters may not both be positive — beside
  the per-field checks, with a fixture that supplies both. This is the same class
  as the guard's existing colonist-reference rules: a per-record check that no
  single field can express.
- **A site publishes what it still needs.** The Buildings table shows the
  shortfall per material — "needs 14 wood" — because a site that is waiting is
  otherwise indistinguishable from a site that is stuck, and the player has no
  other way to tell which.
- **`affordableDefs` must count the queue too, or the UI and the engine
  disagree.** It compares each def against `snapshot.stockpile` alone
  (`game-store.ts:172`), and §2.3 deliberately leaves that stock untouched at
  order time — so after one house is ordered against exactly one house's
  materials, all three surfaces still offer a second while the engine now refuses
  it. The getter subtracts outstanding site demand, summed from the per-material
  shortfalls the row above publishes, so no new engine field is needed. **The
  gates and the refusal must be computed from the same rule**, and a fixture with
  a site already queued is what proves they are.

  This is worth doing here even though §2.3 keeps the affordability check. The
  check tells the player they *could* pay at the moment they ordered; the
  shortfall tells them what is missing *now*, several minutes later, after meals
  and other builds have spent the ledger. They are different facts and only the
  second one explains a site that is not moving.
- **The affordability gates stay.** All four surfaces —
  `BuildPalette.vue:28`, `WorldView.vue:66`, `BuildingsView.vue:70` and the
  `affordableDefs` getter at `game-store.ts:172` — keep gating exactly as they do
  today, because §2.3 keeps the engine-side check they mirror. Removing them is
  increment 10's first task, and doing it here would leave the engine refusing
  what the UI now permits.
- The Economy view names a **build backlog** beside the input and output backlogs
  it already names — the same shape, a different consumer.
- The canvas draws a site distinctly from a finished building. No new glyph is
  required; this is a building state, and `'relocating'` is the precedent for how
  a state is drawn.

### 2.11 Testing and gates

Everything in `docs/process/agent-workflow.md` applies, including the two failure
modes increment 8 added. Three bind unusually hard:

- **Every clause of a compound boolean needs its own fixture.** §2.7 is six
  conditions, and it is exactly the shape where a whole-condition mutation looks
  like coverage.
- **Multi-hauler fixtures.** Increment 8's over-claim family all passed
  single-hauler tests, and §2.2's per-resource room is claimed against by several
  haulers at once — a one-hauler fixture cannot over-claim and so cannot show the
  bug. This binds less hard than it did while §2.4 carried an ordering rule, but
  the claim arithmetic is still a *many* problem.
- **The multi-input path is real content now** (§2.2). Every existing recipe has
  zero or one input; construction costs have two. The proportional-shortfall
  branch of `shortestOf` has never been exercised by shipped content and must be.

### 2.12 Explicitly out of scope

- **A builder role, and labour as a constraint on building.** §1.2. What it
  defers: commute and hunger affecting build speed, a fourth call on the roster,
  and the interesting question of whether building competes with producing. The
  successor is named rather than attempted, and this increment's §4 measurement
  of build time is what a labour model would have to beat.
- **Build time scaling with cost.** One constant for every def; §4 asks whether
  that is wrong and answers with a sweep.
- **Relocating a site** (§2.6).
- **Ordering a building without the materials, and the queue ordering it
  requires.** The whole of increment 10, deferred as one unit because they are one
  change: removing the affordability check is what makes a long queue possible,
  and age-first dispatch is what stops that queue crawling. Shipping either alone
  is worse than shipping neither — the check without the ordering is what this
  increment does deliberately and §2.4 prices; the ordering without the check
  would be machinery with nothing to do.
- **A player-ordered build priority or queue reordering.** Not increment 10
  either. Age is the order there; letting the player reorder is a UI and a
  persistence problem that only becomes interesting once a queue is long enough
  to want it.
- **Cancelling a site partway with a partial refund of build progress.** Progress
  is not a good; materials are refunded in full and time is lost.
- **OBS-8-06, in either direction.** Not measured here and not resolved here.
  The reading it wants is a consumer far from the camp with a depot between, and
  a site is exactly that — but taking it needs `demandSourcesOf` taught about
  sites first, and it reads most usefully against the queue behaviour increment
  10 introduces. It moves there whole.
- **Roads, seasons, carts, storehouse tiers, a bounded camp.** Deferred again,
  and `docs/requirements/Seasons, Weather and Firewood.md` now exists so the
  strongest of them stops living only in a spec's out-of-scope list.

---

## 3. Acceptance criteria

1. **Ordering a building does not move the ledger.** Colony stock is unchanged on
   the order tick — that is the whole of what this criterion claims, and the
   thing it replaces is a *build-time* debit.

   **Afterwards, stock falls at pickup and consumption is recorded at unload,**
   and these are two different moments that this criterion must not blur.
   `fetchArrival` calls `Stockpile.takeAt` the tick a hauler reaches the source
   (`haul-system.ts:188`), so published colony stock drops there, several ticks
   before the goods reach the site. Only the consumption *statistic* waits for
   `unload`'s `recordConsumed` (`haul-system.ts:229`). That split is deliberate
   and pre-dates this increment — `takeAt`'s own comment explains it — and an
   earlier draft of this criterion said stock "falls only as materials land in
   the site's in-tray", which describes neither half. Worse, it is the kind of
   wrong that gets *implemented*: deferring the removal to unload would leave
   goods spendable by `Stockpile.pay` while they ride on a hauler's back, which
   is the duplication the conservation sentinel exists to catch.

   So: unchanged on the order tick; down at pickup; consumed at unload.
2. **A site provides nothing.** A house under construction shelters nobody
   (including on its construction tick), a storehouse under construction is not a
   store destination, and a producer under construction makes nothing.
3. **Materials are carried.** A site at a distant tile receives its cost by
   hauler, leg by leg, with the conservation sentinel at zero throughout.
4. **Several sites ordered at once all complete.** Three affordable sites ordered
   together each reach completion, losing no goods. **No criterion about the
   order or the timing**, deliberately:
   §2.4 leaves dispatch ordering alone, so round-robin filling is the expected
   behaviour and a test asserting anything sharper would be asserting a
   requirement this increment does not have. What must hold is that round-robin
   is *slow* and not *broken* — nothing stalls, nothing is lost, every site
   finishes. Criterion 9 is where the sentinel itself is asserted, because the
   audit gains its construction sink with the balance instruments and not with
   the countdown.
5. **Ordering refuses what the colony cannot pay for, counting the queue.** Two
   houses each costing 15 wood, ordered against 15 wood: the first is accepted
   and **the second is refused**, in the same tick and on the following one. The
   four UI surfaces keep gating too.

   This is the criterion the split rests on, and it is the one an implementation
   passes accidentally with an instantaneous check *only* for the single-order
   case. Both orders must be attempted, and the fixture must not let a hauler
   reach a source in between — that is what distinguishes a cumulative check from
   a check that merely has not noticed yet.

   **The UI must refuse the second order too.** `affordableDefs` reads the
   published stockpile, which §2.3 leaves untouched at order time, so without
   §2.10's change the palette offers what the engine rejects.
6. **Cancelling a site refunds every material delivered to it**, and does not
   move `Delivered/t`.
7. **OBS-5-03 closes.** Demolish-and-rebuild elsewhere now costs the full
   materials and the full build time, so the relocation bypass is priced without
   any demolition history being persisted.
8. **Save v7 round-trips a site mid-build** — countdown and delivered materials
   both — and a v6 save loads with every building finished.
9. **Conservation is exact** across every balance scenario, sites in flight
   included.
10. **`npm run check:all` green**, no baseline loosened, no suppression added,
    every `src/` file at or under 500 nonblank lines.

---

## 4. Balance values

One new constant: `BALANCE.buildTicks`, **30, unchanged by the measurement and
NOT for the reason the shipped comment gives.** That comment says 30 is "well
below a relocation of any distance, so that delivery rather than the countdown
is what the player experiences as the cost of building". The first half is true;
**the second half is false everywhere except the far corner of the map**, and
§4.1 records the disagreement rather than editing the claim to fit or retuning
the constant to rescue it.

| constant | value | outcome | the measurement behind it |
| --- | ---: | --- | --- |
| `buildTicks` | 30 | **Kept, with its stated rationale contradicted.** The number is defensible; the sentence justifying it is not. | Beside the camp a house is delivered in **7** ticks and then stands still for **30**: the countdown is **81%** of the wait. At leg 8 it is 52%, and only at leg 13 does the walk overtake it (43 against 30, 41%). The delivery half does not move when the constant moves and the countdown half does not move when haulers are hired, so the two are separable and both were measured. §4.1's first reading. |
| `buildTicks`, as a FLAT rate | 30 for every def | **Reads wrong near the camp and right far from it.** Not retuned here; scaling with cost is §2.12's deferral and §4.1 says what a successor would be buying. | At leg 1 and two haulers a gatherer's hut (10 units) is finished at 32 ticks and a mill (30 units) at 40 — **three times the cost for 25% more wait**. At leg 13 the same pair reads 44 and 100, a factor of 2.3. Delivery already prices cost; the flat constant is what dilutes it, and it dilutes it most exactly where most building happens. |
| `minSupplyUnits` | 2 | **Measured to make one shipped def unbuildable.** Not touched — this increment does not change dispatch (§2.4) — and filed as **OBS-9-01**. | A `sawmill` site (25 wood) fills to **24/25** and stops forever, at every distance and hauler count measured, with the missing unit standing at the camp. `cost mod haulerCapacity` is 1, `worthMoving`'s exemption is keyed on the SOURCE's holding rather than the target's remaining need, and a site's room only ever shrinks. With homeless haulers (capacity 3) a **gatherer's hut** (10 wood) strands the same way at 9/10. |
| `inputBufferCap` / `haulCarryCapacity` / `haulTilesPerTick` | 12 / 6 / 2 | **Untouched, and untouched by construction.** | Every reading below is taken on a fixture whose stage is inert (`crew: 0`), so increment 5's gradient and increment 8's transfer readings are not re-derived here and are unchanged at HEAD. |

### 4.1 What the harness measured

Every figure below is taken with `buildTicks` at 30 unless the row names another
value. Two instruments produced them, and which one is stated on each reading
because they are not equally reproducible: the **balance harness**
(`completions`, committed in `tests/engine/balance.test.ts` and printed by
`npm run balance:report`), and a **scratch rig** deleted with the measurement
commit, which built its own world because the harness cannot express what §4.1's
third and fifth questions need — see §4.3.

**1. The build-time sweep: the countdown is not invisible beside the walk. Near
the camp it IS the walk's whole rival, and it wins.** One house site (15 wood, 5
planks), two haulers, sweeping the constant by editing it between runs. Delivery
ticks first, total second:

| `buildTicks` | leg 1 | leg 8 | leg 13 |
| ---: | --- | --- | --- |
| 10 | 7 / 16 | 28 / 37 | 43 / 52 |
| 30 | 7 / **36** | 28 / **57** | 43 / **72** |
| 60 | 7 / 66 | 28 / 87 | 43 / 102 |
| 120 | 7 / 126 | 28 / 147 | 43 / 162 |

The delivery column is constant down each leg, which is what makes the halves
separable at all. At the shipped 30 the countdown is **81% / 52% / 41%** of the
total wait at legs 1 / 8 / 13.

**And the two halves answer to different things, which is the strongest form of
the finding.** The same far-corner house at `buildTicks` 30 completes at 128 /
72 / 72 / 44 ticks with one / two / three / four haulers — delivery falls from 99
to 15 while the countdown sits at 30 throughout. So `buildTicks` is doing
something the delivery leg is not: it is the one part of the price a player
cannot buy off with logistics. Whether that is what the spec wanted is the
disagreement in §4's table — the spec said delivery would dominate, and
delivery dominates only past leg ~10.

**2. Build time wants to scale with cost, and the flat rate is most wrong where
it matters most.** One site, two haulers, delivery ticks:

| def | units | materials | leg 1 | leg 13 | total at leg 1 | total at leg 13 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gatherer's hut | 10 | 1 | 3 | 15 | 32 | 44 |
| house | 20 | 2 | 7 | 43 | 36 | 72 |
| workshop | 20 | 1 | 7 | 43 | 36 | 72 |
| mill | 30 | 2 | 11 | 71 | 40 | 100 |
| sawmill | 25 | 1 | **never** | **never** | — | — |

Delivery already scales with cost, almost exactly linearly in loads, and the
number of distinct materials does not enter it — a workshop (20 planks) and a
house (15 wood + 5 planks) are identical at every distance and hauler count
measured, which is the multi-input path behaving. **The flat countdown is
therefore a constant added to a term that is already right**, and near the camp
it is the larger of the two: a mill costs three times a hut and takes 25% longer
to appear. Scaling `buildTicks` with `unitsOf(cost)` would make a mill feel like
a mill at every distance rather than only at leg 13. It is **not done here**
(§2.12 defers it), and this is the number a successor should size it against.

**The sweep also found that a sawmill cannot be built at all** — 24 of its 25
wood, forever, at every distance and hauler count. That is **OBS-9-01**, it is a
`minSupplyUnits` threshold rather than anything construction introduced, and it
is recorded rather than fixed for the reason §2.4 gives about dispatch.

**3. A bounded queue stalls, routinely, and for as long as the contention
lasts.** §2.3 accepts that goods counted at order time can leave for another
consumer before a hauler collects them, and says §4.1 would report whether it
happens in practice. It happens in practice.

The fixture is the one §4.1 asked for: a forester feeding a staffed sawmill that
eats the same wood, a gatherer's hut feeding nine colonists who really do eat,
three haulers, an opening pile of 60 wood, and three `farm` sites (20 wood each)
ordered together at tick 0 — a queue the cumulative check accepts in full,
because 60 wood covers 60 wood of orders. 900 ticks. "Short" below means the
site's materials are incomplete and **nothing is walking toward it**:

| the sawmill's crew | wood consumed vs produced | sites completed | ticks short | longest unbroken |
| --- | --- | --- | ---: | ---: |
| 2 (parity) | ~0.67/tick vs ~0.67/tick | **0 of 3** | 884 / 884 / 889 of 900 | 875 / 854 / 817 |
| 1 (half) | ~0.33/tick vs ~0.67/tick | 3 of 3, at 98 / 98 / 114 | 43 / 48 / 64 | 29 / 29 / 27 |
| unstaffed (control) | 0 vs ~0.67/tick | 3 of 3, at 65 / 65 / 65 | 20 / 15 / 20 | 15 / 5 / 15 |

The control's 15–20 ticks are the instrument's floor — the gap between one
hauler wave and the next — not a stall.

**So the order-time check buys what §2.3 claims it buys and no more, and the
claim is thinner than it sounds.** At parity the queue was accepted against a
ledger that was genuinely there, and then never moved again: **98% of the run
short, in one unbroken stretch of over 800 ticks.** Bounded is not the same as
recoverable-by-waiting; the only recovery is §2.6's cancellation, and the player
has to work out that it is needed.

**The other face of the same fact, and it is the one that decides how much
increment 10 is really removing:** run the same colony with no opening pile —
the wood produced by the forester and eaten by the sawmill as fast as it appears
— and the check **refuses** a 10-wood hut order at tick 150 and again at tick
250. Whether the player meets a refusal or an accepted-and-frozen site depends
on nothing but whether a pile happened to exist on the tick they clicked. The
check is a snapshot of a ledger a staffed consumer drains within tens of ticks,
so **it is a lottery on timing rather than a guarantee about outcomes.**
Increment 10 removes a check that, measured, prevents a queue *starting*
impossible and does not prevent it *becoming* impossible one tick later.

**4. The round-robin: the curve is flat, and what a queue costs is the FIRST
building, not the last.** N house sites ordered on the same tick, at tiles that
are all leg 4 from the camp so nothing in the curve is distance. Completion
ticks:

| N | 1 hauler | 4 haulers |
| ---: | --- | --- |
| 1 | 65 | 35 |
| 2 | 95, 105 | 45, 45 |
| 3 | 125, 135, 145 | 55, 55, 55 |
| 4 | 155, 165, 175, 185 | 65, 65, 65, 65 |
| 6 | 215 … 265 | 75, 75, 85, 85, 85, 85 |
| 8 | 275 … 345 | 95 ×4, 105 ×4 |

**§2.4's prediction holds exactly.** At four haulers every site in a queue of
four crosses zero on the *same tick* — not close together, identical — and at
eight they land in two waves of four. At one hauler the curve is a staircase of
one round trip (10 ticks) rather than a single step, so the spread is 30 ticks
against a 185-tick wait at N=4 and 70 against 345 at N=8: 16% and 20%. Flat
enough that nothing useful arrives before nearly everything does.

**Nothing is lost and nothing is slower overall.** Every ordered site completed
in every run. Deriving a serial ordering's schedule from the measured single-site
delivery time (35 ticks at one hauler, ~10 per wave at four) puts the eighth
house at ~310 and ~110 against the measured 345 and 105 — so the *last* house
arrives at about the time it would have anyway. **The entire cost lands on the
front of the queue:**

| N | first completion, 1 hauler | vs N=1 | first completion, 4 haulers | vs N=1 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 65 | — | 35 | — |
| 2 | 95 | 1.5× | 45 | 1.3× |
| 3 | 125 | 1.9× | 55 | 1.6× |
| 4 | 155 | 2.4× | 65 | 1.9× |
| 6 | 215 | 3.3× | 75 | 2.1× |
| 8 | 275 | 4.2× | 95 | 2.7× |

**Where it starts to hurt:** at four haulers, **three sites is fine** — the first
house is 20 ticks later than it would have been alone, and a player is unlikely
to notice — while **six is where it turns**, at 2.1× and with the first four
arriving in one lump. At one hauler there is no comfortable N: even two sites
push the first house out by half again. That is the sizing input increment 10
asked for, and it says something sharper than "the queue is slow": the queue is
not slow, it is *all deferred*, and age-first dispatch is worth exactly the
front of that table.

**5. What a colony pays to grow.** Ticks from the order to the first unit in the
new building's output buffer — the site delivered, the countdown run, a worker
assigned on the completion tick, and one batch made:

| def | haulers | beside the camp | far corner | far premium |
| --- | ---: | ---: | ---: | ---: |
| gatherer's hut (10 wood) | 1 | 41 | 74 | +33 |
| gatherer's hut | 2 | 35 | 46 | +11 |
| gatherer's hut | 4 | 35 | 46 | +11 |
| farm (20 wood) | 1 | 53 | 130 | +77 |
| farm | 2 | 41 | 74 | +33 |
| farm | 4 | 35 | 46 | +11 |

**The floor is 35 ticks and 30 of it is the countdown** — a colony that hauls
perfectly still waits a third of a year for a hut. Increment 5 priced delivery
as a gradient in throughput; this prices building as a *latency*, and the two
compose the way a player would expect: the far corner costs +11 ticks with
haulers to spare and +77 without them, which is the same "hire another hauler or
build closer" decision increment 5 found, now payable in advance as well as
forever after.

**6. A site is `starving` in dispatch ordering, nobody decided that, and it
matters less than it looks — for a reason that is itself worth inheriting.**
Task 3 found rather than chose this: a site holding none of what it is offered
satisfies all four clauses of `SupplyCandidate.starving`, so it enters
`compareSupplyCandidates` in the starving band ahead of ordinary restocking.
Measured on a sawmill (crew 2) and four `farm` sites, wood inexhaustible at the
camp, 600 ticks, with the two arrangements swapped so neither answer can be an
artefact of who is nearer:

| haulers | arrangement | producer in band | sites in band | both | dispatches on a both-tick |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | sawmill leg 8, sites leg 4 | 40 | 47 | 30 | 3 — **all 3 to a site** |
| 1 | sawmill leg 2, sites leg 13 | 192 | 101 | 60 | 0 |
| 3 | sawmill leg 8, sites leg 4 | 0 | 17 | 0 | 0 |
| 3 | sawmill leg 2, sites leg 13 | 0 | 26 | 0 | 0 |

**A site outranked a genuinely blocked producer three times in 600 ticks, and
only where it was also the nearer of the two.** The band is a floor rather than
a priority, so two starving candidates tie there and the tie falls to `movable`
(6 against 6) and then to route — the site did not win *because* it was a site.
And at three haulers the producer never enters the band at all: it is either
mid-batch or already has a claim walking toward it, so the contention this
reading was taken to find does not arise in a colony that is hauling adequately.

**The queue's real cost to a producer is trip occupancy, not the band**, and it
is an order of magnitude larger:

| haulers | arrangement | planks with 4 sites queued | planks with none | cost |
| ---: | --- | ---: | ---: | ---: |
| 1 | sawmill leg 8, sites leg 4 | 180 | 192 | −6% |
| 1 | sawmill leg 2, sites leg 13 | 244 | 396 | **−38%** |
| 3 | sawmill leg 8, sites leg 4 | 367 | 386 | −5% |
| 3 | sawmill leg 2, sites leg 13 | 368 | 395 | −7% |

A camp-adjacent sawmill loses **38% of its output** to four sites at the far
corner with one hauler, because every site trip is a 27-tick round trip during
which the sawmill next door starves — and none of those trips was won in the
starving band. So increment 10 inherits this as a decision rather than an
accident, with the numbers to decide it on: **keeping sites out of the band
(§2.2 of that spec) costs almost nothing measurable and is right for the reason
it gives, but it will not buy back the throughput a queue takes from a producer,
because the band is not where that throughput goes.**

### 4.2 OBS-8-06 moves to increment 10, unmeasured

An earlier draft took the staging reading here, on the grounds that a
construction site is a consumer at an arbitrary player-chosen tile — precisely
the remote fixture `OBS-8-06` says the repository lacks. That reasoning still
holds and the reading is still worth taking; it is the *timing* that was wrong.

Taking it needs `demandSourcesOf` (`haul-transfer.ts:54`) taught about sites
first — it skips unstaffed buildings and derives demand from `recipe.inputs`
alone, so as the engine stands a remote site creates no depot demand and staging
cannot fire for it at any distance. That is a dispatch change, and dispatch is
what this increment deliberately does not touch (§2.4). Making one exception for
an instrument would put a hand into the exact machinery the split was drawn to
leave alone.

So it moves whole, with its own warning intact: **connect the instrument before
taking the reading.** Measuring first would produce a confident zero from an
instrument that was never wired up, which is the increment-7 harness failure
repeating.

### 4.3 What was left alone, and what could not be measured

- **`buildTicks` was not retuned**, though §4's table records its stated
  rationale as contradicted. Two reasons, and neither is "the number looks
  fine": a fixed, unbuyable-off price for a building is defensible product
  design even though it is not what the spec claimed it was buying; and the
  fixture that would justify a new value is a *queue*, which increment 10 is
  about to change out from under any number chosen now. **The measurement is the
  deliverable and the retune is not.**
- **Build time scaling with cost was measured and not implemented** (§2.12).
- **The hungry half of §4.1's third question was measured only weakly.** Meals
  and construction never compete for the same *resource* — nothing in the
  catalog is built out of berries — so a hungry colony can only compete for
  hauler attention. The fixture ran nine colonists eating from one gatherer's
  hut, and hunger never became the binding term; the producer did. Anyone
  reading the stall numbers should read them as producer contention, which is
  what they measure.
- **OBS-9-01 was found and not fixed** — it is a dispatch threshold, and §2.4 is
  explicit that dispatch is what this increment does not touch.
- **No mid-run drain of a running colony was staged**, for the reason increment
  7 §4.4 gives: no instrument in this repository can stage one. §4.1's third
  reading drains the ledger through a *consumer*, which is the nearest thing
  available and is not the same experiment.
- **Two readings were deliberately not run.** A `buildTicks` sweep at every
  distance × hauler count would have been sixteen more runs to re-measure a
  column already shown to be independent of the constant; and the round-robin
  curve was not taken at two or three haulers, because the one- and four-hauler
  rows bracket the behaviour and the balance project is already minutes long.
- **The scratch rig is gone, and three readings depend on it.** §4.1's third and
  fifth readings and §4.1's sixth reading of dispatch attribution were taken with a
  purpose-built world, because `runScenario` seeds every recipe input at
  1,000,000 or withholds it entirely (`seededResourcesFor`) with nothing in
  between, cannot report whether an order was *accepted*, and publishes no
  per-tick view of a site's in-tray. Reproducing them means rebuilding that rig
  from this section's fixture descriptions. What IS committed is the first,
  second and fourth readings, as two assertions and a report block in
  `tests/engine/balance.test.ts`.
