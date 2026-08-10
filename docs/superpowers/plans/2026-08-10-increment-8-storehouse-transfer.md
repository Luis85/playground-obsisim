# Increment 8 — Storehouse-to-Storehouse Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supply the flow increment 7 measured the absence of. A store site can currently be filled by a building's output but never emptied, so a depot saturates at 60 of 60 and its advantage is a flat one-off. This increment lets a hauler move goods from one store site to another — pulled by a consumer's demand, and pushed to the camp when a depot's headroom is gone — and fixes the dispatch fairness floor first, because without it the far building the depot exists for never gets staged.

**Architecture:** No new component and no new system. `HaulKind` gains a third member, and a transfer is **the supply trip minus its middle leg**: `fetching` to a source site, then `returning` to a destination site, with `targetId` null throughout. `src/shared/haul.ts` grows the demand law — a site's demand derived from the buildings it is the nearest live site to — beside the site law it already owns. `haul-dispatch.ts` grows a third candidate builder and one new claim. Both arrival handlers already exist and become kind-aware. **The save is untouched:** trip state is not serialized, so a third `HaulKind` needs no version bump.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md`. Section references below (§2.4, §2.6, …) are to that document.

## Two measurement checkpoints, and why the order is not negotiable

Task 1 fixes OBS-7-01's fairness floor. **Task 2 measures it with no transfer code anywhere in the tree.** Tasks 3–10 build transfer. Task 11 measures that.

This costs a whole task and buys the only thing that makes either number readable. The staging half of transfer exists to relieve the in-tray concurrency cap; that cap is OBS-7-02; OBS-7-02 is blocked on OBS-7-01. Build both at once and a disappointing transfer reading is indistinguishable from a ranking that was still starving the far consumer — which is exactly the failure §4.3 of increment 7 spent a task diagnosing the *first* time.

**Do not reorder these.** Task 2's numbers go into the spec's §4.1 and are quoted by Task 11's analysis.

## The branch is playable throughout

Unlike increment 7, no window exists where the colony is broken. Task 1 changes a ranking; Tasks 3–5 add law and candidates that nothing dispatches yet; Task 6 turns the mechanic on. Every intermediate commit is a working colony — which means a bisect into this branch lands somewhere meaningful, and there is no "skipped integration test" to un-skip before merge.

One softer window worth knowing: between Tasks 4 and 6 the `'transfer'` member exists on `HaulKind` and nothing ever produces one. Any `switch` that must be exhaustive will compile; any UI label added in Task 9 is unreachable until Task 6. That is a type-level window, not a gameplay one.

## Global Constraints

- **No new component and no new system.** Nothing to add to `buildingComponents`/`colonistComponents` in `src/engine/spawn.ts`, nothing to append to `COMPONENT_TYPES` in `src/engine/world.ts`, nothing to insert into `ALL_SYSTEMS`. OBS-4-02's two-spawn-site trap does not apply this increment — if a task finds itself adding a component, stop and re-read §2.3, because the design says it does not need one.
- **The save is not touched.** `LATEST_SAVE_VERSION` stays 6. No `MigrationStep`, no `SAVE_GUARDS` entry, no `SaveGameV7`. Trip state is not serialized (`buildSaveFromWorld` banks a mid-trip load into the camp and writes no trip), so a third `HaulKind` cannot reach a save file. **If any task finds itself editing `src/shared/save.ts`, it has misread the design** — raise it rather than bumping the version.
- **Mutation-test every test:** break the feature, confirm the named test fails, restore. Fixture values must *discriminate* — if the wrong field holds the same value, the assertion proves nothing.
- **Any quantity a dispatch spends must be tested with MORE HAULERS THAN ONE.** This increment's own spec shipped the same bug four times, in four different terms, and every one of them passes a single-hauler fixture: dispatch runs many haulers per tick while physical stock does not move until a hauler *arrives*, so a bound computed from `getAt`/`totalAt` is identical for every hauler that tick and gets spent as many times as there are idle haulers. The check, applied to any bound: **if ten idle haulers were dispatched on the same tick, would this have stopped the tenth?** Task 12 adds this to `docs/process/agent-workflow.md` as a fourth recurring failure mode, beside the three already there.
- **Every clause of a compound boolean needs its own fixture.** This increment adds a clause to `remainderHome` and to `fetchArrival`'s cancel guard, and both sit inside conditions whose *other* clauses are already gated — the exact configuration where a whole-condition mutation reddens the gated path and looks like coverage while the new clause is untested. Increment 7's whole-branch review found ten defects of this one shape. Test each clause with a fixture where the other clauses are false.
- **A mutation that makes a system THROW does not fail a test by default.** sim-ecs catches a system's exception and publishes it as a `SystemError` event, so the run completes and the assertion reads pre-crash state:

  ```ts
  const errors: unknown[] = [];
  world.eventBus.subscribe(SystemError, (e) => errors.push(e));
  // …step…
  expect(errors).toHaveLength(0);   // and the mutation makes this fail
  ```

- **Confirm every mutation actually applied, and restore by copy.** `sed` exits 0 when its pattern matches nothing, and `git checkout <file>` restores from HEAD — destroying uncommitted implementation rather than just the mutation. Diff against **the backup copy you just took**, never against HEAD:

  ```bash
  cp <file> /tmp/mut-backup
  sed -i 's/…/…/' <file>
  diff -q /tmp/mut-backup <file> && echo "MUTATION DID NOT APPLY"   # vs the copy, NOT HEAD
  npx vitest run <focused test file>         # expect ONLY the named test red
  cp /tmp/mut-backup <file>                  # restore — NOT git checkout
  ```

