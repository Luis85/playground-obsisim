---
id: OBS-4-09
title: The hauler dot animates at a fixed speed unrelated to the trip's simulated duration
status: resolved
severity: important
area: world
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: Codex review on PR
affects:
  - src/shared/haul.ts
  - src/shared/snapshot.ts
  - src/engine/snapshot-builder.ts
  - src/app/world/layout.ts
  - src/app/world/renderer.ts
tags:
  - rendering
  - game-feel
  - needs-design
type: Issue
order: 40
started: ""
finished: ""
horizon: ""
start: ""
due: ""
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

## Resolution

Took the duration-driven fix, with the arithmetic in `layout.ts` rather than in
the renderer. The dot's position is now **derived from the trip's own remaining
ticks**, so the two clocks are identical by construction at every game speed —
there is no speed to keep in step, and the 8x divergence at 4x cannot recur.

### What moved

- `src/shared/haul.ts` gains `HaulPhase` (it lived on the engine's `HaulTrip`,
  and the snapshot cannot import the engine) and `legProgress(ticksLeft,
  totalTicks)` → 0..1, clamped.
- `WorkerSnapshot` gains `haulPhase` and `haulTicksLeft`, and **`haulTargetId`
  is now published on both legs**. Increment 4 published it outbound-only and
  nulled it on the way home, which is half of why the dot turned round in open
  ground: the layout had no idea which building a returning hauler was walking
  back *from*. `trip.targetId` already survived the phase flip; only
  `trip.reset()` clears it.
- `layout.ts` interpolates along the camp↔building line, recomputing the leg's
  length with the same `haulTicks` the simulation charged, so the drawn walk and
  the cost model describe one journey. `PlacedWorker` gains `travelling`.
- `renderer.ts` walks a `travelling` worker at whatever pace covers the step
  before the next sync, instead of a fixed 90 px/s. A reassignment walk is
  unchanged — it is instantaneous in the simulation, so its pace is decoration.

The three new snapshot fields are runtime-only, like the rest of `HaulTrip`;
`world.test.ts`'s `DERIVED` list records that deliberately, so the "every worker
fact must be persisted" invariant still holds for everything else.

### Coverage, and one honest gap

Eight layout tests pin the geometry, including the exact failure this note
describes: **a hauler turns for home from the building, never from open
ground**. Also covered: a just-dispatched hauler stands at the camp rather than
teleporting to its target, an outbound hauler advances monotonically with no
doubling back, the return leg mirrors the outbound one, and `travelling` is set
only mid-trip. Five mutations fail them — parking at the doorstep regardless of
progress (the increment-4 behaviour), ignoring leg direction, inverting
progress, forcing `travelling` false, and hardcoding the leg length.

`snapshot-system.test.ts` drives a real trip and pins the published contract on
both legs, including that dispatch and the turn each set the *full* leg without
decrementing — so the dot correctly stands still on the tick it is assigned, and
at the building on the tick it turns.

**The gap:** the renderer's *pace* is not covered by anything. `renderer.ts`
cannot be imported by vitest, and every smoke phase screenshots after motion
settles, so the suite observes endpoints only. Making the renderer ignore
`travelling` entirely and walk haulers at the old fixed speed leaves
`npm run smoke:world` **all green** — verified. What the smoke suite does cover
is that the layout's interpolated points reach the renderer and are drawn: its
haul phases now include a genuinely mid-leg position, neither endpoint.

The pacing is also the one part that is heuristic rather than derived. The
renderer measures the wall-clock gap between syncs rather than being told the
tick rate, and clamps it to [50, 1000] ms — an unclamped reading after a pause
or a hidden tab would turn the pause's length into a walking pace and leave the
dot crawling. Passing the interval down from the store (which knows the speed
multiplier) would remove the heuristic and make it testable; it needs a change
to the `sync` seam and was not worth bundling into this fix.
