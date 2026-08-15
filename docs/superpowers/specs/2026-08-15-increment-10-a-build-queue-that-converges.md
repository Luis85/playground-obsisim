# Spec: Increment 10 — A Build Queue That Converges

**Status:** Draft
**Predecessor:** `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md`
**Backlog Feature:** `docs/requirements/Construction as Work.md`
**Issues:** measures OBS-8-06 without resolving it.

> **This increment was split out of increment 9**, which shipped construction
> itself: a site occupies its tile, provides nothing, and is finished by
> materials haulers carry to it. That increment kept the affordability rule the
> game has always had — you cannot order what you cannot pay for — and left
> dispatch ordering alone.
>
> This one changes both, and they are one change. §1.1 says why.

---

## 1. Why this increment exists

Increment 9 made building *work*: goods are carried to a site, time passes, the
building appears. What it did not change is that **the player may only order what
the colony can pay for at that instant.** So the interesting thing a colony does
— decide to grow, and then grow into that decision as goods arrive — is still not
expressible. You cannot say "build these three houses" and let the logistics
resolve; you can only say "build the one house I can afford right now", three
times, spaced by however long production takes.

**A build order should be a request.** That is the whole product change here, and
everything else in this spec is the machinery required to make it not-terrible.

### 1.1 The check and the ordering are one change, and this is the point of the split

Increment 9 §2.4 records, in detail, what leaving dispatch alone costs: several
sites ordered at once fill **round-robin**, because `compareSupplyCandidates`
ranks `movable` descending and `movable` is bounded by remaining room, so a
nearly-complete site has small `movable` and loses to a newer empty one. Three
sites finish late and together instead of one at a time.

Under increment 9's affordability check that is **slow but sound**: a queue is
bounded by what the colony could pay for, so every site in it eventually
completes. Remove the check, and the same ordering stops being slow and becomes
**broken** — twenty sites the colony cannot afford round-robin forever and none
of them ever finishes.

So:

- Removing the check without the ordering ships a build queue that crawls, which
  is the failure the player will actually meet, since a request model *invites*
  long queues.
- Adding the ordering without removing the check ships machinery with almost
  nothing to do, and measures as noise.

They ship together or not at all. Increment 9's §4.1 measurement — the completion
curve at N sites — is the sizing input for this one, and should be read before
starting.

### 1.2 Product decisions taken for this increment

- **A build order is a request, not a claim.** Ordering does not reserve
  materials and does not check affordability. Sites compete for goods through
  the supply ranking that already exists. §2.1.
- **The oldest site is served first**, and that ordering is what makes a queue of
  sites converge instead of crawling. §2.2 — it is the sharpest rule here and the
  least obvious.
- **Not a reservation.** The legible third option — check *and* hold the
  materials — is declined for the reason increment 9 declined it: it would be the
  fifth claim in a system where four claims took four rounds of review to get
  right in increment 8, and it buys a rule the player can already understand from
  watching a site sit unfed.
- **OBS-8-06 is measured here, not resolved here.** §4.2.

### 1.3 What this makes harder, deliberately

- **A player can order more than the colony can afford.** That is the direct
  consequence of the request model and it is intended: a build queue that fills
  as goods arrive is the point. §2.1 says what the palette shows instead of
  refusing.
- **Sites and producers now compete for the same goods at scale.** A site's cost
  is planks; planks come from a sawmill; the sawmill needs wood. §2.2 spends most
  of its length on this, because the obvious ordering rules all get it wrong.

---

## 2. Requirements

### 2.1 Ordering a building is a request

`handleConstructBuilding` **stops checking affordability**. It resolves the tile,
takes an id, spawns the building with `Construction(BALANCE.buildTicks)`, and
records the notice as started — all exactly as increment 9 left it, minus the
`canAfford` refusal that increment deliberately kept.

- **No affordability check and no reservation.** The player may queue more than
  the colony holds.
- **The id-exhaustion and tile checks stay, and stay before the spawn.** They are
  the two rejections that must still happen at order time, because neither is
  recoverable later.