- **The 500-nonblank-line cap is a design constraint.** Current counts and the task that owns each split:

  | file | now | owner of its split |
  | --- | ---: | --- |
  | `src/engine/world.ts` | 489 | **must not grow.** Contingency if it does: extract `initialSave` to `src/engine/initial-save.ts` |
  | `src/engine/snapshot-builder.ts` | 368 | Task 9 (unlikely to trip; `snapshot-buildings.ts` already split out) |
  | `src/app/world/layout.ts` | 366 | Task 9 |
  | `src/engine/components.ts` | 332 | Task 4 |
  | `src/shared/haul.ts` | 281 | Task 3 (contingency: `src/shared/store-demand.ts`) |
  | `src/engine/systems/haul-dispatch.ts` | 273 | Task 5 (contingency: `src/engine/systems/haul-transfer.ts`) |
  | `src/engine/systems/haul-system.ts` | 298 | Task 6 |
  | `src/engine/systems/haul-sites.ts` | 165 | Task 6 |

  Check with `grep -cve '^\s*$' <file>` after every task that touches one. **No baseline may be loosened and no suppression added.**
- **Never `--update` a quality baseline to make a gate pass.** `check:quality --update` refuses a loosened value without `--allow-regression`, and refuses pinned-at-zero breaches outright.
- **Never pad comments to buy maintainability points.** Fallow's MI has no length term.
- **Commit by pathspec** (`git commit <path> -m …`), never `git add` + bare `git commit`. A new file needs one `git add` immediately before its commit.
- **Balance constants live only in `src/engine/content/balance.ts`.** `src/shared/**` imports nothing outside itself — which is why `haulTicks` takes `tilesPerTick` and why the demand law in Task 3 takes its target as a parameter rather than reaching for `BALANCE`.
- **Goods are carried, never teleported.** The forward-to-camp guarantee exists only where **no hauler remains to do the walking** — a cancellation, a stand-down, a load-time spill. No transfer may be implemented as a ledger adjustment, and a transfer arriving at a full destination carries on rather than having its load forwarded for free. Free depot-to-camp transport would flatter exactly the number §4.2 is measuring.
- **The dispatch/arrival rule:** every condition a dispatch rests on is either *reserved* or *rechecked* on arrival. Violated and fixed three separate times in increment 7. §2.7 enumerates the new kind's conditions and marks which are which — including the two that are deliberately neither, with the reasoning.
- **Assert on colony-wide totals, not on the field you just wrote.** `conservationError === 0` in every balance scenario. The total is what a player would notice being violated and what a future refactor cannot accidentally satisfy.
- `npm run check:all` must be green at the end of every task. Run `rm -rf coverage` first: `check:quality` hard-fails if `coverage/` exists.
- **A raw `await world.step()` does NOT refresh the snapshot's entity sections.** Use `stepTick` from `tests/engine/fixtures.ts` in any test that asserts on entities appearing or disappearing.

---

### Task 1: The fairness floor (OBS-7-01)

The ranking has no fairness term, so while the nearer hungry building can still take a load it wins every comparison. A bakery at leg 8 behind a mill at leg 6 makes **zero** bread in 600 ticks. §2.1.

**Files:**
- Modify: `src/shared/haul.ts` (`SupplyCandidate`, `compareSupplyCandidates`), `src/engine/systems/haul-dispatch.ts` (`supplyCandidates` populates the new field)
- Test: `tests/shared/haul.test.ts`, `tests/engine/systems/haul-dispatch.test.ts`

**The correction this task rests on — read before starting.** OBS-7-01's "Suggested resolution" offers ageing and says it "could be derived rather than stored: `waitingForInputTicks` is already a live component field and already published." **It is not.** `waitingForInputTicks` is an accumulator in `tests/support/balance-harness.ts` (`StageResult`), summed by sampling snapshot status each tick. Grep confirms no component carries it. Adding one would be memory between ticks, which §2.6 of increment 7 forbids by name. Take the issue's *second* shape instead — a starvation term derived from live state. The issue note is corrected in Task 12.

**Interfaces:**
- `SupplyCandidate` gains `starving: boolean` — **the building holds zero of the resource this candidate would deliver.** Derived in `supplyCandidates` from `row.input.amounts.get(need.resource) ?? 0`, which is public (`ResourceBuffer.amounts` is `public readonly`). Not "holds zero of any input" — the band must be about the resource this candidate is actually for, or two candidates for the same building rank differently for no reason a player could see.
- `compareSupplyCandidates` order becomes: **starving first**, then `movable` descending, then whole route ascending, then building id, then site id. One new term at the front; every existing term keeps its position and its meaning.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/shared/haul.test.ts — the comparator, unit-tested directly, because the
// integration test cannot separate the new term from the route term.
it('a starving building outranks a topping-up one that is nearer', () => {
  // DISCRIMINATING: the starving candidate must be FARTHER and have LESS
  // movable stock, so it loses on every pre-existing term. A fixture where it
  // also wins on distance passes with the new term deleted.
});

it('among starving buildings the nearer is still served first', () => {
  // The counter-direction §2.1 requires. Both starving; route decides.
});

it('among topping-up buildings nothing has changed', () => {
  // Pins the existing order — this is the regression guard for criterion 2.
});

it('the starving term does not disturb the id tie-breaks', () => {
  // Two identical starving candidates differing only in site id.
});
```

```ts
// tests/engine/systems/haul-dispatch.test.ts — the field is populated correctly
it('a building holding some of what it needs is not starving', async () => {
  // 1 unit of flour in the in-tray, room for 11 more. NOT starving.
  // Mutating `=== 0` to `<= 1` must redden this.
});

