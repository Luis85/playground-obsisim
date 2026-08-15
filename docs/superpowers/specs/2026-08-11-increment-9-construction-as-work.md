# Spec: Increment 9 — Construction as Work

**Status:** Draft
**Predecessor:** `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md`
**Backlog Feature:** `docs/requirements/Construction as Work.md`
**Issues:** closes OBS-5-03 by construction. Measures OBS-8-06 without resolving it.

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

- **A build order is a request, not a claim.** Ordering does not reserve
  materials and does not check affordability. Sites compete for goods through
  the supply ranking that already exists. §2.3.
- **The oldest site is served first**, and that ordering is what makes a queue of
  sites converge instead of crawling. §2.4 — it is the sharpest rule in the
  increment and the least obvious.
- **No builder role.** A site completes on materials plus a fixed build time. A
  fourth call on the same colonists would make this increment about labour
  allocation, and the thing that is actually missing is that materials are
  carried. §2.5, and §2.12 records what that defers.
- **OBS-8-06 is measured here, not resolved here.** A construction site is a
  consumer at an arbitrary player-chosen tile, which is precisely the remote
  fixture that issue says the repository lacks. §4.2.

### 1.3 What this makes harder, deliberately

- **A player can order more than the colony can afford.** That is the direct
  consequence of the request model and it is intended: a build queue that fills
  as goods arrive is the point. §2.3 says what the palette should show instead of
  refusing.
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
- **A site wants every material, not one.** `shortestOf` already handles a
  multi-input recipe by proportional shortfall, and this is the first content in
  the game that exercises it — every shipped recipe has zero or one input, a gap
  increment 8 had to work around with a fixture-local def. Construction costs
  make the multi-input path real, and §2.11 requires it be tested as such.

Everything downstream — `supplyCandidates`, claims, the round trip, the
conservation sentinel — is unchanged. A site is a building that needs things.

### 2.3 Ordering a building is a request

`handleConstructBuilding` **stops calling `stockpile.pay`**. It resolves the
tile, takes an id, spawns the building with `Construction(BALANCE.buildTicks)`,
and records the notice as *started* rather than *built*.

- **No affordability check and no reservation.** The player may queue more than
  the colony holds. The build palette stops refusing and starts *informing*:
  what a site still needs is a fact the Buildings table can show, and §2.10 puts
  it there.
- **The cost leaves the ledger when materials enter the site's in-tray**, through
  the `recordConsumed` call `unload` already makes. This is not a new rule; it is
  §2.4 of increment 7's flow table applying unchanged to a new consumer.
- **The id-exhaustion and tile checks stay, and stay before the spawn.** They are
  the two rejections that must still happen at order time, because neither is
  recoverable later.

**Why not a reservation.** It is the legible alternative — you cannot order what
you cannot afford — and it was declined for a specific reason: it would be the
fifth claim in a system where four claims took four rounds of review to get
right in increment 8, and it buys a rule the player can already understand from
watching a site sit unfed. The cost is the failure mode §2.4 exists to prevent,
and that failure mode is real rather than theoretical.

### 2.4 Which site gets served: age first

This is the increment's sharpest rule and the one an implementation will get
wrong by leaving the ranking alone.

**The problem.** `compareSupplyCandidates` ranks `movable` descending before
route. `movable` is bounded by the room left in the target's in-tray. So a site
that is nearly complete has *little* room, therefore *small* `movable`, therefore
**loses** to a site that was ordered later and is still empty. Twenty ordered
sites round-robin, each one's last material delivered last, and none of them
finishes until nearly all of them do.

**The rule.** For construction candidates, **age ascending outranks every other
term** — before the starvation band, before `movable`, before route.

**Age needs no new state.** `IdCounter.take()` is monotone, so a lower building
id *is* an earlier order. The tie-break chain already ends at building id; this
promotes that same field to the front for sites, and the "no memory between
ticks" property of §2.6 survives untouched.

**The starvation band is actively wrong for sites, and this is the subtle half.**
§2.1 of increment 8 promotes a building holding zero of what it needs, because a
producer at zero produces nothing while one holding some is working. A *site* at
zero is not blocked — it is merely newer. Applying the starvation floor to sites
promotes the newest site over the one closest to completion, which is the
round-robin failure again, arriving through the fairness fix rather than through
`movable`.

So: **two questions, two orderings, discriminated by whether the building is
under construction.** For a producer, "which is blocked?". For a site, "which did
the player order first?". Both are derived from live components and neither
touches the other.

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