- **The cost still leaves the ledger as materials are hauled** — at pickup, with
  consumption recorded at unload. Increment 9 built that and nothing here
  disturbs it.

**The affordability gates come out of every build surface** — three views plus
the store getter they all read, and each view gates independently. Removing the
engine refusal alone makes the behaviour **unreachable through the UI** — the worst of both, since the model
allows a queue and the player cannot express one:

| surface | today |
| --- | --- |
| `src/app/components/BuildPalette.vue:28` | `:disabled` unless `affordableDefs[id]` — cannot arm placement |
| `src/app/views/WorldView.vue:66` | the placement predicate returns `affordableDefs[m.defId]` — rejects the tile |
| `src/app/views/BuildingsView.vue:70` | `:disabled` on the table button, tooltip "Not enough resources" |
| `src/app/stores/game-store.ts:172` | `affordableDefs` itself — the getter all three read |

`affordableDefs` is **not deleted**: it stops *gating* and starts *informing*.
What it tells the player is still true and still worth showing — this order will
not start moving until the goods exist — so the tooltip becomes advisory rather
than a refusal.

This list was checked against the real files during increment 9's review and is
believed complete; confirm with `grep -rn "affordableDefs\|canAfford" src/`
before starting, because a fifth surface added since would fail silently by
continuing to refuse.

### 2.2 Which site gets served: age first

This is the increment's sharpest rule and the one an implementation will get
wrong by leaving the ranking alone.

**The problem.** `compareSupplyCandidates` ranks `movable` descending before
route. `movable` is bounded by the room left in the target's in-tray. So a site
that is nearly complete has *little* room, therefore *small* `movable`, therefore
**loses** to a site that was ordered later and is still empty. Twenty ordered
sites round-robin, each one's last material delivered last, and none of them
finishes until nearly all of them do.

**The rule, in two parts:**

1. **A site is never in the starvation band.**
2. **Site selection is a separate phase, not a comparator term.**
   `nextSupplyTarget` picks the best site candidate among sites, picks the best
   candidate among non-sites by the existing comparator, and then chooses between
   those two winners with one ordinary comparison.

**Phase 1 is two steps, not one, and collapsing it reintroduces the bug this
design exists to prevent.** A `SupplyCandidate` is a **building-source pair** —
it carries `buildingId` *and* `siteId` (`haul.ts:355`) — so one site with its
material available at both the camp and a depot produces *several* candidates
with the **same `siteAge`**. "Lowest age wins" leaves those tied, and a tie
resolved by whichever came first in the array is exactly the
iteration-order dependence the two-phase form was introduced to eliminate. It
would be a quieter bug than the non-transitive comparator, not a smaller one:
the *site* served would be right every time, and only the *route* would wobble.

So phase 1 is:

1. **the lowest `siteAge`** — which site the player ordered first;
2. **then the existing comparator among that site's own candidates** — which
   source to fetch from, decided by the terms that already decide it for every
   finished building: `movable`, route, ids.

Two steps, each a total order, and the second one is the machinery increment 7
and 8 already built and tested. No new tie-break is invented here.

**What this guarantees, stated exactly, because a looser phrasing is an
overclaim.** The rule is *the oldest site **that has a candidate this tick** is
served first* — not *the oldest site is always the one served*. A site leaves the
candidate set for **two** distinct reasons, and both are correct rather than
leaks:

- **Its room is fully claimed.** `needOf` returns null once remaining room is
  spoken for by in-flight deliveries (`room − claimedIn <= 0`), so the oldest
  site drops out while its materials are still walking and the next-oldest is
  served. There is nothing useful left to send it; sending more would overfill
  it.
- **Nothing in the colony holds what it needs.** `needOf` names ONE resource —
  the proportionally shortest — and `supplyCandidates` only emits pairs for
  sites *holding* that resource (`sitesHolding`, `haul-dispatch.ts:240`). So an
  older site short of planks, with no planks anywhere, emits **nothing**, while a
  younger site short of wood emits candidates and is served.

