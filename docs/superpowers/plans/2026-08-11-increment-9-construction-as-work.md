# Increment 9 — Construction as Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last place in the game where goods teleport and work happens for free. A building stops appearing finished the tick it is ordered; it becomes a site that occupies its tile, provides nothing, and is completed by materials carried to it.

**Architecture:** One new component (`Construction`), one new system (the countdown), and one reinterpretation: a construction site is **a phase an ordinary `Building` passes through**, not a new entity kind and not a fourth `BuildingDef` role. `Relocation` is the precedent — a component that suspends a building's service while it exists and occupies its tile — and this borrows its shape field for field. A site's demand is its def's `cost`, so `needOf` generalises and the whole delivery machinery from increments 7 and 8 applies unchanged.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-11-increment-9-construction-as-work.md`. Section references below (§2.4, §2.7, …) are to that document.

## The branch is playable throughout, with one visible oddity

No window where the colony is broken. But between Task 2 and Task 5, **ordering a building creates a site that never finishes** — the countdown does not exist yet, so it sits at its tile forever, providing nothing. That is the increment's whole feature arriving in two halves, it is obvious rather than subtle, and Task 5 closes it. Stated here so nobody bisects into it and files a bug.

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
  | `src/shared/haul.ts` | 420 | Task 4 |
  | `src/shared/save-migration.ts` | 415 | Task 8 |
  | `src/engine/systems/haul-dispatch.ts` | 395 | Task 3, Task 4 |
  | `src/engine/components.ts` | 350 | Task 1 |
  | `src/engine/systems/placement-handlers.ts` | 327 | Task 2, Task 7 |

  Check with `grep -cve '^\s*$' <file>` after every task that touches one.
