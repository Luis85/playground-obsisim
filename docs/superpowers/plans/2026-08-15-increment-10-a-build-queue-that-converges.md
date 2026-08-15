# Increment 10 — A Build Queue That Converges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a build order a *request*. The player queues what the colony cannot yet afford, and the queue fills oldest-first so it converges instead of crawling.

**Architecture:** No new components, no new systems, no new save fields. This increment removes a check and reorders one selection: `nextSupplyTarget` becomes two-phase (best site — oldest, then its best source by the existing comparator; best non-site by that same comparator; one comparison between the winners), and `compareSupplyCandidates` gains exactly one term — a site is never in the starvation band.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-15-increment-10-a-build-queue-that-converges.md`. Section references below (§2.2, §4.1, …) are to that document.

**Predecessor:** increment 9 shipped construction itself. This plan assumes sites exist, are delivered to, complete, cancel with a full refund, save and restore, and are drawn. **If a task here finds itself editing `ConstructionSystem` or the `Construction` component, stop** — that is increment 9's territory and reaching into it means this increment has been misread.

## Read the predecessor's measurement first

Increment 9 Task 11 Step 3 measured the completion curve for N sites under round-robin filling, and §4.1 here asks for the same fixture again. **That baseline is the only evidence this increment works.** Read it before starting; if it was not taken, take it against increment 9's merge commit before changing the ranking, because it cannot be recovered afterwards.

## The branch is playable throughout, with one visible oddity

Between Task 1 and Task 2, **the player can queue more than the colony can feed and the queue crawls.** That is increment 9's known behaviour meeting the removed check, it is exactly the failure §1.1 of the spec describes, and Task 2 is the fix. It is two commits, it is obvious rather than subtle, and it is stated here so nobody bisects into it and files a bug.

**Task 1 and Task 2 must land in the same PR.** Either alone is worse than neither: the check without the ordering is what increment 9 already shipped deliberately, and the ordering without the check is machinery with nothing to do.

## Global Constraints

- **No new component, no new system, no new save version.** If a task reaches for one, the design has been misread. This increment is a check removal and a selection reorder.
- **`src/shared/haul.ts` is at 420 of 500** and Task 2 touches it. `src/engine/systems/haul-dispatch.ts` is at 395. Check with `grep -cve '^\s*$' <file>` after the task.
- **Every task's tests must be greenable by that task's own changes.** `check:all` green at the end of every task. Increment 9's plan broke this rule three times in review — a test asserting behaviour a later task enables cannot be committed.
- **Mutation-test every test.** Back up by copy, `sed`, `diff -q` against **the backup** to confirm it applied, restore **by copy** — never `git checkout <file>`, which restores from HEAD and destroys uncommitted work.
- **Any quantity a dispatch spends must be tested with more than one hauler, and §2.2 needs more than one SITE.** Increment 8's over-claim family all passed single-hauler fixtures. The convergence rule is a *many* problem by construction and cannot be observed with one of either.
- **A mutation that makes a system THROW does not fail a test by default.** sim-ecs catches it and publishes a `SystemError`; subscribe and assert `errors` is empty.
- **Do not implement a fix for the §2.3 stall.** Three options are recorded in the spec and §4.1 measures which is needed. Implementing one speculatively is how this increment doubles in size and ships an unmeasured dependency graph.
- **Never `--update` a quality baseline.** Never pad comments for maintainability points.
- **Commit by pathspec.** A new file needs one `git add` immediately before its commit.
- `npm run check:all` green at the end of every task (`rm -rf coverage` first).

---

### Task 1: A build order stops being refused

**Files:**
- Modify: `src/engine/systems/placement-handlers.ts`, `src/app/components/BuildPalette.vue`, `src/app/views/WorldView.vue`, `src/app/views/BuildingsView.vue`, `src/app/stores/game-store.ts`
- Test: `tests/engine/systems/command-system.test.ts`, `tests/app/build-palette.test.ts`, `tests/app/buildings-view.test.ts`, **`tests/app/world-view.test.ts`**

**Four surfaces, four test files.** `WorldView.vue`'s gate lives in its own `tileValid` predicate — `if (m.kind === 'place') return store.affordableDefs[m.defId]` — which no palette or table test can reach. It is also the **primary canvas flow**: leave it (or restore it later) and a player still cannot place an unaffordable order while every other listed test stays green.

**Interfaces:**
- `handleConstructBuilding` **drops the `canAfford` refusal** increment 9 kept. The id-exhaustion and tile checks stay, and stay before the spawn.
- **All four surfaces stop gating.** `affordableDefs` is **not deleted** — it stops gating and starts informing, so the tooltip becomes advisory rather than a refusal.

  | surface | today |
  | --- | --- |
  | `src/app/components/BuildPalette.vue:28` | `:disabled` unless `affordableDefs[id]` — cannot arm placement |
  | `src/app/views/WorldView.vue:66` | placement predicate returns `affordableDefs[m.defId]` — rejects the tile |
  | `src/app/views/BuildingsView.vue:70` | `:disabled` on the table button, tooltip "Not enough resources" |
  | `src/app/stores/game-store.ts:172` | `affordableDefs` — the getter all three read |

- [ ] **Step 1: Confirm the surface list before writing anything**

`grep -rn "affordableDefs\|canAfford" src/`. The four rows above were checked against the real files during increment 9's review, but a fifth surface added since would fail **silently** — by continuing to refuse — so this grep is the whole pre-flight.

- [ ] **Step 2: Write the failing tests**

```ts
it('a colony that cannot afford a building can still order it', async () => {
  // ENGINE level. Empty ledger, order a mill, get a site. This is the test
  // increment 9 deliberately inverted, so it is also the one that pins the
  // product decision changing hands.
});

