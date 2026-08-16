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

Under increment 9's affordability check that is **slow, and sound only in the
narrow sense the check supports**: a queue cannot start out unfundable. It can
still freeze afterwards, and §1.1.1 records that it measurably does. Remove the
check and the same ordering stops being slow and becomes **broken by
construction** — twenty sites the colony never could afford, round-robin, none of
them ever finishing, from the first tick rather than as a contention outcome.

That is the difference this increment has to preserve: it is starting-impossible
versus becoming-impossible, and only the first one is the check's to prevent.

So:

- Removing the check without the ordering ships a build queue that crawls, which
  is the failure the player will actually meet, since a request model *invites*
  long queues.
- Adding the ordering without removing the check ships machinery with almost
  nothing to do, and measures as noise.

They ship together or not at all. Increment 9's §4.1 measurement — the completion
curve at N sites — is the sizing input for this one, and should be read before
starting.

### 1.1.1 What increment 9 measured, and how it changes this increment's case

Three readings came back addressed to this spec. None of them changes what to
build; two change what to *claim*, and one is a warning.

**The check being removed is a lottery, not a guarantee — so this increment gives
up less than §1.1 implies.** Increment 9 §4.1's third question ran three farm
sites (20 wood each) accepted against a genuine 60-wood ledger, with a staffed
sawmill eating the same wood. At crew parity **none of the three completed in 900
ticks, and the queue was short for 98% of the run in one unbroken stretch of over
800 ticks.** The same colony with no opening pile *refuses* the order outright.
So the order-time check prevents a queue *starting* impossible and does nothing
about it *becoming* impossible one tick later: whether a player meets a refusal or
an accepted-and-frozen site depends on whether a pile happened to exist when they
clicked. Removing it costs less than "the thing that bounds the queue" suggests —
but the failure it fails to prevent is the same one this increment must not make
worse, and §4.1's first question here is where that is checked.

**The measured cost of a queue lands on the FIRST building, not the last** —
which is precisely what §2.2 buys back, and it is worth knowing before the work
starts. At four haulers, N sites ordered together complete on the *same tick* as
each other, and the last one arrives at about the time it would have anyway; what
a queue costs is that nothing useful arrives before nearly everything does. The
first completion goes from 35 ticks at N=1 to 65 at N=4 (1.9×) and 95 at N=8
(2.7×). **Three sites is fine and six is where it turns** at four haulers; at one
hauler even two sites push the first building out by half again. Age-first
dispatch is worth exactly the front of that table.

**A site already enters the starving band, and nobody decided that — but it is
not where a queue's cost to a producer goes.** §2.2 below rules sites out of the
band, and increment 9 measured what that is worth: a site outranked a genuinely
blocked producer **three times in 600 ticks**, and only where it was also the
nearer of the two, because the band is a floor rather than a priority and the tie
falls to `movable` and route. At three haulers the producer never enters the band
at all. **The real cost is trip occupancy and it is an order of magnitude
larger:** a camp-adjacent sawmill loses **38% of its output** to four far-corner
sites at one hauler, and none of those trips was won in the band. So §2.2's rule
is right for the reason it gives and costs almost nothing measurable — and it will
not buy back that throughput, because that is not where the throughput goes. Do
not expect the convergence measurement to show a producer recovering.

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
`BALANCE.buildTicks` is increment 9's, and §4.1 measured the queue behaviour
that could have made its value wrong. It did not: the ordering moved completion
ORDER and left the per-site countdown untouched, so the constant ships
unretuned.

### 4.1 What the harness measured

Every figure below comes from a **committed harness fixture** in
`tests/engine/balance.test.ts`, printed by `npm run balance:report`, and every
one of them can be re-taken by running that command. No scratch rig was built
and none is needed — which is the one thing this section can claim that
increment 9's §4.3 could not, and it was bought with a single new field on
`BalanceResult` (`siteInputUnits`, the units standing in ordered sites' in-trays
at the last tick). `buildTicks` is 30 throughout, unretuned, and nothing in §4
below argues for moving it.

**1. Convergence: the queue's whole cost moved off the first building, and the
last one did not pay for it.** Increment 9's §4.1 fourth reading, re-taken on
the identical fixture — N `house` sites ordered on the same tick at tiles that
are all leg 4 from the camp, so nothing in the curve is distance. Completion
ticks, increment 9's round-robin against this increment's age-first:

| N | 1 hauler, increment 9 | 1 hauler, now | 4 haulers, increment 9 | 4 haulers, now |
| ---: | --- | --- | --- | --- |
| 1 | 65 | **65** | 35 | **35** |
| 2 | 95, 105 | **65, 105** | 45, 45 | **35, 45** |
| 3 | 125, 135, 145 | **65, 105, 145** | 55, 55, 55 | **35, 45, 55** |
| 4 | 155, 165, 175, 185 | **65, 105, 145, 185** | 65, 65, 65, 65 | **35, 45, 55, 65** |
| 6 | 215 … 265 | **65, 105 … 265** | 75, 75, 85, 85, 85, 85 | **35, 45 … 85** |
| 8 | 275 … 345 | **65, 105 … 345** | 95 ×4, 105 ×4 | **35, 45 … 105** |

**The first completion is now constant in N** — 65 at one hauler and 35 at four,
at every queue length from one to eight. Increment 9 published that same column
as 65 / 95 / 125 / 155 / 215 / 275 (up to **4.2×**) and 35 / 45 / 55 / 65 / 75 /
95 (up to **2.7×**); the whole of that table is now 1.00× at every row. The
sizing input §1.1.1 asked for — "three sites is fine and six is where it turns"
— no longer describes anything: at these fixtures there is no N at which the
first building arrives later than it would have alone.

**And the last completion did not move by a single tick.** 185 at N=4 and 345 at
N=8 at one hauler; 65, 85 and 105 at N=4, 6 and 8 at four. Every ordered site
completed in every run, at both hauler counts and every N. So this is a pure
redistribution: the ordering did not buy throughput and did not spend any
either, which is exactly what §2.2 claimed for it and is worth stating as a
measured fact rather than as an argument.

**The shape inverted as §2.2 predicted, in both directions.** At four haulers
increment 9's flat step — four sites crossing zero on the same tick — is now a
10-tick staircase, one site per wave. At one hauler the spread at N=8 is 280
ticks of a 345-tick wait (**81%**) where round-robin left 70 of 345 (20%).
Useful buildings now arrive throughout a queue instead of all at the end of it.

**2. How reachable the §2.3 stall is: at no queue length up to ten does the
first completion stop happening.** A separate sweep, as §4.1 required, because
the convergence fixture has no dependency chain in it and could not have
produced this at any N. The fixture: `house` sites (15 wood **and** 5 planks
each) against a two-crew forester feeding a staffed sawmill, three haulers, 900
ticks, and **nothing seeded** — a two-stage scenario withholds every resource a
stage produces, so the only wood in the colony is the forester's and the only
planks are the sawmill's.

| sawmill crew | sawmill leg | queue | first completion | last | completed | wood made | planks made |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 (parity) | 2 | 1 | **never** | — | 0 of 1 | 600 | 592 |
| 2 (parity) | 2 | 3 | **never** | — | 0 of 3 | 600 | 592 |
| 2 (parity) | 2 | 5 | **never** | — | 0 of 5 | 600 | 592 |
| 2 (parity) | 2 | 10 | **never** | — | 0 of 10 | 600 | 592 |
| 1 (half) | 2 | 1 | 116 | 116 | 1 of 1 | 600 | 297 |
| 1 (half) | 2 | 3 | 116 | 209 | 3 of 3 | 600 | 297 |
| 1 (half) | 2 | 5 | 116 | 296 | 5 of 5 | 600 | 297 |
| 1 (half) | 2 | 10 | **116** | 520 | 10 of 10 | 600 | 297 |
| 2 (parity) | 10 | 1 | 113 | 113 | 1 of 1 | 488 | 454 |
| 2 (parity) | 10 | 3 | 137 | 244 | 3 of 3 | 494 | 430 |
| 2 (parity) | 10 | 5 | 186 | 364 | 5 of 5 | 510 | 413 |
| 2 (parity) | 10 | 10 | **186** | 655 | 10 of 10 | 536 | 363 |

**Where the queue is served at all, its length does not delay the first
building.** At half crew the first house completes at tick 116 whether one site
was ordered or ten, and all ten finish inside the run — the convergence property
of reading 1, holding under production contention rather than under haulage
alone.

**Where a queue DOES bite, it is a delay of 1.65× and not a stall.** With the
sawmill at leg 10 and at crew parity, the first completion slips 113 → 137 → 186
→ 186 as the queue goes 1 → 3 → 5 → 10, and every site still finishes. That is
§2.3's mechanism, measured: the oldest site's room fills, it drops out of the
candidate set while its planks are still unmade, and the wood that follows lands
in younger sites' in-trays instead of in the sawmill — whose output falls 454 →
363 (**−20%**) across the same sweep. **This is the number the §2.3 decision
should be made against, and it does not buy the dependency graph.** Nothing
freezes, nothing needs cancelling, and the worst case measured is a first
building arriving two-thirds later than it would have alone. Of the three
options §2.3 records, the cheap global cap is the only one this figure argues
for at all, and "nothing" is defensible.