it('starving is about the resource being delivered, not any input', async () => {
  // A recipe with two inputs: zero of A, plenty of B. The candidate for A is
  // starving; the candidate for B is not.
  //
  // PRE-FLIGHT RESULT: no shipped recipe has two inputs — every def in
  // `src/engine/content/buildings.ts` has 0 or 1. So this test REQUIRES a
  // fixture-local two-input def; it cannot be written against the catalog.
  //
  // Which means the distinction is untestable through the catalog and today
  // `starving` and "in-tray empty" coincide exactly. Write the test anyway,
  // against the fixture def: the per-candidate form is what stops the rule
  // silently meaning the wrong thing the first time a recipe gains a second
  // input, and a rule that only becomes wrong later is the kind this repo has
  // been bitten by twice.
});
```

- [ ] **Step 2: Implement**

The comparator term and the `supplyCandidates` field. Put the reasoning where the term is, not only in the spec — specifically *why this is a floor rather than a different priority*: the condition it ranks on is extinguished by serving the building once, so it cannot pin a hauler to a distant building indefinitely.

- [ ] **Step 3: Mutation-test**

At minimum: delete the starving term; invert it; change `=== 0` to `< 2`. Each must redden exactly one named test.

- [ ] **Step 4: Verify and commit**

`npm run check:all`. Commit by pathspec.

---

### Task 2: Measure the fairness floor, alone

**No transfer code exists in the tree at this point and none may be added by this task.** These numbers go into spec §4.1 and Task 11 quotes them.

**Files:**
- Modify: `tests/engine/balance.test.ts` (the existing `dispatch order under a drained ledger` describe block), `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md` (§4.1)

- [ ] **Step 1: Invert the existing finding into a guard**

`tests/engine/balance.test.ts`, *"collection resumes, but the farther consumer can be starved outright"*, asserts `made === 0` for the far bakery. That assertion **is** the finding today and becomes the regression guard inverted. Rename the test to say what it now guards.

**Both bounds must stay meaningful** (OBS-7-01 says so and it is the discrimination test): a dispatcher that starved the second stage regardless of position puts both tile orders at zero; a dispatcher that shared haulers puts both above zero. Assert both orders, so the test distinguishes the fix from a different breakage.

- [ ] **Step 2: Take the readings**

- Mill/bakery, both tile orders, at 1 / 2 / 3 haulers. The table in OBS-7-01 is the before; produce the after in the same shape.
- Increment 5's distance sweep and increment 7's processor sweep, **unchanged fixtures**. Acceptance criterion 2. If any figure moves, name it and justify it — do not adjust the fixture.
- The hauler-tick split, to confirm the fix did not convert throughput into walking.

`BALANCE_REPORT=1` drives the existing report tests.

- [ ] **Step 3: Write §4.1**

Into the spec, as its own table, labelled as taken before transfer existed. State plainly whether criterion 2 held.

- [ ] **Step 4: Verify and commit**

---

### Task 3: The demand law

A site has no recipe, so its demand is derived from the buildings it is nearest to (§2.2). Pure shared law, no engine imports, no `BALANCE`.

**Files:**
- Modify: `src/shared/haul.ts`
- Test: `tests/shared/haul.test.ts`
- Contingency if `haul.ts` passes 500 nonblank (it is at 281): extract to `src/shared/store-demand.ts`

**Interfaces:**

```ts
/** One building's pull on whatever site is nearest to it. */
export interface DemandSource {
  col: number; row: number;
  inputs: readonly ResourceId[];   // the recipe's input ids — the engine resolves the catalog
}

