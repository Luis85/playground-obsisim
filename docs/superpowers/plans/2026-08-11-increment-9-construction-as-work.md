# Increment 9 — Construction as Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last place in the game where goods teleport and work happens for free. A building stops appearing finished the tick it is ordered; it becomes a site that occupies its tile, provides nothing, and is completed by materials carried to it.

**Architecture:** One new component (`Construction`), one new system (the countdown), and one reinterpretation: a construction site is **a phase an ordinary `Building` passes through**, not a new entity kind and not a fourth `BuildingDef` role. `Relocation` is the precedent — a component that suspends a building's service while it exists and occupies its tile — and this borrows its shape field for field. A site's demand is its def's `cost`, so `needOf` generalises and the whole delivery machinery from increments 7 and 8 applies unchanged.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md`. Section references below (§2.5, §2.7, …) are to that document.

## The branch is playable throughout, with one visible oddity

Between Task 2 and Task 5, **ordering a building creates a site that never finishes** — the countdown does not exist yet, so it sits at its tile forever, providing nothing. That is the increment's whole feature arriving in two halves, it is obvious rather than subtle, and Task 5 closes it. Stated here so nobody bisects into it and files a bug.

**"Providing nothing" is why Task 2b sits where it does, immediately after site creation and before the delivery work.** An earlier draft ran the exclusions as Task 6, after delivery and the countdown, and that made the claim above false in the worst way: a never-finishing site would still shelter colonists (`pending.constructed` seats them the same tick), still act as a store site, and still be staffable and run its recipe. Tasks 2–5 would have shipped buildings that work without being built — which is the exact bug this increment exists to remove, introduced by the increment removing it.

The exclusions depend only on Task 1's component and Task 2's sites, never on delivery or the countdown, so nothing is lost by moving them early. **A site must provide nothing from the first commit in which a site can exist.**

**Two windows this branch really does have, stated honestly rather than papered over.** Both were raised against Task 2's commit and both are consequences of the task split, not defects in it — but the sentence above overstates its own guarantee by one commit, and a reader deserves the real granularity.

- **Task 2's own commit ships sites that still provide service.** The exclusions land in Task 2b, the very next commit, because they are a different file list and their own five fixtures. So the guarantee above holds from **2b**, not from 2. Anyone bisecting into exactly Task 2's commit sees a house that shelters colonists it never cost anything to build.
- **From Task 2 until Task 8, saving and reloading completes every site for free.** `savedBuildingOf` writes a v6 record with no countdown, so `spawnBuilding` restores the site at zero ticks — a finished building, its cost never delivered, and its demand gone from `outstandingMaterials` so further orders are accepted too. Task 8's round-trip is what closes it, and that is the task's real justification: not "the save carries a new number" but "without the number, a reload mints buildings."

Neither is a reason to reorder — 2b follows 2 immediately, and moving the save schema ahead of the delivery path would invert the increment. They are a reason not to ship the branch half-merged, and the PR lands whole.

## Global Constraints