**THE PARITY ROWS ARE A DIFFERENT FAILURE, AND IT RUNS THE OTHER WAY ROUND FROM
§2.3.** With the sawmill beside the camp and at crew parity, **nothing completes
at any queue length including ONE**, the sites' in-trays are empty at the end,
and 592 of 600 logs became planks. §2.3 describes sites taking every remaining
log from a producer; what this fixture shows is the producer taking every log
from the sites. A sawmill re-enters the starvation band after each batch, a site
is never in it (§2.2), and a camp-adjacent producer's claim cycle is short
enough to catch each log as it lands — move the same sawmill ten legs out and
the sites are served, which is what makes this a fact about the claim CYCLE
rather than about the band alone. **A queue of one suffers it in full, so it is
not reachable by queueing and this increment does not make it worse** — but it
is worth recording twice over: it is increment 9's third reading arriving from
the other side, and it is the case §2.3's third remedy ("widen the band" until a
producer can run a whole batch) would make **worse** rather than better.

**3. What a queue costs a colony: the last building pays for the whole queue,
and a priority UI would only choose who pays.** `gatherersHut` sites (10 wood) —
a hut has a recipe, so "first output" is a question that can be asked of it —
ordered together at the same leg-4 tiles:

| haulers | N | first | last | last vs the same hut alone |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 45 | 45 | 1.00× |
| 1 | 3 | 45 | 85 | 1.89× |
| 1 | 5 | 45 | 125 | 2.78× |
| 1 | 8 | 45 | 185 | **4.11×** |
| 4 | 1 | 35 | 35 | 1.00× |
| 4 | 3 | 35 | 45 | 1.29× |
| 4 | 5 | 35 | 55 | 1.57× |
| 4 | 8 | 35 | 65 | **1.86×** |

"Queue it and forget it" prices out as: **the first building arrives exactly when
it would have arrived alone, and the eighth arrives four times later at one
hauler and not quite twice as late at four.** Reading 1 already showed the last
completion is the same tick a round-robin dispatcher produced, so **the total is
fixed and only its distribution is in play** — which is the answer §4.1 wanted
about a future priority UI. Such a UI cannot make a colony grow faster; it can
only let a player choose which building is the one that arrives first, and age
already gives them that for free by ordering. **That is an argument against
building it, not for it**, at least until a queue can be reordered for a reason
other than latency.

**The "first output" half is DERIVED rather than measured, and here is the error
bar.** This harness issues one command (`constructBuilding`) and cannot assign a
worker, so the last step of increment 9's fifth reading — a colonist assigned on
the completion tick, one batch run — is not reproducible here. Adding
`completion + ticksPerBatch` to a hut built alone gives:

| fixture | derived | increment 9 §4.1 reading 5 |
| --- | ---: | ---: |
| hut beside the camp, 1 hauler | 36 + 3 = **39** | 41 |
| hut at the far corner, 1 hauler | 72 + 3 = **75** | 74 |
| hut beside the camp, 2 haulers | 32 + 3 = **35** | 35 |

Within two ticks, and exact on one row against a rig that no longer exists.
Anyone re-taking this should treat first output as "completion plus one batch,
±2", and the honest reading of the table above is that a queue's cost is a
completion-tick cost: the batch that follows is a constant both arms pay.

**4. What was not measured, and what is weak about what was.**

- **Two- and three-hauler columns were not taken**, for increment 9's reason:
  the one- and four-hauler rows bracket the behaviour and the balance project is
  already four minutes long.
- **The stall sweep ran at three haulers only**, and at two crew arrangements
  and two sawmill tiles. The 1.65× above is one point in a space with at least
  four dimensions in it, and it should be quoted as "measured at this fixture"
  rather than as the cost of a queue in general.
- **Both queue fixtures start from an empty ledger.** `runScenario` seeds a
  resource at 1,000,000 or withholds it entirely, so a chain fixture has no
  opening pile at all — where increment 9's stall reading gave its colony 60
  wood. A player queueing against a real pile sits between the two, and neither
  instrument can express that.
- **A site's in-tray is still only sampled at the END of a run**
  (`siteInputUnits`). Increment 9's "ticks short, longest unbroken stretch"
  instrument was a scratch-rig capability and remains one; this section
  therefore says "did not complete" where that one could say "was short for 884
  of 900 ticks".
- **`buildTicks` is not retuned**, and this section found no reason to. It sits
  outside every difference measured here — the queue moved completion ORDER and
  left the per-site countdown alone — so increment 9's decision to keep the
  value and withdraw its stated rationale stands unchanged.

