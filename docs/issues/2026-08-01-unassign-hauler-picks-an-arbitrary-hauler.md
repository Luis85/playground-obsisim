---
id: OBS-4-08
title: Unassigning a hauler picks an arbitrary one, which may be mid-return
status: open
severity: minor
area: engine
increment: 4
created: 2026-08-01
source: increment-4 final whole-branch review (Minor #11)
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - issue
  - ux
  - game-design
---

# Unassigning a hauler picks an arbitrary one

`handleUnassignHauler` (`src/engine/systems/command-handlers.ts:241`) selects
its victim with:

```ts
ctx.workers.find(({ job }) => job.hauling)
```

That is the first hauler in entity-iteration order. It may be one halfway
through a return leg with a full load, while an idle hauler stands at the camp
doing nothing.

## Consequence

No goods are lost — the carried load is banked into the stockpile at
`command-handlers.ts:250` before the trip is reset, and that path is tested. So
this is not a correctness bug.

It is a small player-experience wart: pressing `−` on the Dashboard can
interrupt a productive trip for no reason when an idle hauler was available. The
interrupted trip's remaining walk is wasted work, and from the canvas the player
sees a loaded dot stop mid-journey and become an ordinary worker.

## Why it is unspecified

Spec §2.3 defines hauler *dispatch* ordering carefully — fullest backlog first,
ties by distance to camp, then by building id — but says nothing about which
hauler to *remove*. The implementation picked the simplest thing, which is a
reasonable default for an unspecified rule.

## Proposed fix

Prefer an idle hauler when one exists, and only interrupt a working one when
every hauler is busy. Roughly:

1. a hauler whose trip phase is `idle`
2. otherwise one that is `outbound` (it carries nothing, so nothing is wasted
   but the walk out)
3. otherwise the `returning` one with the fewest ticks left

Worth pairing with a spec sentence in §2.3 so the removal rule is stated
alongside the dispatch rule rather than left to the code.