**The second case must not be "fixed" by blocking the younger site.** Holding
haulers idle in front of a site that cannot be helped, while goods exist that
another site can use, costs throughput to buy an ordering nobody asked for — and
it would not even speed the older site up, because the thing it waits on is
production, not haulage. Age orders the sites that *can* be served; it does not
reserve the colony for the oldest one.

**It follows that completion order is the common case and not a hard guarantee.**
If the oldest site's claimed loads are walking long legs and a younger site's are
walking short ones, the younger can finish first. Forcing strict completion order
would mean holding haulers idle rather than serving a servable site, which costs
throughput to buy an ordering the player did not ask for. §3's criterion is
written against the guarantee this rule actually makes.

`compareSupplyCandidates` itself gains **only** part 1. It stays a single total
order and no age term is added to it.

**Why age cannot be a comparator term, which an earlier draft got wrong.** That
draft applied age "when both candidates are sites". That makes the comparator
**non-transitive**, and `nextSupplyTarget` is a reduction (`compare(candidate, best) < 0`),
so a cycle makes its winner depend on candidate iteration order — the one
property every selection in this codebase commits to *not* having. The cycle,
with nothing starving:

| pair | decided by | winner |
| --- | --- | --- |
| old site (movable 1) vs new site (movable 6) | age | **old site** |
| new site (movable 6) vs a finished building (movable 4) | `movable` | **new site** |
| finished building (movable 4) vs old site (movable 1) | `movable` | **finished building** |

Old beats new, new beats the building, the building beats old. Feed those three
in the order building, old, new and the *newest* site wins.

The two-phase form is transitive by construction: each phase is a total order
over a disjoint set, and the final step is a single pairwise comparison rather
than a reduction over a mixed set. It also mirrors what this section already says
conceptually — "which site did the player order first?" and "which producer is
blocked?" are two questions, so they are answered by two selections rather than
by one comparator asked to hold both.

Everything else is untouched: the cross-comparison between the two winners uses
the existing terms — starvation, `movable`, route, ids — exactly as two finished
buildings are compared.

**Age needs no new state.** `IdCounter.take()` is monotone, so a lower building
id *is* an earlier order. The tie-break chain already ends at building id; this
promotes that same field to the front when both sides are sites, and the "no
memory between ticks" property survives untouched.

**Why a site is never starving.** The band promotes a building holding zero of
what it needs, because a producer at zero produces nothing while one holding some
is working — it means *blocked*. A site produces nothing by definition. It is not
blocked, it is unbuilt, and there is no output being lost while it waits. Reading
"holds zero" as starvation for a site would also promote the newest site over the
one closest to completion, which is the round-robin failure arriving through the
fairness fix rather than through `movable`.

**What an earlier draft got wrong, because the failure it causes is worse than
the one it fixes.** That draft put *sites ahead of finished buildings*
unconditionally. That is a priority inversion: a site's cost is planks, planks
come from a sawmill, the sawmill needs wood — and sites outranking the sawmill
send every log to the sites, so the sawmill never produces, so the oldest site
waits on planks that can never arrive. A continuously extended queue starves the
producer indefinitely.

Removing that clause fixes the *immediate* inversion without any dependency
machinery, and part 1 of the rule is what makes it work: a sawmill with an empty
in-tray *is* starving, sites are *never* starving, so a blocked producer outranks
a queue of sites. Two questions — "which producer is blocked?" and "which site
did the player order first?" — asked in two disjoint comparisons, neither needing
to know about the other.

### 2.3 The producer protection is one load deep, and that is a known limitation

**The predicate is
`!batchActive && couldStartBatch && holdsNoneOf(input, resource) && claimedIn === 0`**
(`haul-dispatch.ts:236`), so the *first* claim toward a producer clears its
starvation flag. With several sites whose cost includes both wood and planks:

1. the sawmill is empty, so it is starving and wins one 6-unit wood claim;
2. `claimedIn` is now non-zero, so it stops being starving;
3. the sites, with large `movable`, take every remaining log;
4. the sawmill turns its 6 wood into 6 planks, and the oldest site needs 10;
5. the rest of the wood is consumed inside younger sites' in-trays.

