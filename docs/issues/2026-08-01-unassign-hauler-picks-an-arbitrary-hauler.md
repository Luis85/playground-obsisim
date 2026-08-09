---
id: OBS-4-08
title: Unassigning a hauler picks an arbitrary one, which may be mid-return
status: resolved
severity: minor
area: engine
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 final whole-branch review (Minor
affects:
  - src/engine/systems/command-handlers.ts
tags:
  - issue
  - ux
  - game-design
type: Issue
order: 110
started: ""
finished: ""
horizon: ""
start: ""
due: ""
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

## Resolution

`handleUnassignHauler` now calls `cheapestHaulerToRelease`, which ranks the
haulers on duty by how much work releasing them would throw away:

1. `idle` — nothing wasted
2. `outbound` — only the walk out, since it carries nothing yet
3. `returning` — a walk that has already earned a load

Within a phase, the one with the fewest `ticksLeft` (smallest remaining walk to
lose). Exact ties keep entity-iteration order, so the choice stays
deterministic — the property the dispatch rule is careful about too.

Worth naming explicitly, because it reads like an oversight otherwise: this is
**not** the inverse of the dispatch rule. Dispatch asks who can do the most
good; removal asks whose work is cheapest to discard. A spec sentence saying so
now sits in §2.3 beside the dispatch rule, as the note suggested.

### Coverage

An integration test in `command-system.test.ts` pins the headline case — with a
loaded hauler on its way home and an idle one at the camp, `unassignHauler`
takes the idle one and the loaded trip keeps its phase and its load, with
nothing banked early.

That test alone was not enough. A mutation flattening all three phases to equal
cost still passed it, because an idle hauler has `ticksLeft` 0 and so wins on
the tiebreak whether or not the phase term exists. The phase term does matter —
an outbound hauler eight ticks out should still be released before a loaded one
three ticks from home, which `ticksLeft` alone gets backwards. So
`cheapestHaulerToRelease` is exported and unit-tested directly in
`tests/engine/systems/hauler-release.test.ts` (7 tests) across the full
ordering matrix.

Five mutations fail the suite: phases flattened to equal cost, outbound ranked
worse than returning, the `ticksLeft` tiebreak dropped, the tiebreak inverted to
prefer the furthest, and the `hauling` filter dropped.