**Demolishing a site refunds every material delivered to it**, through
`refundAt` — not `addAt`, because nothing was produced and a cancelled build must
not inflate `Delivered/t` (§2.4 of increment 7's flow table, last row).

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

### 2.7 The six places where "exists" currently means "works"

Each is a condition that must now exclude a site, each is a separate fixture, and
the list is exhaustive by intent rather than by search:

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
  `relocatingTicks` and `starvingTicks` already use.
- **No new field is needed for the materials.** `SavedBuilding.inputBuffer`
  already round-trips, so a save taken mid-delivery restores a site with exactly
  what had arrived.

### 2.10 Snapshot and surfaces

- Building state gains `'underConstruction'`, ahead of `'relocating'` in the same
  precedence chain — a site cannot be relocating (§2.6), so the two are mutually
  exclusive and the order is a formality, but it is written down.
- **A site publishes what it still needs.** The Buildings table shows the
  shortfall per material, which is what replaces the affordability refusal §2.3
  removes: the player sees "needs 14 wood" rather than being told they cannot
  order it.
- The Economy view names a **build backlog** beside the input and output backlogs
  it already names — the same shape, a different consumer.
- The canvas draws a site distinctly from a finished building. No new glyph is
  required; this is a building state, and `'relocating'` is the precedent for how
  a state is drawn.

### 2.11 Testing and gates

Everything in `docs/process/agent-workflow.md` applies, including the two failure
modes increment 8 added. Three bind unusually hard:

- **Every clause of a compound boolean needs its own fixture.** §2.7 is six
  conditions and §2.4 is an ordering with three terms ahead of the existing
  chain; both are exactly the shape where a whole-condition mutation looks like
  coverage.
- **Multi-hauler fixtures.** Increment 8's over-claim family all passed
  single-hauler tests. §2.4's convergence rule is a *many* problem by
  construction — it cannot be observed with one site or one hauler.
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
- **A player-ordered build priority or queue reordering.** Age is the order.
  Letting the player reorder is a UI and a persistence problem that only becomes
  interesting once a queue is long enough to want it.
- **Cancelling a site partway with a partial refund of build progress.** Progress
  is not a good; materials are refunded in full and time is lost.
- **Resolving OBS-8-06.** Measured, not acted on. §4.2.
- **Roads, seasons, carts, storehouse tiers, a bounded camp.** Deferred again,
  and `docs/requirements/Seasons, Weather and Firewood.md` now exists so the
  strongest of them stops living only in a spec's out-of-scope list.

---

## 3. Acceptance criteria

1. **Ordering a building does not move the ledger.** Colony stock is unchanged on
   the order tick, and falls only as materials land in the site's in-tray.
2. **A site provides nothing.** A house under construction shelters nobody
   (including on its construction tick), a storehouse under construction is not a
   store destination, and a producer under construction makes nothing.
3. **Materials are carried.** A site at a distant tile receives its cost by
   hauler, leg by leg, with the conservation sentinel at zero throughout.
4. **The oldest site completes first.** Five sites ordered at once complete in
   order of ordering, not in reverse and not all at the end. This is the
   discriminating test for §2.4 and it fails against an unmodified ranking.
5. **A site can be ordered without the materials existing**, and completes later
   when they do.
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
- **Convergence.** N sites ordered simultaneously, completion order recorded, at
  one hauler and at four. Acceptance criterion 4 is the bound; the *shape* of the
  completion curve is the reading, and a flat one is the failure §2.4 predicts.
- **What a colony pays to grow.** The first real measurement of expansion cost:
  ticks from order to first output, for a producer built near the camp and one
  built at the far corner. Increment 5's distance gradient priced *delivery*;
  this prices *building*, and the two together are what a player weighs.

### 4.2 OBS-8-06, measured and not resolved

`OBS-8-06` records that the staging half of the transfer mechanic is reachable,
correct and almost never worth a trip — 0 dispatches on the headline fixture
against 145 drains — and argues the case for deleting it is **not yet made**,
because every fixture in the repository puts the camp within a few tiles of
everything that consumes.

**A construction site is the missing fixture.** It is a consumer at an arbitrary
player-chosen tile, it appears as a natural consequence of this increment rather
than as a test built to prove a point, and its demand is large and bursty in a
way no recipe's in-tray is.

So §4 must report, for a site ordered far from the camp with a depot between:
whether staging fires, how many dispatches, and whether the site completes sooner
with the depot than without. Three outcomes, all worth having:

- **Staging fires and pays** — OBS-8-06 closes, the deletion case is dead, and
  §1.1 of increment 8 is vindicated on ground it never got to stand on.
- **Staging fires and does not pay** — the deletion case is made on the
  mechanic's own best fixture, which is what OBS-8-06 asks for.
- **Staging still does not fire** — then the reason is structural rather than
  situational, and OBS-8-06's second hypothesis is the live one: staging is
  *dominated by construction*, because a supply trip already fetches from any
  site and delivers to the building, and no constant fixes that.

This increment reports which. Acting on it belongs to OBS-8-06.