/** Per-site, per-resource demand, keyed siteId → resource → units. */
export function siteDemandOf(
  sites: readonly StoreSite[], sources: readonly DemandSource[], targetPerSource: number,
): Map<number, Map<ResourceId, number>>;
```

`targetPerSource` is a parameter, not `BALANCE.siteStagingTarget`, for the reason `haulTicks` takes `tilesPerTick`: `src/shared/**` imports nothing outside itself.

Resolution is `nearestSite(col, row, sites)` — already exported, currently unused by dispatch, and already "nearest, then id" so the answer never depends on array order.

**The engine, not this function, filters `sources`.** Staffed and non-relocating are engine conditions (`StaffedSet`, `Relocation`); passing a filtered list keeps the law free of both.

- [ ] **Step 1: Write the failing tests**

```ts
it('a building pulls on the site nearest to it, and on no other', () => {});

it('two buildings nearest the same site add their demand', () => {
  // 2 × target, not target. A max-instead-of-sum implementation must redden.
});

it('a building equidistant from two sites pulls on the lower id', () => {
  // The `closer` tie-break, inherited rather than reimplemented.
});

it('a site nearest to nothing has no demand for anything', () => {
  // The corner-chain depot in §4.3 — and the case the push rule exists for.
});

it('the camp is an ordinary site here', () => {
  // A building beside the camp pulls on the camp. NOT special-cased.
});

it('demand is per-resource', () => {
  // A mill nearest to a depot creates wheat demand there and no flour demand.
});
```

- [ ] **Step 2: Implement**

- [ ] **Step 3: Mutation-test**

Point `nearestSite` at the camp unconditionally; replace sum with assignment; drop the per-resource keying. Each reddens exactly one named test.

- [ ] **Step 4: Verify and commit**

---

### Task 4: `HaulKind` gains a third member

The type widens and the trip shape is documented. Nothing produces a transfer yet.

**Files:**
- Modify: `src/shared/haul.ts` (`HaulKind`), `src/engine/components.ts` (`HaulTrip` doc comments only)
- Test: `tests/engine/components.test.ts`

**Interfaces:**
- `export type HaulKind = 'collect' | 'supply' | 'transfer';`
- **`HaulTrip` gains exactly one field, `staging: boolean`, and no others.** `sourceSiteId`, `destSiteId`, `plannedAmount`, `amount`, `resource`, `pickedUp` already carry everything a transfer's *mechanics* need, which is what makes §2.7's claim invariant hold for the new kind. `targetId` stays `null` for a transfer's whole life.

  **The correction, and why it is not a loosening.** This bullet read "no new fields on `HaulTrip`" until a review of the plan found the consequence: Task 10 requires `transfersStaging` / `transfersDrain` counted separately, because §4.2 must be able to say *which half did the work* — and the class is unrecoverable from everything else on the trip. The snapshot publishes neither `sourceSiteId` nor `destSiteId` (`snapshot-builder.ts` publishes `haulKind`, `haulTargetId` and `haulPickedUp` only), so a harness sees no more than "a transfer started". Worse, the route is not a discriminator even with full trip access: §2.2 makes the camp an ordinary site in the pull rule, so a depot → camp move can legitimately be *either* class, with the same source, destination and resource. Re-deriving the class in the harness by recomputing site demand would put a second copy of the dispatch law in test support — the failure `StaffedSet` exists to prevent, and the shape of increment 7's harness defect.

  A boolean set at dispatch on the trip's own component satisfies the claim invariant exactly as `pickedUp` does: it is written at the moment the difference is real, it is read back from live components, nothing is remembered outside the trip, and dispatch stays a pure function of world state. `HaulTrip` is runtime-only, so **the save is still untouched** — `clearTrip` resets it to `false` beside every other field, and `false` for every `collect` and `supply` trip is the truth rather than a default.

  It is `staging`, not `kind: 'staging' | 'drain'`: the two classes are one job with two reasons, they share every line of the trip machinery, and a fourth `HaulKind` would force a branch at every exhaustive site for a distinction no arrival handler makes.
- `HaulTrip.kind`'s doc comment gains the transfer case: for a transfer it describes the whole trip accurately, unlike for supply, because a transfer never picks up output.

- [ ] **Step 1: Widen the type and follow the compiler**

`tsc` names every exhaustive site. Expect the snapshot union (`src/shared/snapshot.ts` `haulKind`) to widen for free. **Any site that needs a `'transfer'` branch before Task 6 should throw or be marked unreachable rather than guessed at** — a wrong default here is invisible until Task 11's measurement is already contaminated.

- [ ] **Step 2: Test that the trip shape holds**

```ts
it('a transfer trip carries its whole intent in components', () => {
  // Set kind/sourceSiteId/destSiteId/plannedAmount/staging by hand; assert
  // every field a dispatch would need is readable back with no external state.
});

it('cancel() clears the staging flag', () => {
  // A hauler that ran a staging transfer and then takes a collect job must not
  // still report `staging`. DISCRIMINATING: set it true, cancel, assert false —
  // a `clearTrip` that omits the field passes every other test in the suite,
  // and the symptom would be a silently inflated `transfersStaging` in §4.2.
});

it('cancel() brings a transfer to a stop where it is standing', () => {
  // legPositionOf, same as any other kind — the shared law, not a new branch.
});
```

- [ ] **Step 3: Verify and commit**

Confirm `src/shared/save.ts` is untouched. If the compiler asked for a save change, stop and re-read §2.11.

---

### Task 5: Transfer candidates, and the one new claim

**Files:**
- Modify: `src/engine/systems/haul-dispatch.ts`, `src/engine/content/balance.ts`
- Create (if the line budget requires): `src/engine/systems/haul-transfer.ts`
- Test: `tests/engine/systems/haul-dispatch.test.ts`, `tests/engine/content.test.ts`

**Interfaces:**
- `BALANCE` gains `siteStagingTarget: 12`, `minTransferUnits: 4`, `storehouseFreeFloor: 12`. Each gets a doc comment naming the §4 question it is unmeasured against — these are starting points, and saying so is how increment 5's "tuned later" lie is not repeated.
- `Claims` gains **one** lookup:

  ```ts
  /** Units of a resource already walking toward a site on a transfer — the
   * site-level twin of `input`, and for the identical reason: without it every
   * idle hauler transfers into the same deficit on the same tick. */
  inboundAt(siteId: number, resource: ResourceId): number;
  ```

  Summed over trips as `kind === 'transfer' && destSiteId === siteId && resource === r`
  → `plannedAmount + (phase === 'returning' ? amount : 0)`. The two terms are
  disjoint: `plannedAmount` is zeroed the moment `takeAt` returns a real figure,
  and `amount` is zero until then — the same disjointness `Claims.input` relies on.
- **`heldAtOf` must also change**, and this is the easiest thing in the increment
  to miss because the function looks like it already covers the case. It counts
  only `phase === 'returning'`, so a transfer that reserved its destination at
  dispatch contributes **nothing** to `heldAt` for the whole fetch leg — the leg
  during which the reservation is the only thing standing between two haulers and
  the same headroom. Add a second term, **gated on kind**:

  ```ts
  trip.kind === 'transfer' && trip.phase === 'fetching' && trip.destSiteId === siteId
    ? trip.plannedAmount : 0
  ```

  The gate is not cosmetic. A *supply* trip's `destSiteId` is `CAMP_SITE_ID`
  through its fetch leg (`beginTrip` sets it; `turnForHome` resolves it for real
  on the return), so an ungated clause has every supply fetch reserving room at
  the camp — harmless, because the camp is unbounded, and therefore precisely the
  kind of wrong-but-invisible that survives to become load-bearing.

  No signature change: `kind`, `phase`, `destSiteId` and `plannedAmount` are all
  on `HaulTrip`, and `heldAtOf` already takes `TripRow[]`.
- `Claims` gains a **second** lookup, `plannedOutAt(siteId): number` — the
  resource-agnostic twin of `unclaimedAt`, summing `phase === 'fetching' && sourceSiteId === siteId → plannedAmount`
  across every resource and every kind. Share one traversal with `unclaimedAt`.
- **Read §2.4's opening rule before writing a single term of `movable`.** Every
  term must be reservation-aware. Three drafts of that section shipped the same
  bug in three different terms, each time because a neighbouring term *was*
  reservation-aware and looked like it composed. It does not: a claim on one
  quantity bounds that quantity and no other. The check to apply to any term:
  **if ten idle haulers were dispatched on the same tick, would this term have
  stopped the tenth?**

  The three corrected terms, all of which look right and are not:

  | term | wrong | right |
  | --- | --- | --- |
  | destination room | `capacity − totalAt(D)` | `capacity − heldAt(D)` |
  | source surplus | `held(r) − demand(r)` | `unclaimedAt(S, r) − demand(r)` |
  | drain size | "below the floor" as a bare trigger | `drainNeed(S)`, computed net of `plannedOutAt(S)` |

  Note the middle row **removes** the separate `unclaimedAt` term from the
  staging `min`: once surplus is defined through it, `surplus ≤ unclaimedAt`
  always, so listing both is redundant and listing only the second is the bug.
- `TransferCandidate { sourceSiteId, sourceCol, sourceRow, destSiteId, destCol, destRow, resource, movable, staging: boolean }`
- `compareTransferCandidates(a, b, from)`: **staging before drain**, then `movable` descending, then whole hauler → source → destination route ascending, then source id, then destination id. Route measured from where the hauler stands, exactly as `supplyRouteDistance` does.
- `transferCandidates(...)` builds both classes per §2.4.

- [ ] **Step 1: Write the failing tests**

Each of these is a clause that can be independently broken:

```ts
it('a depot short of what its nearby mill eats pulls stock from the camp', () => {});

