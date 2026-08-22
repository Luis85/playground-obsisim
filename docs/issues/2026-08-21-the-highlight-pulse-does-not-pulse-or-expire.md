---
id: OBS-11-02
title: setHighlight draws a fixed-opacity rectangle that never animates or expires, though the function is named highlightPulse
status: Open
severity: minor
area: app
increment: 11
created: 2026-08-21
source: increment-11 Task 13 (visual language) — an automated PR reviewer flagged glyphs.ts's highlightPulse as a static rectangle against spec §2.3's "a transient pulse" language; recorded rather than fixed because renderer.ts is verifiable only through the fixed-index smoke harness, and animating it risks exactly the kind of timing-dependent flakiness that harness is not built to absorb
affects:
  - src/app/world/glyphs.ts
  - src/app/world/renderer.ts
  - scripts/world-smoke.mjs
type: Issue
parent: "[[Excalibur World View]]"
order: 360
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# The highlight pulse does not pulse or expire

## What happens

`glyphs.ts`'s `highlightPulse(theme)` draws a single `Rectangle` at a fixed
35% opacity:

```ts
export function highlightPulse(theme: WorldTheme): Actor {
  const pulse = new Actor({ z: 2 });
  pulse.graphics.use(new Rectangle({ width: TILE * 1.1, height: TILE * 1.1, color: Color.fromHex(theme.accent) }));
  pulse.graphics.opacity = 0.35;
  return pulse;
}
```

It never changes opacity, never grows or shrinks, and never expires on its
own — it is drawn once per `setHighlight(subjects)` call and stays exactly as
drawn until `renderer.ts`'s `WorldScene` kills it (either the next
`setHighlight` call, per `renderer.ts` line ~222, or a colony reset). The
function's own name promises motion the implementation does not have.

## Why this was flagged, and why it is arguable

Spec §2.3 introduces the plural highlight as "a transient pulse over a set,
with no selection and no Inspector." An automated PR reviewer read
"transient pulse" as "must fade or expire over time" and flagged the static
rectangle as an unmet requirement.

That reading is not the only one the spec text supports, and `renderer.ts`
already has a comment (line ~217) making the other one explicit:

> "id: a highlight is a transient reaction to one panel click, not a tracked
> [entity] — ..."

That comment glosses "transient" as *not tracked by id across syncs* — a
highlight redraws fresh from the current subject list on every
`setHighlight` call rather than following a building or colonist around by
id the way a selection ring does. Under that reading, the current
implementation already satisfies "transient": nothing about it claims the
rectangle also has to move, breathe, or self-expire.

Spec §2.9 separately names exactly three motion transitions this increment
owes — dock panel enter/leave, attention row appear, vitals value-change
flash — all CSS, all in `styles.css`, all gated on
`prefers-reduced-motion`. The highlight pulse is a **canvas** concern
(Excalibur, not CSS) and is not one of the three. Nothing in the acceptance
criteria (§3) mentions it either.

## Why it was not changed in Task 13

Two reasons, not one:

1. **The textual case above.** "Transient" already has a documented meaning
   in this codebase that the current code satisfies; treating the reviewer's
   alternative reading as authoritative would be picking one interpretation
   over another that the file itself argues for, not fixing a clear defect.
2. **The verification cost is real and the wrong shape for this task.**
   `renderer.ts` is excluded from `tests/app/` by design (spec §2.5 — it
   touches `window` at module scope and is slow under happy-dom) and is
   verified ONLY by `npm run smoke:world`, whose checks are fixed-index
   phases with 300ms fixed waits and byte-exact screenshot comparisons
   (`scripts/world-smoke.mjs`, phases 40-42 exercise this exact pulse today).
   A self-expiring pulse driven by wall-clock time is precisely the kind of
   change that harness cannot absorb without becoming flaky: a pulse that
   has already faded out by the time a fixed 300ms `shot()` runs would make
   "the pulse moved to a colonist" (phase 41) and "the pulse clears" (phase
   42) indistinguishable by accident, on a schedule that depends on exact
   frame timing rather than on `setHighlight` actually being called with an
   empty set. A bounded, non-expiring "breathing" animation (opacity
   oscillating but never reaching the same value as "no pulse") would avoid
   that specific trap, but still needs a NEW smoke phase and comparison to
   prove it animates at all, and shifts every fixed step index after it —
   including the final `dispose()` check at what is today step 43. That is a
   real, isolated piece of work, not a two-line fix, and Task 13's stated
   priority was the layout gap (`.obsisim-world-screen`'s missing grid,
   `.is-overlay`'s missing overlay CSS), which this file left for months
   with zero rules at all.

## What would resolve this

Either:

- **Decide "transient" was never about self-expiry** and rename
  `highlightPulse` to something that does not promise motion (`highlightMark`,
  `highlightRing`), closing this issue by adjusting the name to the
  behaviour rather than the other way around; or
- **Give it a bounded, non-expiring animation** (an opacity or scale
  oscillation via Excalibur's action API, replayed forever until
  `setHighlight` clears it) — genuinely animated, never reaching a state a
  fixed-wait screenshot could mistake for "cleared" — and extend
  `scripts/world-smoke.mjs` with a phase that samples the SAME highlighted
  frame twice at different fixed delays and asserts they differ (proving
  motion) without touching the existing clear/move phase indices.

Either is a small, scoped follow-up; this issue exists so the decision made
in Task 13 (defer) is recorded rather than silently dropped.
