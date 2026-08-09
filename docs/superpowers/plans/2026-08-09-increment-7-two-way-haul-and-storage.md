# Increment 7 — Two-Way Haul & Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish increment 4's sentence. A recipe's inputs stop being paid out of a global store and start being carried to the building that needs them; a `storehouse` gives the player a second place to drop and collect, so a distant cluster becomes an investment rather than a mistake.

**Architecture:** One new component (`InputBuffer`), one new building role (`storage` beside `recipe` and `beds`), and one reinterpretation: `Stockpile` stops being a single map and becomes a map per **store site** while keeping every aggregate method it exposes today. `src/shared/haul.ts` grows the site law — `StoreSite`, `CAMP_SITE_ID`, two-point distances, nearest-with-room — exactly as it already owns the camp-relative law. `HaulSystem` gains a trip `kind` and one leading `fetching` leg for supply trips; the rest of the trip is identical for both kinds, which is what keeps this a change to one system rather than a second one. **Haulers deliberately have no base site** — spec §2.5 records the model that was tried and discarded, and Task 6 is what that buys.

**Tech Stack:** TypeScript, sim-ecs 0.6.4, Vue 3 + Pinia, Vitest, Excalibur (canvas only), fallow (quality gates).

**Spec:** `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md`. Section references below (§2.4, §2.6, …) are to that document.

## The branch is not playable between Tasks 3 and 6, deliberately

Task 3 stops `ProductionSystem` paying inputs from the colony store. Task 6 is
what starts delivering them. **In between, every input-consuming building — mill,
bakery, sawmill, workshop — sits at `waitingForInput` with ample stock and idle
haulers, and the multi-building integration test is skipped because of it.**

That window is real, and it is stated here so nobody discovers it by bisecting
into it or by merging the branch half-finished. Two things about it:

- **It cannot be avoided by reordering.** Task 6's supply leg needs the
  `InputBuffer` that Task 3 creates, so 3 must precede 6. Closing the window
  means either merging the two into one very large task, or writing a
  dual-payment `ProductionSystem` in Task 3 that Task 6 immediately deletes —
  more code and more risk than the window costs.
- **The branch merges as a whole.** It is one PR of fifteen tasks; no
  intermediate commit is a release candidate. What matters is that the window
  closes before merge, which Task 6 Step 5b enforces by un-skipping the
  integration test and requiring it to pass on its own merits, and which the
  final whole-branch review re-checks by confirming no skip survives.

## Global Constraints

- **Every component must be attached in `buildingComponents`/`colonistComponents` in `src/engine/spawn.ts`** — the single shared list — *and* its type appended to `COMPONENT_TYPES` in `src/engine/world.ts` for save round-tripping. Forgetting either is silent and has bitten twice (OBS-4-02). This increment adds exactly one component, in Task 3.
- **No vitest test may import `src/app/world/renderer.ts` or `src/app/world/graphics-cache.ts`.** Excalibur throws on import outside a browser. Their only coverage is `npm run smoke:world`. **Task 12 adds a third file to that list** (`src/app/world/glyphs.ts`); update `docs/process/agent-workflow.md` when it does, or the rule silently stops covering the code it exists for.
- **Mutation-test every test:** break the feature, confirm the named test fails, restore. Fixture values must *discriminate* — if the wrong field holds the same value, the assertion proves nothing. This increment's single most important test (Task 3) is exactly this shape: a building must fail to produce **while the colony stockpile is full**, or a pass proves only that there was no flour anywhere.
- **A mutation that makes a system THROW does not fail a test by default.** sim-ecs catches a system's exception and publishes it as a `SystemError` event, so the run completes and the assertion reads pre-crash state. Any mutation whose effect is a crash rather than a wrong value needs the test to assert on the error itself:

  ```ts
  const errors: unknown[] = [];
  world.eventBus.subscribe(SystemError, (e) => errors.push(e));
  // …step…
  expect(errors).toHaveLength(0);   // and the mutation makes this fail
  ```

- **Confirm every mutation actually applied.** `sed` exits 0 when its pattern matches nothing, so a stale pattern leaves the file untouched and the test passes against the *unmutated* implementation. After each `sed`: `git diff --quiet <file> && echo "MUTATION DID NOT APPLY"`.
- **Restore a mutation by copy, never by `git checkout <file>`.** Mutation checks run in the TDD gap between green and commit, so the file's real content is *uncommitted* — and `git checkout <file>` restores it from HEAD, silently destroying the entire implementation rather than just the mutation. Task 1 hit this and recovered only because it had a scratch copy. Use:

  ```bash
  cp <file> /tmp/mut-backup            # before the sed
  sed -i 's/…/…/' <file>
  git diff --quiet <file> && echo "MUTATION DID NOT APPLY"
  npx vitest run <focused test file>   # expect ONLY the named test red
  cp /tmp/mut-backup <file>            # restore — NOT git checkout
  ```

  The same trap applies to `git stash` and `git restore`. If you have already committed the work, `git checkout` is safe again — but the copy is safe in both cases, so just use the copy.
- **The 500-line cap is a design constraint in this increment, not a formality.** Five files this plan must touch are already close to it. The split is named in the task that trips it, and **no baseline is loosened**:

  | file | now | owner of its split |
  | --- | ---: | --- |
  | `src/engine/world.ts` | 478 | Task 3 (contingency: extract `initialSave` to `src/engine/initial-save.ts`) |
  | `src/app/world/renderer.ts` | 445 | Task 12 (`src/app/world/glyphs.ts`) |
  | `src/engine/snapshot-builder.ts` | 438 | Task 10 (`src/engine/snapshot-buildings.ts`) |
  | `src/engine/systems/command-handlers.ts` | 426 | Task 8 (`src/engine/systems/placement-handlers.ts`) |
  | `src/engine/resources.ts` | 387 | Task 2 (`src/engine/stockpile.ts`) |
  | `src/engine/systems/haul-system.ts` | 157 | Task 6 (`src/engine/systems/haul-dispatch.ts`) |

  Check with `grep -cve '^\s*$' <file>` after every task that touches one.
- **Never `--update` a quality baseline to make a gate pass.** `check:quality --update` refuses a loosened value without `--allow-regression`, and refuses pinned-at-zero breaches outright.
- **Never pad comments to buy maintainability points.** Fallow's MI has no length term.
- **Commit by pathspec** (`git commit <path> -m …`), never `git add` + bare `git commit`. A new file needs one `git add` immediately before its commit.
- **Systems must be listed in `ALL_SYSTEMS` order** — `buildColonyPrepWorld` throws otherwise. This increment does not add or reorder a system.
- **Balance constants live only in `src/engine/content/balance.ts`.** Shared law takes them as parameters — `src/shared/**` may import nothing outside itself. This is why `haulTicks` takes `tilesPerTick` and why `nearestSiteWithRoom` takes an occupancy lookup rather than reaching for `Stockpile`.
- **Goods are carried, never teleported.** That is the sentence increment 4 shipped half of and this one finishes, so it applies to the increment's own machinery too: Task 2's forward-to-camp guarantee exists for paths where **no hauler remains to do the walking** (a cancellation, a stand-down, a load-time spill), not as the ordinary overflow route. A hauler that finds its destination full carries on to the next one. Free depot-to-camp transport would flatter §4 q2, which is measuring whether a depot pays for itself.
- **Conservation is the invariant this increment can most easily break.** Goods now exist in four places (camp, storehouse, input buffer, output buffer) plus a hauler's hands. Every cancellation path — demolition, relocation, unassignment, a target that vanished — must put a carried load *somewhere*. Prefer `refundAt` over `addAt` for anything a hauler did not actually complete a delivery of, or the Economy view's `Delivered/t` inflates for goods nobody hauled. Task 2's two banking invariants exist so that "somewhere" cannot be nowhere: a bank never partially fails, and no ledger site can outlive the building behind it. **Assert on a colony-wide total, not on the field you just wrote** — the total is what a player would notice being violated, and it is what a future refactor cannot accidentally satisfy.
- `npm run check:all` must be green at the end of every task. Run `rm -rf coverage` first: `check:quality` hard-fails if `coverage/` exists.
- **A raw `await world.step()` does NOT refresh the snapshot's entity sections.** Use `stepTick` from `tests/engine/fixtures.ts` in any test that asserts on entities appearing or disappearing.

---

### Task 1: The store-site law

Pure shared law, no engine changes, landed first so every later task has a vocabulary. `src/shared/haul.ts` is 97 lines and owns the spatial rules of hauling exactly as `placement.ts` owns those of placement (§2.2).

**Files:**
- Modify: `src/shared/haul.ts`
- Test: `tests/shared/haul.test.ts`

**Interfaces:**
- Consumes: `ticksForDistance`, `TileRef` (already imported).
- Produces:
  - `export const CAMP_SITE_ID = 0`
  - `export interface StoreSite { id: number; col: number; row: number; capacity: number | null }`
  - `export function haulTicksBetween(from: TileRef, to: TileRef, tilesPerTick: number): number`
  - `export function nearestSite(col: number, row: number, sites: readonly StoreSite[]): StoreSite | null`
  - `export function nearestSiteWithRoom(col, row, sites, heldAt: (siteId: number) => number, amount: number): StoreSite | null` — **takes the load size**: a predicate that only skips already-full sites sends 12 units at a depot holding 55 of 60 and splits the load on arrival. The test is `heldAt(id) + amount <= capacity`.
  - `export function sitesHolding(sites, unclaimedAt: (siteId: number) => number): StoreSite[]` — every site with unclaimed stock of a resource, for §2.6's supply pairing.
  - `export type HaulKind = 'collect' | 'supply'`
  - `HaulPhase` gains `'fetching'` — a hauler walking empty to the site it will load a supply trip from. Published, so it belongs here in shared law beside the other three.
  - `export interface SupplyCandidate { buildingId: number; buildingCol: number; buildingRow: number; siteId: number; siteCol: number; siteRow: number; resource: ResourceId; movable: number }` — a candidate is a **building–source pair**, not a building. A building suppliable from both the camp and a depot is two candidates, and without the source in the shape `compareSupplyCandidates` can only rank hauler-to-building distance: it could not implement §2.6's hauler→source→building ordering or its site-id tie-break, and dispatch would happily pick a remote source with a nearer stocked site available — distorting §4 q2, which is measuring exactly whether a depot shortens trips. The tile fields are named for what they are, because a bare `col`/`row` on a two-ended thing reads as the building's to everyone including the tests.
  - `export function compareSupplyCandidates(a, b, from: TileRef): number` — `movable` descending, then the **whole route** `haulDistance(from → site) + haulDistance(site → building)` ascending, then `buildingId`, then `siteId`.
  - `export function nextSupplyTarget(candidates, from: TileRef): SupplyCandidate | null`
- **Unchanged on purpose:** `CAMP_TILE`, `haulDistance`, `haulTicks`, `legProgress`, `HaulCandidate`, `claimableAt`, `compareHaulCandidates`, `nextHaulTarget`. `haulTicks` is re-expressed in terms of `haulTicksBetween` but keeps its signature — `haulerCapacity` and the commute charge still measure from the camp.

> **`tests/shared/haul.test.ts` already contains a partial draft of this step**, committed in `c6468e8` from an implementation run that started against an older version of this plan. **Rewrite it rather than extending it.** It predates the building–source *pair* shape of `SupplyCandidate`, so its tie-break fixtures encode only building coordinates — which means a comparator that ignores the source leg entirely and ranks plain hauler-to-building distance still passes them. That is the specific defect Step 1 below now guards against, and it is invisible unless you compare the fixture against the interface.

- [ ] **Step 1: Write the failing tests**