it('a site is never both source and sink for one resource', () => {
  // The termination property (§2.2), asserted directly rather than inferred.
});

it('a full-enough depot drains its no-demand stock to the camp', () => {});

it('a depot with headroom above the floor does not drain', () => {
  // The clause that makes a drain purposeful rather than tidying. Its own
  // fixture: stock present, demand zero, headroom ABOVE the floor.
});

it('a drain never targets another depot', () => {
  // Two depots, one full one empty. The full one drains to the CAMP.
});

it('the camp never drains', () => {
  // Unbounded: no free-space floor to breach. This is the termination proof.
});

it('a transfer below minTransferUnits is not a candidate', () => {});

it('there is no "everything the site holds" escape hatch', () => {
  // DISTINCT from worthMoving, deliberately (§2.4). A 1-unit tail at a depot
  // produces no transfer candidate and is NOT stranded — assert that supply can
  // still fetch it, or this test reads as a bug rather than a decision.
});

it('a deficit already being walked toward is not offered twice', () => {
  // inboundAt. Two idle haulers, one deficit: the second gets no transfer.
});

it('a deficit larger than the depot has room for is sized to the room', () => {
  // 56 wood in a 60-cap depot, 12-unit wheat demand, zero wheat: deficit 12,
  // room 4. movable must be 4, not 6. DISCRIMINATING — a fixture where the
  // deficit is already below both haulerCapacity and the room passes with the
  // room term deleted entirely.
});

it('two transfers of DIFFERENT resources cannot overbook one depot', () => {
  // The case inboundAt structurally cannot see, because it is per-resource and
  // capacity is not. First hauler fetching wheat toward a depot with 6 units of
  // room; the second must not be dispatched with flour for the same 6 units.
  // Reddens if heldAtOf's fetching-transfer term is missing — and NOT if only
  // inboundAt is present, which is the whole point of the fixture.
});

it('a fetching transfer reserves destination room; a fetching supply does not', () => {
  // Both clauses of the new heldAtOf term, one fixture each. The kind gate is
  // the untested half: with it removed, supply fetches reserve camp room, and
  // because the camp is unbounded nothing else in the suite would ever notice.
});

// ── The over-claim family. Every one of these dispatches SEVERAL haulers on one
// ── tick against a quantity that does not move until a hauler arrives. A
// ── single-hauler fixture passes against every bug below.

it('two haulers staging from one source cannot exceed its surplus', () => {
  // 20 wheat, demand 12, surplus 8, capacity 6. First takes 6, second must take
  // 2 — NOT 6. Then assert the thing that actually matters: the source is left
  // AT its demand and has NOT become a sink. A test that only checks the second
  // load's size passes an implementation that is off by one in the other
  // direction; assert the invariant, not just the arithmetic.
});

it('a source over-committed into deficit would reverse-transfer', () => {
  // The consequence, as its own test: run the fixture above to completion and
  // assert no transfer is ever dispatched BACK to the source. This is §2.2's
  // termination property, and it is the reason the previous test exists.
});

it('concurrent drains stop once the floor is scheduled to be restored', () => {
  // 60/60 depot, floor 12, capacity 6, THREE idle haulers. Exactly two drains
  // dispatch and the third gets nothing. A two-hauler fixture cannot see this:
  // the bug is that drainNeed never falls, so it needs a hauler that must be
  // REFUSED.
});

it('a supply fetch from a depot counts toward its drain headroom', () => {
  // plannedOutAt counts every fetching trip, not only transfers. Fixture: a
  // supply hauler already fetching from a depot that is one unit below its
  // floor; no drain should be dispatched, because the room is already coming.
});

it('candidate order does not depend on array order', () => {
  // Pass the same candidates shuffled; same winner. The guarantee every other
  // selection in this codebase commits to.
});
```

- [ ] **Step 2: Implement**

Watch the line budget — `haul-dispatch.ts` is at 273 and this is the largest single addition in the increment. If the split is needed, `src/engine/systems/haul-transfer.ts` takes the candidate builder and its comparator, leaving claims and `chooseJob` where they are.

- [ ] **Step 3: Mutation-test**

Each clause separately: remove the floor check; allow depot→depot drains; drop `inboundAt` from the deficit; swap staging/drain priority; lower `minTransferUnits` to 0.

Then the **over-claim family**, which is where this task's real risk is. Each of these reverts one term to its physical-state form — the form that looks correct and passes every single-hauler test:

- `roomAt`: `capacity − heldAt(D)` → `capacity − totalAt(D)`
- `heldAtOf`: drop the fetching-transfer term; separately, remove its kind gate
- `surplus`: `unclaimedAt(S, r) − demand(r)` → `held(r) − demand(r)`
- `drainNeed`: drop `plannedOutAt(S)`; separately, restrict it to transfers only

**None of these is caught by a whole-condition mutation**, because the neighbouring term survives and keeps the rest of the suite green — which is exactly what made all four ship in the spec. Each must redden its own multi-hauler fixture and nothing else.

- [ ] **Step 4: Verify and commit**

---

### Task 6: The transfer trip runs

The mechanic turns on. §2.5, §2.6, §2.7.

**Files:**
- Modify: `src/engine/systems/haul-dispatch.ts` (`chooseJob`, `beginTransfer`), `src/engine/systems/haul-system.ts` (`fetchArrival`), `src/engine/systems/haul-sites.ts` (`remainderHome`)
- Test: `tests/engine/systems/haul-system.test.ts`, `tests/engine/systems/haul-sites.test.ts`

**Interfaces:**
- `chooseJob` offers **supply, then collect, then transfer** (§2.6). The rationale goes in a comment where the fallthrough is: a transfer moves goods nothing is waiting for, so it can only spend hauler-ticks that would otherwise be idle — and the occupancy cost it *does* have is named there too, not hidden.
- `beginTransfer(trip, at, target)` mirrors `beginSupply`: sets `kind`, `resource`, `sourceSiteId`, **`destSiteId` (the reservation)**, `plannedAmount`, `targetId = null`, **`staging` from the candidate's class**, and starts the `fetching` leg. `staging` is written here and read nowhere in the engine — Task 10's instruments are its only consumer, and that is the whole reason it exists (Task 4). Every other kind leaves it `false`, which `beginTrip` must set rather than assume, or a hauler that ran a staging transfer and then took a collect job would still report `staging`.
- `remainderHome` gains `trip.kind === 'supply'` as its first clause (§2.5).
- `fetchArrival` becomes kind-aware in two places:
  - the `targetRowOf === undefined` cancel must admit a transfer *before* the building lookup, or **every transfer cancels on arrival at its source** (a transfer's `targetId` is null, so the lookup always misses);
  - the tail starts a `returning` leg to the **reserved** destination, not an `outbound` leg to a building — and **without going through `destinationFor`**, which would discard the reservation `heldAt` is built on;
  - a transfer whose `takeAt` returned **0** cancels where it stands. No load and no building to continue to — the one case with no counterpart in the supply path, where a zero fetch carries on and finishes as an ordinary collect run.
- `depositArrival`'s "did not arrive at a live destination" branch widens to "**or the destination cannot take the whole load**", taking the same `turnForHome` exit. Reservation covers every hauler-driven way a site fills; it does not cover `spillTo` from a demolished storehouse. Bank-what-fits-and-forward-the-rest is `bankWithSpill`'s behaviour and it teleports the remainder to the camp past a hauler standing at the depot.

- [ ] **Step 1: Write the failing tests, tick by tick**

A trip is a state machine; a test that reads only the end state passes for the wrong reasons.

```ts
it('a transfer fetches from one site and banks at another', async () => {
  // tick 1: dispatch — phase FETCHING, carrying NOTHING. Even a camp-sourced
  //   job pays haulTicksBetween's never-free one-tick minimum.
  // tick n:   source arrival — carrying > 0, phase RETURNING (not OUTBOUND).
  // tick n+m: deposit — the destination site gains, the source does not regain.
  // throughout: colony total unchanged.
});