**It is a stall, not an unrecoverable deadlock**, and the recovery is
cancellation: cancelling a younger site refunds its materials in full, returning
that wood to the ledger. Increment 9 shipped that refund and tested that the
returned goods re-enter the ordinary supply path, so the recovery is a property
this increment inherits rather than one it has to establish.

That is a real and discoverable player action, and it is why this ships as a
limitation rather than a blocker. **But it is reachable by doing exactly what
§2.1 invites** — queueing more than the colony can currently afford — so a player
must not be the first to find it, and §4.1 measures how reachable it is.

**Fixing it properly is a decision rather than a patch**, and the options are
recorded because a successor will want them:

- **reserve** a producer's inputs against the demand of sites needing its output
  (a dependency graph — the most correct and by far the most machinery);
- **cap** the share of a resource all sites may hold at once (a global throttle —
  one constant, no graph, and it degrades gracefully);
- **widen the band** so it survives until a producer can actually run a batch
  rather than until its first claim (deeper than it looks, and it changes
  dispatch for producers generally, including cases with no sites in them at
  all).

§4.1 measures how reachable the stall is at realistic queue lengths, so the
choice is made against a number rather than an intuition. **Do not implement one
of these speculatively during this increment** — the measurement is the
deliverable, and the third option in particular touches behaviour that has
nothing to do with construction.

### 2.4 What a site publishes

Increment 9 already publishes a site's per-material shortfall in the Buildings
table. Under a request model that display stops being a nicety and becomes the
**only** explanation the player has for a site that is not moving — there is no
longer a refusal at order time to tell them the goods were short. It is not
changed here, but it is now load-bearing, and a regression in it is a P1 rather
than a cosmetic bug.

The Economy view's **build backlog** is likewise inherited and likewise becomes
more important: it is where "I have queued more than I can feed" shows up as a
number.

### 2.5 Out of scope

- **A player-ordered build priority or queue reordering.** Age is the order.
  Letting the player reorder is a UI and a persistence problem that only becomes
  interesting once a queue is long enough to want it — which, after this
  increment, it finally will be. A good successor.
- **Resolving the §2.3 stall.** Measured, not acted on. The three options are
  recorded above so the decision is informed; taking one is the next increment's
  business.
- **Resolving OBS-8-06.** Measured, not acted on. §4.2.
- **Any change to what a site is**, what it excludes, how it saves, or how it
  completes. All of that is increment 9's and is assumed working. If this
  increment finds itself editing `ConstructionSystem`, something has gone wrong.

---

## 3. Acceptance criteria

1. **A site can be ordered without the materials existing**, and completes later
   when they do — through the command handler *and* through all four UI surfaces.
   The engine-level and UI-level tests are both required: an engine test passes
   regardless of the gates, which is exactly how a half-done version of this
   would ship.
2. **The oldest servable site is always the site served.** Five sites ordered at
   once, all needing the same available material, are filled one at a time rather
   than round-robin: no younger site receives a load while an older one still has
   unclaimed room **and a candidate**. This is the discriminating test for §2.2
   and it **fails against increment 9's unmodified ranking** — confirm that
   before implementing.

   Both qualifiers are load-bearing and §2.2 explains them. "Unclaimed room"
   because a site drops out once its room is spoken for by walking deliveries;
   "and a candidate" because a site whose needed resource exists nowhere emits
   nothing at all, and a younger site is then correctly served ahead of it. The
   fixture gives every site the same material precisely so the second case
   cannot fire and confuse the first.

   Stated as a serving rule rather than as "they complete in order of ordering",
   which §2.2 explains is not guaranteed: unequal leg lengths can let a younger
   site finish first.
3. **A blocked producer outranks a queue of sites.** A staffed sawmill with an
   empty in-tray is served before any site, with sites queued that need its
   planks. Fails against a "sites first" ordering.
