---
id: OBS-4-04
title: Smoke checks compare whole frames while fixtures change many things at once
status: open
severity: minor
area: world
increment: 4
created: 2026-08-01
source: increment-4 Task 14 review
affects:
  - scripts/world-smoke.mjs
  - scripts/world-smoke-harness/main.ts
tags:
  - issue
  - test-validity
  - rendering
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
