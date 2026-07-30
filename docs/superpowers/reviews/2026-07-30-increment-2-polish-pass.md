# Review: Increment 2 (Excalibur World View) — polish pass

**Date:** 2026-07-30
**Scope:** PR #4 as pushed after two Codex review rounds. This pass re-read
the increment with fresh eyes, verified the renderer in a real browser, and
applied the fixes below in the same PR.

## What was examined

1. The full increment diff (`git diff origin/main`) — layout/theme/renderer
   modules, WorldView, wiring, gates, docs.
2. Consistency of the layout's stability guarantees after the id-keyed slot
   fix from the review round.
3. The renderer's actual behavior in a browser — previously verified only by
   the type checker, since unit tests cannot construct a canvas runtime.
4. Gate docs (`docs/build-ci/quality-gates.md`) for statements invalidated
   by this increment (none — the baseline snippet there is explicitly
   historical, "at Task 18 adoption").

## Findings and actions

| # | Finding | Action |
|---|---------|--------|
| 1 | **Camp spots had the same instability the review flagged for buildings**: idle placement was rank-based, so any colleague heading to work reshuffled every camper — inconsistent with the id-keyed fix shipped for building slots. | `stableSlots()` extracted and shared; camp spots are now id-keyed with a stretching span (`CAMP_MIN_SPOTS`). New regression test: a worker going idle leaves existing campers in place. |
| 2 | **Renderer verified only by types.** The one untested module was the one holding a real WebGL engine. | New optional browser smoke test (`npm run smoke:world`): builds a harness with vite, drives the real adapter in Chromium via playwright-core, and asserts on screenshots — boots and draws, walk animation runs, `stop()` freezes frames even while syncs continue, `start()` resumes, `dispose()` clean, zero page errors. All eight assertions pass. |
| 3 | **Progress fill was green-on-green** (seen in the smoke screenshot): a producing forester at 90% read as an empty track. | Dedicated `progressFill` theme color (bright cream) plus a dark track behind the fill. |
| 4 | **Idle camp read as bare grass** — spec calls it a camp. | Tent marker (`⛺`) anchored at the camp, position exported by the layout (`WorldLayout.camp`). |

## Deliberately not changed

- Sync-while-hidden (the store watcher keeps diffing the scene while the tab
  is deactivated): ~30 entities at ≤ 8/s of pure JS with the render clock
  stopped — measurable cost only in theory; revisit if colonies grow orders
  of magnitude.
- The plan document is left as authored; as-built deviations are recorded in
  its Execution Notes.

## Addendum (same pass, after Codex rounds 3 and 4)

The span-stretch residual first listed as accepted (span changes reshuffling
workers whose assignments did not change) was correctly re-flagged by review:
crossing the camp's baseline capacity is an ordinary state, not an edge. A
first fix made the *scene* sticky (park while the post is unchanged), but
round 4 found its flaw — a memoryless layout can hand an arrival a slot a
parked bystander already occupies, stacking two actors permanently.

Root cause, both rounds: allocation had no memory while the display did.
Final design inverts that — the memory lives in the layout, explicitly:
`layoutWorld(snapshot, previous?)` keeps every same-post worker on the exact
slot it held and allocates newcomers only into free slots; positions are
pure functions of (post, slot), never of roster size (over-capacity slots
wrap into a second row inside the cell). The renderer is memoryless again
and simply follows targets, feeding each layout back as the next
`previous`. All three review scenarios are named regression tests
(arrival-collision, over-capacity shrink, camp-baseline crossing), plus a
fixpoint test (`layoutWorld(s, layoutWorld(s)) === layoutWorld(s)`).

## Verification

- `npm run check:all` green end to end after the pass (lint, LOC, CSS,
  quality ratchet incl. the 90.5 maintainability floor, typecheck, tests,
  build, artifact budgets).
- `npm run smoke:world` green (8/8 assertions) against the final visuals.
