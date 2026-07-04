# Increment 1 (Economy Core) — Multi-Perspective Review

**Date:** 2026-07-03
**Scope:** Everything on PR #2 at commit `15085a6` (engine, UI, Obsidian shell, quality gates), reviewed AFTER the per-task reviews and the final whole-branch correctness review had passed. Six independent reviewers, each with a distinct lens; game-balance and performance claims verified by headless simulation, test-suite strength by hand-run mutation testing.

## Verdict at a glance

| Perspective | Verdict |
|---|---|
| Game design & balance | Mechanically green, **strategically amber** — chains work, but the economy is flat: no scarcity, dominant strategies, hunger nearly inert |
| Architecture & roadmap readiness | **Strong** — layering is real and machine-enforced; three seams need attention before/during increment 2 |
| Security & marketplace | **Low-to-medium risk, marketplace-ready** — no injection/eval/network; one DoS-shaped gap (unbounded save arrays) |
| Performance & memory | **No concern at any realistic scale** — 0.12–0.14 ms/tick at increment-1 size; tick budget crossover ≈ 60–70k workers; the real ceiling is unvirtualized DOM tables |
| Player UX | Solid table foundation, **not survivable for a new player** — zero onboarding, invisible success feedback, hunger reads backwards |
| Test-suite quality | **Strong, not just green** — 7/10 hand-run mutations killed; the 3 survivors are precisely characterized with the assertions that would kill them |

The engineering layers (architecture, security, performance, tests) are in good-to-excellent shape. The gaps concentrate exactly where an economy-core increment would predict: the *game* (balance) and the *player* (UX) — now quantified rather than assumed.

## Key findings per perspective