Append to `tests/shared/haul.test.ts`. The cases that matter are the ones an implementation can get subtly wrong:

```ts
describe('haulTicksBetween', () => {
  it('is never free, even between adjacent tiles', () => {
    expect(haulTicksBetween({ col: 5, row: 5 }, { col: 5, row: 6 }, 2)).toBe(1);
  });
  it('agrees with haulTicks when measured from the camp', () => {
    // haulTicks is now DEFINED as this, and the test pins the two together so
    // a future edit to one cannot silently re-price every existing trip.
    for (const tile of [{ col: 0, row: 0 }, { col: 23, row: 15 }, { col: 2, row: 0 }]) {
      expect(haulTicksBetween(CAMP_TILE, tile, 2)).toBe(haulTicks(tile.col, tile.row, 2));
    }
  });
});

describe('nearestSiteWithRoom', () => {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: 2, row: 0, capacity: null };
  const depot: StoreSite = { id: 7, col: 20, row: 14, capacity: 60 };

  it('prefers the depot for a building beside it', () => {
    expect(nearestSiteWithRoom(21, 14, [camp, depot], () => 0, 6)?.id).toBe(7);
  });
  it('falls through to the camp when the depot is full', () => {
    // Discriminating: the depot is still NEARER. Only the room check can move
    // this answer, so a mutation that ignores capacity fails here and nowhere else.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 60 : 0), 6)?.id).toBe(CAMP_SITE_ID);
  });
  it('accepts a load that fills a depot EXACTLY', () => {
    // heldAt + amount === capacity must still be a valid destination. Without
    // this case the prescribed `>` -> `>=` mutation reddens no test at all,
    // which makes that mutation check vacuous.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 54 : 0), 6)?.id).toBe(7);
  });

  it('rejects a depot with SOME room but not enough for the load', () => {
    // The case the `amount` parameter exists for. 55 of 60 held, 12 to bank:
    // a predicate that only skips FULL sites picks the depot and splits the
    // load on arrival.
    expect(nearestSiteWithRoom(21, 14, [camp, depot], (id) => (id === 7 ? 55 : 0), 12)?.id).toBe(CAMP_SITE_ID);
  });

  it('never runs out of destinations while the camp exists', () => {
    // capacity: null is unbounded, so the camp is the guaranteed fallback.
    expect(nearestSiteWithRoom(21, 14, [camp], () => 1e9, 6)).not.toBeNull();
  });
  it('breaks a distance tie by site id, not by argument order', () => {
    const a: StoreSite = { id: 9, col: 4, row: 0, capacity: 60 };
    const b: StoreSite = { id: 3, col: 0, row: 0, capacity: 60 };
    expect(nearestSiteWithRoom(2, 0, [a, b], () => 0, 6)?.id).toBe(3);
    expect(nearestSiteWithRoom(2, 0, [b, a], () => 0, 6)?.id).toBe(3);
  });
});
```

For `nextSupplyTarget`, the fixture must exercise the **whole route**, because a candidate is a building–source pair: most movable first, then `hauler → source → building` ascending, then lowest building id, then lowest site id. Pin it with **one building reachable from two sites** whose ordering differs depending on whether the source leg is counted — a fixture encoding only building coordinates cannot tell a correct comparator from one that ignores the source entirely, and that is exactly what the draft in the working tree does.

- [ ] **Step 2: Run tests to verify they fail**

`npx vitest run tests/shared/haul.test.ts` — FAIL, the symbols do not exist.

- [ ] **Step 3: Implement**

`haulTicksBetween` is the generalisation; redefine `haulTicks` through it rather than leaving two copies of the rounding rule:

```ts
export function haulTicksBetween(from: TileRef, to: TileRef, tilesPerTick: number): number {
  return ticksForDistance(Math.hypot(to.col - from.col, to.row - from.row), tilesPerTick);
}

export function haulTicks(col: number, row: number, tilesPerTick: number): number {
  return haulTicksBetween(CAMP_TILE, { col, row }, tilesPerTick);
}
```

`nearestSiteWithRoom` takes `heldAt` rather than a `Stockpile`, for the reason every other function here takes its inputs: `src/shared/**` imports nothing outside itself, and a site's occupancy lives in engine state.

```ts
export function nearestSiteWithRoom(
  col: number, row: number, sites: readonly StoreSite[], heldAt: (siteId: number) => number, amount: number,
): StoreSite | null {
  let best: StoreSite | null = null;
  for (const site of sites) {
    // The WHOLE load must fit: `>= capacity` skips only sites already full and
    // lets a 12-unit load pick a depot holding 55 of 60.
    if (site.capacity !== null && heldAt(site.id) + amount > site.capacity) continue;
    if (best === null || closer(site, best, col, row)) best = site;
  }
  return best;
}
```

`closer` compares distance then id, so the answer never depends on array order — the same property `compareHaulCandidates` ends with and for the same reason.

- [ ] **Step 4: Mutation-check**

```bash
cp src/shared/haul.ts /tmp/mut-haul     # MAKE the backup — the restore below needs it
sed -i 's/heldAt(site.id) + amount > site.capacity/heldAt(site.id) >= site.capacity/' src/shared/haul.ts
git diff --quiet src/shared/haul.ts && echo "MUTATION DID NOT APPLY"
npx vitest run tests/shared/haul.test.ts   # expect the exact-fit test red, and only it
cp /tmp/mut-haul src/shared/haul.ts     # NOT git checkout — see Global Constraints
```

This mutation flips `>` to `>=`, which rejects a load that fills a depot *exactly* — so the exact-fit test is the one that must catch it. Without that test the mutation reddens nothing, the check reports a pass, and Step 5 happily commits an implementation that sends exact-fit loads on a needless trip to the camp.

- [ ] **Step 5: Gates and commit**

```bash
rm -rf coverage && npm run check:all
grep -cve '^\s*$' src/shared/haul.ts   # well under 500
git commit src/shared/haul.ts tests/shared/haul.test.ts -m "feat(shared): the store-site law, so the camp stops being the only destination

haulTicks is now defined through haulTicksBetween rather than repeating the
rounding rule, and a test pins the two together: the camp-relative price every
existing trip pays must not move when a second site becomes possible."
```

---

### Task 2: `Stockpile` becomes a multi-site ledger

The reinterpretation the rest of the increment stands on (§2.4). The aggregate API is unchanged — that is the whole design — so **no existing caller is edited in this task**, and every existing test must stay green without modification. If one needs changing, the change is wrong: say so rather than editing the test.

`src/engine/resources.ts` is 387 lines and `Stockpile` grows by ~80 here, so it moves to its own file in the same task.

**Files:**
- Create: `src/engine/stockpile.ts` (moved from `resources.ts`, then extended)
- Modify: `src/engine/resources.ts` (re-export `Stockpile` so no import site changes)
- Test: `tests/engine/stockpile.test.ts` (new), and whichever existing file holds the current `Stockpile` tests — move them, do not duplicate.

**Interfaces:**
- Produces (new, site-aware — used only by `HaulSystem`, the command handlers and the save):
  - `getAt(siteId: number, id: ResourceId): number`
  - `totalAt(siteId: number): number`
  - `addAt(site: StoreSite, id: ResourceId, amount: number): void` — banks at that site, records into `producedThisTick`
  - `refundAt(site: StoreSite, id: ResourceId, amount: number): void` — same, without recording a delivery
  - `takeAt(siteId, id, amount): number` — takes up to `amount`, returns what was taken
  - `spillTo(toSiteId: number, fromSiteId: number): void`
  - `siteIds(): number[]`, `siteJSON(siteId): Partial<Record<ResourceId, number>>`
  - `seedSite(siteId: number, contents: Partial<Record<ResourceId, number>>): void` — **restore only.** The `StoreSite`-typed banking calls above deliberately cannot express "bank into a store that is not a live site", which is what stops an orphan site being created during play. Loading needs exactly that, though: a save taken while a **stocked storehouse was mid-relocation** holds `stored` contents for a building §2.3 excludes from the site list until its countdown ends, so there is no `StoreSite` to hand `addAt`. Seeding is not banking — it reconstructs a state the engine previously wrote, records no delivery, and is called once per building by the restore path. Restrict it to that caller; if it ever appears in `HaulSystem`, the invariant has been bypassed rather than served.
  - `recordConsumed(id: ResourceId, amount: number): void` — record consumption without removing anything. Needed because §2.4 moves the moment of consumption away from the moment goods leave a site: a supply load leaves the camp on one tick and enters a building's input buffer several ticks later, and only the second is the colony actually spending it.
- **Unchanged, and pinned by tests:** `get`, `total`, `canAfford`, `pay`, `take`, `add`, `refund`, `resetTickFlows`, `producedThisTick`, `consumedThisTick`, `toJSON`.
- **The two banking calls take a resolved `StoreSite`, not a site id, and neither can partially fail** (§2.4). Whatever does not fit at the named site is forwarded to the camp, which is unbounded and cannot refuse, so no caller is handed a remainder to mishandle — and the callers most likely to mishandle one are the cancellation paths in Task 8, which run in rare branches where a dropped remainder goes unnoticed. Taking a `StoreSite` is the other half: a `StoreSite` only comes from `storeSitesOf` (Task 5), which returns live non-relocating stores only, so **banking into a demolished storehouse is not expressible**. That has to be impossible rather than merely avoided, because Task 9 serializes a storehouse's contents off its *building record*: an orphaned site's goods would count in `colonyWealth`, be unreachable by any hauler, and vanish at the next save with nothing reporting it.

- [ ] **Step 1: Write the failing tests**

```ts
it('a colony with goods split across sites spends as one', () => {
  const s = new Stockpile({ wood: 10 });          // camp
  s.addAt(depot(60), 'wood', 15);                 // a depot
  expect(s.get('wood')).toBe(25);
  expect(s.pay({ wood: 20 })).toBe(true);         // neither site alone could
  expect(s.get('wood')).toBe(5);
});

it('spends the camp first, then sites by ascending id', () => {
  // The amounts are chosen so NO subset sums to the payment: camp 5, site3 8,
  // site9 2, paying 10. Camp-first leaves camp 0, site3 3, site9 2; drawing
  // site3 first leaves camp 3, site3 0, site9 2. Different residues, so the
  // assertion actually pins the order.
  //
  // An earlier version used camp 4 + site3 8 paying 12 — which those two sum to
  // EXACTLY, so swapping them left an identical residue and the test pinned
  // only "site9 last". Any fixture where a prefix of the draw order happens to
  // sum to the payment cannot discriminate the order.
  const s = new Stockpile({ wood: 5 });
  s.addAt(depot(60, 9), 'wood', 2);
  s.addAt(depot(60, 3), 'wood', 8);
  expect(s.pay({ wood: 10 })).toBe(true);
  expect(s.getAt(CAMP_SITE_ID, 'wood')).toBe(0);
  expect(s.getAt(3, 'wood')).toBe(3);
  expect(s.getAt(9, 'wood')).toBe(2);
});

it('a bank beyond a site capacity spills to the camp rather than being lost', () => {
  // §2.4 invariant 1. DISCRIMINATING: assert BOTH sides — 60 at the depot and
  // 40 at the camp. An implementation that simply drops the excess passes any
  // assertion that only checks the depot.
  const s = new Stockpile();
  s.addAt(depot(60), 'wood', 100);
  expect(s.getAt(7, 'wood')).toBe(60);
  expect(s.getAt(CAMP_SITE_ID, 'wood')).toBe(40);
  expect(s.get('wood')).toBe(100);
});

it('the camp is unbounded', () => {
  const s = new Stockpile();
  s.addAt(camp(), 'wood', 10_000);
  expect(s.get('wood')).toBe(10_000);
});

it('toJSON is the camp alone, so a v5 stockpile round-trips unchanged', () => {
  const s = new Stockpile({ wood: 10 });
  s.addAt(depot(60), 'wood', 15);
  expect(s.toJSON()).toEqual({ wood: 10 });
  expect(s.siteJSON(7)).toEqual({ wood: 15 });
});

it('refundAt does not count as a delivery', () => {
  const s = new Stockpile();
  s.refundAt(depot(60), 'wood', 5);
  expect(s.producedThisTick.get('wood') ?? 0).toBe(0);   // and addAt makes this 5
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run tests/engine/stockpile.test.ts`.