it('the palette arms on an empty ledger', async () => {
  // UI level, and REQUIRED SEPARATELY — acceptance criterion 1 says so. The
  // engine test above passes regardless of all four gates, so on its own it
  // would let a version ship where the model allows a queue the player cannot
  // express.
});

it('WorldView accepts the tile for an unaffordable def', async () => {
  // ITS OWN TEST, in tests/app/world-view.test.ts, because `tileValid` is an
  // INDEPENDENT gate that the palette and table fixtures cannot exercise — and
  // it is the primary canvas flow, so this is the one whose absence hurts most.
  //
  // The existing WorldView placement fixture uses a RICH snapshot, which passes
  // the gate whether it is there or not. Build an EMPTY-ledger snapshot or this
  // test proves nothing.
});

it('the Buildings table button is enabled on an empty ledger', async () => {
  // The third surface. Separate fixtures per surface — one test spanning
  // several passes with any one gate restored.
});

it('the tooltip still says what is missing', async () => {
  // affordableDefs INFORMS. A test that only checks the button is enabled
  // passes against deleting the getter outright, which loses the one piece of
  // information the player has left.
});

it('id exhaustion and an unbuildable tile are still refused', async () => {
  // The two rejections that survive. Separate fixtures.
});
```

- [ ] **Step 3: Implement, mutation-test, commit**

Mutations: restore the `canAfford` refusal; restore each gate separately — **including `tileValid`'s**, which is the one a rich-snapshot fixture would not catch; delete `affordableDefs` entirely (must redden the tooltip test).

---

### Task 2: Age first — the ordering that makes a queue converge

**The sharpest rule in the increment**, and the one an implementation gets wrong by leaving the ranking alone. Read §2.2 in full before starting.

**Files:**
- Modify: `src/shared/haul.ts` (`SupplyCandidate`, `compareSupplyCandidates`), `src/engine/systems/haul-dispatch.ts`
- Test: `tests/shared/haul.test.ts`, `tests/engine/systems/haul-dispatch.test.ts`

**Interfaces:**
- `SupplyCandidate` gains `siteAge: number | null` — the building id for a site, `null` for a finished building. **No new state**: `IdCounter.take()` is monotone, so a lower id *is* an earlier order, and the tie-break chain already ends at this field.
- `compareSupplyCandidates` gains **exactly one** thing: **a site is never in the starvation band.** No age term is added to it. **Do not add a "sites first" clause** either — see below.
- `nextSupplyTarget` becomes **two-phase**, and this is where age lives:
  1. best **site** candidate — see below, it is two steps;
  2. best non-site by the existing comparator;
  3. one ordinary comparison between those two winners.

**Phase 1 is TWO steps and collapsing it reintroduces iteration-order dependence.** A `SupplyCandidate` is a **building-source pair** — `buildingId` *and* `siteId`, `haul.ts:355` — so one site whose material sits at both the camp and a depot yields several candidates with the **same `siteAge`**. "Lowest age wins" leaves them tied and the winner falls to array order. So: lowest `siteAge` first, **then the existing comparator among that site's own candidates** to choose the source. No new tie-break is invented — step 2 is the machinery increments 7 and 8 already built.

This failure is quieter than the non-transitive comparator, not smaller: the *site* served is right every time and only the *route* wobbles, so it survives every test that asserts which building got the load.

**Age must NOT be a comparator term, and this is the subtle half.** Applying age "when both candidates are sites" makes `compareSupplyCandidates` **non-transitive**, and `nextSupplyTarget` is a reduction — so the winner depends on candidate iteration order, the one property every selection in this codebase commits to not having. With nothing starving: an old site (movable 1) beats a newer site (movable 6) on age; the newer site beats a finished building (movable 4) on `movable`; the building beats the old site on `movable`. Feed them in the order building, old, new and the *newest* site wins.

Two phases are transitive by construction — each is a total order over a disjoint set, and step 3 is a single comparison rather than a reduction over a mixed set.

**Why, restated because the code will not show it:** `movable` is bounded by remaining room, so a nearly-complete site has small `movable` and **loses** to a newer empty one. Twenty sites round-robin and none finishes.

**Do not put sites ahead of finished buildings.** That is the priority inversion §2.2 spends its length on: a site's cost is planks, planks come from a sawmill, the sawmill needs wood, and sites outranking the sawmill send every log to the sites — so the planks never exist. The two-part rule fixes it **with no dependency machinery**, and part 1 is what does it: a sawmill with an empty in-tray *is* starving, a site never is, so a blocked producer outranks a queue of sites automatically, through the band increment 8 already shipped for exactly this purpose.

- [ ] **Step 1: Write the failing tests**

```ts
it('nextSupplyTarget picks an older site over a newer one that is emptier and nearer', () => {
  // Through THE SELECTOR, not the comparator — age no longer lives in
  // `compareSupplyCandidates` and a comparator-level test of it cannot pass,
  // and would push an implementer straight back to the non-transitive version
  // this design exists to avoid.
  //
  // DISCRIMINATING: the older site must lose on EVERY comparator term — less
  // movable, farther, not starving — so a fixture where it also wins on one of
  // them proves nothing.
});