it('a transfer does not go home to its source', async () => {
  // THE clause (§2.5). Fixture: !pickedUp && amount > 0 && source live and with
  // room — every condition that sends a SUPPLY remainder home is true, and the
  // transfer must still reach its destination. Mutating the whole condition in
  // remainderHome leaves the supply tests red and this one green; only the
  // `kind === 'supply'` clause makes this fixture discriminate.
});

it('a supply remainder still goes home to its source', async () => {
  // The other side of the same clause. Both fixtures, or neither proves anything.
});

it('a transfer whose source emptied mid-walk cancels empty-handed', async () => {
  // takeAt returns 0. Assert the hauler is idle AND the colony total is intact.
});

it('a transfer whose destination vanished carries its load onward', async () => {
  // Demolish the destination depot mid-return. NOT banked remotely, NOT walked
  // back to source: nearest-with-room from where it stands. Assert the hauler
  // walks a fresh leg (phase still returning, new legTo) rather than teleporting.
});

it('a transfer whose destination filled below its reservation carries on', async () => {
  // Reserved room consumed by a path with no trip behind it. The fixture banks
  // into the destination directly (`stockpile.addAt(dest, …)`) while the
  // transfer walks its return leg.
  //
  // CORRECTED. This step first said "demolish ANOTHER storehouse so spillTo
  // fills this one", and that fixture cannot create the condition:
  // `handleDemolishBuilding` calls `spillTo(CAMP_SITE_ID, …)`
  // (placement-handlers.ts) and CAMP_SITE_ID is the only destination `spillTo`
  // is ever passed, so a demolished depot's contents always land at the camp
  // and never in a bounded site. The destination would keep its reserved room
  // and the transfer would deposit normally — a test that passes without ever
  // reaching the branch it names.
  //
  // Banking directly is the honest fixture rather than a workaround: §2.7 says
  // this branch is EXPECTED TO BE UNREACHABLE in ordinary play and is specified
  // anyway on increment 7's precedent (`buildingArrival`'s demolished-target
  // branch has no live caller either). A branch with no reachable trigger can
  // only be tested by constructing the state directly, and pretending otherwise
  // is how the untested version ships.
  //
  // The assertion is the one a conservation sentinel CANNOT make: colony total
  // is preserved either way, so assert that the camp's stock did NOT rise on
  // the arrival tick and the hauler is walking a new leg. A test on the total
  // alone stays green against exactly the bug this branch exists to prevent.
});

it('a transfer does not claim any building output buffer', async () => {
  // targetId null. A collect candidate at a building must be unaffected by a
  // transfer in flight. This holds today by accident of the null — test it,
  // because nothing else says so.
});

it('a stalled producer and a starving consumer both beat a transfer', async () => {
  // Acceptance criterion 9. Three jobs available, one hauler: it takes supply.
  // Then two available, one hauler: it takes collect. Only with neither does it transfer.
});
```

- [ ] **Step 2: Implement**

- [ ] **Step 3: Mutation-test — the clause work is here**

Per-clause, not per-condition: remove `kind === 'supply'` from `remainderHome` alone; make `fetchArrival`'s transfer admission unconditional; route the transfer's return through `destinationFor`; reorder `chooseJob` to offer transfer first. Each must redden exactly one named test.

- [ ] **Step 4: Verify and commit**

Check `haul-system.ts` (298) and `haul-sites.ts` (165) against the cap.

---

### Task 7: Conservation and the cancellation paths

Every path that ends a transfer must put its load somewhere (§2.9).

**Files:**
- Modify: `src/engine/systems/command-handlers.ts`, `src/engine/systems/population-handlers.ts` (only if a transfer reaches a path they do not already cover)
- Test: `tests/engine/systems/command-handlers.test.ts`, `tests/engine/systems/population-system.test.ts`, `tests/engine/stockpile.test.ts`

**Expect most of this to be verification, not change.** The existing paths were written against `HaulTrip`, not against a kind, and should cover a transfer unchanged. **That is the claim this task tests rather than assumes** — increment 7 fixed the dispatch/arrival rule three times, and each time it was a path that "obviously" already worked.

- [ ] **Step 1: Write the failing tests**

```ts
it('demolishing a building leaves a transfer in flight alone', async () => {
  // handleDemolishBuilding walks outbound trips by targetId; a transfer's is
  // null. Correct — and untested until now.
});