- [ ] **Step 3: Move the class, then extend it**

Move `Stockpile` verbatim into `src/engine/stockpile.ts` first and confirm the suite is green **before** changing anything. `resources.ts` re-exports it (`export { Stockpile } from './stockpile';`) so not one import site moves — a rename and a behaviour change in one commit is two mistakes waiting to be attributed to each other.

Then the storage becomes per site:

```ts
private readonly sites = new Map<number, Map<ResourceId, number>>();
```

`get(id)` sums across sites; `pay`/`take`/`remove` draw in **camp-first, then ascending site id** order (`drawOrder()`), which is the one place that order is written down. `bank` keeps its `MAX_SAVED_COUNTER` saturation, now per site, for the reason it exists: the engine must never write a save its own guard rejects.

- [ ] **Step 4: Mutation-check the draw order and the cap**

```bash
cp src/engine/stockpile.ts /tmp/mut-stockpile
sed -i 's/\.sort((a, b) => a - b)/.sort((a, b) => b - a)/' src/engine/stockpile.ts
git diff --quiet src/engine/stockpile.ts && echo "MUTATION DID NOT APPLY"
npx vitest run tests/engine/stockpile.test.ts   # expect ONLY the draw-order test red
cp /tmp/mut-stockpile src/engine/stockpile.ts   # NOT git checkout: this file is UNTRACKED
# at this point, so checkout cannot restore it and would leave the mutation in place.
```

- [ ] **Step 5: Gates and commit**

```bash
rm -rf coverage && npm run check:all
grep -cve '^\s*$' src/engine/resources.ts src/engine/stockpile.ts
git add src/engine/stockpile.ts tests/engine/stockpile.test.ts
git commit src/engine/stockpile.ts src/engine/resources.ts tests/engine/stockpile.test.ts tests/engine -m "feat(engine): one ledger, held in several places

Stockpile keeps every aggregate method it had — a goods total is a goods total
wherever it stands — so hunger, construction, wealth, stats and the save are
untouched. What changes is that goods now have a location a hauler can walk to."
```

---

### Task 3: `InputBuffer`, and production draws locally

The increment in one component (§2.1). This is the task that changes the game.

**Files:**
- Modify: `src/engine/components.ts` (`InputBuffer`)
- Modify: `src/engine/spawn.ts` (`buildingComponents`, `clampedInputBuffer`, `BuildingSpec.inputBuffer`)
- Modify: `src/engine/world.ts` (`COMPONENT_TYPES`)
- Modify: `src/engine/content/balance.ts` (`inputBufferCap`)
- Modify: `src/engine/systems/production-system.ts`
- Test: `tests/engine/systems/production-system.test.ts`, `tests/engine/systems/command-system.test.ts` (component parity)

**Interfaces:**
- Produces: `class InputBuffer` (same shape as `OutputBuffer`; extract the shared body only if it stays under the complexity gate — two small classes beat one clever one), `BALANCE.inputBufferCap`, `clampedInputBuffer`.
- **Blast radius, stated up front:** every existing `ProductionSystem` test that seeds a stockpile to make a mill or bakery run must instead seed that building's `InputBuffer`. Expect ~6–10 fixtures. `npm test` enumerates them; do not hunt by hand.

- [ ] **Step 1: Write the failing tests**

The first of these is the acceptance criterion of the whole increment, and its fixture is the thing to get right:

```ts
it('a staffed mill with an empty input buffer produces nothing, however full the colony store', async () => {
  // DISCRIMINATING FIXTURE: 10,000 wheat in the stockpile. Before this task
  // that mill produced flour every 3 ticks. A pass here cannot come from
  // "there was no wheat" — there is more wheat than the mill could eat in a
  // session, and it is simply in the wrong place.
  const save = { ...initialSave(), stockpile: { wheat: 10_000 }, colonists: [] };
  // …spawn a mill at (5,3), staff it with one adult, step 20 ticks…
  expect(snap.state).toBe('waitingForInput');
  expect(snap.buffered).toBe(0);
  expect(stockpile.get('wheat')).toBe(10_000);   // and nothing was quietly eaten
});

it('the same mill produces once wheat is in its own input buffer', async () => {
  // The other half: without this, "produces nothing" would also pass with
  // ProductionSystem deleted entirely.
  //
  // …same fixture, but inputBuffer: { wheat: inputBufferCap } …
  //
  // SIX wheat would not survive the 20-tick horizon: a mill is one wheat per
  // three-tick batch, so six run out around tick 18 and the mill correctly
  // returns to `waitingForInput` — the assertion below would then reject the
  // implementation it is meant to accept. Seed the cap.
  //
  // And assert what the feature DOES, not the state it happens to be in at a
  // chosen tick: a momentary `producing` is hostage to `ticksPerBatch` and the
  // crew's work power, both of which are tunable. Output banked and local
  // input drawn down is the claim.
  expect(snap.buffered).toBeGreaterThan(0);
  expect(inputBuffer.total()).toBeLessThan(BALANCE.inputBufferCap);
  expect(stockpile.get('wheat')).toBe(10_000);   // still not touched
});
```

- [ ] **Step 2: Run tests to verify they fail** — the first fails (it produces), the second fails (`inputBuffer` is not a `BuildingSpec` field).

- [ ] **Step 3: The component, the cap, the spawn list**

`InputBuffer` mirrors `OutputBuffer`: `amounts`, `total()`, `room(cap)`, `add`, `take`. It needs `fullestResource`'s opposite — **`shortestOf(recipe, order)`**, the input this building has least of relative to what its recipe wants, ties by catalog order. Put that on the component beside `take`, so `HaulSystem` and any UI preview cannot derive it differently.

In `balance.ts`:

```ts
  /** Units a building may hold of its own recipe's inputs (total across
   * resources, like outputBufferCap). Mirrors the output cap so a building's
   * in-tray and out-tray are the same size and a hauler's round trip is
   * symmetric. At one input per batch this is 12 batches of runway — ~36 ticks
   * for a mill, comfortably longer than the 13-tick worst-case one-way walk. */
  inputBufferCap: 12,
```

`clampedInputBuffer` is `clampedBuffer` against `inputBufferCap`. **Do not** parameterise `clampedBuffer` by reading a cap off the caller — give it a cap argument and keep one function; two copies of the trim loop is how the input side ends up trimming to the output cap after a retune.

Append `InputBuffer` to `COMPONENT_TYPES` **and** to `buildingComponents`. `world.ts` is at 478 lines: check `grep -cve '^\s*$' src/engine/world.ts` after the edit, and if it crosses, extract `initialSave` into `src/engine/initial-save.ts` rather than loosening anything.

- [ ] **Step 4: Production pays locally**

Both payment sites move — the `startBatch` guard and the chain-into-the-next-batch call at the end of `completeBatches`. Miss the second and a building produces exactly one batch per delivery, which looks like a balance problem and is not:

```ts
function startBatch(production: Production, input: InputBuffer, buffer: OutputBuffer, recipe: RecipeDef, perBatch: number): void {
  if (production.batchActive) return;
  if (buffer.room(BALANCE.outputBufferCap) < perBatch) return;
  if (payFrom(input, recipe.inputs)) { production.batchActive = true; production.progress = 0; }
}
```

`ProductionSystem` no longer takes `WriteResource(Stockpile)` at all. Removing that dependency is the check that the move is complete: if it still compiles with the resource declared, something is still reaching for the global store.

- [ ] **Step 5: Fix the existing fixtures**

`npm test` names them. Each is the same edit — a stockpile seed becomes an `inputBuffer` seed on the building under test. Read each one as you go: a test that was *about* the stockpile draining (rather than about production) is telling you something, and its assertion may need to move rather than its fixture.

- [ ] **Step 6: Mutation-check**

```bash
cp src/engine/systems/production-system.ts /tmp/mut-production
sed -i 's/if (payFrom(input, recipe.inputs))/if (stockpile.pay(recipe.inputs))/' src/engine/systems/production-system.ts
# (restore the resource declaration by hand for this check, then:)
npx vitest run tests/engine/systems/production-system.test.ts   # the first test above must go red
cp /tmp/mut-production src/engine/systems/production-system.ts   # NOT git checkout — it
# would reset a TRACKED file to HEAD and discard the whole uncommitted implementation.
```

- [ ] **Step 7: Gates and commit**

```bash
rm -rf coverage && npm run check:all
git commit src/engine tests/engine -m "feat(engine): a recipe's inputs come from the building, not from the colony

ProductionSystem no longer holds Stockpile at all. A mill beside ten thousand
wheat produces nothing until a hauler brings it some, which is the half of
increment 4's 'goods stop teleporting' that never shipped."
```

---

### Task 4: The `storehouse`, and `storage` as a third building role

**Files:**
- Modify: `src/shared/content-types.ts` (`storage: number` on `BuildingDef`; `'storehouse'` on `BuildingDefId`)
- Modify: `src/engine/content/buildings.ts`, `src/engine/content/balance.ts`
- Modify: `src/shared/snapshot.ts` (`BuildingState` gains `'storing'`), `src/app/labels.ts`
- Modify: `src/engine/snapshot-builder.ts` (`stateOf`)
- Test: `tests/engine/content.test.ts`

**Interfaces:**
- Produces: `BUILDINGS.storehouse`, `BALANCE.storehouseCapacity`, `BALANCE.minSupplyUnits`, `BuildingState` `'storing'`.

- [ ] **Step 1: Generalise the content invariant (failing test first)**

Increment 6 pinned *"exactly one of a recipe or beds"*. It becomes three roles:

```ts
it('every building def fills exactly one role: produces, shelters, or stores', () => {
  // A def with none does nothing at all; a def with two is two mechanics in one
  // entry. This is increment 6's two-way invariant generalised, not replaced —
  // if it ever needs a fourth arm, that is the moment to ask whether roles want
  // to be data rather than three fields.
  for (const def of Object.values(BUILDINGS)) {
    const roles = [def.recipe !== null, def.beds > 0, def.storage > 0].filter(Boolean).length;
    expect(roles, `${def.id} fills ${roles} roles`).toBe(1);
  }
});

it('the storehouse stores and does nothing else', () => {
  expect(BUILDINGS.storehouse.storage).toBe(BALANCE.storehouseCapacity);
  expect(BUILDINGS.storehouse.workerSlots).toBe(0);   // a shed, not a job
  expect(BUILDINGS.storehouse.recipe).toBeNull();
  expect(BUILDINGS.storehouse.beds).toBe(0);
});
```

- [ ] **Step 2: The def and the constants**

```ts
  storehouse: {
    id: 'storehouse', name: 'Storehouse', cost: { wood: 20, planks: 10 }, workerSlots: 0,
    recipe: null, beds: 0, storage: BALANCE.storehouseCapacity,
  },
```

Every other def gains `storage: 0`. Typecheck enumerates them.

- [ ] **Step 3: `'storing'` in `stateOf`**

`stateOf` currently returns `'housing'` for any recipe-less building, which would make a storehouse read "housing". The order matters — put the storage arm before the housing one and derive both from the def rather than from `recipe === null`:

```ts
if (relocatingTicks > 0) return 'relocating';
if (def.storage > 0) return 'storing';
if (def.recipe === null) return 'housing';
```

- [ ] **Step 4: Labels and palette**

`src/app/labels.ts` gains `storing: 'Storing'`. The palette derives from `BUILDING_IDS`, so the storehouse appears in the World tab and the table's construct control with no further wiring — **verify that rather than assuming it**, since it is the kind of claim that is true until a filter is added.

- [ ] **Step 5: Mutation-check, gates, commit**

Mutate `roles).toBe(1)`'s subject by giving the storehouse `beds: 1` and confirm the invariant test — and only it — goes red.

```bash
rm -rf coverage && npm run check:all
git commit src tests -m "feat(content): a storehouse, and storage as a third building role

increment 6's 'exactly one of a recipe or beds' generalises rather than being
replaced: produces, shelters, or stores, exactly one."
```

---

### Task 5: Store sites come from the world

Where `HaulSystem` gets its `StoreSite[]` (§2.3, §2.7). Small, and worth its own commit because two exclusion rules live here and both are easy to get wrong in a way nothing else catches.

**Files:**
- Create: `src/engine/systems/haul-sites.ts`
- Test: `tests/engine/systems/haul-sites.test.ts`

**Interfaces:**
- Produces: `storeSitesOf(rows, pending): StoreSite[]` — the camp always first (id 0, `capacity: null`), then every non-relocating storehouse not in `pending.demolished`, ascending by id.

- [ ] **Step 1: Write the failing tests**

Two exclusions, one inclusion-that-isn't:

```ts
it('excludes a relocating storehouse', () => {
  // A building mid-move provides none of its service — the same rule
  // beds.total already applies to a relocating house (increment 6).
});

it('excludes a storehouse demolished earlier this tick', () => {
  // CommandSystem runs before HaulSystem and the entity survives until the
  // post-step sync, so without pending.demolished a hauler is dispatched to a
  // shed that is already gone.
});

it('does NOT include a storehouse constructed earlier this tick', () => {
  // Deliberate, and the opposite call from homing's pending.constructed
  // handling: a colonist left homeless beside a house built this tick is a
  // contradiction the player can SEE in one snapshot, while a hauler not yet
  // using a new shed is invisible and costs one tick. Simpler wins here.
});
```

- [ ] **Step 2: Implement, mutation-check each exclusion separately, commit**

Each of the three cases must go red on its own mutation and stay green on the other two — that is what makes them three tests rather than one test written three ways.

---

### Task 6: The supply leg

The heart of it (§2.5, §2.6). `haul-system.ts` is 157 lines and roughly doubles; the candidate-building and dispatch halves move to `src/engine/systems/haul-dispatch.ts` in this task, leaving the system as the tick loop it reads as today.

**Files:**
- Create: `src/engine/systems/haul-dispatch.ts`
- Modify: `src/engine/systems/haul-system.ts`, `src/engine/components.ts` (`HaulTrip`)
- Test: `tests/engine/systems/haul-system.test.ts`, `tests/engine/systems/haul-dispatch.test.ts`

