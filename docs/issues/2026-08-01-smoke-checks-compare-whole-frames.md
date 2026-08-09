---
id: OBS-4-04
title: Smoke checks compare whole frames while fixtures change many things at once
status: Done
severity: minor
area: world
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 Task 14 review
affects:
  - scripts/world-smoke.mjs
  - scripts/world-smoke-harness/main.ts
tags:
  - test-validity
  - rendering
type: Issue
parent: "[[Logistics]]"
order: 90
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Smoke checks compare whole frames while fixtures change many things at once

`npm run smoke:world` is the **only** thing that exercises the real Excalibur
renderer — Excalibur throws on import outside a browser, so no vitest test can
touch it. That makes the strength of these checks unusually load-bearing.

Nearly every check has the shape `check('…', !after.equals(before))`: a
full-frame screenshot compared for inequality. Combined with fixtures that
change several things between phases, a check can pass while the specific
feature it names is broken.

## Evidence

The two haul checks added in increment 4 are the clearest case.

Between `moved` and `outbound`, the fixture simultaneously removes building 3,
resets building 2 to `unstaffed`, drops worker 10's `toolTicks` override and
worker 11's `efficiency` override, **and** reassigns worker 12 to hauling.
Between `outbound` and `delivered`, worker 12 changes position, gains a tool
ring, **and** gains a load marker.

So a regression that broke only the hauler-specific rendering — `placeHaulers`
routing, or the `carrying` load-marker toggle — would still leave enough other
pixels different to keep `!x.equals(y)` true. The check named "the hauler
returns to camp carrying its load" would stay green with the load marker
entirely absent.

This is not specific to the new checks; it is the suite's general philosophy.
The new ones simply made it visible.

## What already works well and should be kept

Two existing checks do not have this weakness and are worth preserving as
patterns:

- `stop() halts rendering (frames frozen despite new sync)` asserts frames are
  **equal** while state changes — an equality assertion cannot pass by accident.
- The `__probe()` grid samples `renderer.pick` across page coordinates and
  counts what it hits, which is a semantic assertion rather than a pixel diff.

## Proposed fix

Two independent improvements:

1. **Change one thing per phase.** A phase that only reassigns worker 12 makes
   the following check mean what its name says. Where a phase must change
   several things, say so in its name.
2. **Assert on regions or semantics, not whole frames.** Clipping the screenshot
   to the area around the hauler, or extending the `__probe()` idea to report
   what is drawn where, would let a check fail for the reason it claims.

Neither needs doing at once — but the fixture design should not be extended
further in its current shape, because each added phase makes the coupling
harder to unpick.

## Resolution

Took improvement 1 — **change one thing per phase** — which turned out to be
sufficient for the case this note calls out, and made improvement 2 unnecessary
there. The isolation now comes from the fixture rather than from clipping the
screenshot, so the checks stay whole-frame comparisons and still fail only for
the reason they name.

The two haul phases became four, driven by one `haulScene(tick, hauler)` helper
that holds the buildings and the other two workers **identical** across all of
them. Only worker 12 differs, one field at a time:

| phase | worker 12 | the check it enables |
| --- | --- | --- |
| 6 | idle at camp, tooled | baseline |
| 7 | `+ hauling, haulTargetId: 1` | a dispatched hauler is drawn at its target |
| 8 | `+ hauling` (walking home, empty) | walking home differs from walking out |
| 9 | `+ carrying: 6` | **the load marker specifically** |

Worker 12 is tooled in every phase, so the tool ring and the load marker are
still drawn on the same worker in phase 9 — the coverage the old fixture wanted
— without the ring being part of what changes. Ticks strictly increase because a
sync at the same or an earlier tick is a colony reset by design, which would
have wiped the scene between phases.

### The note's claim, tested

This note asserts that the check named "the hauler returns to camp carrying its
load" *would stay green with the load marker entirely absent*. That was verified
directly rather than taken on trust: setting `bundle.load.graphics.visible =
false` in `renderer.ts` leaves all 17 old checks green, and fails exactly one of
the new ones — `the load marker is drawn on a carrying hauler`.

The converse holds too. Making `placeHaulers` route nobody fails both routing
checks and leaves the load-marker check green, because the marker does not
depend on routing. The three checks now discriminate between the two features
they cover.

### What was deliberately not done

Improvement 2 (region-clipped or semantic assertions) is **not** implemented.
With one change per phase the whole-frame comparison is already specific, and a
pixel clip would have added geometry that has to track the camera transform.
The suite's two existing strong patterns are untouched and still worth copying:
the `stop()` check asserts frames are **equal** while state changes, and
`__probe()` samples `renderer.pick` semantically.

The rest of the suite was reviewed and left alone. `a moved building is drawn at
its new tile` was already built for isolation ("no worker motion to hide
behind"), and the remaining comparisons are against a blank canvas or claim the
conjunction they test (`start() resumes and draws`). The haul phases were the
outlier, not the norm.

The fixture rule — one change per phase, and say so in the name when a phase
must change several things — is recorded in `docs/process/agent-workflow.md` so
the next phase added follows it.
