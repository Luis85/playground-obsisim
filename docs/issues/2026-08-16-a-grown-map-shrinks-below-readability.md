---
id: OBS-11-01
title: A map grown past DEFAULT_MAP fits by shrinking tiles toward unreadability, and increment 11 makes that canvas the primary control surface
status: Open
severity: important
area: app
increment: 11
created: 2026-08-16
source: increment-11 spec review — found while checking the spec's claim that "the map is a fixed 24×16", which is false; recorded rather than fixed because a usable answer is four coupled pieces, none of them unit-testable
affects:
  - src/app/world/renderer.ts
  - scripts/world-smoke-harness
type: Issue
parent: "[[Excalibur World View]]"
order: 350
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A grown map shrinks below readability

## What happens

`DEFAULT_MAP` is 24×16, but the map is **not** fixed at that size. `placement.ts`
admits `MIN_MAP` 8×6 through `MAX_MAP` 256×256, `save.ts` persists the size and
validates it against those bounds, and `mapThatFits`/`grownMap` deliberately
grow a migrated colony's map past the default when its buildings will not fit.

`fitCamera` (`renderer.ts`) fits whatever it is given:

```ts
camera.zoom = Math.min(width / worldW, height / worldH) * 0.95;
```

There is no lower bound. On a grown map in a narrow pane — ObsiSim is an
Obsidian `ItemView` and can be dragged into a sidebar — the whole map is fitted
by making each tile small enough that buildings, state rings, colonist dots and
stage marks stop being distinguishable.

## Why it matters more after increment 11

This behaviour is unchanged and has been there since increment 3 gave the map a
size at all. What changes is the stake: through increment 10 the canvas was one
tab of five and every decision had a table behind it, so an unreadable canvas
cost legibility. Increment 11 makes the canvas the primary control surface and
demotes the tables to a fallback, so an unreadable canvas costs playability.

## Why it is not fixed in increment 11

The increment 11 spec §2.1 carried a fix through three review rounds and each
one was wrong in a different way, which is the actual argument for splitting it
out. A usable answer needs four coupled pieces:

1. **A zoom floor** — stop fitting below a minimum readable tile size.
2. **A camera that survives `sync()`** — `WorldScene.sync()` calls `fitCamera`
   unconditionally and it rewrites `camera.pos` as well as `camera.zoom`, so at
   two ticks a second any camera position is discarded within half a second.
   Refitting has to become conditional on the map or viewport actually changing.
3. **Drag-to-pan with a movement threshold**, so a drag pans and a click still
   selects or places. A DOM scroll container is *not* an alternative: the engine
   is built with `DisplayMode.FillContainer`, so the canvas is always exactly
   the host's size and clamping zoom crops rather than making the host taller.
4. **A decision about plural focus** — a panel row that names a set (an Economy
   stage, a multi-colonist Attention row) has no single subject to centre on,
   and framing the whole set would mean zooming below the floor point 1 exists
   to enforce.

None of it is unit-testable. `renderer.ts` touches `window` at module scope and
takes seconds to evaluate under happy-dom, so `tests/app/` never imports it —
every app test drives an injected fake. All four pieces would be verified by
`npm run smoke:world` alone, which means the work also has to extend that
harness.

## What increment 11 does instead

Nothing. `fitCamera` is left exactly as it is, so a grown map behaves on the
world screen precisely as it behaves on today's world tab — no better, no worse,
and no regression. "Focus this building" from a panel row is a highlight pulse
rather than a camera move, which is the entire correct behaviour on a
default-map colony, where the whole map is on screen anyway.

## Who actually hits this

Only a colony whose map has been grown, and nothing at runtime grows one: no
command changes the map size, so `grownMap` and `mapThatFits` are reached from
**save migration** alone — a v1 save with more buildings than the default layout
can seat. A colony started on any recent version stays at `DEFAULT_MAP` forever
and never meets this.

That is what makes deferring it defensible rather than merely convenient, and it
is also why the fix should be measured against a real migrated save rather than
against a hand-written oversized fixture.