**Interfaces:**
- `HaulTrip` gains, all runtime-only:
  - `kind: HaulKind = 'collect'`
  - `atCol` / `atRow` — **where this hauler physically is** when not on a leg. A position, not a site id: no membership to dangle when a storehouse is demolished, nothing to repair at the top of a tick. This one edit deletes the whole reachability class (spec §2.5). **Defaults to `CAMP_TILE`, not `(0, 0)`** — every other numeric field on `HaulTrip` defaults to zero, so a fresh or restored hauler would otherwise start in the map's corner and price its first leg from a tile it has never stood on. Set in `colonistComponents` (the single shared spawn list), and covered for both a recruited and a restored hauler.
  - `sourceSiteId` and `plannedAmount` — the site a supply trip is fetching from, and **how much it intends to take**. The quantity needs its own field and must not be folded into `amount`: the claim map has to subtract a pending take so two haulers do not both plan the last six wheat, but a fetching hauler is carrying *nothing* until it arrives — and `buildSaveFromWorld` banks `trip.amount` into the save as real cargo (increment 4's mid-trip simplification). Overloading `amount` therefore either leaves concurrent haulers unable to see the pending quantity, or **duplicates goods on any save taken mid-fetch**: banked into the stockpile by the producer while still sitting at the source. `amount` keeps meaning cargo in hand, and `plannedAmount` becomes 0 the moment `takeAt` returns the real figure.
  - `destSiteId: number = CAMP_SITE_ID` — where the return leg is headed
  - `legFromCol` / `legFromRow` and `legToCol` / `legToRow` — **both endpoints of whichever leg is running, frozen when that leg begins.** Every leg, not just the return: a `fetching` or `outbound` trip cancelled part-way needs the same interpolation, and reading endpoints that were only ever populated for the return leg puts the hauler at a default or a stale tile — which is the cancellation bug of the previous round, surviving its own fix.

    This replaces `pickupCol`/`pickupRow`, which were introduced for the return leg alone (OBS-5-01) and whose name stops being true the moment a `fetching` leg uses them: nothing is picked up at its origin. The published snapshot fields rename with them (`haulLegFromCol` and so on), and the layout gets simpler rather than more complex — `legFrom`, `legTo` and `legProgress` describe *any* leg with no per-phase cases at all.

    `legTo` is a tile, not a site id, for the reason OBS-5-01 established: a depot relocated mid-leg resolves the same id to a **new** tile, and a demolished one resolves to nothing, leaving no origin to price the onward leg from.
  - `pickedUp = false` — whether the load in hand came out of an output buffer. The flow-accounting discriminator (§2.4): by the time a load reaches a site, a genuine delivery and an undelivered supply remainder are indistinguishable without it.
- `haulerCapacity(homeTile)` — **unchanged from increment 6**, camp-relative. The bed-to-base version was collateral from the discarded base model; reverting it means increment 6's measured commute figures, and §4 q1's control, are not disturbed by this increment at all.
- `reset()` clears `kind`, `pickedUp`, `sourceSiteId`, `destSiteId` and the rest. **`atCol`/`atRow` must be brought up to date first, not merely preserved.** While a leg runs they name its *origin*, so a trip cancelled several ticks in would otherwise snap the hauler back over every tile it had walked. Derive the position from the leg's frozen endpoints and `legProgress(ticksLeft, legTicks)` — the interpolation the renderer already uses to place the dot — so the hauler stops where the player last saw it:

  ```ts
  cancel(trip) {
    const t = legProgress(trip.ticksLeft, trip.legTicks);
    trip.atCol = trip.legFromCol + (trip.legToCol - trip.legFromCol) * t;   // and atRow
    trip.reset();
  }
  ```

  A fractional position is fine; it is only ever a distance origin.

  **`reset()` is private to `cancel()`. Nothing else may call it.** Every branch that ends a trip goes through `cancel()`, because every one of them needs the position brought up to date first — and the branches that forget are the ones added later, by someone reading the surrounding code rather than this rule. Both fetch-arrival cancellations are examples: they fire *after* the hauler has walked its whole leg, so `legProgress` is 1 and the correct position is `legTo`, while `atCol`/`atRow` still hold `legFrom`. A bare `reset()` there preserves the stale origin and teleports the hauler back across the leg it just finished, mis-pricing its next dispatch and jumping its marker. If a future branch genuinely must not move the hauler, it still calls `cancel()` — `legProgress` decides, not the caller.

- [ ] **Step 1: Write the failing tests**

Tick-by-tick, because a trip is a state machine and a test that only reads the end state passes for the wrong reasons:

```ts
it('a supply hauler fetches, unloads, and comes back with what was waiting', async () => {
  // camp: 20 wheat. A mill at (12,8) with an empty input buffer and 4 flour
  // already in its output buffer — so the return leg has something to carry
  // and the round trip in §2.5 is actually exercised.
  //
  // THREE legs, and the first assertion is the one a two-leg habit gets wrong:
  // tick 1: dispatch — phase FETCHING and carrying NOTHING. Even a camp-sourced
  //   job pays haulTicksBetween's never-free one-tick minimum, so a hauler
  //   cannot be outbound-and-loaded on the dispatch tick. Asserting otherwise
  //   rejects a correct implementation, or invites skipping the fetch leg when
  //   the source happens to be the camp.
  // tick n:   source arrival — carrying > 0, phase OUTBOUND
  // tick n+m: building arrival — mill inputBuffer gains wheat, hauler now flour
  // tick n+2m: deposit — the destination site gains flour
  // and across the whole trip: total wheat + flour in the world is unchanged.
});

it('a supply trip that finds nothing waiting returns empty', async () => { /* … */ });

it('the remainder rides home when the input buffer filled meanwhile', async () => {
  // Another hauler got there first. The leftover must NOT be silently dropped:
  // assert the colony total, not just the hauler.
});

it('a returning supply remainder is not counted as a delivery', async () => {
  // §2.4's flow table, and the one row an implementation reaches for addAt on
  // by reflex. DISCRIMINATING: run the same fixture twice — once where the
  // hauler brings back 4 units it could not deliver, once where it brings back
  // 4 units it picked up from the output buffer. Same amount, same tick, same
  // destination; deliveredRate must move in the second run and NOT in the
  // first. Asserting only the first run passes with addAt deleted entirely.
});

it('a hauler idle where a storehouse stood keeps its tile and dispatches from there', async () => {
  // NOT "dispatches from the camp" — that was the base model, where a hauler
  // belonged to a site and had to be re-homed when the site vanished. Here
  // atCol/atRow is a physical position, cancellation brings it up to date, and
  // there is no membership to repair. Teleporting the hauler to the camp would
  // mis-price its next leg and draw it in the wrong place.
  //
  // Same test again for a storehouse sent into RELOCATION rather than
  // demolished: both must leave the hauler exactly where it is standing.
});
```

- [ ] **Step 2: Implement dispatch**

`haul-dispatch.ts` owns: the claim map (counting **both** kinds — a supply hauler also loads output on arrival, §2.6), the collect candidates (unchanged), the supply candidates, and `chooseJob(trip, sites, …)`, whose order is **supply, then collect** — supply candidates are paired with a source site across *every* site (§2.6), so there is no third tier and no base to be stuck at.

The supply-first rule and its non-deadlock belong in a comment where the fallthrough is, not only in the spec:

```ts
// Supply is offered first: a building waiting on inputs produces NOTHING,
// while one with a full output buffer has already produced and its goods are
// safe where they stand. The obvious objection is a deadlock — every hauler
// supplying, nobody collecting, the ledger drained — and it cannot happen
// structurally: a supply job requires stock to exist SOMEWHERE in the ledger,
// and only collection puts it there. As the ledger empties, supply candidates
// vanish and collection resumes on its own. Measured in spec §4 q3 rather
// than left as this argument.
//
// NOT "stock at the hauler's own site" — haulers have no site. That phrasing
// is the discarded base model, and this is the one function where it could
// creep back in: a source is chosen across EVERY site and the trip begins by
// walking to it. The mutation check for this step reddens all five
// reachability fixtures if sources get restricted to where a hauler stands.
```

- [ ] **Step 3: Implement the legs**

The outbound arrival handler is the only genuinely new code, and it does three things in order — unload, then load, then choose a destination:

```ts
const arrive = (trip: HaulTrip, row: BuildingRow, capacity: number): void => {
  // Staffing is a DISPATCH-TIME filter (§2.6) and the world moves during a
  // leg: the target's last worker can be unassigned, retire or die while this
  // hauler walks, and none of those cancels the trip the way a demolition
  // does. Unloading anyway parks goods in a processor that cannot use them and
  // loses them if it is demolished — exactly what the staffing rule prevents,
  // defeated by travel time. Leave the load in hand instead; `pickedUp` stays
  // false, so it is an undelivered remainder and goes home to its source.
  const staffed = row.workers > 0;
  if (trip.kind === 'supply' && trip.resource !== null && staffed) {
    const placed = row.input.add(trip.resource, Math.min(trip.amount, row.input.room(BALANCE.inputBufferCap)));
    // Consumption is recorded HERE, not when the load left its site: this is
    // the moment the goods leave the colony's store for good, and it is the
    // honest successor to the consumption ProductionSystem used to record when
    // it paid a recipe out of the stockpile (§2.4).
    stockpile.recordConsumed(trip.resource, placed);
    trip.amount -= placed;          // the remainder rides home; nothing is destroyed
  }
  // BOTH kinds load on the way back — this is the round trip the increment is named for.
  if (trip.amount === 0) {
    const resource = row.buffer.fullestResource(RESOURCE_IDS);
    const taken = resource === null ? 0 : row.buffer.take(resource, capacity);
    trip.resource = taken > 0 ? resource : null;
    trip.amount = taken;
    trip.pickedUp = taken > 0;      // decides addAt vs refundAt on arrival (§2.4)
  }
  // An undelivered supply remainder goes back where it CAME from, not to
  // whatever site is nearest: routing it onward would turn camp wheat into
  // depot stock without it ever being consumed — the store-to-store transfer
  // §2.13 excludes — and contradict the source-refund rule Task 8 applies when
  // the same trip is cancelled instead. `!pickedUp && amount > 0` is exactly
  // this case, because a hauler only loads output with empty hands.
  const remainder = !trip.pickedUp && trip.amount > 0;
  const dest = (remainder ? sourceIfItFits(trip, sites, heldAt) : null)
    ?? nearestSiteWithRoom(row.position.col, row.position.row, sites, heldAt, trip.amount)
    ?? campSite;
  trip.destSiteId = dest.id;
  trip.phase = 'returning';
  const ticks = haulTicksBetween(row.position, dest, BALANCE.haulTilesPerTick);
  trip.ticksLeft = ticks;
  trip.legTicks = ticks;
  // ALL FOUR, every leg. Setting one and leaving the rest at defaults is the
  // failure this four-field model exists to prevent, and this snippet had
  // exactly that shape for a round.
  trip.legFromCol = row.position.col;  trip.legFromRow = row.position.row;
  trip.legToCol = dest.col;            trip.legToRow = dest.row;
};
```

The `trip.amount === 0` guard is load-bearing and not an optimisation: a hauler still holding an undelivered remainder must carry *that* home rather than mixing two resources in one pair of hands, which `HaulTrip` has no room to represent.

**The load fits on arrival by construction**, because choosing `destSiteId` reserved room for it (Step 3c). So the deposit handler's ordinary path is: bank (`addAt` when `trip.pickedUp`, `refundAt` when not), set `atCol`/`atRow` to where it now stands, go idle.

Two earlier drafts of this brief tried to solve it at arrival instead, and both leaked. Checking for room only at pickup lets two haulers aim at a depot with room for one. Re-resolving on arrival and comparing site ids fixes the *full* depot and misses the **partially** full one — `nearestSiteWithRoom` still resolves to the site underfoot when it has any room at all, so the load splits, part banked and part forwarded to the camp with nobody walking it. Reservation removes both, which is why the fix belongs at the moment the destination is chosen rather than the moment it is reached.

The one case reservation cannot cover is a destination that **stops existing** — demolished, or in transit:

```ts
// Not "the depot filled" — that cannot happen now — but "the depot is gone".
// The load must be CARRIED wherever it ends up, so this starts a new leg
// rather than banking remotely. Task 2's forward-to-camp guarantee is the last
// resort for paths with NO HAULER LEFT to walk (a cancellation, a stand-down,
// a load-time spill); using it here would teleport goods to the camp while the
// hauler stands at the depot, and §4 q2 measures exactly whether a depot pays
// for itself.
// Compare the TILE this leg was aimed at, not the site id. A storehouse that
// finishes relocating mid-leg keeps its id and changes its tile, so an
// id-only test passes and the load is deposited at a depot the hauler never
// walked to. The frozen legTo is what the walk was actually priced against.
const arrived = dest !== null && dest.col === trip.legToCol && dest.row === trip.legToRow;
if (!arrived) { startReturnLeg(trip, at, dest ?? camp); return; }
```

The camp is unbounded and cannot vanish, so the walk terminates. **The test asserts the ticks**, not only that the goods reached the camp — an arrival-count assertion passes for a teleport, which is the whole thing this rule prevents.

- [ ] **Step 3c: Reservations, and the claim invariant behind them**

Claims are recomputed every tick from live components, which is what makes dispatch a pure function of world state. It follows that **any intent a hauler holds must be reconstructible from its own components next tick** — an intent recorded nowhere is not a claim, however firmly a brief says it is. Both of the following were real defects in earlier drafts of this plan before they were rules:

- `destSiteId` **reserves** room at the destination from the moment it is chosen, and `nearestSiteWithRoom` counts reservations against capacity exactly as `claimableAt` counts claims against a building's buffer. A refund that eats reserved room puts the returning hauler straight back into the split-load case reservation exists to remove.

  **A trip releases its own reservation before resolving a new destination.** A cancelling hauler otherwise double-counts itself — carrying six to a depot holding 54 of 60, its own six is already reserved, so the lookup reports 60, adding six again overflows, and the depot is rejected for a load whose room was reserved for exactly this. Clearing `destSiteId` *is* the release, because reservations are a projection of live components (Step 3c): clear first, resolve second, and every other trip's reservation still counts. Pin it with a fixture where the depot fits the load only if the trip's own reservation is excluded.

  **Honouring that is the caller's job, not the banking call's.** `addAt(site, …)` and `refundAt(site, …)` see a site's *physical* contents and know nothing about room another hauler has been promised — giving them reservation awareness would mean teaching the ledger about haul trips, which the rest of this design keeps out of it. So every caller, cancellations included, resolves its destination through `nearestSiteWithRoom(…, heldAt, amount)` with the **same reservation-aware `heldAt`** dispatch uses, and banks only into what that returns. The camp being unbounded is what makes that resolution always succeed.
- A **fetching** hauler records `sourceSiteId`, which is its claim on that site's stock. Without it two haulers both plan to take the same last six wheat and one arrives to nothing. (The discarded base model had the same defect in a different costume: its rebase leg carried no target, so the claim it promised was unreconstructible and the whole fleet would have rebased at once.)

Two fixtures, both of which fail loudly without the reservations above: two haulers destined for a depot with room for one (and a third for a depot with room for *part* of a load); three idle haulers and one remote supply job, of which exactly one fetches it.

- [ ] **Step 3b: The fetching leg**

A supply trip begins with a walk to wherever the goods are. Write the failing test first, because the cases it covers are the ones the discarded base model needed four separate rules for:

```ts
it('a hauler at the camp fetches from a remote depot to feed a mill beside it', async () => {
  // Under the base model this deadlocked: a supply job loaded only at the
  // hauler's own site, and a hauler only changed site by depositing at one, so
  // nothing ever sent one to a depot holding wheat next to a mill with no
  // output to collect. It needed a `rebasing` phase, a priority rule to make
  // that phase fire, and a claim to stop the whole fleet firing it at once.
  //
  // With no base it is an ordinary supply job whose first leg is long.
  // Assert the MILL EVENTUALLY PRODUCES — the symptom a player reports is a
  // cluster that never starts.
});
```

Then the same fixture reached three more ways, all of which also deadlocked before and are now expected to be dull: after a reload; after that depot's haulers have all died; for a depot built this tick. And a fourth with a **busy forester beside the camp**, which is the one that caught the base model's priority rule being unreachable. Keep all five. Each is a regression sentinel against reintroducing a base by accident.

The leg itself:

```ts
// phase 'fetching': atCol/atRow -> the source site's tile, empty-handed.
// On arrival, takeAt the load (recording NOTHING — goods in transit are not
// gone, §2.4) and switch to 'outbound' from the source tile to the building.
//
// The target is rechecked HERE, before taking anything. §2.5's rule — any
// condition a dispatch decision rests on is either reserved or rechecked on
// arrival — covers the target's existence too: handleDemolishBuilding cancels
// OUTBOUND trips aimed at the building, and a fetching hauler is walking to a
// SOURCE, so nothing cancels it today. It would draw stock out of the source
// and carry it to a building already known to be gone, tying up both until the
// arrival path refunds them. Nothing has been taken yet, so this is a clean
// cancel: no disposal, no remainder.
if (targetGone(trip)) { cancel(trip); return; }   // cancel(), never reset() — see below
//
// And the SOURCE, by tile rather than by id — round nineteen's lesson applied
// to the other end of the trip. A storehouse that relocates keeps its
// sourceSiteId and moves; §2.3 drops it from the site list only while it is IN
// transit, so a hauler arriving after the move completes finds the id alive
// again at a different tile, and an id-keyed takeAt would draw goods out of a
// building standing somewhere the hauler is not. legTo is the tile this leg
// was priced against, so it is the tile that has to still be there.
const source = siteById.get(trip.sourceSiteId);
if (source === undefined || source.col !== trip.legToCol || source.row !== trip.legToRow) {
  cancel(trip);   // clean: nothing has been taken yet — but still cancel(), not reset()
  return;
}
//
// trip.amount MUST become what takeAt ACTUALLY RETURNED, never the amount
// claimed at dispatch. A source claim reserves stock against other HAULERS;
// it does not bind Stockpile.pay, which spends camp-first across every site
// for construction costs and meals. So a build ordered while this hauler was
// walking can legitimately have spent the wheat it set out to fetch. Carrying
// the claimed figure regardless would CREATE goods out of nothing.
trip.amount = stockpile.takeAt(trip.sourceSiteId, trip.resource, trip.plannedAmount);
trip.plannedAmount = 0;   // the claim is spent; `amount` is cargo from here on
if (trip.amount === 0) { /* nothing to deliver: continue as a collect trip */ }
```

The alternative — making source claims bind aggregate spends — was rejected: it would push knowledge of haul trips down into the ledger, which every other part of this design keeps out of it, to prevent a case a single line of reconciliation handles.

```ts
it('a construction ordered mid-fetch cannot make the hauler create goods', async () => {
  // The resource must be one that is BOTH a recipe input and a construction
  // cost, or the fixture cannot discriminate at all. No building costs wheat,
  // so a wheat-fetching hauler's source can never be drained by a build order,
  // the mutation that carries plannedAmount instead of takeAt's return still
  // passes, and the regression this test exists for goes untested.
  //
  // The intersection is exactly two: WOOD (a sawmill's input) and PLANKS (a
  // workshop's input). Use a sawmill fetching wood, and order a build that
  // spends that wood while the hauler is walking.
  //
  // Assert the COLONY TOTAL across the whole trip — the hauler must arrive
  // with what was actually there, or with nothing.
});
```

A source that is demolished or sent into transit under a `fetching` hauler simply cancels the trip: nothing has been picked up, so there is nothing to dispose of. No rule needed, which is the point of the model.

- [ ] **Step 4: (deleted)**

The base model needed a pass at the top of every tick to re-resolve haulers whose site had been demolished or sent into transit. With no base there is no membership to dangle. **If you find yourself needing this step, a base has crept back in** — stop and re-read spec §2.5.

- [ ] **Step 5: Mutation-check**

Eleven separate mutations, each of which must redden exactly one test: drop the arrival-time staffing recheck (a fixture where the target's only worker is unassigned mid-leg, asserting the goods come home rather than sitting in an unstaffed mill); carry the *claimed* fetch amount instead of `takeAt`'s return value (the construction-during-fetch conservation fixture); drop the `amount` argument from `nearestSiteWithRoom` so it only skips full sites (the partial-room fixture); let `refundAt` ignore reservations (the cancellation-plus-return fixture); read the destination from `destSiteId`'s live tile rather than the frozen one (the relocated-mid-return fixture); drop the destination reservation (the two-haulers-one-depot fixture); drop the `sourceSiteId` claim (the three-haulers-one-job fixture); restrict supply sources to the site the hauler stands on (**all five** reachability fixtures — this is the base model creeping back, and it should be loud); drop the unload (`row.input.add`); drop the return-leg load; and force `pickedUp = true` unconditionally (the delivery-inflation test).

- [ ] **Step 5b: Un-skip the integration chain test — this task is what unblocks it**

Task 3 stopped inputs teleporting; nothing delivered them until now, so a multi-building chain could not run and `tests/engine/integration.test.ts` has a chain test sitting under `it.skip` with that justification. **The supply leg you just built is what makes it passable again.** Remove the skip and confirm it goes green on its own merits.

If it does not pass, that is a finding about this task, not a reason to leave it skipped — a chain that still cannot run means supply dispatch is not reaching a real multi-stage colony, which is the whole point of the increment. Report it rather than re-skipping.

- [ ] **Step 6: Gates and commit**

```bash
rm -rf coverage && npm run check:all
grep -cve '^\s*$' src/engine/systems/haul-system.ts src/engine/systems/haul-dispatch.ts
git add src/engine/systems/haul-dispatch.ts tests/engine/systems/haul-dispatch.test.ts
git commit src/engine tests/engine -m "feat(engine): haulers carry inputs out and goods back in one trip

The return leg is identical for both kinds, which is why this is a change to
one system rather than a second one."
```

---

### Task 7: Claims, determinism, and the commute a hauler actually walks

**Files:**
- Modify: `src/engine/systems/haul-dispatch.ts`, `src/engine/systems/haul-system.ts`
- Test: `tests/engine/systems/haul-system.test.ts`

- [ ] **Step 1: Both kinds claim, in both directions**

Two claim maps, and missing either produces a specific, nameable failure:

- **output claims** must count supply haulers (they load on arrival), or two haulers are sent at the same six units;
- **input claims** must subtract pending deliveries from a building's deficit, or every idle hauler in the colony leaves for the same empty mill on the same tick.

Test the second by dispatching three haulers in one tick at one starved bakery and asserting they choose three different jobs (or that two find none) — with a fixture where three targets exist, so the assertion discriminates.

- [ ] **Step 2: The commute stays camp-relative — do not touch it**

This step used to add a `siteTile` argument to `haulerCapacity` and test two colonists "based" at a depot. **That was the discarded base model and the instruction is deleted.** Following it would reintroduce base-dependent capacity, demand state `HaulTrip` no longer carries, and move the raw-producer control §4 q1 requires to stay unchanged.

`haulerCapacity(homeTile)` keeps increment 6's signature and its camp-relative measurement, untouched by this increment. The only thing to verify here is that nothing in Tasks 1–6 changed it:

```bash
git diff main -- src/engine/systems/haul-system.ts | grep -n "haulerCapacity"   # expect no signature change
```

If that shows a second argument, a base has crept back in — stop and re-read spec §2.5.

- [ ] **Step 3: Determinism**

Extend the existing determinism test to cover both kinds: build one world state, run the dispatch twice from identical inputs in different entity orders, assert identical claims. The tie-break chains end at the building id precisely so this holds.

- [ ] **Step 4: Mutation-check, gates, commit.**

---

### Task 8: Goods, demolition, relocation — and two carried-forward issues

Conservation (§2.7) plus OBS-6-08 (§2.12); OBS-5-03 is settled without code (Step 3). `command-handlers.ts` is 426 lines and the placement handlers move out here.

**Files:**
- Create: `src/engine/systems/placement-handlers.ts` (construct / move / demolish, moved verbatim first)
- Modify: `src/engine/systems/command-handlers.ts`, `src/engine/snapshot-builder.ts`, `src/engine/systems/population-handlers.ts` (`standDown` — the fourth cancellation path)
- Modify: `docs/issues/2026-08-09-demolish-and-rebuild-bypasses-the-priced-relocation.md`, `docs/issues/2026-08-09-a-relocating-crews-work-power-is-computed-then-discarded.md`
- Test: `tests/engine/systems/command-system.test.ts`

- [ ] **Step 1: Move the handlers, green suite, commit that alone.** A move and a behaviour change in one commit is two mistakes waiting to be attributed to each other.

  **Then read what you moved, rather than assuming a verbatim move is finished.** `handleMoveBuilding` retargets an outbound hauler with `haulTicks(to.col, to.row, BALANCE.haulTilesPerTick)` — camp-relative, and correct only while the camp was the only origin a trip could start from. Task 6 dispatches from wherever the hauler is standing, so one that started its leg at a remote depot now gets charged a camp-to-target walk it is not walking, and the renderer derives the dot's position from that same `legTicks`. That is OBS-5-01 exactly — a leg length disagreeing with the leg the sim is running — reintroduced by a task that only moved code:

```ts
// Resolve the hauler's live base and measure from it, not from the camp.
// From where the hauler IS, not where its leg began. Measuring from the old
// origin restarts the journey: the dot jumps backward and the walk already
// covered is charged a second time. The cancellation rule in Task 6 already
// derives the current position; reuse it, freeze THAT as the new leg origin,
// and price only the remaining walk.
const at = positionAlong(trip);                 // legFrom + (legTo - legFrom) * legProgress
trip.legFromCol = at.col; trip.legFromRow = at.row;
trip.legToCol = to.col;   trip.legToRow = to.row;
const ticks = haulTicksBetween(at, to, BALANCE.haulTilesPerTick);
```

  The test needs a fixture where the two figures **differ** — a depot in the far corner and a target moved near the camp — or it passes against the camp-relative version it exists to rule out.

- [ ] **Step 2: Demolition, three rules with one test each**

```ts
it('demolishing a storehouse leaves colony wealth unchanged', async () => {
  // THE assertion for §2.7. Not "the camp gained 30 wood" — wealth across the
  // tick, which is the property the player would notice being violated and the
  // one a future refactor of where goods live cannot accidentally satisfy.
});

it('demolishing a producer loses both its buffers, and says so', async () => {
  // OBS-4-07's decision, extended to the input buffer for the same reason:
  // neither is in the ledger, and a building left full of goods should be
  // expensive to bulldoze.
});

it('a cancelled trip disposes of its load by whether a hauler is left to walk', async () => {
  // FOUR paths, and they split TWO ways — grouping them was the defect here.
  //
  // A FETCHING hauler cancels clean in every one of these: nothing has been
  // taken from the source yet, so there is no load to dispose of. Only
  // outbound and returning trips reach the split below.
  //
  // Nobody left to walk it -> bank immediately (refundAt for a supply load,
  // addAt for a pickup, decided by `pickedUp`):
  //   - unassignHauler
  //   - standDown in population-handlers.ts, which lives in another system,
  //     runs BEFORE HaulSystem in the tick, and banks with stockpile.add()
  //     today — right while every carried load was collected output.
  //
  // Hauler survives and can carry it -> start a RETURNING leg with the load:
  //   - the target demolished under an outbound hauler
  //   - the "building gone" branch on arrival
  // Banking these teleports cargo out of a walking hauler's hands, which §2.4
  // forbids, and understates haul time in the direction that flatters §4.
  //
  // Assert the TICKS for the surviving-hauler cases, not just the destination:
  // an assertion that the goods arrived passes for a teleport.
});

it('a hauler who dies mid-supply-trip refunds rather than delivers', async () => {
  // standDown's own test, because it is reached through retirement, starvation
  // and death rather than through any command — nothing in this task's other
  // fixtures goes near it. Assert deliveredRate does not move, and that it DOES
  // move for a hauler dying with a collected load, or the test passes with the
  // banking deleted entirely.
});

it('cancelling a supply trip whose source filled meanwhile loses nothing', async () => {
  // The source depot is BOUNDED and back at capacity by the time the trip is
  // cancelled. Task 2's invariant sends the overflow to the camp; without it
  // the reset() that follows deletes whatever refundAt could not bank.
  // Assert the colony total, and the camp's share.
});

it('cancelling a supply trip whose source was demolished in the same drain loses nothing', async () => {
  // Sharper, and the reason addAt/refundAt take a resolved StoreSite: banking
  // into a dead storehouse would create a ledger site no building owns. Those
  // goods would count in colonyWealth, be unreachable by any hauler, and
  // disappear at the next save — because Task 9 serializes site contents off
  // the BUILDING record. Assert the total AND that no site survives without a
  // building; the second is the one that catches an orphan.
});
```

- [ ] **Step 3: OBS-5-03 — nothing to implement, and that is the decision**

**Already decided, before implementation: accepted, not fixed.** The issue note carries the reasoning and is already marked `status: Accepted`; spec §2.12 and §2.13 record it. Nothing in this task changes code for it.

The short version, so nobody reopens it mid-task: pricing the bypass needs *persisted demolition history*, because the cheap version does not work — charging downtime only when a construct lands on the same tick as a matching demolish is defeated by waiting a tick. A save field, its guard, its migration and its clamp is a real cost for a gap worth a few ticks to a player willing to demolish, wait and rebuild. `[[Construction as Work]]` closes it for free as a side effect, which is where it should be closed.

**If you disagree after reading the note, say so rather than implementing something** — that is a scope change, not a task detail.

- [ ] **Step 3b: `cheapestHaulerToRelease` has to learn about `fetching`**

OBS-4-08 gave `unassignHauler` a rule — release the cheapest trip to throw away — ordered `idle`, then `outbound`, then `returning`, on the reasoning that an outbound hauler carries nothing so only its walk out is lost. **Three legs break that reasoning**, and the ordering silently inverts:

- a `fetching` hauler is **empty** (it has not reached its source), and is not in the enum at all;
- an `outbound` hauler on a *supply* trip is **carrying inputs**.

So with one hauler fetching empty-handed and another outbound with a load, the untouched rule releases the loaded one — teleporting its cargo home while leaving the empty worker on duty, which is the opposite of what the rule is for.

Rank on **what is actually carried** rather than on phase name: empty hands first (`idle`, `fetching`, and a `collect` trip's outbound leg), then loaded (`returning`, and a `supply` trip's outbound leg), with the existing fewest-`ticksLeft` and entity-order tie-breaks underneath. `pickedUp` and `kind` already distinguish every case; no new state.

Test the mixed-phase case specifically — one fetching hauler and one loaded outbound hauler, asserting the empty one goes. A fixture with only one phase present cannot catch an inverted order.

- [ ] **Step 4: OBS-6-08 — one path to a relocating crew's work power**

Engine-side and snapshot-side reach zero two different ways today. A relocating *store* now needs excluding from site lists as well, which would make it three. Collapse to one derivation. Read the issue note first.

- [ ] **Step 5: Update the OBS-6-08 note**

Set `status: Done`, `resolved: 2026-08-09`, and name the commit that did it — the convention every resolved note in `docs/issues/` follows. **Do not** write the resolution before the commit exists; a note naming a commit that does not exist is worse than no note. OBS-5-03's note is already final (Step 3) and needs no edit.

- [ ] **Step 6: Gates and commit.**

---

### Task 9: Save v6

**Files:**
- Modify: `src/shared/save.ts`, `src/shared/save-migration.ts`, `src/engine/save-guard.ts`, `src/engine/spawn.ts`, `src/engine/world.ts`, `src/engine/restore.ts`
- **Modify: `src/engine/game-engine.ts` (`buildSaveFromWorld`) and `src/engine/snapshot-builder.ts` (`savedBuildingOf`, `gatherEntityFacts`, `BuildingFacts`)** — the live producer. See Step 0; omitting these is the failure mode of this task.
- Note: restoring a **relocating** storehouse's contents goes through `seedSite` (Task 2), not `addAt` — §2.3 keeps a store in transit out of the site list, so there is no `StoreSite` to bank against, and a save can legitimately be taken mid-relocation. Cover that save/load case: a stocked storehouse saved with `relocatingTicks > 0` comes back holding exactly what it held.
- Test: `tests/shared/save-migration.test.ts`, `tests/engine/save-guard.test.ts`, `tests/engine/world.test.ts`, `tests/engine/game-engine.test.ts`

- [ ] **Step 0: Read this before writing anything else**

`buildSaveFromWorld` writes `world.getResource(Stockpile).toJSON()` — which Task 2 made **camp-only** — and maps buildings through `savedBuildingOf`, which knows nothing about either new field. Adding two required fields to `SavedBuilding` is satisfied by writing `{}` for both. That typechecks, migrates, round-trips, and passes every guard test in Step 1, while **silently deleting every storehouse's contents and every input buffer on save**.

So the producer changes with the format, in this task: `savedBuildingOf` writes the input buffer and `siteJSON(building id)`, and `BuildingFacts` carries what it needs to. And the round-trip test uses a colony with goods in **both** the camp and a storehouse — a fixture whose camp is empty would pass with the site half deleted, which is the same class of non-discriminating fixture increment 5's `Delivered/t` test was fixed for.

**Interfaces:**
- **Freeze the current record as `SavedBuildingV4` first, then extend.** `SaveGameV4.buildings` is typed `SavedBuilding[]` and `SaveGameV5` inherits it through `Omit<SaveGameV4, …>`, so simply adding fields to `SavedBuilding` makes **v4 and v5 statically require v6 fields** — every legacy fixture and every migration input would have to carry `inputBuffer` and `stored` or stop compiling, forcing you to either falsify the old fixtures or leave v6 with no distinct shape. The file already has this pattern (`SavedBuildingV1`, `V2`, `V3` are frozen and commented as such): rename today's record to `SavedBuildingV4`, point `SaveGameV4`/`SaveGameV5` at it, and let the new `SavedBuilding` extend it. `SaveGameV6` then redefines `buildings: SavedBuilding[]` rather than omitting only `version`.
- `SavedBuilding` gains `inputBuffer` and `stored`, both required, both `{}` when empty (the uniform shape `buffer` established in v3 — a single unconditional guard check).
- `SaveGameV6 extends Omit<SaveGameV5, 'version'>` with `version: 6`. `stockpile` is now **the camp's contents**, which for a v5 colony is exactly what it already was.
- `LATEST_SAVE_VERSION = 6`. The literal type is what makes the bump self-policing: raising the constant fails typecheck at both producers until the type moves with it. Let it.

- [ ] **Step 1: Write the failing tests**

```ts
it('a v5 colony loads as v6 with empty input buffers and its stockpile at the camp', () => { /* … */ });

it('an over-cap input buffer trims, and the save still loads', () => { /* clamped, never rejected */ });

it('stored goods a building cannot legally hold spill to the camp', () => {
  // Includes `stored` on a def with storage: 0 — a hand-edited save, or a
  // storehouse whose capacity was retuned DOWN. The assertion is that the
  // AGGREGATE is conserved, not that the field survived: the camp is unbounded,
  // so conservation is exact and nothing is refused.
});

it('a colony with goods in the camp AND a storehouse round-trips both', () => {
  // The producer test. Distinct amounts at each site — 30 wood at the camp,
  // 17 planks in the depot — so a save that writes only one of them fails on
  // the value, not merely on a total that happens to differ.
});

it('every ledger site other than the camp names a building in the save', () => {
  // The sentinel for Task 2's second invariant, asserted from the other end.
  // A site with no building behind it is unserializable BY CONSTRUCTION here —
  // savedBuildingOf walks buildings — so its goods would vanish silently. Four
  // lines, and it catches the whole class rather than the one path that
  // produced it. Run it over a colony that has been through a demolition.
});

it('save and load conserves everything and the colony resumes work', () => {
  // NOT tick-identical resumption — that was an overclaim and is now false.
  // A colony saved with a hauler standing beside a depot comes back with
  // everyone at the camp, so claims, travel times and distribution all differ. What
  // IS guaranteed, and what this asserts: total goods unchanged across the
  // cycle, every site's stock still reachable, and delivery resuming within a
  // bounded number of ticks.
});

it('a hauler mid-supply-trip banks its load at the camp and stands there on load', () => {
  // HaulTrip still never enters the save (increment 4's simplification, kept):
  // conservation exact, no guard, no migration, and job selection is
  // deterministic from persisted state so the colony resumes identically.
});
```

- [ ] **Step 2: The migration**

```ts
const migrateV5toV6: MigrationStep = {
  from: 5,
  to: 6,
  migrate: (save) => {
    const v5 = save as SaveGameV5; // the runner guard-validated this shape
    return {
      ...v5,
      version: 6,
      buildings: v5.buildings.map((b) => ({ ...b, inputBuffer: {}, stored: {} })),
    };
  },
};
```

A v5 colony was exactly a v6 colony with no storehouses and every input already paid. Append to `SAVE_MIGRATIONS`, add `guards[6]`.

- [ ] **Step 3: Guards and clamps**

`isSaveGameV6` validates both maps structurally (safe non-negative integers, `MAX_BUFFER_KEYS`) — reuse the existing buffer-shape helper rather than writing a third copy. `isLoadableSave`'s `isBuffersValid` extends to both new maps for the catalog check.

The spill-at-load rule lives in the restore path, not the guard: the guard says "this file is well-formed", the restore says "and here is where those goods actually end up under current balance". Conflating them is how a retune starts rejecting saves.

- [ ] **Step 4: Mutation-check**

Drop `inputBuffer: {}` from the migration and confirm the v5→v6 test goes red rather than the guard test — if the guard reddens instead, the guard is doing the migration's job.

Then the one that matters most here: make `savedBuildingOf` write `stored: {}` unconditionally. **Only** the both-sites round-trip test may go red. If nothing does, that test's fixture is not discriminating and the save format is free to lose goods.

- [ ] **Step 5: Gates and commit.**

---

### Task 10: Snapshot and the read-model

`snapshot-builder.ts` is 438 lines; the building-section half moves to `src/engine/snapshot-buildings.ts` here.

**Files:**
- Create: `src/engine/snapshot-buildings.ts`
- Modify: `src/engine/snapshot-builder.ts`, `src/shared/snapshot.ts`, `src/app/stores/game-store.ts`
- Modify: `src/engine/initial-snapshot.ts` — Step 4, and it is the reading-side twin of Task 9's Step 0 trap
- Test: `tests/engine/snapshot-builder.test.ts`, `tests/app/stores/game-store.test.ts`

**Interfaces:**
- `BuildingSnapshot` gains `inputBuffered: number`, `stored: number`, `storage: number`.
- `ColonistSnapshot` gains `haulKind: HaulKind | null`, `haulPickedUp: boolean`, `haulLegFromCol`/`haulLegFromRow`, `haulLegToCol`/`haulLegToRow`, and `haulAtCol`/`haulAtRow`.
- Store getters (derived once, not per view): `unitsShort`, `buildingsWaitingForInput`.

- [ ] **Step 1: Move first, green suite, commit.**
- [ ] **Step 2: New fields, with tests whose fixtures discriminate** — give `inputBuffered`, `stored` and `buffered` three *different* values in the fixture, or a field pointed at the wrong source passes (increment 5's `Delivered/t` test survived exactly that mutation until its three fields were given distinct values).

- [ ] **Step 3: Publish the site endpoint, or Task 12 cannot be written**

`haulSpot` in `src/app/world/layout.ts` reads:

```ts
const from = w.haulPhase === 'outbound' ? CAMP_ANCHOR : pickup;
const to = w.haulPhase === 'outbound' ? door : CAMP_ANCHOR;
```

Both endpoints are the camp, hardcoded, and the trip's own endpoints are runtime-only. So a depot trip would be drawn walking to and from the camp tent, and Task 12's promised "a dot leaves a site, reaches a building, and returns" is unwritable. Publish the leg's **two** frozen endpoints — `haulLegFrom*` and `haulLegTo*` — plus `haulAt*` for a hauler with no leg running. A single "site end" pair, which an earlier draft of this step specified, cannot describe a leg beginning from an arbitrary position (the fractional tile a cancellation leaves behind) and gives an idle hauler no coordinates at all, so both of those states stay unrenderable and Step 3's own idle-at-a-depot coverage is unwritable. Same reason as `haulPickupCol/Row` in OBS-5-01 — the app cannot re-derive an endpoint the sim froze — applied to both ends.

Cover all three states in the layout test, including **idle at a depot** — an idle hauler currently falls through to camp placement, so a fix that only handles the two moving legs leaves a dot standing in the wrong place.

- [ ] **Step 4: The seeded snapshot must aggregate every site**

`buildInitialSnapshot` derives stock, wealth, meals per head and therefore affordability from `save.stockpile` — camp-only from Task 9 on. Its own doc comment says why that is not a transient: *"a restored engine starts PAUSED — so this is not a placeholder that a tick will shortly correct, it is what the player looks at for as long as they leave the game paused."* A colony reopened with its planks in a depot shows a short wealth figure, a meals-per-head the birth gate disagrees with, and a build palette refusing buildings it can afford.

Aggregate the camp with every building's restored `stored`. Then **project every clamp and every default the spawn path applies**, because this projection bypasses both the components and the restore path and so inherits neither:

- **Input buffers** clamp the way `buildingFactsOfSaved` already clamps output buffers.
- **`stored` clamps and spills exactly as Task 9's restore does.** A depot saved at 60 under a `storehouseCapacity` since reduced to 30 must read `30 / 30` with the other 30 at the camp — not `60 / 30`, which is what a straight aggregation shows, and which the first tick would then silently correct under the player's eyes.
- **`haulAt*` seeds from `CAMP_TILE`**, not from a numeric zero. Task 6 initialises the spawned `HaulTrip` there, but this function projects the *saved colonist* directly and never touches that component — so an idle hauler's dot sits at `(0, 0)` until the first tick moves it to `(2, 0)`. This is round eleven's spawn-path defect in the other producer, and it is the second time these two have needed the same edit (Task 9 Step 0 was the first).

`buildInitialSnapshot`'s own doc comment is the standard to hold this to: *anything derived here independently would be a second source of truth that the first tick silently overwrites.* Each bullet above is one of those.

The test reads the snapshot **before the first tick** — from a save with distinct camp and depot balances (equal balances, or a total that happens to match, would pass with one side ignored), an over-capacity depot, and an idle hauler.

- [ ] **Step 5: Store getters, mutation-checked, gates, commit.**

---

### Task 11: Tables, panel and the Economy view

No-WebGL parity — the promise made in increment 3 §1.1 and kept ever since (§2.10).

**Files:**
- Modify: `src/app/views/BuildingsView.vue`, `src/app/components/SelectionPanel.vue`, `src/app/views/EconomyView.vue`
- Test: `tests/app/views/*.test.ts`

- [ ] **Step 1:** Buildings table gains an `In` column beside `Waiting`; a storehouse row shows `held / capacity`; the state column shows `Waiting for input`.
- [ ] **Step 2:** Selection panel shows both buffers, and a storehouse's contents against capacity.
- [ ] **Step 3:** Economy view names the **input** backlog beside the output backlog it already names — units short, and how many buildings are idle waiting for them. This is the answer to "why is my bakery stopped?" and it is in scope.
- [ ] **Step 4:** A test that constructs a storehouse from the table and asserts it appears — the fallback path must be able to build the building this increment adds, or parity is a claim rather than a property.
- [ ] **Step 5:** Mutation-check each column against a neighbouring one, gates, commit.

---

### Task 12: The world view, and the renderer's line budget

**Files:**
- Create: `src/app/world/glyphs.ts`
- Modify: `src/app/world/renderer.ts`, `src/app/world/layout.ts`, `src/app/components/WorldLegend.vue`
- Modify: `docs/process/agent-workflow.md` (the no-import rule gains a third file)
- Modify: `scripts/world-smoke-harness/main.ts`, `scripts/world-smoke.mjs`

- [ ] **Step 1: Extract the glyph drawing first.** `renderer.ts` is at 445 of 500 with nothing baselined and this task adds a storehouse glyph, a fill ring and a carrying-in marker. Extract, confirm `npm run smoke:world` is unchanged, commit that alone.
- [ ] **Step 2:** Storehouse glyph with a fill ring; `storing` and `waitingForInput` state colours; a hauler carrying **in** drawn distinguishably from one carrying **out**, so flow direction reads at a glance. **Read `haulPickedUp`, not `haulKind`** — the job kind is frozen at dispatch and stops describing the cargo exactly when §2.5's round trip works: a `supply` trip carrying collected output home would be drawn backwards, and that is the headline case in acceptance criterion 2. Also draw the `fetching` phase — and note it needs no per-phase geometry at all: every leg freezes `legFrom` and `legTo` (Task 6), so one interpolation over `legProgress` places a dot in any phase. That is strictly less code than the `CAMP_ANCHOR` special-casing it replaces.
- [ ] **Step 3:** A legend entry for each of the three. The legend explains every encoding — true since increment 2, and this increment is not the exception.
- [ ] **Step 4: Smoke checks, one change per fixture phase.** A supply leg: a dot leaves a site **carrying**, reaches a building, returns. This depends on Task 10 Step 3 having published both leg endpoints — without them `haulSpot` draws every leg to and from the camp anchor, and a depot phase would look identical to a camp one, which is the kind of check that stays green with the feature absent. Nearly every smoke check has the shape `!after.equals(before)`, so a phase that moves five things at once stays true for reasons unrelated to its name (OBS-4-04). Mutation-test by disabling the feature in `renderer.ts` or `layout.ts` and confirming that named check — and only it — goes red.
- [ ] **Step 5:** `grep -cve '^\s*$' src/app/world/renderer.ts src/app/world/glyphs.ts` — both under 500. Gates, commit.

---

### Task 13: Extend the harnesses

The instruments §4 needs. A task, not an afterthought — increment 6 shipped a birth-threshold regression that only a harness caught, and the harness had to exist first.

**Files:**
- Modify: `tests/support/balance-harness.ts` (a two-stage chain; an optional storehouse)
- Modify: `tests/support/population-harness.ts` (`storehouses?: number`)
- Test: `tests/engine/balance.test.ts` (the `balance` vitest project)

- [ ] **Step 1: `Scenario` grows a second stage.** Today it measures one building. §4 q1 and q2 both need a *chain* — a forester feeding a sawmill at a distance — so the descriptor needs a second building and the result needs per-stage figures. Keep the existing single-building path working unchanged: increment 5's sweep is the control in q1, and a control that had to be rewritten is not one.
- [ ] **Step 2: `storehouses`,** placed at a scenario-specified tile. In the population harness this closes a gap increment 6 flagged and this increment widens: the harness *cannot build*, which was a conservative control there and is a distortion here, because a colony that cannot build a depot cannot play this increment.
- [ ] **Step 3: Sentinels.** `frozenSteps` must stay 0 (OBS-6-02's regression sentinel). Add a conservation sentinel while the instrument is open: **opening holdings**, plus what was made, **minus what production consumed**, minus the true sinks (eaten, and destroyed by demolition), equals total goods at the end — counting every site, every input and output buffer, and every load in a hauler's hands.

Both correction terms are load-bearing and each was a defect in an earlier draft of this step:

- **Opening holdings.** The harness seeds each scenario's resources before the run, so an equation starting from zero fails every scenario by its own starting inventory and detects nothing.
- **Recipe inputs.** `ProductionLedger` records **gross** output, so a sawmill turning one wood into one plank books a plank made while a wood disappeared. Counting production without subtracting what it consumed makes every processed unit appear twice — and §4's headline scenarios are forester→sawmill chains, so a correct run fails the sentinel on its own conversions. Subtract recipe inputs alongside gross outputs, or equivalently count only net external generation (the raw producers). This increment moves goods through four places plus a hauler's hands, and a silent leak would show up in §4's numbers as a balance problem rather than as the bug it is.
- [ ] **Step 4:** `npm run test:balance` green; timeouts explicit (these run thousands of ticks — vitest's 5s default will fail them). Gates, commit.

---

### Task 14: Measure

**Files:**
- Modify: `tests/engine/balance.test.ts`

Answer §4.1's questions with numbers. Run:

```bash
rm -rf coverage
npm run balance:report 2>&1 | tee /tmp/increment-7-report.txt
npm run balance:population 2>&1 | tee -a /tmp/increment-7-report.txt
```

- [ ] **Step 1: q1 — the gradient, both halves.** Re-run increment 5's sweep for a **raw producer** and confirm it is **unchanged**. That is the control and the more important of the two readings: a raw producer has no inputs, nothing is delivered to it, and a shift there means this increment broke something it did not intend to touch. Then measure the processor's gradient, expected to be roughly halved in reach. **If it is not halved, find out why before believing it.**
- [ ] **Step 2: q2 — does a storehouse pay for itself?** The two-stage chain at a range of distances, with and without a depot, at each hauler count. The answer wanted is a **crossover distance**: the leg beyond which 20 wood and 10 planks buys more throughput than another hauler. If the depot never wins, or wins everywhere, the storehouse is mistuned and `storehouseCapacity` or the cost is where to look first.
- [ ] **Step 3: q3 — thrash and deadlock.** A colony with a drained ledger and every building wanting inputs: confirm collection resumes rather than the colony sitting still. Report the split of hauler-ticks between the two kinds, and **how often a supply trip returns loaded** — the round trip in §2.5 is only worth its complexity if that number is not near zero. If it is near zero, say so in §4 and propose removing the mechanic rather than keeping it because it is written.
- [ ] **Step 4: the fourth reading.** Repeat increment 6's 12,000-tick chain run with and without a depot. If `birthFoodPerHead: 12` holds in both, record it beside increment 6's curve; if it does not, that is a retune this increment owns, measured the same way §4.1 of increment 6 measured its own.
- [ ] **Step 5: Re-read the two fixtures increment 6 flagged** (its §4.3): the chain test's peak against the bed count, and the housing property test's saturation. Both hold their conclusions by *margin* rather than by assertion, and this increment moves food supply against bed supply — which is precisely the change that narrows them. Re-read the printed curve, not only the green tick.
- [ ] **Step 6: Commit the measurements** (test changes only; §4 itself is Task 15).

---

### Task 15: Document and close out

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` (§4)
- Modify: `README.md`
- Modify: `docs/requirements/Two-Way Haul and Storage Buildings.md` (status), and add PBI notes for what shipped
- Modify: `docs/issues/` (any finding judged real and not fixed here)

- [ ] **Step 1: Rewrite §4** with what the harness measured, replacing "reasoning to be checked" with a measured column. A constant that moves must move because of a number in `/tmp/increment-7-report.txt`, and that number goes in the table. **"Validated, unchanged" is a legitimate answer** to any row.
- [ ] **Step 2: README.** An Increment 7 section in the voice of the existing six — what a *player* can now do, not what was implemented. Update the Documentation list with the new spec and plan paths.
- [ ] **Step 3: Backlog.** Set the Two-Way Haul feature to its shipped state and add PBI notes under it for what actually shipped, filed and parented the way every other requirement note is (`docs/README_PRODUCT_BACKLOG.md` is the contract). Anything deliberately not built stays a `New` item rather than disappearing. `docs/requirements/Construction as Work.md` already exists (written when it was descoped); roads and storehouse-to-storehouse transfer still need notes.
- [ ] **Step 4: Issues.** Anything found and judged real but not fixed gets a note, parented into the backlog. Increments 4, 5 and 6 each found several; finding none would be the surprising outcome, not the good one.
- [ ] **Step 5: Final gates**

```bash
rm -rf coverage && npm run check:all && npm run smoke:world
for f in src/engine/world.ts src/app/world/renderer.ts src/engine/snapshot-builder.ts \
         src/engine/systems/command-handlers.ts src/engine/resources.ts src/shared/save.ts; do
  printf "%-50s %s\n" "$f" "$(grep -cve '^\s*$' $f)"
done
git diff --stat scripts/loc-baseline.json scripts/quality-baseline.json   # expect NO changes
```

The last line is the important one: if a baseline moved, find out why before shipping.

- [ ] **Step 6: Commit and open the PR.**

---

## Notes for the implementer

- **Push back rather than guess.** Roughly half of increment 4's task briefs contained an error — a helper that did not exist, a wrong expected value, a parameter that would have corrupted eight call sites. Implementers caught them only because they were told to. **If a brief here disagrees with the code, the code wins: say so.**
- **Task 2's promise is testable and load-bearing: no existing caller changes.** If making the ledger multi-site requires editing `HungerSystem`, `handleConstructBuilding`, `colonyWealth`, `StatsSystem` or their tests, the aggregate API has leaked and the design has gone wrong. Stop and say so rather than editing the callers.
- **Task 3 has the widest blast radius.** Every fixture that seeded a stockpile to make a processing building run now seeds an input buffer. Let `npm test` enumerate them. Read each as you go: a test that was *about* the stockpile draining is telling you something, and its assertion may need to move rather than its fixture.
- **Conservation is the invariant most at risk.** Goods now live in four places plus a hauler's hands. Every cancellation path must put a carried load somewhere: demolition of the target, `unassignHauler`, the "building gone" branch, and save-time. Prefer asserting on a colony-wide total over asserting on the field you just wrote — the total is the property a player would notice being violated, and it is the one a future refactor cannot accidentally satisfy.
- **`refundAt` vs `addAt` is not a style choice.** `producedThisTick` is what `StatsSystem` publishes as `Delivered/t`; anything banked that a hauler did not actually deliver must not inflate it. That distinction already caught one bug (OBS-4-06) and this increment triples the number of sites that bank goods. The hard case is the one the trip has to carry a flag for: a hauler walking home with six flour is either delivering goods the ledger never counted or carrying back a supply remainder the colony already owned, and **the load itself cannot tell you which** — hence `pickedUp`. Read spec §2.4's table before writing any banking call; every row of it is a bug someone would otherwise ship.
- **Do not reorder the systems to close the one-tick input delay** (§2.8). Putting haulage before production moves the tick from the input side to the output side; it does not remove it.
- **`OutputBuffer.fullestResource` and `InputBuffer.shortestOf` are opposites and must stay opposite.** Both take catalog order as an argument for the same reason — determinism that does not depend on `Map` insertion order — and both are read by the engine's authoritative choice *and* by anything that previews it.
- **Timeouts:** balance and population scenarios run thousands of ticks through the full system set. Explicit `120000` / `180000` timeouts are required; vitest's 5s default will fail them.
- **If §4 q3 says the round trip almost never returns loaded, delete the mechanic.** A measurement that argues against a design decision is the point of measuring. Increment 6 moved a shipped constant on exactly that basis, and its spec says why at length.
