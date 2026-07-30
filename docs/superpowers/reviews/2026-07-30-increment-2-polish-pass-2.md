# Review: Increment 2 — polish pass 2 (UX/UI & economy)

**Date:** 2026-07-30
**Scope:** PR #4 after the first polish pass and Codex rounds 3–4. Directed
focus: UX/UI and economy. Deliberately avoids the UX cheap-wins reserved for
increment 1.5 (success notices, humanized labels, table hunger coloring,
starter hint) to stay conflict-free with PR #3.

## Shipped in this pass

| # | Item | Where |
|---|------|-------|
| 1 | **World hover inspection** — `pick()` on the renderer seam (live camera → tile space → pure `pickAt`), DOM tooltip with building staffing/state/batch or worker efficiency/hunger/tool | `layout.ts`, `renderer-key.ts`, `renderer.ts`, `WorldView.vue` |
| 2 | **Encoding legend** under the canvas (state rings, worker colors, tool ring, progress bar, camp tent), colored from the same resolved theme | `WorldView.vue`, `styles.css` |
| 3 | **Resource runway** — `runways` store getter (`ceil(stock / -netFlow)`), an "Empties in" column on Dashboard (warning ≤ 30t) and per-chain-output on Economy | `game-store.ts`, `DashboardView.vue`, `EconomyView.vue` |
| 4 | **Bottleneck surfacing** — `staffingByDef` getter; per-stage Status (`not built` / `unstaffed` / `⚠ starved` / `ok`) with starved rows tinted; starvation is the engine's own `waitingForInput` truth | `game-store.ts`, `EconomyView.vue` |
| 5 | **Codex round 5a**: overflow slots now take unique van-der-Corput shelf spots — an 11-workers-at-2-slots grandfathered save gets 11 distinct, contained positions (was: y-clamp collisions) | `layout.ts` |
| 6 | **Codex round 5b**: async engine-boot rejections no longer escape the seam — `onFatal` notifies the view (same fallback UI); clock ops serialize behind the boot promise so fast tab switches / closes cannot race it | `renderer.ts`, `renderer-key.ts`, `WorldView.vue` |
| 7 | Smoke test gained an end-to-end `pick()` probe: a 40×26 page-coordinate grid resolved through the live camera finds buildings, workers, and empty ground | `scripts/world-smoke*` |

## Structural cleanups the floor demanded

Growing the app layer dragged the fallow maintainability average (fan-out
penalties on views importing store + several catalog modules). Holding the
locked 90.6 floor honestly forced consolidations that are improvements in
their own right:

- **Content barrel** `src/engine/content/index.ts` — the app layer imports
  the catalog through one surface (engine internals keep direct imports).
- `describePick` (tooltip lines) lives with `pickAt` in the pure layout
  module, not in the view.
- `stageStatuses` joined `staffingByDef`/`runways` as store getters; the
  EconomyView precomputes flat display rows, keeping its template to plain
  interpolation.
- The legend is a self-contained `WorldLegend.vue` that resolves the theme
  against its own element.

## Verification

- 175 unit tests green (new: pick hit-testing, overflow uniqueness at 11/2,
  runway/staffing/status getters, tooltip + legend + async-fatal component
  tests, EconomyView/DashboardView column tests).
- `npm run check:all` green end to end; maintainability floor holds at the
  locked 90.6 with every other counter at zero.
- `npm run smoke:world` green (9 assertions, including the pick probe).

## Deliberately not done

- Canvas *commands* (click to build/assign) — increment 3's interaction
  model, arriving with real player-driven placement.
- Chain throughput math beyond the engine's own signals (no predicted
  equilibrium rates) — worth designing when trade (increment 4 of the PRD
  roadmap) changes what "enough" means.
- Balance/content changes — increment 3 territory per the 1.5 spec.
