---
id: OBS-4-09
title: The hauler dot animates at a fixed speed unrelated to the trip's simulated duration
status: open
severity: important
area: world
increment: 4
created: 2026-08-01
source: Codex review on PR #6 (P1), arithmetic verified against the code
affects:
  - src/app/world/renderer.ts
  - src/app/world/layout.ts
tags:
  - issue
  - rendering
  - game-feel
  - needs-design
---

# The hauler dot animates at a fixed speed unrelated to the trip

The simulation gives a haul trip an explicit duration in ticks. The renderer
does not know about it: `renderer.ts:264` moves every worker actor toward its
target with `actions.moveTo(target, WORKER_SPEED)`, a constant pixels-per-second
walk. The two clocks therefore disagree, and the faster the game runs the worse
it gets.

## The arithmetic

Verified against the code, not estimated:

| | value | source |
| --- | --- | --- |
| tick rate at 1× | 2 ticks/s | `BALANCE.baseTicksPerSecond` |
| haul speed | 2 tiles/tick | `BALANCE.haulTilesPerTick` |
| **simulated travel** | **4 tiles/s** | product of the two |
| worker actor speed | 90 px/s | `renderer.ts:23` `WORKER_SPEED` |
| tile size | 48 px | `layout.ts:5` `TILE` |
| **animated travel** | **1.875 tiles/s** | 90 / 48 |

The simulation moves a hauler **more than twice as fast as the dot does** at 1×,
and the gap scales with game speed — `intervalMs = 1000 / (baseTicksPerSecond *
speed)`, so at 4× the simulation is over eight times faster than the animation.

## Failure scenario

A forester at the far corner `(23, 15)` is 13 ticks from camp each way.

1. A hauler dispatches. The sim will have it arrive in 13 ticks — **6.5 seconds**
   at 1×.
2. The dot has 25.8 tiles to cover at 1.875 tiles/s — **13.8 seconds**.
3. At t = 6.5 s the trip flips to `returning`. `snapshot-builder.ts` stops
   publishing `haulTargetId`, `placeHaulers` falls through to the camp position,
   and the dot **reverses direction from wherever it happens to be** — roughly
   halfway across the map, having never reached the building.
4. At t = 13 s the sim deposits the load into the stockpile. The dot is still
   walking home and arrives several seconds later.

So the goods are banked before the carrier visibly arrives, and the trip that
acceptance criterion 2 says must be visible as "a dot leaving and returning" is
visible as a dot turning round in open ground.

## Why it only surfaced now

Ordinary worker reassignment has the same fixed-speed animation, and it is
harmless there: the simulation treats reassignment as instantaneous, so the walk
is pure decoration and any duration looks plausible. Haulers are the first
entity whose travel has a *simulated* duration, which is what turns a cosmetic
choice into a contradiction.

## Why this is not a small fix

The renderer would need the trip's remaining tick budget and the current game
speed to compute a per-move velocity — either passed through `WorldLayout` or
read from the store — and then decide what happens when the player changes
speed mid-walk, or when a trip is retargeted by a building move. `moveTo`'s
fixed-speed contract does not express "arrive in exactly N seconds"; that wants
`easeTo`/a duration-based action, or per-frame interpolation driven by
`ticksLeft`.

There is a cheaper partial: retune `WORKER_SPEED` so 1× roughly matches (4
tiles/s ≈ 192 px/s). That removes the reversal at 1× and leaves it at 2× and 4×,
and it speeds up every other worker walk as a side effect. Worth measuring
before adopting — it may look frantic.

Left for a design pass rather than patched on the branch that found it.