it('compareSupplyCandidates is unchanged for two finished buildings', () => {
  // The comparator's own test is now purely a regression guard. Age must NOT
  // appear in it.
});

it('a STARVING producer outranks a site', () => {
  // ACCEPTANCE CRITERION 3, and the priority inversion guarded from the
  // direction that matters. A sawmill with an empty in-tray beats a queue of
  // sites that need its planks — which is what stops the queue starving the
  // chain that supplies it. Reverse this and the fixture below deadlocks.
});

it('a queue of sites does not starve the producer that makes what they need', async () => {
  // The integration form. Sites must cost BOTH wood and planks — a plank-only
  // fixture cannot catch the stall below, because those sites never compete
  // with the sawmill for wood at all.
  //
  // Three wood-and-plank sites, a staffed sawmill with an empty in-tray, wood
  // in the camp. Against a "sites first" ordering the sawmill never runs.
  //
  // KNOWN LIMITATION, and this test pins its BOUNDARY rather than its absence
  // (spec §2.3): the starvation band clears on the sawmill's FIRST claim
  // (`claimedIn === 0`), so protection is one load deep and a long enough queue
  // still stalls. Assert what the shipped rule guarantees — the sawmill is
  // served before any site — and leave the stall to the §4.1 measurement.
});

it('a site is never in the starvation band', () => {
  // A site holding zero must NOT be promoted the way a producer holding zero is.
});