### 4.2 OBS-8-06, measured and not resolved

**The instrument was connected first, and it had to be.** `demandSourcesOf`
(haul-transfer.ts) skipped every unstaffed building and derived demand from
`recipe.inputs` alone. A construction site is never staffed and has no recipe —
its demand is its `cost` map — so **a remote site created no depot demand, no
depot ever had a deficit to be staged into, and staging could not fire for a
site at any distance.** It now gates on `acceptsSupply` (the rule that already
decides which buildings a hauler may deliver to) and reads a site's cost, proved
by a fixture in `tests/engine/systems/haul-transfer.test.ts` where a depot
beside a house site acquires a wood and planks demand from it — with the site
asserted unstaffed, so the demand cannot have arrived through the staffing gate,
and with a FINISHED house of the same def as the control that pulls nothing.
Three mutations redden it, including the exact pre-increment form.

**The reading.** One or three `house` sites at the far corner (23,15), 26 tiles
of walking from the only goods in the colony, with a depot at (12,8) on the line
between them; 400 ticks:

| sites | haulers | depot | completions | staging dispatches | depot peak | depot at end | supply ticks | loaded-leg ticks |
| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | no | 128 | 0 | 0 | 0 | 108 | 52 |
| 1 | 1 | yes | **128** | 2 | 12 | 12 | 102 | 52 |
| 1 | 2 | no | 72 | 0 | 0 | 0 | 108 | 52 |
| 1 | 2 | yes | **72** | 4 | 24 | 24 | 96 | 52 |
| 1 | 4 | no | 44 | 0 | 0 | 0 | 108 | 52 |
| 1 | 4 | yes | **44** | 4 | 24 | 24 | 84 | 52 |
| 3 | 1 | no | 128, 240, 352 | 0 | 0 | 0 | 324 | 156 |
| 3 | 1 | yes | **128, 240, 352** | 2 | 12 | 12 | 318 | 156 |
| 3 | 2 | no | 72, 128, 184 | 0 | 0 | 0 | 324 | 156 |
| 3 | 2 | yes | **72, 128, 184** | 4 | 24 | 24 | 312 | 156 |
| 3 | 4 | no | 44, 72, 100 | 0 | 0 | 0 | 324 | 156 |
| 3 | 4 | yes | **44, 72, 100** | 4 | 24 | 24 | 300 | 156 |

**The second of §4.2's three outcomes, and nothing was tuned toward it: staging
FIRES, and it does not pay.** Two dispatches at one hauler and four at two and
four, moving 12 or 24 units out to the depot — and **every completion tick is
digit-for-digit identical with the depot and without it**, in all six pairs,
with a demand that outlives one hauler wave as readily as with a single site's.

**Nothing ever used what was staged.** The depot's closing level equals its peak
in every run, so not one unit was fetched back out of it, and the loaded leg
(`outbound` hauler-ticks) is 52 and 156 with the depot and without — every load
that reached a site walked the full leg from the camp. The reason is in the
supply ranking rather than in staging: a supply candidate is priced on the whole
hauler → source → building route, and these haulers idle at the camp, where
camp → corner (25.8 tiles) beats camp → depot → corner (27.4). **The depot can
only pay for a hauler that is already standing near it**, which is what increment
8 §4.3 found for the ordinary chain fixtures and is now confirmed at the remote
fixture OBS-8-06 said the repository lacked.

**What the depot did buy is a shorter walk home and a relabelling.** The `supply`
bucket falls from 108 hauler-ticks to 84 at four haulers, and `returning` from
52 to 42 at one, because a hauler that has just unloaded at the corner returns to
the nearer site; the ticks that leave the supply bucket reappear in the transfer
one. No building arrives earlier for any of it.

**So OBS-8-06's second hypothesis is NOT the live one.** The trigger is not
narrower than situational — it fired on the first fixture written for it. What
survives is the issue's own first sentence, now with the missing case filled in:
staging is reachable and correct and **is not worth its trips even at the
fixture it was written for**. This increment reports that and does nothing about
it; deleting or re-siting the mechanic is OBS-8-06's decision, and it must be
taken with the DRAIN half in view, which is a different rule solving increment
7's silting defect and did not fire here at all (24 units is far below the
48-unit staging ceiling, so the parked stock is inert rather than silted).

**The weakness in this reading, stated rather than left for a successor to
find:** it is one depot tile on one map with haulers whose house is beside the
camp. The shape that could still make staging pay is a colony whose haulers idle
NEAR the depot — a producer standing next to it, say — and that fixture was not
run here, because §4.2 asked for a remote SITE and that is what was built.