- **Every task's tests must be greenable by that task's own changes.** `check:all` is required green at the end of every task, so a test asserting behaviour a *later* task enables cannot be committed — the implementer must then skip it, weaken it, or pull the later task forward, and all three are worse than writing the right assertion now. **This plan broke that rule three times in review** (Task 1's save round-trip needs Task 8's schema; Tasks 3 and 4 asserted completion, which needs Task 5's system), so before starting any task, check its tests against its own file list. Where the strong assertion belongs to a later task, the earlier one asserts the strongest thing it *can* reach and names the task that finishes the job.
- **Grep for the four "a building is a producer" proxies and justify every hit.** Every shipped predicate and constant in this engine was written when a building was one of exactly three things: a producer, a shelter, or a store. A site is none of them. Two rounds of review on this plan found **six** places that assumed a fourth kind could not exist, across four proxies — and enumerating them one review round at a time is not a method. §2.7 has the table; the search is:

  ```bash
  grep -rn "inputBufferCap" src/          # "an in-tray belongs to a recipe, so 12 is enough"
  grep -rn "staffed\|StaffedSet" src/     # "a building worth feeding has workers"
  grep -rn "relocatingTicks\|isRelocating" src/   # "the only non-working building is a moving one"
  grep -rn "affordableDefs\|canAfford" src/       # "you cannot order what you cannot pay for"
  ```

  Each hit is either a site exemption, a site exclusion, or deliberately neither — and the third case needs a sentence saying why. The tasks below name the hits two reviews found; they are not a complete list, and a task that finds a new one should fix it and say so rather than deferring it.
- **Mutation-test every test.** Back up by copy, `sed`, `diff -q` against **the backup** to confirm it applied, restore **by copy** — never `git checkout <file>`, which restores from HEAD and destroys uncommitted work.
- **Every clause of a compound boolean needs its own fixture.** §2.7 is six separate exclusions and §2.4 is an ordering with a new term ahead of the existing chain. Both are the shape where a whole-condition mutation reddens a gated path and looks like coverage.
- **Any quantity a dispatch spends must be tested with more than one hauler, and §2.4 needs more than one SITE.** Increment 8's over-claim family all passed single-hauler fixtures. The convergence rule is a *many* problem by construction and cannot be observed with one of either.
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
- Modify: `src/engine/world.ts`, `src/engine/components.ts`, `src/engine/spawn.ts`, `src/shared/placement.ts`
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
- Modify: `src/engine/systems/placement-handlers.ts`
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- `handleConstructBuilding` **stops calling `ctx.stockpile.pay(def.cost)`**, spawns with `Construction(BALANCE.buildTicks)`, and its notice says *started* rather than *built*.
- The id-exhaustion and tile checks stay, and stay **before** the spawn — neither is recoverable later. The `pay` rejection disappears with `pay` itself.

- [ ] **Step 1: Write the failing tests**

```ts
it('ordering a building does not move the ledger', async () => {
  // Colony stock IDENTICAL on the order tick. Assert the whole colonyStock(),
  // not just the two cost resources — a partial assertion passes an
  // implementation that pays a different resource.
});

it('a colony that cannot afford a building can still order it', async () => {
  // §2.3, and the decision it embodies. Empty ledger, order a mill, get a site.
  // This is the test that fails against any reservation design, so it is also
  // the one that pins the decision.
});

it('a site occupies its tile', async () => {
  // A second building cannot be placed on it. The site is an obstruction from
  // the order tick, not a reservation.
});

it('id exhaustion and an unbuildable tile are still refused', async () => {
  // Both rejections survive the removal of the third. Separate fixtures — a
  // single test covering both passes with one of them deleted.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: restore the `pay` call; spawn with `ticksLeft = 0`; move the tile check after the spawn.

---

### Task 3: A site's demand is its cost, and three gates must let it through

**Without all four changes in this task, no material can ever reach a site and the feature does not work at all.** Three of them are outside `haul-dispatch.ts`, and a brief scoped to `needOf` alone — as an earlier draft of this plan was — ships a site that is offered materials and can never receive them.

**Files:**
- Modify: `src/engine/systems/haul-dispatch.ts` (`needOf`, `supplyCandidates`), `src/engine/systems/haul-system.ts` (`unload`)
- Test: `tests/engine/systems/haul-dispatch.test.ts`, `tests/engine/systems/haul-system.test.ts`

**Interfaces:**
- `needOf` branches on `isUnderConstruction`: a site's wanted map is `BUILDINGS[defId].cost` and its per-resource room is `cost[r] − held[r]`, **not** `BALANCE.inputBufferCap`.
- `supplyCandidates` (line 172) checks `staffed.has(id)` **before** calling `needOf`, so the branch above is unreachable for a site until this gate exempts one. A site is never staffed: Task 6 forbids assigning workers, and a house or storehouse def has `workerSlots: 0` regardless.
- `unload` (`haul-system.ts:221–222`) does **both** remaining halves — it rechecks staffing, and it caps placement at `row.input.room(BALANCE.inputBufferCap)`. Exempt the first and make the second cost-aware, or a mill site accepts 12 of its 30 units while dispatch offers the remaining 18 forever. That is a livelock, not a shortfall.
- **Dispatch and arrival must be exempted together** — `staffed` is derived once per tick and handed to both readers precisely so they cannot drift (§2.5 of increment 7). Exempting only dispatch is worse than exempting neither: haulers walk to a site that refuses the load, the goods walk back, and the conservation sentinel stays at zero the whole time.

**Why the exemption is principled, and this belongs in the code comment:** increment 7 §2.6 gates on staffing because goods in an `InputBuffer` are out of the spendable ledger and die with the building. Neither half holds for a site — §2.6 refunds its materials in full on cancellation, and it consumes them by completing rather than by working. If a later increment adds a builder role or removes that refund, this exemption must be revisited.

Everything else downstream is unchanged. Do not add a parallel candidate builder — that is the second delivery mechanism the backlog note warns doing this before increment 7 would have required.

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

### Task 4: Age first — the ordering that makes a queue converge

**The sharpest rule in the increment**, and the one an implementation gets wrong by leaving the ranking alone. Read §2.4 in full before starting.

**Files:**
- Modify: `src/shared/haul.ts` (`SupplyCandidate`, `compareSupplyCandidates`), `src/engine/systems/haul-dispatch.ts`
- Test: `tests/shared/haul.test.ts`, `tests/engine/systems/haul-dispatch.test.ts`

**Interfaces:**
- `SupplyCandidate` gains `siteAge: number | null` — the building id for a site, `null` for a finished building. **No new state**: `IdCounter.take()` is monotone, so a lower id *is* an earlier order, and the tie-break chain already ends at this field.
- `compareSupplyCandidates` gains exactly two things:
  1. **when both candidates are sites**, age ascending decides ahead of every other term;
  2. **a site is never in the starvation band.**

  A site against a finished building is ranked by the existing terms, unchanged. **Do not add a "sites first" clause** — see below.

**Why, restated because the code will not show it:** `movable` is bounded by remaining room, so a nearly-complete site has small `movable` and **loses** to a newer empty one. Twenty sites round-robin and none finishes.

**And why the rule stops there.** An earlier draft put sites ahead of finished buildings unconditionally, which is a priority inversion: a site's cost is planks, planks come from a sawmill, the sawmill needs wood — sites outranking the sawmill send every log to the sites, the sawmill never produces, and the oldest site waits on planks that can never arrive. A continuously extended queue starves the producer indefinitely.

The two-part rule fixes that **with no dependency machinery**, and part 2 is what does it: a sawmill with an empty in-tray *is* starving, a site never is, so a blocked producer outranks a queue of sites automatically — through the band increment 8 already shipped for exactly this purpose.

- [ ] **Step 1: Write the failing tests**

```ts
it('an older site outranks a newer one that is emptier and nearer', () => {
  // Unit test on the comparator. DISCRIMINATING: the older site must lose on
  // EVERY pre-existing term — less movable, farther, and not starving — so a
  // fixture where it also wins on one of them proves nothing.
});

it('a STARVING producer outranks a site', () => {
  // The priority inversion, guarded from the direction that matters. A sawmill
  // with an empty in-tray beats a queue of sites that need its planks — which
  // is what stops the queue starving the chain that supplies it. Reverse this
  // and the fixture below deadlocks.
});

it('a queue of sites does not starve the producer that makes what they need', async () => {
  // The integration form: three plank-costing sites and a staffed sawmill with
  // an empty in-tray, wood in the camp. The sawmill must receive wood and
  // produce planks. Against a "sites first" ordering the sawmill never runs and
  // no site ever completes — which is exactly what an earlier draft specified.
});

it('a site is never in the starvation band', () => {
  // Part 2 of the rule, as a unit test. A site holding zero must NOT be
  // promoted the way a producer holding zero is.
});

it('among finished buildings nothing has changed', () => {
  // The regression guard for increments 7 and 8's ranking work.
});

it('with five sites, every dispatch serves the oldest incomplete one', async () => {
  // ACCEPTANCE CRITERION 4 expressed in terms this task can reach, and the
  // integration test the unit tests cannot replace. Runs against an UNMODIFIED
  // ranking and fails — confirm that before implementing, because it is the
  // whole justification for this task.
  //
  // DISPATCH order, not COMPLETION order: ConstructionSystem does not exist
  // until Task 5, so no site can finish here and a completion assertion cannot
  // go green. The round-robin is still fully visible — assert that site 1's
  // in-tray fills before site 2 receives anything. Task 5 adds the completion-
  // order test that criterion 4 is finally stated in.
  //
  // At one hauler and at four: the round-robin is worse with more haulers, so
  // a single-hauler fixture understates it.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: drop the site-before-building term; reverse age; move age after `movable`; apply the starvation band to sites. **The third is the one that matters** — it leaves a plausible-looking ordering that still round-robins, and only the five-site integration test catches it.

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

it('five sites ordered at once complete in the order they were ordered', async () => {
  // ACCEPTANCE CRITERION 4, finally statable: Task 4 proved the DISPATCH order
  // and this proves it produces the completion order it was chosen for. Both
  // are needed — dispatch order without completion order does not rule out a
  // countdown that reorders them, which is precisely what this task adds.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: count down regardless of materials; complete at `ticksLeft === 1`; record consumption on completion; place the system before `HaulSystem`.

---

### Task 6: The six places "exists" meant "works"

§2.7's table. **Six exclusions, six fixtures** — this is the task the compound-boolean rule was written for.

**Files:**
- Modify: `src/engine/systems/population-handlers.ts` (rehome), `src/engine/systems/command-system.ts:105` and `src/engine/systems/population-system.ts:72` (the two runtime shelter-row builders), `src/engine/snapshot-builder.ts:223` (the published bed total), `src/engine/systems/haul-sites.ts` (`storeSitesOf`), `src/engine/systems/production-system.ts`, `src/engine/systems/command-handlers.ts:140` (worker assignment), `src/engine/snapshot-buildings.ts`
- Test: the matching suites

**"An unfinished house has no beds" has FIVE call sites**, three of them here and two in Task 8. `grep -rn "relocatingTicks === 0\|isRelocating(\|state !== 'relocating'" src/` finds them: `command-system.ts:105` and `population-system.ts:72` build the runtime shelter rows, `snapshot-builder.ts:223` computes the **published** bed total, and `restore.ts:123` / `save-guard.ts:95` are load-time. Fixing only the rehome path leaves a colonist seated in a site by whichever of the others ran first.

`snapshot-builder.ts:223` is the one that is not about occupancy at all: `buildingSnaps.filter((b) => b.state !== 'relocating')`. It governs what the Population view *advertises*, and the comment directly above it states the principle a site would violate — "`total` therefore means beds you can actually sleep in tonight, which is the only number a player can act on." Without it the view reads spare capacity while the birth and nomad gates correctly refuse it, which is the display contradicting the rule it exists to explain. Add `src/engine/snapshot-builder.ts` to this task's files and assert a site's beds are absent from `snapshot.beds.total`.

**The one that will be missed:** `pending.constructed` is folded into homing precisely so a colonist can be sheltered on the tick a house appears — `shelters` in `command-system.ts:107`, verified. That now shelters them in a hole in the ground. It is the only entry in the table where the *existing* behaviour is a deliberate same-tick optimisation rather than an incidental lookup.

**The one that is an addition rather than an exclusion:** `handleAssignWorker` (`command-handlers.ts:140`) gates on `found.slots.max`, and a site carries its def's `workerSlots` like any other building — a mill site has two. So it accepts workers today and the refusal must be **added**, not preserved. With no builder role (§1.2) a colonist assigned to a site would stand in it doing nothing, which `ProductionSystem`'s exclusion makes silent rather than visible.

- [ ] **Step 1: Write six failing tests, one per row**

```ts
it('a house under construction shelters nobody, including on its own construction tick', async () => {});
it('a storehouse under construction is not a store destination', async () => {
  // And the second-order proof: loads route PAST it to the camp, exactly as
  // they did before it was ordered.
});
it('a site runs no recipe and produces nothing', async () => {});
it('a site cannot be assigned a worker', async () => {});
it('a site reports underConstruction, not relocating or waitingForInput', async () => {});
it('a site is not counted as colony wealth', async () => {
  // Not in the ledger it left AND not in the building it has not become.
});
```

- [ ] **Step 2: Implement, mutation-test each exclusion separately, commit**

Six mutations, one per exclusion, each reddening exactly one test.

---

### Task 7: Cancellation and conservation

**Files:**
- Modify: `src/engine/systems/placement-handlers.ts` (demolish, move)
- Test: `tests/engine/systems/command-system.test.ts`

**Interfaces:**
- **The existing `def.cost` refund loop (`placement-handlers.ts:144`) must branch on construction state.** It refunds the full cost unconditionally, which was right while Task 2's `pay(def.cost)` charged it at order. With that payment gone, cancelling a site **mints the cost from nothing**, and cancelling a partly-supplied site refunds the cost *and* the in-tray — the same goods twice. Both are conservation failures.

  | demolished | cost refund | in-tray |
  | --- | --- | --- |
  | a finished building | yes, unchanged | destroyed, unchanged |
  | a site | **no** — nothing was paid | **refunded** via `refundAt` |

- Demolishing a site refunds its delivered materials through `destinationFor` with the reservation-aware `heldAt`.
- **`demolitionNotice` (`placement-handlers.ts:101`) must become site-aware**, and this is OBS-4-07 repeating rather than a cosmetic edit. It opens with a hardcoded `` `Demolished the ${name} — cost refunded` `` and describes the in-tray as *lost* — for a site, both halves are exactly backwards: no cost is refunded and the materials come back. OBS-4-07 is filed against precisely this failure, a notice claiming "cost refunded" while goods were silently deleted, and shipping the inverse of it here would be the same defect with the sign flipped.
- `handleMoveBuilding` **refuses a site**, with a notice (§2.6, §2.12).

- [ ] **Step 1: Write the failing tests**

```ts
it('cancelling a site with NOTHING delivered refunds nothing', async () => {
  // THE MINTING TEST, and the one an implementation reading only "sites refund
  // their materials" will not think to write. Order a mill, demolish it before
  // a single hauler arrives, assert the colony total is UNCHANGED. Against the
  // unbranched loop this reports +20 wood +10 planks from nowhere.
});

it('cancelling a partly supplied site refunds only what arrived', async () => {
  // The double-refund case. 6 wood delivered of 20: the total rises by 6, not
  // by 26 and not by 20.
});

it('cancelling a site refunds what was delivered to it', async () => {
  // Assert the COLONY TOTAL, and separately that deliveredRate did NOT move —
  // refundAt not addAt. The total alone passes against addAt.
});

it('demolishing a FINISHED building still refunds its cost', async () => {
  // The other side of the branch, and the regression guard for every increment
  // before this one. Without it the branch can be written as "never refund".
});

it('cancelling a partly supplied site says what actually happened', async () => {
  // The NOTICE, asserted on its text. It must not claim a cost refund and must
  // not describe the returned materials as lost. OBS-4-07 exists because a
  // notice said "cost refunded" while goods were deleted; shipping its inverse
  // here is the same defect with the sign flipped, and the ledger assertions
  // above all pass while the player is told the opposite of the truth.
});

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
- Modify: `src/shared/save.ts`, `src/shared/save-migration.ts`, `src/engine/game-engine.ts`, `src/engine/restore.ts`, `src/engine/spawn.ts` (`clampedInputBuffer`), `src/engine/initial-snapshot.ts`, `src/engine/save-guard.ts`
- Test: `tests/shared/save.test.ts`, `tests/shared/save-migration.test.ts`, `tests/engine/world.test.ts` (the paused-snapshot projection), `tests/engine/save-guard.test.ts`

**Four files beyond the obvious two**, because "the save carries a new number" understates what restore touches:
- `spawn.ts` — `clampedInputBuffer` clamps the live entity to `inputBufferCap`
- `initial-snapshot.ts:118` — the **same clamp** on the paused snapshot, a *second* projection; fix one and a restored 30-unit site holds 30 while the screen says 12
- `restore.ts:123` — `usableBeds`
- `save-guard.ts:95` — `colonistTargets`, both halves: `shelters` gates on `relocatingTicks === 0`, and `workplaces` adds every recipe building regardless of construction, so a hand-edited v7 save can assign a worker to a site and pass the guard

**One hit of the `relocatingTicks === 0` proxy is deliberately left alone:** `save-migration.ts:156` needs no construction term, because the v6 → v7 migration is total — every building in a pre-v7 save is finished, so no migration step can see an unfinished one. Record that in a comment rather than adding a term that can never fire.

**Interfaces:**
- `LATEST_SAVE_VERSION = 7`. `SavedBuilding` gains `constructionTicks: number`, guarded with `isTickCounter` — the same check `relocatingTicks` and `starvingTicks` use.
- Migration v6 → v7 sets it to **0 for every building**: every building in a v6 save is finished by construction, so the migration is total and needs no heuristic.
- **No new field for the materials.** `SavedBuilding.inputBuffer` already round-trips.
- The bump is self-policing — `SaveGameV6.version` is the literal `6`, so raising the constant fails typecheck at both producers until the type is updated.

**Two restore-path defects that the "no new field needed" framing hides.** `SavedBuilding.inputBuffer` does round-trip, and that is not sufficient:

- `buildingComponents` restores through `clampedInputBuffer` (`spawn.ts:113`), which is `clampedBuffer(saved, BALANCE.inputBufferCap)`. **A 30-unit mill site saved mid-countdown reloads holding 12**, destroying 18 units the ledger already recorded as consumed. The clamp must take the site's cost as its bound, as `needOf` and `unload` do.
- `usableBeds` (`restore.ts:118`) gates on `count > 0 && b.relocatingTicks === 0` — relocation being the only way a house could exist unusable. An unfinished house otherwise seats colonists at load, and the **paused initial snapshot reports them housed** until the first tick evicts them.

- [ ] **Step 1: Write the failing tests, then implement, then mutation-test, commit**

```ts
it('a site mid-build round-trips its countdown and its delivered materials', async () => {
  // The in-tray fixture MUST exceed BALANCE.inputBufferCap — 30 units, not 6.
  // Below the cap it passes against the unfixed clamp and proves nothing, which
  // is the whole reason this defect survived a draft that said the field
  // "already round-trips".
});
it('an unfinished house houses nobody at load, in the paused snapshot', async () => {
  // Before any tick runs. Asserting after a step passes against the runtime
  // rehome eviction and misses the restore predicate entirely.
});
it('a v6 save loads with every building finished', async () => {});
it('a negative or fractional constructionTicks is rejected', async () => {});
```

---

### Task 9: Snapshot and surfaces

**Files:**
- Modify: `src/engine/snapshot-buildings.ts`, `src/shared/snapshot.ts`, the Buildings table, the Economy view, `src/app/world/layout.ts`
- Test: `tests/app/buildings-view.test.ts`, `tests/app/economy-view.test.ts`, `tests/app/world-layout.test.ts`, `npm run smoke:world`

**Interfaces:**
- State `'underConstruction'`, ahead of `'relocating'` in the precedence chain.
- **A site publishes what it still needs, per material.** This is what replaces the affordability refusal Task 2 removed: the player sees "needs 14 wood" instead of being told they cannot order it.
- The Economy view names a **build backlog** beside the input and output backlogs.
- **The affordability gates come out of all three build surfaces.** Task 2 removes the refusal in the command handler, and without this the queue-without-materials behaviour is **unreachable through the UI** — acceptance criterion 5 passes in the engine and the player still cannot order the site:

  | surface | today |
  | --- | --- |
  | `src/app/components/BuildPalette.vue:28` | `:disabled` unless `affordableDefs[id]` — cannot arm placement |
  | `src/app/views/WorldView.vue:66` | placement predicate returns `affordableDefs[m.defId]` — rejects the tile |
  | `src/app/views/BuildingsView.vue:70` | `:disabled` on the table button, tooltip "Not enough resources" |
  | `src/app/stores/game-store.ts:172` | `affordableDefs` — the getter all three read |

  `affordableDefs` is **not deleted**: it stops gating and starts informing. What it tells the player remains true and worth showing, so the tooltip becomes advisory rather than a refusal.

- [ ] **Step 1: Find the surfaces before writing anything**

`grep -rn "relocating" src/app` for the state, and `grep -rn "affordableDefs" src/app` for the gates — the four rows above are what review found, and the grep is what confirms there is no fifth. Pre-flight the brief against the real files.

The test that matters here is a **UI-level** one: with an empty ledger, the palette arms, the tile is accepted, and the order goes through. An engine-level test of criterion 5 already exists in Task 2 and passes regardless of these gates, which is exactly how this was missed.

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
- The conservation sentinel must count a site's in-tray and a site's refund.

- [ ] **Step 1: Test the instruments before trusting them**

```ts
it('the completion log records order, not just totals', async () => {
  // Three sites completing at different ticks. A count passes a round-robin;
  // only the order distinguishes it.
});
it('a scenario with no sites reports no completions', async () => {
  // The zero side, which is what catches an over-counting instrument.
});
it('goods in a site in-tray are conserved', async () => {});
```

- [ ] **Step 2: Verify and commit**

---

### Task 11: Measure

**Files:**
- Modify: `tests/engine/balance.test.ts`, the spec's §4

- [ ] **Step 1: The build time sweep** — at least three values of `buildTicks`, on a fixture where delivery is fast and one where it is slow. The question is whether the countdown does anything the delivery leg does not already do. If it is invisible next to the walk, say so.
- [ ] **Step 2: Does build time want to scale with cost?** A house and a workshop take the same time at a flat constant. Build several of each and report whether flat reads as wrong.
- [ ] **Step 3: Convergence.** N sites at one hauler and at four; report the completion *curve*, not just the order. A flat curve is the failure §2.4 predicts.
- [ ] **Step 4: What a colony pays to grow.** Ticks from order to first output, near the camp and at the far corner. Increment 5 priced delivery; this prices building.
- [ ] **Step 5a: Connect the instrument BEFORE taking the OBS-8-06 reading.** `demandSourcesOf` (`haul-transfer.ts:54`) skips unstaffed buildings and derives demand from `recipe.inputs` alone, so as the engine stands **a remote site creates no depot demand and staging cannot fire for it at any distance.** Teach it about sites — unstaffed, demand from `cost` — and prove it with a fixture that shows a depot acquiring demand from a nearby site. This is a code change inside a measurement task, deliberately: taking the reading first would produce a confident zero from an instrument that was never connected, which is the increment-7 harness failure repeating.
- [ ] **Step 5b: OBS-8-06.** A site ordered far from the camp with a depot between. Report whether staging fires, how often, and whether the site completes sooner with the depot. §4.2 names the three outcomes and all three are worth having — **do not tune to reach one of them.** If Step 5a was skipped, the reading is invalid and reports the third outcome by construction.
- [ ] **Step 6: Write §4.1 and §4.2 from what was measured**, in §4.3-of-increment-7's manner. If a decision this spec took measures badly, record the disagreement rather than retuning toward the claim.
- [ ] **Step 7: Verify and commit**

---

### Task 12: Document and close out

**Files:**
- Modify: `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md` (OBS-5-03 → Done, closed by construction rather than by bookkeeping — the outcome its own note predicted), `docs/issues/2026-08-11-the-staging-half-of-transfer-is-correct-and-almost-never-worth-a-trip.md` (OBS-8-06, updated with §4.2's reading whichever way it went), `docs/requirements/Construction as Work.md` (status), `docs/README_PRODUCT_BACKLOG.md` if statuses roll up
- Create: a Feature note for the builder role if §4 argues for one; any issue Task 11 found

- [ ] **Step 1: Close what closed, carry what did not.** An issue that is not fixed gets its note updated with what this increment learned, not left untouched.
- [ ] **Step 2: Whole-branch review.** Read the diff for the compound-boolean shape specifically, and for the multi-hauler/multi-site over-claim shape. Confirm no skip survives, no baseline moved, no suppression added, every `src/` file at or under 500 nonblank lines.
- [ ] **Step 3: `npm run check:all`, commit, open the PR**

---

## Notes for the implementer

- **Push back on this plan.** Roughly half of increment 4's briefs contained an error, and increments 8's plan contained two that pre-flight caught. Check each brief against the real files before starting.
- **The one thing not to compromise on** is Task 4's five-site integration test. Everything else here is machinery; that test is the only thing standing between this feature and a build queue that crawls. Confirm it fails against the unmodified ranking *before* implementing — a test that was never seen to fail is a claim, not evidence.
- **If a task finds itself inventing a second delivery mechanism for materials, stop.** The whole architecture of this increment is that a site is a building that needs things, and increment 7's machinery already knows how to feed one. A parallel path is the design this sequencing exists to avoid.
