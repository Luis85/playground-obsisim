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

**What this buys, stated exactly.** Every site in the queue is fundable from
present stock. That is what makes §2.4's round-robin *slow* rather than *broken*,
and it is the sentence the whole split rests on — without a cumulative check it
is simply false.

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
check is cumulative, so a queue can never contain more than present stock funds.
Three sites ordered together are three sites the colony can pay for *at once*, so
every one of them completes — round-robin makes them finish *late and together*
rather than *early and in order*. Slow is a fair cost for an increment whose
subject is that materials are carried at all.

**This rests entirely on the check being cumulative.** With an instantaneous one,
N sites can share one building's worth of materials, round-robin splits it, and
none completes — the broken queue, inside increment 9. §2.3 says why the naive
check does not survive the removal of `pay`.

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

The refund resolves through `destinationFor` with the reservation-aware `heldAt`,
exactly as every other banking path does, so a refund cannot land in room another
hauler is already walking toward.

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
- **The guard** is `isTickCounter`, the same non-negative-safe-integer check
  `relocatingTicks` and `starvingTicks` already use. **That is necessary and not
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

One new constant: `BALANCE.buildTicks`, starting at 30 — an order of magnitude
above a recipe batch and well below a relocation of any distance, so that
delivery rather than the countdown is what the player experiences as the cost.
Unmeasured, and §4.1 says so.

### 4.1 What must be measured

- **A build time sweep** across at least three values, on a fixture where
  delivery is fast and one where it is slow. The question is whether `buildTicks`
  is doing anything the delivery leg is not already doing — if the countdown is
  invisible next to the walk, it should be said plainly rather than defended.
- **Whether build time should scale with cost.** A house (15 wood, 5 planks) and
  a workshop (20 planks) take the same time at a flat constant. Measure a chain
  that builds several of each and report whether the flat rate reads as wrong.
- **How bad the round-robin actually is.** N sites ordered simultaneously, at one
  hauler and at four, reporting the completion *curve*. This is the measurement
  that sizes increment 10 rather than a pass/fail: §2.4 predicts a flat curve —
  everything finishing at once, late — and the question is how flat, and at what
  N it starts to hurt. **Do not fix it here.** A number that says "three sites are
  fine and six are miserable" is exactly what the successor needs and is worth
  more than a rushed ordering rule.
- **What a colony pays to grow.** The first real measurement of expansion cost:
  ticks from order to first output, for a producer built near the camp and one
  built at the far corner. Increment 5's distance gradient priced *delivery*;
  this prices *building*, and the two together are what a player weighs.

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