it('demolishing the source depot mid-fetch loses nothing', async () => {
  // spillTo sends its contents to the camp; the hauler's tile recheck fails and
  // it cancels empty. Assert the COLONY TOTAL, not the depot.
});

it('demolishing the destination depot mid-return loses nothing', async () => {});

it('unassigning a hauler mid-transfer banks its load', async () => {
  // bankCarriedLoad → destinationFor from legPositionOf. remainderHome is gated
  // off, so it resolves nearest-with-room. Assert the total.
});

it('a hauler dying mid-transfer banks its load', async () => {});

it('a relocating destination is not a live site for a transfer', async () => {
  // storeSitesOf already excludes it. Assert the transfer does not deposit into
  // a depot that is in transit.
});
```

- [ ] **Step 2: Fix whatever the tests actually break**

If nothing breaks, the task's deliverable is the test suite and a note in the commit message saying the paths held unchanged. Do **not** manufacture a change to justify the task.

- [ ] **Step 3: Mutation-test and commit**

---

### Task 8: Flow accounting

A transfer is not a delivery (§2.8). No code change is expected — which is precisely why this needs a discriminating test.

**Files:**
- Test: `tests/engine/systems/haul-system.test.ts`, `tests/engine/systems/stats-system.test.ts`

- [ ] **Step 1: Write the discriminating test**

```ts
it('a transfer does not move Delivered/t, and a collect of the same size does', async () => {
  // The same fixture twice — this is increment 7's remainder-row test, applied
  // to the new kind. Once banking 4 units carried by a transfer, once banking 4
  // units picked up from an output buffer. Same amount, same tick, same site.
  // deliveredRate must move in the second and NOT in the first.
  //
  // Asserting only the first run passes with addAt deleted entirely, which is
  // the exact failure increment 5 shipped and increment 7 caught.
});

it('a transfer records no consumption', async () => {
  // recordConsumed fires only from unload, which a transfer never reaches.
  // consumptionRate unchanged across a completed transfer.
});
```

- [ ] **Step 2: Mutation-test**

Point `bankLoad` at `addAt` unconditionally; force `pickedUp = true` on a transfer. Each must redden a named test.

- [ ] **Step 3: Verify and commit**

---

### Task 9: Snapshot and surfaces

**Files:**
- Modify: `src/engine/snapshot-builder.ts` (likely nothing — `haulKind` publishes `trip.kind` directly), `src/app/components/SelectionPanel.vue`, `src/app/components/WorldLegend.vue`, `src/app/world/layout.ts` (only if it branches on kind)
- Test: `tests/app/selection-panel.test.ts`, `tests/app/world-layout.test.ts`, `npm run smoke:world`

**Interfaces:**
- `haulPickedUp` **remains the direction marker**, not `haulKind` (§2.10). A transfer's load came from a store, so `pickedUp` is false and the marker draws it carrying goods *in* — which is what it is doing. Do not add a kind-driven branch to the marker; increment 7's §2.10 records why that draws the round trip backwards.
- `haulTargetId` is `null` for a transfer. Find every surface that resolves it to a building name and give it a transfer rendering — a transfer names no building and must not render as "hauling to —" or crash a lookup.
- No new colour or glyph. This is a job kind, not a new entity.

- [ ] **Step 1: Find the surfaces**

`grep -rn "haulTargetId\|haulKind" src/app` before writing anything. Pre-flight the brief against the real files — roughly half of increment 4's briefs contained an error of exactly this kind.

- [ ] **Step 2: Write the failing tests, then implement**

**Change one thing per smoke-check fixture phase** (OBS-4-04). A phase that moves five things keeps `!after.equals(before)` true for reasons unrelated to its name.

- [ ] **Step 3: Mutation-test the smoke checks**

Disable the transfer label in `layout.ts` or the panel and confirm the named check — and only that check — goes red. **No vitest test may import `renderer.ts`, `graphics-cache.ts` or `glyphs.ts`**; if this task splits the renderer again, add the new file to that list in `docs/process/agent-workflow.md` in the same commit.

- [ ] **Step 4: Verify and commit**

---

### Task 10: The instruments

§4 asks questions the harness cannot currently answer. Increment 7 found its harness was counting other buildings' inputs as this building's output and every figure that divided by it was wrong — so instruments are a task, not an afterthought.

**Files:**
- Modify: `tests/support/balance-harness.ts`, `tests/support/goods-audit.ts`, `tests/support/population-harness.ts`
- Test: `tests/engine/balance.test.ts` (the `two-way haul instruments` describe block — every instrument gets a test that it measures what it claims)

**Interfaces:**
- `HaulerTicks` gains `transfer` as a fourth job category beside `collect` and `supply`. §2.6's claim is that transfers are paid out of idle time; this is where it is checked.
- `BalanceResult` gains:
  - `transfers: number` and `transfersStaging` / `transfersDrain` — the two classes counted separately, because §4.2 must be able to say which half did the work. Read from `HaulTrip.staging` at the tick a transfer is dispatched, **not** re-derived from the route: a depot → camp move is legitimately either class (§2.2 makes the camp an ordinary site in the pull rule), so route-based attribution is wrong rather than approximate. Task 4 added the field for exactly this and nothing else.
  - `storedSeries: number[]` — per-site occupancy sampled over the run. **Acceptance criterion 4 is about turnover, and a single `storedAtEnd` cannot distinguish "never filled" from "filled and drained".**
- The conservation sentinel must count a transfer in flight. Verify `goods-audit.ts` already sums haulers' hands regardless of kind; if it keys on kind anywhere, fix it.

- [ ] **Step 1: Test the instruments before trusting them**

```ts
it('the transfer counter counts transfers and not supply fetches', async () => {
  // DISCRIMINATING: a scenario with supply trips and no transfers must report 0.
  // The increment-7 lesson — an instrument that over-counts is worse than none.
});

it('the stored series shows turnover, not just a final level', async () => {
  // A depot that fills and drains must produce a non-monotone series. A test
  // asserting only `storedAtEnd < capacity` passes on a depot that never filled.
});