- **The new component must be attached in TWO places**: `buildingComponents` in `src/engine/spawn.ts` (the single shared spawn list) *and* `COMPONENT_TYPES` in `src/engine/world.ts` for save round-tripping. Forgetting either is silent and has bitten twice (OBS-4-02). This increment adds exactly one component, in Task 1.
- **The new system must be listed in `ALL_SYSTEMS` in order** — `buildColonyPrepWorld` throws otherwise, and a test pins the order. Task 5 adds one, after `HaulSystem` (so a delivery landing this tick counts toward completion) and before `StatsSystem` (so a completion is in this tick's flows).
- **`src/engine/world.ts` is at 489 of 500 and this increment must touch it** (both `COMPONENT_TYPES` and `ALL_SYSTEMS`). **Extract `initialSave` to `src/engine/initial-save.ts` in Task 1**, before adding anything — this is the contingency increments 7 and 8 both named and neither needed, and it is now forced. Do it as its own commit so the extraction and the feature are separable.
- Other files near the cap, with the task that owns each split:

  | file | now | owner |
  | --- | ---: | --- |
  | `src/engine/world.ts` | 489 | **Task 1 — mandatory extraction, see above** |
  | `src/engine/systems/haul-transfer.ts` | 436 | untouched, keep it that way |
  | `src/shared/save.ts` | 434 | Task 8 (contingency: the v7 record beside the v6 one is small; if it trips, split the guards) |
  | `src/shared/haul.ts` | 420 | untouched — dispatch ordering is increment 10 |
  | `src/shared/save-migration.ts` | 415 | Task 8 |
  | `src/engine/systems/haul-dispatch.ts` | 395 | Task 3 |
  | `src/engine/components.ts` | 350 | Task 1 |
  | `src/engine/systems/placement-handlers.ts` | **429 after Task 2** | Task 2, Task 3, Task 7 |
  | `src/engine/snapshot-builder.ts` | 368 | Task 2b |

  Check with `grep -cve '^\s*$' <file>` after every task that touches one.

  **`placement-handlers.ts` is now the file to watch, not `world.ts`.** Task 2 took it from 327 to 429 of 500, and two more tasks add to it — Task 3's in-tray refund together with the notice's returned-materials half, and Task 7's relocation refusal. Task 3 is the one with room to spare. Contingency, in preference order: extract the demolition path (`demolitionNotice`, `heldText`, `refundCostOf` and the refund branch) into `src/engine/systems/demolition.ts`, which is a coherent seam rather than a size-driven split; failing that, extract the construction path. Do it as its own commit, before the feature change, exactly as Task 1 did for `world.ts`.
- **Every task's tests must be greenable by that task's own changes.** `check:all` is required green at the end of every task, so a test asserting behaviour a *later* task enables cannot be committed — the implementer must then skip it, weaken it, or pull the later task forward, and all three are worse than writing the right assertion now. **This plan broke that rule three times in review** (Task 1's save round-trip needs Task 8's schema; Task 3 asserted completion, which needs Task 5's system; and a stalled-queue recovery test sat in a dispatch task that had neither completion nor cancellation), so before starting any task, check its tests against its own file list. Where the strong assertion belongs to a later task, the earlier one asserts the strongest thing it *can* reach and names the task that finishes the job.
- **Grep for the three "a building is a producer" proxies and justify every hit.** Every shipped predicate and constant in this engine was written when a building was one of exactly three things: a producer, a shelter, or a store. A site is none of them. Two rounds of review on this plan found **six** places that assumed a fourth kind could not exist, across these proxies — and enumerating them one review round at a time is not a method. §2.7 has the table; the search is:

  ```bash
  grep -rn "inputBufferCap" src/          # "an in-tray belongs to a recipe, so 12 is enough"
  grep -rn "staffed\|StaffedSet" src/     # "a building worth feeding has workers"
  grep -rn "relocatingTicks\|isRelocating" src/   # "the only non-working building is a moving one"
  ```

  **Three proxies, not four.** An earlier draft listed `affordableDefs`/`canAfford` as a fourth, because §2.3 removed the affordability check. It does not any more — that assumption stays TRUE in this increment (Task 2 keeps the refusal), so there is nothing to audit. It becomes increment 10's first task.

  Each hit is either a site exemption, a site exclusion, or deliberately neither — and the third case needs a sentence saying why. The tasks below name the hits two reviews found; they are not a complete list, and a task that finds a new one should fix it and say so rather than deferring it.
- **Mutation-test every test.** Back up by copy, `sed`, `diff -q` against **the backup** to confirm it applied, restore **by copy** — never `git checkout <file>`, which restores from HEAD and destroys uncommitted work.
- **Every clause of a compound boolean needs its own fixture.** §2.7 is six separate exclusions, and that is the shape where a whole-condition mutation reddens a gated path and looks like coverage.
- **Any quantity a dispatch spends must be tested with more than one hauler.** Increment 8's over-claim family all passed single-hauler fixtures, and Task 3 makes a site's per-resource room claimable by several haulers at once — one hauler cannot over-claim, so a one-hauler fixture cannot show the bug.
- **A mutation that makes a system THROW does not fail a test by default.** sim-ecs catches it and publishes a `SystemError`; subscribe and assert `errors` is empty.
- **Goods are carried, never teleported.** This increment exists to make that sentence true in the last place it is false. No path may complete a site by moving goods without a hauler.
- **Conservation is exact, and the sentinel is not sufficient.** A refund that teleports preserves the colony total. Assert what a total cannot see.
- **Balance constants live only in `src/engine/content/balance.ts`.** `src/shared/**` imports nothing outside itself.
- **Never `--update` a quality baseline.** Never pad comments for maintainability points.
- **Commit by pathspec.** A new file needs one `git add` immediately before its commit.
- `npm run check:all` green at the end of every task (`rm -rf coverage` first).
- **A raw `await world.step()` does NOT refresh the snapshot's entity sections.** Use `stepTick` from `tests/engine/fixtures.ts` for anything asserting on entities appearing or disappearing.
- The `balance` vitest project includes only `tests/engine/balance.test.ts`. Scratch measurement files must run under `--project unit` and be deleted before committing.

---

### Task 1: `world.ts` makes room, and the component lands

Two commits, deliberately separable: the extraction that unblocks the file, then the component.

**Files:**
- Create: `src/engine/initial-save.ts`, and move `initialSave` there
- Modify: `src/engine/world.ts`, `src/engine/components.ts`, `src/engine/spawn.ts`, `src/shared/placement.ts`, **`src/engine/content/balance.ts`** (`buildTicks`)
- Test: `tests/engine/world.test.ts`, `tests/engine/components.test.ts`, `tests/shared/placement.test.ts`

**Interfaces:**
- `Construction { ticksLeft = 0 }` — mirrors `Relocation` field for field.
- `isUnderConstruction(ticksLeft): boolean` in `src/shared/placement.ts`, beside `isRelocating` and for the same reason: the snapshot publishes the state and `src/shared/**` may not import the engine.
- `BALANCE.buildTicks = 30`, with a doc comment naming §4.1's question rather than claiming the value is tuned.

- [ ] **Step 1: Extract `initialSave` first, and commit it alone**

`world.ts` is at 489 of 500. Do this before adding a line to it. The extraction must be behaviour-neutral — no test should change — which is what makes it safe to commit separately and what makes the next commit's diff readable.

- [ ] **Step 2: Add the component, attached in both places**

`buildingComponents` in `spawn.ts` **and** `COMPONENT_TYPES` in `world.ts`.

**The test that would really catch a miss here is a save round-trip, and it cannot be written yet** — `buildSaveFromWorld` serializes through `savedBuildingOf` (`game-engine.ts:43`) and the save record has no construction field until Task 8. Registering the component does not persist its value on its own. So Task 1 asserts registration directly, and **Task 8 carries the round-trip that actually proves persistence**:

```ts
it('a spawned building carries a Construction component', async () => {
  // The spawn half. Weak on its own — a component attached in spawn.ts and
  // missing from COMPONENT_TYPES passes this.
});

it('COMPONENT_TYPES includes Construction', () => {
  // The registration half, asserted directly because the behavioural version
  // needs Task 8's schema. Deliberately a structural assertion: it is the only
  // thing this task's own changes can make true, and OBS-4-02's two-spawn-site
  // trap is exactly what it guards.
});
```

- [ ] **Step 3: Verify and commit**

`grep -cve '^\s*$' src/engine/world.ts` must be comfortably under 500 with the additions in.

---

### Task 2: Ordering creates a site

**Files:**
- Modify: `src/engine/systems/placement-handlers.ts`, **`src/engine/systems/command-system.ts`** (the `buildings` query), **`src/engine/systems/command-handlers.ts`** (`BuildingRow`, `CommandContext`), **`src/engine/spawn.ts`** (`BuildingSpec`, `buildingComponents`)
- Test: `tests/engine/systems/command-system.test.ts`

**`spawn.ts` is here because Task 1 left `buildingComponents` hardcoding `new Construction()`** (`spawn.ts:145`) — zero ticks, which is correct for every existing caller and useless to this task. `BuildingSpec` has no construction input, so ordering through the shared spawn path produces a building at zero ticks (not a site), and appending a second `Construction` alongside it would attach the component twice. Thread it the way the file already threads the analogous countdown: `BuildingSpec` carries `relocatingTicks?: number` (`spawn.ts:129`), so add `constructionTicks?: number` beside it and have line 145 read it. Every existing caller omits it and keeps today's zero.

**The cumulative check cannot be written from `placement-handlers.ts` alone**, and this is the trap in this task's file list. `command-system.ts:72` builds each row from `{ entity, building, slots, position, buffer, input, relocation }` — **no `Construction`** — so the handler cannot tell an unfinished site from a finished building that happens to hold inputs. Neither fallback works: counting `pending.constructed` sees only sites ordered this tick and misses every one from a previous tick, and counting every building with an in-tray reserves finished producers' stock forever. The component has to reach the row.

**Interfaces:**
- `handleConstructBuilding` **stops calling `ctx.stockpile.pay(def.cost)`**, spawns with `Construction(BALANCE.buildTicks)`, and its notice says *started* rather than *built*.
- **The affordability REFUSAL stays; only the PAYMENT goes.** `pay` today does both — it tests and it debits — so removing the call removes both unless the test is put back explicitly ahead of the spawn. Dropping the refusal is increment 10's opening move and must not happen here by accident: it is a product change, and arriving at it through a refactor is how it would ship unnoticed and unmeasured.
- **And the replacement check must be CUMULATIVE, not `stockpile.canAfford(def.cost)`.** This is the trap in this task. Payment is what used to make a second order see the first one's cost gone; without it, every order in a drain reads the same untouched ledger. `canAfford` alone accepts two 15-wood houses against 15 wood, round-robin splits it, and neither completes — the broken queue this increment claims is increment 10's. The rule (§2.3):

  ```
  outstanding[r] = Σ over sites of max(0, cost[r] − held[r])
  refuse unless ∀r ∈ def.cost: colonyStock[r] ≥ outstanding[r] + def.cost[r]
  ```

  **`∀r` ranges over the resources the NEW order spends, not the whole catalog** — and this is a correction, not a shortcut. Taken over every resource the rule is self-detonating, because `outstanding` counts material in transit twice (see the paragraph below): the instant a hauler picks up the last 10 planks for a mill site, `colonyStock.planks` is 0 while `outstanding.planks` is still 10, so **every order of every building type is refused colony-wide until that load lands** — a lockout the player cannot clear by not ordering. Nothing the check exists for is lost by narrowing: for any resource the new order actually spends, `outstanding[r]` is still summed in full, so two orders against one building's materials are still refused. Implemented and commented as a decision in Task 2.

  **The Σ must skip `ctx.demolishedIds`.** Removal is deferred to the end of the drain, so a site demolished earlier in this same drain is still sitting in `ctx.buildings` with its `Construction` and its in-tray intact. Summed naively, that ghost's shortfall is charged against the very order meant to replace it, and a demolish-then-rebuild pair in one drain is refused for materials the colony demonstrably has — the refund from the demolish having already landed. This is not a new mechanism: `placement-handlers.ts:23-31` already carries a helper that filters exactly this set, with a comment saying why, and `findBuilding` (`command-handlers.ts:88`) applies the same exclusion. Use it. **Fixture: demolish a site and order its replacement in ONE drain, and require the second order to be ACCEPTED.**

  Derived from live components at every call, stored nowhere, reserving nothing. Deliberately conservative by the amount in transit — a picked-up load has left `Stockpile` and not yet reached `held`, so it is counted twice against the player. That is the safe direction, and increment 10 deletes the check entirely.

  **It is an ORDER-TIME check and guarantees nothing about completion** (§2.3). It writes nothing down, so a trip already dispatched to fetch wood for a sawmill still has that wood in `colonyStock` when the check reads it, and an accepted site can be left short a few ticks later. **Do not fix this with a reservation** — reserving strongly enough to guarantee completion would mean holding materials against meals. The queue can stall; it is bounded, and cancellation recovers it.
- The id-exhaustion and tile checks stay, and stay **before** the spawn — neither is recoverable later, and the affordability check joins them there.
- **Cancelling a site must stop refunding the cost, and that branch lands HERE rather than in Task 7.** `handleDemolishBuilding`'s refund loop (`placement-handlers.ts:144`) pays back `def.cost` unconditionally, which was exactly right while this task's `pay(def.cost)` charged it at order. The moment payment goes, that loop **mints the cost from nothing** for every cancelled site — a conservation break shipped in this commit and live until Task 7, which this plan's own "the branch is playable throughout" claim does not permit.

  It also destroys the fixture below. Demolish a site and order its replacement in one drain: the unbranched loop mints the ghost's full cost into the ledger, and that minted stock covers the ghost's outstanding demand *and* the replacement — so the second order is accepted whether or not `demolishedIds` is excluded, and the test proves nothing. **A non-discriminating fixture is worse than no fixture**, because it reads as coverage.

  So this task adds the site half of the branch — **a site refunds no cost, a finished building refunds as it always did** — plus the conservation assertion, and the matching half of the notice, since a cancelled site must stop claiming a refund the moment it stops receiving one.

  The rest is split by what each part first becomes possible: **Task 3** takes refunding the delivered in-tray through `refundAt` and the notice's returned-materials wording (neither is writable before Task 3 puts anything in a tray, and deferring either would make Tasks 3–6 destroy delivered materials or misreport them). **Task 7** takes refusing to relocate a site, and the recovery property that needs Task 5's countdown.

- [ ] **Step 1: Write the failing tests**

```ts
it('ordering a building does not move the ledger', async () => {
  // Colony stock IDENTICAL on the order tick. Assert the whole colonyStock(),
  // not just the two cost resources — a partial assertion passes an
  // implementation that pays a different resource.
});

it('a colony that cannot afford a building is still refused', async () => {
  // Empty ledger, order a mill, get a REFUSAL and no site. Removing `pay`
  // deletes the debit and the test together unless the check is put back
  // deliberately, so without this test increment 10's product change ships
  // silently inside a refactor.
});

it('the SECOND of two orders sharing one building\'s materials is refused', async () => {
  // ACCEPTANCE CRITERION 5, and THE test this task exists to get right. Two
  // houses at 15 wood each against exactly 15 wood: first accepted, second
  // REFUSED.
  //
  // Run it BOTH ways — both orders in one tick's drain, and one order per tick
  // — and in neither case let a hauler reach a source in between. A plain
  // `stockpile.canAfford(def.cost)` passes the single-order test above and
  // FAILS this one, which is the whole point: it reads the same untouched
  // ledger twice.
  //
  // Without this, increment 9 ships the broken queue it claims belongs to
  // increment 10, and §2.4's bounded-queue claim is simply false.
});

// NO test that an accepted site is GUARANTEED to complete. §2.3 is explicit
// that the check writes nothing down, so goods it counted can leave for a
// sawmill or a meal before a hauler collects them. Task 11 measures how often
// that happens; asserting it cannot would be asserting a guarantee this
// increment deliberately does not make.

it('a site occupies its tile', async () => {
  // A second building cannot be placed on it. The site is an obstruction from
  // the order tick, not a reservation.
});

it('id exhaustion and an unbuildable tile are still refused', async () => {
  // All three rejections survive. Separate fixtures — one test covering several
  // passes with any one of them deleted.
});

it('cancelling a site with nothing delivered refunds nothing', async () => {
  // THE MINTING TEST, pulled forward from Task 7 because this task is where the
  // minting starts. Order a mill, demolish it, assert the colony total is
  // UNCHANGED. Against the unbranched loop it reports +20 wood +10 planks from
  // nowhere. Task 3 owns the in-tray refund and the notice's returned-materials
  // half; the notice's cost half belongs to this task, beside this branch.
});

it('demolishing a FINISHED building still refunds its cost', async () => {
  // The other side of the branch, and the regression guard for every increment
  // before this one. Without it the branch can be written as "never refund".
});

it('a site demolished and replaced in ONE drain accepts the replacement', async () => {
  // The demolishedIds exclusion. Removal is deferred to the end of the drain, so
  // the ghost is still in ctx.buildings with its Construction and its in-tray.
  //
  // This fixture only discriminates because the two tests above landed first: an
  // unbranched refund mints the ghost's whole cost, which covers its outstanding
  // demand and the replacement both, and the order is accepted with the
  // exclusion missing. Write it AFTER them, and mutation-test it by deleting
  // ONLY the demolishedIds filter.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: restore the `pay` call; delete the check entirely; **replace the cumulative check with a plain `stockpile.canAfford(def.cost)`** — the one that must redden the two-order test and nothing else; spawn with `ticksLeft = 0`; move the tile check after the spawn.

---

### Task 2b: A site provides nothing

§2.7's table. **Six exclusions, six fixtures** — this is the task the compound-boolean rule was written for.

**Files:**
- Modify: `src/engine/systems/population-handlers.ts` (rehome), `src/engine/systems/command-system.ts:105` and `src/engine/systems/population-system.ts:72` (the two runtime shelter-row builders), `src/engine/snapshot-builder.ts:223` (the published bed total), `src/engine/systems/haul-sites.ts` (`storeSitesOf`), **`src/engine/systems/haul-dispatch.ts`** (`storeSitesFrom`, `StoreRow`), **`src/engine/systems/haul-system.ts`** (its `buildings` query), `src/engine/systems/production-system.ts`, `src/engine/systems/command-handlers.ts:140` (worker assignment + `BuildingRow`), `src/engine/snapshot-buildings.ts`
- Test: the matching suites

**The store-site exclusion needs `Construction` THREADED to it, and `haul-sites.ts` alone cannot do it.** `storeSitesOf` takes `StoreSiteRow`, which `storeSitesFrom` (`haul-dispatch.ts`) builds from `Building`, `Position` and `Relocation` — and `HaulSystem`'s own `buildings` query does not read `Construction` at all. So the predicate has nothing to test and an unfinished storehouse stays a live destination however the exclusion is written. Add the component to the query, to `StoreRow`/`StoreSiteRow`, and to the two other row builders (`command-system.ts:105`, `population-system.ts:72`) that construct the same shape. Files: `haul-sites.ts`, `haul-dispatch.ts`, `haul-system.ts`.

**"An unfinished house has no beds" has FIVE call sites**, three of them here and two in Task 8: `command-system.ts:105` and `population-system.ts:72` build the runtime shelter rows, `snapshot-builder.ts:223` computes the **published** bed total, and `restore.ts:123` / `save-guard.ts:95` are load-time. Fixing only the rehome path leaves a colonist seated in a site by whichever of the others ran first.

`grep -rn "relocatingTicks === 0\|isRelocating(\|state !== 'relocating'" src/` is how they were found, but it **returns thirteen hits, not five** — the rest are haul and production paths that are not about beds. It also returns a *sixth* bed-related one, `save-migration.ts:156` (`savedShelterIds`, whose own comment says "A house mid-relocation offers no bed today"), which is deliberately left alone for the reason Task 8 records: the v6 → v7 migration is total, so no migration step can ever see an unfinished building. Treat the grep as a way to confirm this list, not as a list.

`snapshot-builder.ts:223` is the one that is not about occupancy at all: `buildingSnaps.filter((b) => b.state !== 'relocating')`. It governs what the Population view *advertises*, and the comment directly above it states the principle a site would violate — "`total` therefore means beds you can actually sleep in tonight, which is the only number a player can act on." Without it the view reads spare capacity while the birth and nomad gates correctly refuse it, which is the display contradicting the rule it exists to explain. Add `src/engine/snapshot-builder.ts` to this task's files and assert a site's beds are absent from `snapshot.beds.total`.

**The one that will be missed:** `pending.constructed` is folded into homing precisely so a colonist can be sheltered on the tick a house appears — `shelters` in `command-system.ts:107`, verified. That now shelters them in a hole in the ground. It is the only entry in the table where the *existing* behaviour is a deliberate same-tick optimisation rather than an incidental lookup.

**The one that is an addition rather than an exclusion:** `handleAssignWorker` (`command-handlers.ts:140`) gates on `found.slots.max`, and a site carries its def's `workerSlots` like any other building — a mill site has two. So it accepts workers today and the refusal must be **added**, not preserved. With no builder role (§1.2) a colonist assigned to a site would stand in it doing nothing, which `ProductionSystem`'s exclusion makes silent rather than visible.

- [ ] **Step 1: Write five failing tests, one per exclusion**

(§2.7 has six rows; the sixth is a projection, not an exclusion, and Task 9 owns it — see the note after the list.)

```ts
it('a house under construction shelters nobody, including on its own construction tick', async () => {});
it('a storehouse under construction is not a store destination', async () => {
  // And the second-order proof: loads route PAST it to the camp, exactly as
  // they did before it was ordered.
  //
  // Exercise it on a LATER TICK, not the order tick. On the order tick
  // `pending` masks it; the predicate is what must reject it afterwards, and a
  // same-tick fixture passes with the predicate unchanged.
});
it('a site runs no recipe and produces nothing', async () => {});
it('a site cannot be assigned a worker', async () => {});
it('a site is not counted as colony wealth', async () => {
  // Not in the ledger it left AND not in the building it has not become.
  //
  // EXPECT THIS TO PASS UNCHANGED, and do not manufacture a change to justify
  // it. `colonyWealth` sums the `Stockpile` ledger alone — `snapshot-system.ts`
  // for the live tick, `initial-snapshot.ts` for the paused one — and a site's
  // delivered materials sit in an `InputBuffer`, which never enters that sum.
  // The exclusion is structural already. This is a regression pin on that
  // structure, which is why neither of those two files is in this task's list.
});
```

**Five tests, not six: 'a site reports underConstruction' lives in Task 9.** It is
the one row of §2.5 that is a *projection* rather than an exclusion, and it cannot
be asserted from this task's file list. `BuildingState` is a union in
`shared/snapshot.ts` (Task 9's file), and two exhaustive `Record<BuildingState, …>`
definitions — `BUILDING_STATE_LABELS` (`labels.ts:6`) and the world theme's
`stateRing` (`theme.ts:12`) — fail typecheck the moment a member is added without
an entry. That is deliberate: both carry comments saying so, dating from when
`relocating` and `housing` joined. So asserting the state here would drag
`shared/snapshot.ts` and two app files into a task scoped to
`snapshot-buildings.ts`, and without them this task cannot finish on the green
`check:all` every task requires.

Between this task and Task 9 a site reports whatever the existing precedence
chain yields, and that is **not** a single state — `buildingState`
(`snapshot-buildings.ts`) tests storage before recipe before staffing, so a
storehouse site reads `storing`, a house site reads `housing`, and only a
producer site reads `unstaffed`. All three publish their *finished* capacities
alongside, and the Buildings view offers a producer site's assign button, which
the engine now refuses. Nothing asserts otherwise in that window, and Task 9 is
where it becomes wrong to.

**That is a real window and it is deferred on a technical constraint, not a
preference** — unlike the refund and the notice, which moved earlier in this
increment precisely because they could. `BuildingState` is a union in
`shared/snapshot.ts`, and two exhaustive `Record<BuildingState, …>` definitions
fail typecheck the moment a member is added without an entry, so the state
cannot land in any task that does not also own `labels.ts` and `theme.ts`.
Task 9 owns all three. Do not attempt it here.

- [ ] **Step 2: Implement, mutation-test each exclusion separately, commit**

Five mutations, one per exclusion, each reddening exactly one test.

---
### Task 3: A site's demand is its cost, and three gates must let it through

**Without all four changes in this task, no material can ever reach a site and the feature does not work at all.** Three of them are outside `haul-dispatch.ts`, and a brief scoped to `needOf` alone — as an earlier draft of this plan was — ships a site that is offered materials and can never receive them.

**Files:**
- Modify: `src/engine/systems/haul-dispatch.ts` (`needOf`, `supplyCandidates`), `src/engine/systems/haul-system.ts` (`unload`), **`src/engine/systems/haul-claims.ts`** (`Claims.input`, resource-aware — see below), **`src/engine/systems/placement-handlers.ts`** (the in-tray refund — see below)
- Test: `tests/engine/systems/haul-dispatch.test.ts`, `tests/engine/systems/haul-system.test.ts`, `tests/engine/systems/haul-claims.test.ts`, `tests/engine/systems/command-system.test.ts`

**This task owns the in-tray refund, because this task is what makes a partly supplied site possible.** Task 2 already branched the *cost* refund (a site refunds none). The in-tray half could not be written there — nothing could reach a tray. It cannot wait for Task 7 either: the moment materials land in a site's `InputBuffer`, the existing rule destroys them on demolition ("whatever was waiting in either tray dies with the building", `placement-handlers.ts`), so Tasks 3 and 5 would ship a cancellation path that permanently loses everything delivered. Refund the delivered materials through `destinationFor` with the reservation-aware `heldAt`, and assert conservation here.

**The notice's in-tray half ships with the refund, here.** Task 2 already made a cancelled site stop claiming a cost refund. What `demolitionNotice` still does is describe a demolished building's trays as *lost* — true for a finished building, and the exact inverse of the truth for a site the moment this task lets materials reach one. Deferring it would give the Task 3 to Task 6 commits a false receipt while the ledger conserves correctly, which is the OBS-4-07 shape with the sign flipped and is why the cost half moved too. Assert the notice text alongside the refund: the ledger assertions all pass while the player is told the opposite of what happened.

Task 7 keeps what genuinely needs later tasks: refusing to relocate a site, and the recovery property (cancel one site so another *completes* on the returned materials — which needs Task 5's countdown).

**`haul-claims.ts` is where the resource filter lives**, and neither of the other two files can recover a per-resource figure once `Claims.input` has returned its aggregate. Omitting it leaves wood in flight consuming a site's plank room, which is exactly the defect the interface note below describes and the concurrent-material fixture is written to catch.

**Interfaces:**
- `needOf` branches on `isUnderConstruction`: a site's wanted map is `BUILDINGS[defId].cost` and its per-resource room is `cost[r] − held[r]`, **not** `BALANCE.inputBufferCap`.
- **`Claims.input` must become resource-aware** (`haul-claims.ts:241`), and multi-input construction costs are the first content that makes this matter. It sums `plannedAmount + amount` over every supply trip targeting a building **with no resource filter** — harmless while every recipe has one input, wrong the moment a consumer wants two: wood already walking to a mill site subtracts from that site's *plank* room. Add the resource to the lookup and to `needOf`'s `claimedIn`.
- **`needOf` must pick the shortest resource that still has UNCLAIMED room**, not simply the shortest. `shortestOf` ignores claims, so once wood's room is fully claimed the site keeps selecting wood, computes `room <= 0`, and returns null — dropping out of dispatch entirely while its planks go unserved.

  **Claims must enter the RATIO, not merely filter the candidates.** An earlier revision of this bullet said to pre-filter `shortestOf`'s `order` down to resources with unclaimed room left. That does not work, and the concurrency fixture below is what exposes it. `shortestOf` (`components.ts:179`) computes `ratio = held(id) / wanted` from physical amounts alone. Take an empty 20-wood/10-plank site: both ratios are 0, the strict `<` tie-break hands it to whichever comes first in `RESOURCE_IDS`, and wood wins. A first hauler claims 10 wood — but nothing has been *delivered*, so `held` is still 0, both ratios are still 0, and wood still has unclaimed room (20 − 10), so it survives the filter and wins again. The second hauler picks wood too, and delivery stays serialized exactly as before.

  Rank by **`(held[r] + claimed[r]) / cost[r]`** instead. With 10 wood in flight that reads wood at 0.5 and planks at 0, so planks is selected and the two materials move concurrently — which is the behaviour the fixture asserts.

  **Implement this as a local walk in `needOf` (`haul-dispatch.ts:113`), not by editing `shortestOf`.** `src/engine/components.ts` is not in this task's file list, every other caller of the method would inherit the change, and the method takes a `RecipeDef` — which a site does not have, since its demand is a `cost` map. A site's branch needs its own per-resource walk regardless; give it one. That serializes a multi-material site's delivery into one resource at a time and would bias the one-versus-four-hauler readings in §4.1. Walk the cost by proportional shortfall and take the first resource with unclaimed room left.
- `supplyCandidates` (line 172) checks `staffed.has(id)` **before** calling `needOf`, so the branch above is unreachable for a site until this gate exempts one. A site is never staffed: Task 2b forbids assigning workers, and a house or storehouse def has `workerSlots: 0` regardless.
- `unload` (`haul-system.ts:221–222`) does **both** remaining halves — it rechecks staffing, and it caps placement at `row.input.room(BALANCE.inputBufferCap)`. Exempt the first and make the second cost-aware, or a mill site accepts 12 of its 30 units while dispatch offers the remaining 18 forever. That is a livelock, not a shortfall.
- **Dispatch and arrival must be exempted together** — `staffed` is derived once per tick and handed to both readers precisely so they cannot drift (§2.5 of increment 7). Exempting only dispatch is worse than exempting neither: haulers walk to a site that refuses the load, the goods walk back, and the conservation sentinel stays at zero the whole time.

**Why the exemption is principled, and this belongs in the code comment:** increment 7 §2.6 gates on staffing because goods in an `InputBuffer` are out of the spendable ledger and die with the building. Neither half holds for a site — §2.6 refunds its materials in full on cancellation, and it consumes them by completing rather than by working. If a later increment adds a builder role or removes that refund, this exemption must be revisited.

Everything else **inside the dispatch-and-arrival path** is unchanged — scoped deliberately, because the sister spec (§2.2) records "everything else is unchanged" as an earlier draft's claim that was false, and the four changes above are the corrections. Two of that draft's six exceptions are still outstanding and are *not* Task 3's: `GoodsAudit`'s construction sink is Task 10, and `storeSitesFrom` / `HaulSystem`'s query is Task 2b. Do not add a parallel candidate builder — that is the second delivery mechanism the backlog note warns doing this before increment 7 would have required.

- [ ] **Step 1: Write the failing tests**

```ts
it('a site wants its cost, and stops wanting a material once it has it', async () => {
  // 20 wood / 10 planks. With 20 wood delivered, wood is no longer wanted and
  // planks are. DISCRIMINATING against a cap-based room: assert a wood need
  // ABOVE inputBufferCap is offered, which a 12-cap implementation cannot do.
});

it('a site with two materials outstanding asks for the proportionally shortest', async () => {
  // §2.2's multi-input path — the first SHIPPED content to exercise
  // `shortestOf`'s proportional branch. Every recipe in the catalog has 0 or 1
  // input, so this branch has only ever been unit-tested against a
  // fixture-local def. Now it is real, and it needs a real fixture.
});

it('a finished building still wants its recipe, not its cost', async () => {
  // The other side of the branch. Its own fixture, or the clause is untested.
});

// ── The three gates. Each one alone stops the feature dead, and each passes
// ── every test above it, because those are all unit tests on needOf.

it('an unstaffed site is a supply candidate', async () => {
  // supplyCandidates' staffing gate, which sits BEFORE needOf. Assert a
  // candidate EXISTS for a site with no workers — a fixture that happens to
  // staff the site proves nothing and cannot be staffed anyway.
});

it('an unstaffed producer is still NOT a supply candidate', async () => {
  // The other side of the same clause. Increment 7 §2.6's rule survives for
  // everything that is not a site; without this fixture the exemption could be
  // written as "always true" and pass.
});

it('a site accepts a delivery larger than inputBufferCap', async () => {
  // The unload cap. 20 wood into a mill site: all of it lands, not 12.
  // DISCRIMINATING: use a cost ABOVE the cap, or the assertion cannot tell the
  // two limits apart.
});

it('wood in flight does not consume the site\'s plank room', async () => {
  // Claims.input's missing resource filter. A hauler carrying wood to a mill
  // site must not reduce the plank room `needOf` reports. Invisible on every
  // shipped recipe — they all have one input — and wrong the moment a consumer
  // wants two.
});

it('two materials can be in flight to one site at the same time', async () => {
  // The consequence, and the one that bites the §4.1 hauler-count readings:
  // with two haulers and a 20-wood/10-plank site, one may carry wood and the
  // other planks CONCURRENTLY. A `shortestOf` that ignores claims picks wood
  // twice, finds no room, and drops the site out of dispatch entirely.
});

it('cancelling a partly supplied site refunds only what arrived', async () => {
  // The in-tray half of the refund, and it belongs here because this task is
  // what first puts anything in a tray. 6 wood delivered of 20: the colony total
  // rises by 6, not by 26 and not by 20. Assert separately that deliveredRate did
  // NOT move — refundAt, not addAt. The total alone passes against addAt.
  //
  // Without this, Tasks 3 and 5 ship a cancellation that destroys every
  // delivered material, which is the conservation break this increment exists
  // to close, arriving inside the task that opens the delivery path.
});

it('cancelling a partly supplied site says what actually happened', async () => {
  // The NOTICE, asserted on its text, and it ships with the refund above rather
  // than four tasks later. It must not describe the returned materials as lost —
  // the inverse of the truth for a site the moment anything can reach a tray.
  // OBS-4-07 exists because a notice said "cost refunded" while goods were
  // deleted; this is that defect with the sign flipped, and every ledger
  // assertion above passes while the player is told the opposite of the truth.
  //
  // The cost half of this notice already landed in Task 2. Extend it, do not
  // replace it, and leave the finished-building wording alone.
});

it('a mill site receives its full 30-unit cost', async () => {
  // The end-to-end proof that all four changes compose. This is the test that
  // fails if any single one of them is missed, and the one to write FIRST.
  //
  // It asserts the in-tray reaches 30 and STOPS THERE. It must NOT assert
  // completion: ConstructionSystem does not exist until Task 5, and this plan's
  // own preamble says sites never finish between Tasks 2 and 5 — so a
  // completion assertion here cannot go green, and `check:all` is required
  // green at the end of every task. An earlier draft asserted completion and
  // was self-contradictory. Task 5 carries the completion half.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations, one per change: point a site's want at `recipe`; cap a site's room at `inputBufferCap` in `needOf`; restore the staffing gate in `supplyCandidates`; restore the staffing recheck in `unload`; restore `inputBufferCap` in `unload`; invert the `isUnderConstruction` branch.

**Four of those six leave a plausible, compiling implementation** that delivers nothing or delivers 12 units and stalls — and only the end-to-end test catches them. A suite of `needOf` unit tests passes against all four.

---

### Task 4 was age-first dispatch, and it is now increment 10

**Nothing replaces it here.** `compareSupplyCandidates` and `nextSupplyTarget` are untouched by this increment, and a site competes for haulers on exactly the terms every other supply target already uses.

That has a visible consequence the implementer should expect rather than debug: **several sites ordered at once fill round-robin.** `movable` is bounded by remaining room, so a nearly-complete site has small `movable` and loses to a newer empty one. Three sites ordered together finish late and together instead of one at a time. §2.4 prices this and accepts it — with the affordability check still in place (Task 2), a queue is bounded by what the colony could have paid for when each order was accepted, so round-robin is slow rather than broken.

**Do not read that as "every site completes."** The check is order-time only and reserves nothing (§2.3), so goods it counted can be spent on a meal or a producer before a hauler collects them, and an accepted site can be left short. The queue is bounded and *recoverable* — cancelling a site returns its materials — not guaranteed. Task 11 Step 2b measures how often the stall really happens; Task 5's three-site test proves completion only for a controlled fixture with nothing else competing for the ledger, which is exactly as sharp as acceptance criterion 4 gets.

**If a fixture here appears to want an ordering rule, it is the wrong fixture.** No acceptance criterion in this increment mentions service order or completion order; criterion 4 says only that several sites all complete. A test asserting anything sharper is asserting a requirement this increment does not have, and it belongs to the successor.

The ordering work — age-first as a separate selection phase, the non-transitivity trap, the starvation band, the producer-starvation stall and its recovery — moved intact to `docs/superpowers/plans/2026-08-15-increment-10-a-build-queue-that-converges.md`. It is not being rediscovered there; it is the same text, and it is the reason increment 10 exists.

---

### Task 5: The countdown, and completion

**Files:**
- Create: `src/engine/systems/construction-system.ts`
- Modify: `src/engine/world.ts` (`ALL_SYSTEMS`)
- Test: `tests/engine/systems/construction-system.test.ts`, `tests/engine/world.test.ts`

**Interfaces:**
- `ConstructionSystem`, placed **after `HaulSystem`** (a delivery landing this tick counts toward completion) and **before `StatsSystem`** (a completion is in this tick's flows). The order test in `world.test.ts` must be updated in the same commit.
- Each tick, for each building with `ticksLeft > 0`: if its `InputBuffer` holds the full `cost`, decrement; else hold. At zero, empty the in-tray.
- **Materials complete is DERIVED, never stored** (§2.1) — `InputBuffer` against `BUILDINGS[defId].cost`, recomputed each tick. A stored flag is a second source of truth that can disagree with the buffer it summarises.
- Emptying the in-tray at completion records **nothing** (§2.8): those goods were consumed on arrival, and counting them again double-counts the build.

- [ ] **Step 1: Write the failing tests**

```ts
it('a site short of one material does not count down', async () => {
  // Everything but one plank. ticksLeft UNCHANGED across many ticks.
  // DISCRIMINATING: short by ONE unit of ONE material, so an implementation
  // testing "has any materials" or "has the first material" passes wrongly.
});

it('a fully supplied site counts down and completes', async () => {
  // Tick by tick: the countdown runs, the in-tray empties at zero, and the
  // building produces on the NEXT tick through the ordinary systems.
});

it('completion records no consumption', async () => {
  // §2.8. consumptionRate must not move on the completion tick — the goods
  // were consumed when they arrived. Reaching for recordConsumed here is the
  // reflex this test exists to catch.
});

it('a house completes and is then homed by the ordinary pass', async () => {
  // No special case in completion. rehome seats a colonist the next tick.
});

it('three affordable sites ordered at once ALL complete', async () => {
  // ACCEPTANCE CRITERION 4, and note what it does NOT say. No assertion about
  // which finishes first or how long they take: dispatch ordering is untouched
  // in this increment, so round-robin filling is the EXPECTED behaviour and any
  // sharper assertion would pin a requirement §2.4 explicitly declines to make.
  //
  // What this must prove is that round-robin is slow rather than broken:
  // every site reaches completion and nothing stalls. Give the fixture enough
  // ticks that a round-robin fill still finishes; a tick budget tuned to
  // sequential delivery would fail here for the wrong reason and invite
  // someone to "fix" it with the ordering rule increment 10 owns.
  //
  // NO CONSERVATION-SENTINEL ASSERTION HERE. GoodsAudit gets its construction
  // sink in Task 10 and runs only under the balance harness; until then it
  // reports every completed cost as lost, so a sentinel assertion in this task
  // is red through no fault of the code under test. Assert colony totals
  // directly if this fixture wants a conservation claim, and leave the
  // sentinel to Task 10's completed-site scenario.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: count down regardless of materials; complete at `ticksLeft === 1`; record consumption on completion; place the system before `HaulSystem`.

---


### Task 7: Cancellation and conservation

**Files:**
- Modify: `src/engine/systems/placement-handlers.ts` (demolish, move)
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- **The `def.cost` refund branch ALREADY LANDED IN TASK 2** — do not write it again, and do not assume it is missing. Task 2 removes the payment, so leaving the loop unconditional would have minted the cost from every cancelled site for four tasks running, and it would also have made Task 2's own same-drain fixture non-discriminating. Task 2 therefore carries the site half (a site refunds no cost), the finished-building regression guard, and their conservation assertions. **Confirm that against `placement-handlers.ts` before starting; if the branch is absent, the earlier task is wrong and you should stop and report.**

  **The in-tray refund ALSO already landed, in Task 3**, for the same reason one task earlier: Task 3 is what first lets a material reach a tray, so leaving the refund until here would have shipped a cancellation that destroys every delivered good across the Task 3 and Task 5 commits. Confirm it too, and stop and report if it is absent.

  What is left for this task is everything that genuinely needed a later task to exist.

  | demolished | cost refund | in-tray |
  | --- | --- | --- |
  | a finished building | yes, unchanged | destroyed, unchanged |
  | a site | **no** — nothing was paid | **refunded** via `refundAt` |

- Demolishing a site refunds its delivered materials through `destinationFor` with the reservation-aware `heldAt` — **landed in Task 3, verify rather than rewrite.**
- **`demolitionNotice` is DONE — both halves, and neither is yours.** The cost half landed in Task 2 (a cancelled site stopped claiming a refund it never got, the moment payment was removed) and the in-tray half in Task 3 (a site's delivered materials come back, so describing them as lost inverted the truth the moment anything could reach a tray). Each moved to sit with the behaviour it describes. **Verify both and stop and report if either is missing — do not rewrite them.**

  The rest of this bullet is why they mattered, and it is OBS-4-07 repeating rather than a cosmetic edit. It opens with a hardcoded `` `Demolished the ${name} — cost refunded` `` and describes the in-tray as *lost* — for a site, both halves are exactly backwards: no cost is refunded and the materials come back. OBS-4-07 is filed against precisely this failure, a notice claiming "cost refunded" while goods were silently deleted, and shipping the inverse of it here would be the same defect with the sign flipped.
- `handleMoveBuilding` **refuses a site**, with a notice (§2.6, §2.12). **Task 8 depends on this and must not be reordered ahead of it:** its cross-field save invariant rejects a record carrying both countdowns on the grounds that the engine can never write one. Until this refusal lands, the engine *can* — order a building, wait for the site, move it, and both countdowns run at once. The guard would then be rejecting saves the engine itself produced. Between Task 2 and here the state is reachable and harmless (nothing consumes it, and `ConstructionSystem` does not exist before Task 5); from here on it is unreachable, which is what makes Task 8's rejection correct rather than punitive.

- [ ] **Step 1: Write the failing tests**

```ts
// 'cancelling a site with NOTHING delivered refunds nothing' and 'demolishing a
// FINISHED building still refunds its cost' are ALREADY GREEN — they landed with
// the branch in Task 2. Do not duplicate them. Re-run them, and if either is
// missing, stop and report rather than writing it here.

// 'cancelling a partly supplied site refunds only what arrived' — INCLUDING the
// deliveredRate assertion — is ALREADY GREEN from Task 3. Re-run it, do not
// rewrite it, and stop and report if it is missing.

it('cancelling a site returns its materials to the ledger for another site to use', async () => {
  // The RECOVERY property, and the general form of it. Two sites, the wood
  // split between them so neither can finish; cancel one, and require the other
  // to complete on the returned materials.
  //
  // It is here rather than folded into the refund tests above because it proves
  // something they do not: that refunded goods re-enter the ordinary supply
  // path rather than landing somewhere a hauler will not look. Increment 10
  // leans on exactly this to argue its starvation stall is recoverable, so it
  // wants to be true and tested BEFORE that argument is made.
});

it('demolishing a FINISHED building still refunds its cost', async () => {
  // The other side of the branch, and the regression guard for every increment
  // before this one. Without it the branch can be written as "never refund".
});

// 'cancelling a partly supplied site says what actually happened' is ALREADY
// GREEN — the notice's cost half landed in Task 2 and its in-tray half in Task 3,
// each with the behaviour it describes. Re-run it. Do not rewrite it, and stop
// and report if it is missing.

it('a finished building is unchanged by this', async () => {
  // The asymmetry is deliberate (§2.6). Pin the existing behaviour so a future
  // reader sees a decision rather than an inconsistency.
});

it('a site cannot be relocated', async () => {});

it('a hauler walking to a cancelled site loses nothing', async () => {
  // The existing cancellation paths, pointed at a new kind of target. Expect
  // this to pass unchanged — and test it, because increment 8 found three
  // paths that "obviously" already worked and did not.
});
```

- [ ] **Step 2: Fix whatever actually breaks, commit**

If nothing breaks, the deliverable is the suite and a commit message saying so. Do not manufacture a change to justify the task.

---

### Task 8: Save v7

**Files:**
- Modify: `src/shared/save.ts`, `src/shared/save-migration.ts`, `src/engine/game-engine.ts`, `src/engine/restore.ts`, `src/engine/spawn.ts` (`clampedInputBuffer`), `src/engine/initial-snapshot.ts`, `src/engine/save-guard.ts`, **`src/shared/snapshot.ts`**, **`src/engine/snapshot-buildings.ts`**, **`src/engine/systems/snapshot-system.ts`**, **`src/engine/initial-save.ts`**, **`src/engine/world.ts`**, **`src/main.ts`**

**`src/engine/world.ts` and `src/main.ts` are the CONSUMER side, and without them a correctly migrated v7 save is rejected before it can be restored.** `world.ts` is the load gate: `isLoadableSave` (`world.ts:110`) calls `isSaveGameV6` and narrows to it, and `prepareLoadedSave` (155), `LoadDecision` (162), `buildColonyPrepWorld`'s options (254) and `createColonyWorld` (478) are all typed `SaveGameV6`. `main.ts:66` and `main.ts:70` are the shell's persistence signatures. Move every one of them to the current save type alongside the guard. Add both files to this list. **Verify by loading a migrated v6 fixture end to end** — a test that stops at the migration's output never reaches the gate that rejects it.

**`initial-save.ts` is the second producer the bump fails at**, and it did not exist when this list was written — Task 1 extracted it out of `world.ts`. It returns `SaveGameV6` (`initial-save.ts:12`), assigns `LATEST_SAVE_VERSION` to `version` (line 14), and writes a starter building record with no `constructionTicks` (line 28). Raising the constant breaks its typecheck, and until its return type and starter record move to v7 it cannot emit a loadable fresh save. That is the self-policing this task's last bullet promises, doing its job — but only if the file is in the list. **Assert `initialSave()` round-trips as a valid v7 save**, since a fresh colony is the one save every player has.
- Test: `tests/shared/save.test.ts`, `tests/shared/save-migration.test.ts`, `tests/engine/world.test.ts` (the paused-snapshot projection), `tests/engine/save-guard.test.ts`, `tests/engine/snapshot.test.ts`

**The last three are not optional and not Task 9's.** This task's clamp test needs the NUMERIC `BuildingSnapshot.constructionTicks` (see the prerequisite note below), and publishing it takes all three: `shared/snapshot.ts` declares the field, `snapshot-buildings.ts` projects it, `snapshot-system.ts` reads the live `Construction` component. Task 9 adds the `underConstruction` STATE, which is a different thing and cannot substitute — a state cannot distinguish a clamped countdown from an unclamped one.

**Four files beyond the obvious two**, because "the save carries a new number" understates what restore touches:
- `spawn.ts` — `clampedInputBuffer` clamps the live entity to `inputBufferCap`
- `initial-snapshot.ts:118` — the **same clamp** on the paused snapshot, a *second* projection; fix one and a restored 30-unit site holds 30 while the screen says 12
- `restore.ts:123` — `usableBeds`
- `save-guard.ts:95` — `colonistTargets`, both halves: `shelters` gates on `relocatingTicks === 0`, and `workplaces` adds every recipe building regardless of construction, so a hand-edited v7 save can assign a worker to a site and pass the guard

**One hit of the `relocatingTicks === 0` proxy is deliberately left alone:** `save-migration.ts:156` needs no construction term, because the v6 → v7 migration is total — every building in a pre-v7 save is finished, so no migration step can see an unfinished one. Record that in a comment rather than adding a term that can never fire.

**Interfaces:**
- `LATEST_SAVE_VERSION = 7`. The current `SavedBuilding` gains `constructionTicks: number`, guarded with `isTickCounter` (`save.ts:263`) — the check `starvingTicks` and `ageTicks` use (`save.ts:277-278`). **Not the one `relocatingTicks` uses.** That field is guarded by a bare `Number.isFinite(...)` (`save.ts:397`), which accepts negatives and fractions; reaching for "whatever `relocatingTicks` does" gives `constructionTicks` the weaker guard and the rejection test below then proves nothing.
- **FREEZE the v6 building record first, and follow the pattern the file already sets.** `SaveGameV6.buildings` is typed `SavedBuilding[]` (`save.ts:228`), so adding a required field to that interface silently claims every v6 save has it — and `isSavedBuildingV6Shape` (`save.ts:404`) casts to `SavedBuilding` to read its fields. A brief that says "SavedBuilding gains `constructionTicks`, guarded with `isTickCounter`" invites putting that check where v6 validation reaches it, and then **every genuine v6 save is rejected before the migration can supply the zero.** The migration would be correct and unreachable.

  `save.ts:220` already states the rule for exactly this case — `SaveGameV6` redeclares `buildings` rather than inheriting because "it is the one field whose record type moves, and the version literal has to move with it". So: introduce a frozen `SavedBuildingV6`, point `SaveGameV6.buildings` at it, leave `isSavedBuildingV6Shape` checking that shape, and let the *current* `SavedBuilding` carry the new field for v7.
- Migration v6 → v7 sets it to **0 for every building**: every building in a v6 save is finished by construction, so the migration is total and needs no heuristic.
- **The save guard needs a CROSS-FIELD invariant, which no per-field check can express** (§2.10). `handleMoveBuilding` refuses to relocate a site, so the two countdowns are mutually exclusive in every save the engine writes — but a hand-edited or corrupt v7 file can carry `constructionTicks > 0` *and* `relocatingTicks > 0`, and `isTickCounter` accepts each of them independently. Loading it gives a building whose two countdowns both advance, with the relocation hidden behind `underConstruction` in the snapshot. Reject the record. This is the same class as the guard's existing colonist-reference rules: a per-record check that no single field can express.

  **The same invariant must cover production state, and that half is worse.** `SavedBuilding` carries `progress: number` and `batchActive: boolean`, guarded only per-field (`save.ts:236-237` — `Number.isFinite` and `typeof === 'boolean'`), so `constructionTicks > 0` alongside `batchActive: true` passes every check here. Task 2b's exclusion makes `ProductionSystem` *skip* a site rather than reject its state, so the impossible batch sits frozen for the whole countdown and then **resumes at completion and yields output the site never consumed inputs for** — goods minted from a hand-edited file, through a path that looks like ordinary production. Require an under-construction building to have idle production state (`batchActive === false`, and `progress` at zero), and refuse the record otherwise.
- **No new field for the materials.** `SavedBuilding.inputBuffer` already round-trips.
- The bump is self-policing — `SaveGameV6.version` is the literal `6`, so raising the constant fails typecheck at both producers until the type is updated.

**Two restore-path defects that the "no new field needed" framing hides.** `SavedBuilding.inputBuffer` does round-trip, and that is not sufficient:

- `buildingComponents` restores through `clampedInputBuffer` (`spawn.ts:113`), which is `clampedBuffer(saved, BALANCE.inputBufferCap)`. **A 30-unit mill site saved mid-countdown reloads holding 12**, destroying 18 units the ledger already recorded as consumed. The clamp must take the site's cost as its bound, as `needOf` and `unload` do — **per resource, not as one total.** `clampedBuffer` takes a single aggregate cap and spends it in catalog order, so the cheapest implementation of "bound by the cost" is to pass `sum(cost)`, and that is wrong in a way no equal-to-cost fixture can see. After a rebalance from 20 wood/10 planks to 10 wood/20 planks, a site saved under the old cost restores holding 20 wood — inside the aggregate 30, over `cost.wood` — accepts 10 more planks, and clears 40 units against a 30-unit cost on completion. A new `clampedToCost` keyed per resource is the fix; reusing `clampedBuffer` with a summed cap is the defect.

  **And the trimmed excess must be RETURNED, not dropped.** This is the half that makes the clamp itself a conservation bug rather than a display one. A site's in-tray lives outside `Stockpile`, so units the clamp declines to keep do not fall back anywhere — they cease to exist at load, which is precisely the failure this task exists to prevent, arriving through its own fix. Every existing `clampedBuffer` caller can drop silently because it trims a save the engine itself wrote and the cap has not moved; `clampedToCost` is the first one whose bound can legitimately *shrink* between save and load, because `cost` is content and content gets rebalanced.

  So the restore must bank the per-resource excess to the camp through the restore-only path that records no delivery — the same one seeded stock uses, `Stockpile.refund` (`stockpile.ts:137`), which `seedStoredGoods` (`restore.ts:234`) already calls for its own storehouse-capacity spill — and a fixture must assert the **colony total is unchanged across the round trip**, not merely that the tray was trimmed. A test that checks only the kept amount passes against an implementation that deletes the rest.

  **And the PAUSED snapshot must show the banked excess too, which is a second projection and a second fixture.** `restoredStock` (`initial-snapshot.ts:147-152`) derives published stock as `save.stockpile[r] + Σ building.stored[r]` — it never reads `inputBuffer`, correctly, because in-tray goods are outside the ledger. But the trimmed excess *becomes* ledger at load, and this sum cannot see it. A restored colony would then show the refunded wood missing from `stockpile` and from `colonyWealth` until the first tick rebuilt the snapshot from the live `Stockpile`. That is exactly the failure the function's own comment (`initial-snapshot.ts:139-144`) already documents for `stored` — it sums from the SAVED maps precisely so `seedStoredGoods`' spill stays in the total — so this is that same rule applied to a second spill, not a new principle. Add the per-resource excess to `restoredStock` and assert the refunded resource **before any tick runs**.
- `usableBeds` (`restore.ts:118`) gates on `count > 0 && b.relocatingTicks === 0` — relocation being the only way a house could exist unusable. An unfinished house otherwise seats colonists at load, and the **paused initial snapshot reports them housed** until the first tick evicts them.

- [ ] **Step 1: Write the failing tests, then implement, then mutation-test, commit**

```ts
it('a site mid-build round-trips its countdown and its delivered materials', async () => {
  // The in-tray fixture MUST exceed BALANCE.inputBufferCap — 30 units, not 6.
  // Below the cap it passes against the unfixed clamp and proves nothing, which
  // is the whole reason this defect survived a draft that said the field
  // "already round-trips".
});
it('a site restored over its cost in ONE material is trimmed in that material', async () => {
  // Deliberately UNEVEN and deliberately not equal to the aggregate: a saved
  // tray of 20 wood against a cost of 10 wood / 20 planks. Total 20 <= total
  // cost 30, so a summed-cap clamp keeps all 20 wood and this is the only
  // shape that reddens it. Assert the kept WOOD is 10.
});
it('the 10 wood that clamp declined is in the camp, not gone', async () => {
  // THE CONSERVATION HALF, and the one the test above passes without. Assert
  // the COLONY TOTAL is identical across save -> load. A site's in-tray is
  // outside Stockpile, so trimmed units have nowhere to fall back to and simply
  // vanish unless the restore banks them deliberately.
  //
  // Assert too that deliveredRate did NOT move: this is a restore, not a
  // delivery, so it goes through the restore-only path seeded stock uses.
});
it('the banked excess is in the PAUSED snapshot, before the first tick', async () => {
  // The second projection. `restoredStock` sums save.stockpile + stored and
  // never reads inputBuffer, so the refunded 10 wood is invisible to it while
  // the live Stockpile already holds it. Assert snapshot.stockpile.wood.stock
  // AND colonyWealth with ZERO ticks run — after a step this passes against the
  // unfixed projection, because the tick rebuilds from the live ledger.
});
it('an unfinished house houses nobody at load, in the paused snapshot', async () => {
  // Before any tick runs. Asserting after a step passes against the runtime
  // rehome eviction and misses the restore predicate entirely.
});
it('a v6 save loads with every building finished', async () => {
  // THE FREEZE TEST. A genuine v6 fixture — no `constructionTicks` anywhere in
  // it — must pass `isSaveGameV6` and reach the migration. Against a v6 guard
  // that learned about the new field this is rejected before migrating, which
  // is the failure the frozen record exists to prevent.
});
it('a negative or fractional constructionTicks is rejected', async () => {});
it('a record with BOTH countdowns positive is rejected', async () => {
  // The CROSS-FIELD invariant. Every per-field guard accepts this record —
  // isTickCounter passes on both numbers independently — so only a per-record
  // check reddens it. Assert the save is REFUSED, not repaired.
});
it('a site carrying an ACTIVE production batch is rejected', async () => {
  // The second half of the same invariant, and the one with a goods-minting
  // consequence rather than a display one. constructionTicks > 0 with
  // batchActive: true passes every per-field guard; ProductionSystem SKIPS a
  // site rather than clearing it, so the batch thaws at completion and produces
  // output against inputs that were never consumed. Assert REFUSED, not
  // repaired.
  //
  // TWO fixtures, because one cannot separate the clauses. A batch legitimately
  // BEGINS at zero progress, so `batchActive: true, progress: 0` is a reachable
  // corrupt state and is the only shape that proves `batchActive` itself is
  // rejected — a guard written as `progress !== 0` passes a mid-batch fixture
  // while still admitting that record, and it thaws into free production. Pair
  // it with `batchActive: false, progress > 0` for the other clause.
});

// PREREQUISITE for the clamp test below: `BuildingSnapshot` must publish the
// NUMERIC `constructionTicks`, analogous to `relocatingTicks`, and this task
// adds it — not Task 9, which only adds the `underConstruction` state. A
// boolean-like state cannot tell a clamped countdown from an unclamped one:
// both publish `underConstruction`, so the mutation survives and the assertion
// proves nothing. That is `agent-workflow.md`'s "indistinguishable fixture
// values" failure exactly.

it('a countdown saved under a larger buildTicks is clamped to the current one', async () => {
  // `isTickCounter` is necessary and NOT sufficient. relocatingTicks is also
  // clamped on restore by clampedRelocation against the CURRENT constant
  // (spawn.ts:67); constructionTicks needs the same, or a site saved before
  // buildTicks was lowered keeps more build time than a freshly ordered one.
  // The saved value must EXCEED the current constant or the fixture passes
  // unclamped. Assert BOTH projections — live component and paused snapshot.
});
```

---

### Task 9: Snapshot and surfaces

**Files:**
- Modify: `src/engine/snapshot-buildings.ts`, `src/shared/snapshot.ts`, `src/app/views/BuildingsView.vue` (the Buildings table), `src/app/views/EconomyView.vue` (the Economy view), `src/app/world/layout.ts`, **`src/app/labels.ts`** (`BUILDING_STATE_LABELS`), **`src/app/world/theme.ts`** (`stateRing`), **`src/app/stores/game-store.ts`** (`affordableDefs`), **`src/app/components/SelectionPanel.vue`**, **`src/app/components/WorldLegend.vue`**
- Test: `tests/app/buildings-view.test.ts`, `tests/app/economy-view.test.ts`, `tests/app/world-layout.test.ts`, **`tests/engine/systems/snapshot-system.test.ts`**, `npm run smoke:world`

**The engine projection needs its own fixture, and none of the app suites is one.** This task changes `snapshot-buildings.ts` to derive both the new state and the per-material shortfall, but the app tests build `BuildingSnapshot` objects directly and the layout and smoke checks only consume values already projected — so an implementation that leaves a live site reporting `unstaffed`, or computes its shortfall wrongly, satisfies every other test listed here. Nothing in `tests/` currently reaches `buildingState` by name at all. Assert both fields from a live `Construction` + `InputBuffer` fixture in `snapshot-system.test.ts`.

**The last five were absent from this list through fifteen review rounds** while the prose below required three of them by name. `labels.ts` and `theme.ts` are the two exhaustive `Record<BuildingState, …>` definitions the prose already argues force themselves on the compiler; `game-store.ts:172` is where `affordableDefs` lives. `SelectionPanel.vue:29` (a `relocatingTicks > 0` countdown) and `WorldLegend.vue:30` (a `stateRing.relocating` legend chip) are what Step 1's prescribed `grep -rn "relocating" src/app` actually returns — they are named here so the grep confirms a list rather than discovering one.

**Interfaces:**
- State `'underConstruction'`, ahead of `'relocating'` in the precedence chain — which puts it first overall, and that is the point. `buildingState` (`snapshot-buildings.ts`) tests storage, then recipe, then staffing, so **all three building kinds currently mis-report a site**: a storehouse site reads `storing`, a house site reads `housing`, a producer site reads `unstaffed`. Fixtures for all three, not just the producer.
- **A site must also publish the capacities it does not have.** `buildingSnapshotsOf` currently derives `beds` and `storage` for a site exactly as for a finished building, so the Buildings view offers a site's full capacity and enables a producer site's assign button, which the engine refuses. Task 2b zeroed the *aggregate* bed total (`snapshot-builder.ts:223`); the per-building projection is this task's.
- **Adding the union member is three files, not one**, and this task owns all
  three: the member in `shared/snapshot.ts`, a label in `BUILDING_STATE_LABELS`
  (`labels.ts:6`), and a ring color in the theme's `stateRing` (`theme.ts:12`).
  Both are exhaustive `Record<BuildingState, …>`, so the compiler names the two
  it needs — which is why Task 2b defers the state assertion here rather than
  reaching across into these files. The §2.5 row *'a site reports
  underConstruction, not relocating or waitingForInput'* is a test of this task.
- **A site publishes what it still needs, per material** — "needs 14 wood". Not a replacement for the affordability refusal (Task 2 keeps that): it is the only way to tell a site that is waiting from a site that is stuck, several minutes after the order, once meals and other builds have spent the ledger.
- The Economy view names a **build backlog** beside the input and output backlogs.
- **The affordability gates STAY — and `affordableDefs` must become CUMULATIVE to match Task 2.** The three views keep gating, but the getter behind them cannot stay as it is: it compares each def against `snapshot.stockpile` alone (`game-store.ts:172`), and Task 2 deliberately leaves that stock untouched at order time. So after one house is ordered against exactly one house's materials, all three surfaces keep offering a second while the engine now refuses it — the UI promising what the engine denies, the mirror image of the failure increment 10's Task 1 exists to prevent.

  Subtract outstanding site demand, summed from the per-material shortfalls the row above already publishes. No new engine field. **The gate and the refusal must come from one rule**, and the fixture that proves it has a site already queued. Removing the gates altogether is increment 10's first task, not this one's.

- [ ] **Step 1: Find the state surfaces before writing anything**

`grep -rn "relocating" src/app` — every place that special-cases the relocating state is a place that probably needs the construction one. Pre-flight the brief against the real files.

```ts
it('the palette refuses a second house once one is queued against the same materials', async () => {
  // THE UI HALF of acceptance criterion 5, and it fails against today's
  // affordableDefs. Order one house against exactly one house's materials;
  // published stock is UNCHANGED (Task 2), so a getter reading stock alone
  // still says affordable while the engine refuses. Assert all three surfaces.
});
```

**Do grep for `affordableDefs`** — the getter changes in this task (see above), even though the three view-level gates do not. What increment 10 inherits is the removal of the gates; what this task owes is a getter that refuses what the engine refuses.

- [ ] **Step 2: Tests, implement, mutation-test the smoke checks, commit**

**Change one thing per smoke-check fixture phase** (OBS-4-04). No vitest test may import `renderer.ts`, `graphics-cache.ts` or `glyphs.ts`.

---

### Task 10: Instruments

§4 asks questions the harness cannot answer. Increment 8's Task 10 is the precedent, and its lesson is that an instrument that over-counts is worse than none because it is believed.

**Files:**
- Modify: `tests/support/balance-harness.ts`, `tests/support/goods-audit.ts`
- Test: `tests/engine/balance.test.ts`, `tests/support/balance-harness.test.ts`

**Interfaces:**
- `Scenario` gains construction: sites ordered at given tiles at given ticks.
- `BalanceResult` gains `completions: { buildingId, defId, tick }[]` — **completion order is the reading**, not a count, because §4.1's convergence question is about order and a count cannot express it.
- **The conservation sentinel needs a construction SINK, not just in-tray coverage.** `GoodsAudit`'s law is `predicted = opening + made − recipeInputs − eaten + commandFlow + removalFlow` (`goods-audit.ts:219`) and there is no construction term. Goods sitting in a site's in-tray are conserved — the audit already counts input buffers — but `ConstructionSystem` **empties that tray at completion**, so those units leave `final` with nothing subtracting them and every scenario that completes a site reports `conservationError` equal to the negative construction cost.

  Add a cumulative construction-inputs term and subtract it in `predicted`. **The fixture must COMPLETE a supplied site**, not merely deliver to one — a test that only checks goods sitting in the tray passes against the missing sink, which is the whole defect.

  This lands in Task 10 rather than Task 5 because `GoodsAudit` runs only under the balance harness, and no balance scenario can order a site until this task adds construction to `Scenario`. Task 5's own unit tests complete sites without touching the audit.

- [ ] **Step 1: Test the instruments before trusting them**

```ts
it('the completion log records order, not just totals', async () => {
  // Three sites completing at different ticks. A count passes a round-robin;
  // only the order distinguishes it.
});
it('a scenario with no sites reports no completions', async () => {
  // The zero side, which is what catches an over-counting instrument.
});
it('goods in a site in-tray are conserved', async () => {
  // The IN-FLIGHT half only. It passes with the construction sink entirely
  // absent, because buffered goods are still standing in goodsStanding — so on
  // its own it is not evidence of anything and must never be the only fixture.
});
it('a scenario that COMPLETES a supplied site reports conservationError === 0', async () => {
  // THE ONE THAT CATCHES THE MISSING SINK, and the reason the prose above
  // insists on completion. ConstructionSystem empties the tray at completion,
  // so those units leave `final` with nothing subtracting them: without the
  // construction term this reports exactly the negative cost. Run the scenario
  // past the countdown, not merely up to delivery.
  //
  // Without it the balance measurements in Task 11 ship with every completed
  // cost reported as lost goods, and §4.1 gets written from that.
});
```

- [ ] **Step 2: Verify and commit**

---

### Task 11: Measure

**Files:**
- Modify: `tests/engine/balance.test.ts`, the spec's §4

- [ ] **Step 1: The build time sweep** — at least three values of `buildTicks`, on a fixture where delivery is fast and one where it is slow. The question is whether the countdown does anything the delivery leg does not already do. If it is invisible next to the walk, say so.
- [ ] **Step 2: Does build time want to scale with cost?** A house and a workshop take the same time at a flat constant. Build several of each and report whether flat reads as wrong.
- [ ] **Step 2b: Does a bounded queue actually stall?** §2.3's check is order-time only, so goods it counted can leave for a producer or a meal before a hauler collects them. Run a queue alongside a hungry colony and a staffed producer competing for the same resource; report how often an accepted site is left short and for how long. If it is routine, the check buys less than this increment claims — which increment 10 needs to know before it removes the check.
- [ ] **Step 3: How bad is the round-robin?** N sites ordered at once, at one hauler and at four, reporting the completion *curve*. **This measurement sizes increment 10; it is not a pass/fail.** §2.4 predicts a flat curve — everything finishing at once, late — and the question is how flat, and at what N it starts to hurt. A reading of "three is fine, six is miserable" is the most valuable thing this task can produce.

  **Do not fix what this finds.** The ordering rule is specified, reviewed and waiting in increment 10's plan; reaching for it here would ship the change this split exists to separate, and unmeasured.
- [ ] **Step 4: What a colony pays to grow.** Ticks from order to first output, near the camp and at the far corner. Increment 5 priced delivery; this prices building.
- [ ] **Step 5: Write §4.1 from what was measured**, in §4.3-of-increment-7's manner. If a decision this spec took measures badly, record the disagreement rather than retuning toward the claim.

**OBS-8-06 is NOT measured here.** It moved to increment 10 whole, with its "connect the instrument first" warning intact — the reading needs `demandSourcesOf` taught about sites, and that is a dispatch change this increment deliberately does not make. §4.2 says so.
- [ ] **Step 6: Verify and commit**

---

### Task 12: Document and close out

**Files:**
- Modify: `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md` (OBS-5-03 → Done, closed by construction rather than by bookkeeping — the outcome its own note predicted), `docs/issues/2026-08-11-the-staging-half-of-transfer-is-correct-and-almost-never-worth-a-trip.md` (OBS-8-06 — **not** resolved and not measured; note that increment 10 now owns the reading and why), `docs/requirements/Construction as Work.md` (status), `docs/README_PRODUCT_BACKLOG.md` if statuses roll up
- Create: a Feature note for the builder role if §4 argues for one; any issue Task 11 found

- [ ] **Step 1: Close what closed, carry what did not.** An issue that is not fixed gets its note updated with what this increment learned, not left untouched.
- [ ] **Step 2: Whole-branch review.** Read the diff for the compound-boolean shape specifically, and for the multi-hauler/multi-site over-claim shape. Confirm no skip survives, no baseline moved, no suppression added, every `src/` file at or under 500 nonblank lines. **Confirm `src/shared/haul.ts` and `nextSupplyTarget` are untouched** — if the diff reaches dispatch ordering, the split has leaked.
- [ ] **Step 3: `npm run check:all`, commit, open the PR**

---

## Notes for the implementer

- **Push back on this plan.** Roughly half of increment 4's briefs contained an error, and increments 8's plan contained two that pre-flight caught. Check each brief against the real files before starting.
- **The one thing not to compromise on** is Task 3's delivery path — a site that is offered materials and can never receive them is this increment's total failure, and three of the four changes in that task are outside `haul-dispatch.ts`. Confirm each gate lets a site through against the real files before implementing.
- **Do not fix the round-robin.** Task 11 Step 3 measures it and increment 10 fixes it, with a plan that eleven review rounds have already been spent on. A dispatch change smuggled in here would be unmeasured, would land outside the file list of every task in this plan, and would make the successor's measurement meaningless.
- **If a task finds itself inventing a second delivery mechanism for materials, stop.** The whole architecture of this increment is that a site is a building that needs things, and increment 7's machinery already knows how to feed one. A parallel path is the design this sequencing exists to avoid.