### 1. Game design & balance (verified by simulation)
- **Bread is dominated by berries as food, ~2.4×** (4.17 vs 10.05 hunger-points per worker-tick). Feeding 100 population costs ~22 bread-chain workers vs ~10 gatherers. The "best food" is really a wealth product mislabeled.
- **Tools are a no-decision auto-include**: ~15× ROI, whole-workforce tooling costs <4% of labor. The workshop even self-catalyzes by tooling its own workers.
- **No sink or scarcity after the opening**: wood is created from nothing, nothing decays; wealth is unbounded and monotonic, and idle wood-hoarding is a valid risk-free strategy.
- **Farm is mis-sized** (4 slots vs the chain's 2-worker absorption; the bakery is the true ceiling at 0.5 bread/tick).
- Pacing: first bread ≈ 2.4 min, first tool ≈ 2.9 min at 1× — brisk. Hunger soft-pressure only ever slows (floor 0.2, no death); the recruit cooldown never actually couples to food.
- **Increment-2 recommendations:** add a genuine sink/scarcity (finite forest, upkeep, or spoilage); reposition food so bread wins past a population threshold; give tools an opportunity cost; retune farm slots; gate recruiting on food/housing.

### 2. Architecture & increment-2 readiness
- Layering (shared ← engine / app / shell) is genuinely enforced (fallow zones + lint twins); the engine is headless for real; sim-ecs is fully contained behind the facade. Worker *removal* (aging/death) is absorbed better than feared — ids are monotonic, save indices are recomputed per serialize. One unwritten invariant for the first `removeEntity`: clear dangling `JobAssignment.buildingId`.
- **Riskiest seams:** (1) `SaveGameV1` has version scaffolding but **no migration machinery** — bumping to v2 would route every live save to the corrupt-backup path (data loss); (2) entity-fact gathering exists in three places (SnapshotSystem, refreshEntitySections, buildInitialSnapshot) — every new worker field is a 3-site edit; (3) `BALANCE` as a frozen module singleton blocks per-save difficulty later.
- **Pre-increment-2 refactors worth doing:** introduce the save-migration seam while there is exactly one version; collapse fact-gathering to one source (post-step refresh makes SnapshotSystem's entity work redundant); generalize meal selection with `hungerRestore` on `ResourceDef` (unblocks food variety and fixes the store's hardcoded lowFood).

### 3. Security & marketplace robustness
- **Clean on all injection axes:** no v-html/innerHTML/eval/new Function anywhere; zero network calls; prototype-pollution attempt via `__proto__` stockpile keys tested and rejected (`Object.hasOwn` catalog checks); unknown save fields are purged on the next autosave (save is rebuilt, never spread).
- **Medium:** save guards never cap array lengths — a multi-million-entry hostile `data.json` freezes the renderer during entity spawning (measured 300k workers → 1.9 s, linear). Add a sanity cap (e.g. max workers/buildings) to `isLoadableSave`.
- **Low:** `CommandQueue.pending` is unbounded while paused (UI buttons stay enabled when paused).
- Marketplace checklist passes: view lifecycle, no `!important` (CI-gated), manifest/version sync gate, dev/runtime deps separated, lockfile + `npm ci` reproducibility.

### 4. Performance & memory (measured)
- 0.12–0.14 ms/tick at ≤50 entities; 1.1 ms at 500 workers; 5.8 ms at 5,000 — the 125 ms budget (8 ticks/s) crosses over only around 60–70k workers.
- Re-entrancy guard degrades gracefully under overload (ticks drop, counter stays honest). No leaks across open/close (WeakMap registry confirmed weak; store dereferenced on unmount). All buffers bounded.
- **Waste found:** `refreshEntitySections` re-runs the full entity aggregation every tick even when no command created entities — gate it on "did this tick create/remove entities". The eventual scaling ceiling is the unvirtualized Buildings/Population tables, not the sim.

### 5. Player UX
- Good bones: semantic tables, sensible tab split, disabled-with-reason buttons, persistent low-food warning.
- **Top friction:** sim auto-starts with zero onboarding (nothing says "build a forester"); successful commands produce no feedback (NoticeBoard only carries rejections); hunger (higher=worse) sits unstyled next to efficiency (higher=better); per-worker starvation is only visible on the least-visited tab; reset is one Enter-dismissible confirm away from wiping the colony.
- **Cheap wins:** success notices through the existing channel; sentence-case the state enums and color the hunger cell past the meal threshold; a one-line starter hint on the empty Buildings view.

### 6. Test-suite quality (hand-run mutation testing)
- **7/10 mutations killed** — all seven were arithmetic thresholds, guard comparisons, and state-machine branches, the highest-value categories.
- **3 survivors** (all invisible to line coverage, all "assertion already true independent of the mechanism"): the hunger meal-threshold gate (no test with a well-fed worker + food in stock); `buildSaveFromWorld`'s sorts (iteration order happens to match id order in every test); `flush()`'s settle await (never exercised with a genuinely in-flight tick). The exact killer assertions are specified in the full report.

## Convergent findings (independent reviewers, same spot)

1. **Entity-fact gathering consolidation** — architecture (3-site edit risk) and performance (redundant per-tick recompute) point at the same refactor; doing it once fixes both.
2. **Unvirtualized tables** — flagged by both performance (scaling ceiling) and security (render-DoS amplifier).
3. **Hunger mechanic** — UX (legibility trap) and balance (nearly inert pressure) both mark it as increment 2's most important redesign.
4. **The load path** — security's array cap and architecture's migration seam both land in `isLoadableSave`/`loadSave`; one hardening pass covers both.

## Prioritized actions

**Before or at the start of increment 2 (small, high-value):**
1. Save-migration seam (discriminated union + identity `migrate()`) — cheap now, data-loss-shaped later.
2. Array-length caps in the save guard (security M1).
3. The three killer tests for the survived mutations.
4. Consolidate entity-fact gathering to one source (+ gate the post-step refresh on entity-creating ticks).
5. UX cheap-wins batch: success notices, humanized state labels, hunger coloring, starter hint (folds into the existing UI-polish ticket).

**Into increment 2's design (not code fixes — design decisions):**
6. Economy sinks/scarcity; food repositioning (berries cap / bread economics); tools opportunity cost; farm sizing; food-coupled recruiting.
7. Meal-selection generalization via `hungerRestore` on `ResourceDef`.

**Later (when the trigger arrives):**
8. Table virtualization (before any entity-cap increase); command-registry pattern (when the Command union grows); `BALANCE` as injected world resource (increment 5 difficulty); onboarding flow (when there's a tutorial to point at).

*Full per-perspective reports (with methodology, measurements, and file:line evidence) were produced as working artifacts in the session's scratch space; this document preserves the durable findings.*