it('hauler-tick shares still sum to the total', async () => {
  // The fourth category must come out of the existing ones, not be added beside them.
});
```

- [ ] **Step 2: Add OBS-7-05's cheap guard**

```ts
it('a with/without-depot pair is identical below the first old-age death', async () => {
  // The issue's own suggested assertion. Pins the harness's determinism without
  // pinning the lifespan jitter. Does NOT touch lifespanFor — out of scope (§2.13).
});
```

Add the sibling note to `PopulationScenario.storehouses`'s doc comment, beside the placement trap it already carries: **below the first old-age death a with/without pair is comparable digit for digit; above it, only aggregate outcomes are.**

- [ ] **Step 3: Verify and commit**

---

### Task 11: Measure

The increment's central claim (§1.1) is either confirmed or contradicted here. **Do not tune toward the claim.**

**Files:**
- Modify: `tests/engine/balance.test.ts`, `docs/superpowers/specs/2026-08-10-increment-8-storehouse-transfer.md` (§4.2–§4.5)

- [ ] **Step 1: The headline reading**

The corner chain, with and without a depot, at **600 / 1,200 / 2,400 / 4,800** ticks (all below the first old-age death, so OBS-7-05 cannot reach them). Report **absolute advantage per horizon**, not only percentages — §4.3 of increment 7 found flatness that a percentage was hiding, and 26 / 24 / 28 is what a buffer looks like.

Acceptance criterion 3: the advantage at 2,400 must exceed the advantage at 600.

- [ ] **Step 2: The mechanism, separately from the outcome**

`stalledTicks` and `waitingForInputTicks` per stage, and `storedSeries`. §1.1 claims the depot works by unstalling a producer and unstarving a consumer; these say whether it does, independently of the throughput number they are supposed to explain.

- [ ] **Step 3: The costs**

- The camp-fed processor, the configuration that lost 10%. **Report it, including worse. Do not rescue it** (§1.2, §2.13).
- The hauler-tick split with transfer as a fourth category, against `haulerIdleTicks` — is transfer paid out of idle time as §2.6 claims, or is it displacing work?
- The fetch-leg share, which is the named cause of the camp-fed loss.

- [ ] **Step 4: Sweep the three new constants**

At least three values each, on the fixture each is supposed to govern. A constant that changes nothing across its sweep is a finding worth writing down.

- [ ] **Step 5: OBS-7-02, answered by measurement**

Re-run the fixture that established `inputBufferCap: 12` as the binding constraint on a far processor. Either the cap is no longer binding — the issue closes on a finding and the constant never moves — or it still is, and the issue carries forward with a second measurement.

- [ ] **Step 6: Write §4.2–§4.5, in §4.3's manner**

If the advantage is still flat, record a second disagreement with §1 and describe the mechanic as what it measured as. **Do not edit §1 to match, and do not retune until the number cooperates.** That symmetry is the instrument working, and it is the thing increment 7 got right.

- [ ] **Step 7: Verify and commit**

---

### Task 12: Document and close out

**Files:**
- Modify: `docs/issues/2026-08-10-the-farther-consumer-starves-outright.md` (OBS-7-01 → Done, **and correct the `waitingForInputTicks` claim** in its Suggested resolution — Task 1's brief depends on that correction and the next reader should not inherit the error), `docs/issues/2026-08-10-a-far-processor-is-capped-by-its-in-tray…` (OBS-7-02, per Task 11 Step 5), `docs/issues/…-a-with-without-depot-comparison…` (OBS-7-05, partial — the guard landed, the structural fix did not), `docs/requirements/Storehouse-to-Storehouse Transfer.md` (status, `finished`), `docs/requirements/Storehouses - a Second Place to Put Things.md` (the §1.1 reframing — a pipeline stage, not a second place to put things), `docs/README_PRODUCT_BACKLOG.md` if statuses roll up there
- Modify: `docs/process/agent-workflow.md` — add the **multi-hauler over-claim** failure mode as a fourth entry beside the three under "Tests". It is the same shape as the other three (a fixture that cannot distinguish the bug from the fix) and it cost four review rounds on this increment's spec alone, so it belongs in the shared list rather than in one plan's constraints.
- Create: any new issue Task 11 found

- [ ] **Step 1: Close what closed, carry what did not**

An issue that is *not* fixed gets its note updated with what this increment learned, not left untouched. OBS-5-03's "Accepted" is the precedent for recording a judgement rather than a silence.

- [ ] **Step 2: File what Task 11 found**

Especially a worse camp-fed-processor number, which §1.2 committed in advance to filing rather than fixing.

- [ ] **Step 3: Whole-branch review**

Read the whole diff for the compound-boolean shape specifically — increment 7's whole-branch review found ten defects of that one kind and this increment adds clauses in the two most load-bearing conditions on the branch. Confirm no test skip survives, no baseline moved, no suppression added, `src/shared/save.ts` untouched, and every `src/` file at or under 500 nonblank lines.

- [ ] **Step 4: `npm run check:all`, commit, open the PR**

---

## Notes for the implementer

- **Push back on this plan.** Roughly half of increment 4's briefs contained an error — a helper that did not exist, a wrong expected value, a positional parameter that would have corrupted eight call sites. Implementers caught them only because they were told to push back rather than guess. This plan already contains one correction to a written source (OBS-7-01's `waitingForInputTicks` claim, Task 1); assume it is not the only one, and check each brief against the real files before starting.
- **The one thing not to compromise on** is §2.5's clause and its two fixtures. Everything else in this increment is machinery; that clause is the guarantee increment 7 built two mechanisms to protect, and it is being deliberately opened by one condition. If the transfer-does-not-go-home test and the supply-remainder-does test do not both exist and both discriminate, the increment has traded a working guarantee for a feature.
- **A transfer that cannot be reconstructed from `kind` / `sourceSiteId` / `destSiteId` / `plannedAmount` / `staging` is the wrong design.** If an implementation reaches for a field that survives between ticks outside the trip's own components, stop — that is the claim invariant failing, and increment 7's spec broke that rule twice in drafts before catching it. `staging` is on that list and is not an exception to it: it lives on the trip, it is written once at dispatch, and nothing outside the trip remembers it. Task 4 states why it had to exist at all.