4. **The winner does not depend on candidate order**, and this must be proved in
   **two** shapes, because they fail for different reasons:

   - **Mixed kinds.** All six permutations of an old site with small `movable`, a
     newer site with large `movable`, and a finished building between them select
     the same winner. This is the transitivity criterion — the cycle in §2.2 only
     exists across the site/non-site boundary.
   - **Multiple sources for one site.** All permutations of several candidates
     for the **same** oldest site — its material available at the camp and at a
     depot — select the same source. A candidate is a building-source pair, so
     phase 1's age term alone leaves these tied; only the second step of phase 1
     breaks it. The mixed-kind fixture uses one candidate per building and cannot
     catch this.
5. **Among finished buildings, nothing has changed.** Every existing dispatch
   test passes untouched.
6. **Conservation is exact** across every balance scenario, long queues included.
7. **`npm run check:all` green**, no baseline loosened, no suppression added,
   every `src/` file at or under 500 nonblank lines.

---

## 4. Balance values

**No new constants.** This increment removes a check and reorders a selection;
`BALANCE.buildTicks` is increment 9's and is not retuned here unless §4.1 finds
the queue behaviour makes its measured value wrong.

### 4.1 What must be measured

- **Convergence, against increment 9's baseline.** N sites ordered
  simultaneously, completion order and the completion *curve* recorded, at one
  hauler and at four. Increment 9's §4.1 measured the same fixture under
  round-robin; **the reading here is the difference**, and it is the only
  evidence that this increment did what it exists to do. A curve that has not
  changed shape means the ordering rule is not reaching the case it was written
  for.
- **How reachable the §2.3 stall is.** Sites costing both wood and planks, queued
  against a chain that makes the planks, at queue lengths of 1 / 3 / 5 / 10. The
  reading is the queue length at which the first completion stops happening —
  which is the number that decides whether the residual hazard needs the
  dependency graph, the global throttle, or nothing at all. Report it even if it
  is "never at any length this fixture can express", because that is the result
  that would close the question.

  **This is a separate sweep from the convergence one** and must not be folded
  into it: the convergence fixture has no dependency chain in it, so it cannot
  produce the stall at any N, and reporting "no stall observed" from that fixture
  would be a confident wrong answer.
- **What a queue costs a colony.** Ticks from order to first output for the last
  site in a queue of N, against the same site built alone. This prices the thing
  the player is actually being offered — "queue it and forget it" — and is the
  reading that would justify or kill a future priority UI.

### 4.2 OBS-8-06, measured and not resolved

`OBS-8-06` records that the staging half of the transfer mechanic is reachable,
correct and almost never worth a trip — 0 dispatches on the headline fixture
against 145 drains — and argues the case for deleting it is **not yet made**,
because every fixture in the repository puts the camp within a few tiles of
everything that consumes.

A construction site is a consumer at an arbitrary player-chosen tile, which is
precisely the remote fixture that issue says is missing. It lands here rather
than in increment 9 because taking the reading requires a dispatch change, and
increment 9 deliberately made none.

**Connect the instrument before taking the reading.** `demandSourcesOf`
(`haul-transfer.ts:54`) skips unstaffed buildings and derives demand from
`recipe.inputs` alone, so as the engine stands **a remote site creates no depot
demand and staging cannot fire for it at any distance.** Teach it about sites —
unstaffed, demand from `cost` — and prove it with a fixture showing a depot
acquiring demand from a nearby site. Measuring first would produce a confident
zero from an instrument that was never wired up, which is the increment-7 harness
failure repeating.

Then: a site ordered far from the camp with a depot between. Report whether
staging fires, how often, and whether the site completes sooner with the depot.
Three outcomes are possible and **all three are worth having — do not tune to
reach one of them**:

- **Staging fires and pays** — OBS-8-06 closes, the deletion case is dead, and
  the mechanic has found the fixture it was written for.
- **Staging fires and does not pay** — the mechanic works and is not worth its
  trips even at its own best fixture, which is what OBS-8-06 asks for.
- **Staging still does not fire** — the trigger condition is narrower than
  situational, and OBS-8-06's second hypothesis is the live one.

This increment reports which. Acting on it belongs to OBS-8-06.
