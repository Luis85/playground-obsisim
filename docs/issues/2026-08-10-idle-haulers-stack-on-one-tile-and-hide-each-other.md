---
id: OBS-7-04
title: Idle haulers park on whatever tile their last trip ended at, stacking on one doorstep where the canvas cannot draw or click them apart
status: Open
severity: minor
area: app
increment: 7
created: 2026-08-10
source: increment-7 task 12 review (recorded as a minor with a rarity argument), sharpened three times — by the reviewer's correction that it is not a tick race, by a PR review pointing out that canvas picking cannot reach a hidden colonist, and by the whole-branch review correcting "resolves on the next dispatch" to "bounded but permanent while idle" and the drawing function from haulSpot to restSpot
affects:
  - src/app/world/layout.ts
  - src/engine/components.ts
type: Issue
parent: "[[Seeing Goods Move Both Ways]]"
order: 220
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Idle haulers stack on one tile and hide each other

## What happens

A hauler with no trip stands at `atCol`/`atRow`, and `restSpot`
(`src/app/world/layout.ts:314`) draws it there — a pure function of that one
tile, with no slot allocation at all, unlike the camp band a few lines below
it. Those fields are written by `cancel()` at **every** trip end, to wherever
the trip finished — which for an ordinary completed trip is the site it banked
into. Idle haulers therefore gather on whatever tile they last delivered to,
and a colony with several of them and no work parks them all on the same
doorstep, one dot exactly on top of another, at the identical pixel.

Buildings and their crews get slot layout — `heldSlots` fans workers out around
their post — and haulers deliberately do not: they carry `HAULER_SLOT` (-1) and
are skipped by that pass, because a hauler on a leg is at a computed point on a
line and not in anybody's slot ring.

## Why it matters

The first framing of this, when it was recorded as a Task 12 minor, was that it
is a cosmetic overlap that resolves on the next dispatch. Two corrections make it
more than that.

**It is not a tick-simultaneity race.** Because `cancel()` writes the position at
every trip end rather than only on an interrupted one, a colony with nothing to
haul parks every hauler on its last depot **indefinitely** — for as long as
there is no work, which in a colony whose chain has stalled is exactly when a
player is looking at the world view trying to find out why.

**A hidden dot cannot be clicked.** Canvas picking has no way to reach a
colonist drawn underneath another one, so this is not only "the count looks
wrong": a player cannot select those haulers on the canvas at all. The tables
still list every colonist, so no-WebGL parity is intact and the colony stays
playable — but the world view silently loses a subject the rest of the app
exposes.

The honest framing, put together from both corrections, is **bounded but
permanent while idle** — not rare, and not self-resolving on its own timeline.
It resolves the instant any of the stacked haulers is dispatched again, which
is why "resolves on the next dispatch" felt true; it just says nothing about
how long that wait is, and a colony with a genuinely idle fleet can sit there
for as long as the player leaves it. This stays **Minor**, because the tables
keep the colony fully playable without the canvas — but the reasoning for that
rating has to be the bound, not an appeal to rarity that a stalled chain
falsifies on its own.

## Suggested resolution

Give idle haulers a slot the way crews get one, keeping haulers on a leg out of
it. `heldSlots` already owns the fan-out and already special-cases
`HAULER_SLOT`; the change is to route a hauler whose leg is not running through
the slot pass keyed on its resting tile rather than on a building id, which is
what `at: null` in the placement record currently declines to do.

Two constraints worth stating before someone writes it:

- **A resting tile is not necessarily integral.** A cancellation leaves a hauler
  at a fractional point along its leg, by design (§2.5), so the key cannot be a
  tile lookup that assumes whole coordinates.
- **The layout must stay stable across ticks.** The existing slot machinery
  carries `previous` for exactly this reason — a dot that reshuffles its offset
  every tick reads as movement that is not happening.

Whether this is worth doing at all is a fair question and the cheapest honest
alternative is a count badge rather than a fan-out. Either way the test is the
one the layout suite is already shaped for: two idle haulers resting at the same
tile must not be placed at the same point, and two haulers mid-leg must still be
placed by `legPositionOf` alone.