it('the winner does not depend on candidate order — mixed three-candidate permutations', () => {
  // ACCEPTANCE CRITERION 4a, THE TRANSITIVITY TEST, and it must use a MIXED set:
  // one old site with small movable, one newer site with large movable, one
  // finished building in between. Feed all SIX permutations and require the
  // same winner every time.
  //
  // A same-kind shuffle test cannot catch this: the cycle only exists across the
  // site/non-site boundary. An earlier draft made the comparator non-transitive
  // and every existing order-independence test stayed green.
});

it('the SOURCE chosen for the oldest site does not depend on candidate order', () => {
  // ACCEPTANCE CRITERION 4b, and it fails for a DIFFERENT reason than 4a — one
  // fixture cannot serve both. Several candidates for the SAME oldest site: its
  // material at the camp and at a depot, different routes and movable. Permute
  // and require the same SOURCE every time.
  //
  // The mixed-kind fixture above uses one candidate per building, so every
  // siteAge is distinct and the tie never arises. Here they are all equal by
  // construction, which is the only shape that reddens a phase 1 that stops at
  // the age term.
});

it('among finished buildings nothing has changed', () => {
  // ACCEPTANCE CRITERION 5, the regression guard for increments 7 and 8's
  // ranking work.
});

it('with five sites, no younger site is served while an older one has unclaimed room', async () => {
  // ACCEPTANCE CRITERION 2, in the exact form §2.2 guarantees. Runs against
  // increment 9's UNMODIFIED ranking and fails — confirm that before
  // implementing, because it is the whole justification for this increment.
  //
  // GIVE EVERY SITE THE SAME MATERIAL. A site whose needed resource exists
  // nowhere emits NO candidate at all (`sitesHolding`, haul-dispatch.ts:240),
  // so a mixed-cost fixture can legitimately serve a younger site and this test
  // would fail against correct code. One material, present in the camp.
  //
  // NOT "every dispatch serves the oldest site": `needOf` correctly drops a
  // site once its remaining room is fully claimed, so the next-oldest is served
  // while the first one's materials are still walking. An "always the oldest"
  // assertion is false against a correct implementation at more than one
  // hauler, which is precisely the fixture that matters.
  //
  // Assert on DISPATCH, not completion. Completion order is explicitly not
  // guaranteed (§2.2) — unequal legs can let a younger site finish first with
  // nothing wrong. Assert site 1's in-tray fills (or is fully claimed) before
  // site 2 receives anything.
  //
  // At one hauler and at four: the round-robin is worse with more haulers, so a
  // single-hauler fixture understates it.
});
```

- [ ] **Step 2: Implement, mutation-test, commit**

Mutations: add a site-before-building term; reverse age; move age into the comparator; apply the starvation band to sites; **drop phase 1's second step so it returns the first lowest-age candidate it finds**. **The third is the one that matters** — it leaves a plausible-looking ordering that still round-robins, and only the five-site integration test catches it.

---

### Task 3: Measure

**Files:**
- Modify: **`src/engine/systems/haul-transfer.ts`** (`demandSourcesOf`, Step 4a), `tests/engine/balance.test.ts`, `tests/support/balance-harness.ts` (only if the queue fixtures need a knob increment 9's `Scenario` does not have), the spec's §4
- Test: **`tests/engine/systems/haul-transfer.test.ts`** — the focused proof that a depot acquires demand from a nearby site, separate from any balance reading

**This task contains a code change, and the file list must say so.** Step 4a is not instrumentation-adjacent — it edits dispatch. A file inventory of "balance tests and the spec" is exactly how an implementer arrives at Step 4b with the instrument still disconnected and reports a confident zero.

- [ ] **Step 1: Convergence, against increment 9's baseline.** N sites ordered simultaneously, at one hauler and at four, reporting completion order and the completion *curve*. **The reading is the DIFFERENCE from increment 9's §4.1 figure**, not the absolute shape — that comparison is the only evidence this increment did what it exists to do. A curve that has not changed shape means the ordering rule is not reaching the case it was written for, and that is a finding to report rather than to tune away.
- [ ] **Step 2: How reachable is the §2.3 stall?** Sites costing **both wood and planks**, queued against a chain that makes the planks, at queue lengths of 1 / 3 / 5 / 10. Report the queue length at which the first completion stops happening.

  **A SEPARATE sweep from Step 1, and the separation is load-bearing.** Step 1's fixture has no dependency chain in it, so it cannot produce the stall at any N; folding the two together would report "no stall observed" as a confident wrong answer. Report the number even if it is "never at any length this fixture can express" — that result would close the question.
- [ ] **Step 3: What a queue costs a colony.** Ticks from order to first output for the last site in a queue of N, against the same site built alone. This prices "queue it and forget it", which is what this increment actually sells.
- [ ] **Step 4a: Connect the instrument BEFORE taking the OBS-8-06 reading.** `demandSourcesOf` (`haul-transfer.ts:54`) skips unstaffed buildings and derives demand from `recipe.inputs` alone, so as the engine stands **a remote site creates no depot demand and staging cannot fire for it at any distance.** Teach it about sites — unstaffed, demand from `cost` — and prove it with a fixture that shows a depot acquiring demand from a nearby site. This is a code change inside a measurement task, deliberately: taking the reading first would produce a confident zero from an instrument that was never connected, which is the increment-7 harness failure repeating.
- [ ] **Step 4b: OBS-8-06.** A site ordered far from the camp with a depot between. Report whether staging fires, how often, and whether the site completes sooner with the depot. §4.2 names the three outcomes and all three are worth having — **do not tune to reach one of them.** If Step 4a was skipped, the reading is invalid and reports the third outcome by construction.
- [ ] **Step 5: Write §4.1 and §4.2 from what was measured.** If a decision this spec took measures badly, record the disagreement rather than retuning toward the claim.
- [ ] **Step 6: Verify and commit**

---

### Task 4: Document and close out

**Files:**
- Modify: `docs/issues/2026-08-11-the-staging-half-of-transfer-is-correct-and-almost-never-worth-a-trip.md` (OBS-8-06, updated with §4.2's reading whichever way it went), `docs/requirements/Construction as Work.md` (status), `docs/README_PRODUCT_BACKLOG.md` if statuses roll up
- Create: an issue for the §2.3 stall carrying §4.1 Step 2's number and the three options; a Feature note for build priority / queue reordering if §4.1 Step 3 argues for one

- [ ] **Step 1: File the stall as an issue, with its number.** The three remedies are in spec §2.3 and the measurement that chooses between them is Step 2's. An issue without the number is the thing this increment was written to avoid.
- [ ] **Step 2: Close what closed, carry what did not.** An issue that is not fixed gets its note updated with what this increment learned, not left untouched.
- [ ] **Step 3: Whole-branch review.** Read the diff for the compound-boolean shape specifically, and for the multi-hauler/multi-site over-claim shape. **Confirm `ConstructionSystem` and the `Construction` component are untouched** — if the diff reaches them, this increment has strayed into its predecessor. Confirm no skip survives, no baseline moved, no suppression added, every `src/` file at or under 500 nonblank lines.
- [ ] **Step 4: `npm run check:all`, commit, open the PR**

---

## Notes for the implementer

- **Push back on this plan.** Roughly half of increment 4's briefs contained an error, and increment 9's spec and plan took eleven review rounds — six of whose findings were in the two sections that became *this* increment. Check each brief against the real files before starting.
- **The one thing not to compromise on** is Task 2's five-site integration test. Everything else here is machinery; that test is the only thing standing between this feature and a build queue that crawls. **Confirm it fails against the unmodified ranking before implementing** — a test that was never seen to fail is a claim, not evidence, and this one has a specific trap: three of the four mutations listed leave an ordering that looks right and still round-robins.
- **Two tasks, one PR.** Task 1 without Task 2 ships the crawl. If Task 2 turns out to be bigger than it looks, the right move is to hold Task 1 back, not to ship half.
- **The stall in §2.3 is known, measured and deliberately unfixed.** If a fixture here appears to demand a dependency graph, it is measuring the thing Task 3 Step 2 is for. Report the number; do not build the graph.
