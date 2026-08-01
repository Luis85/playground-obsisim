---
id: OBS-4-06
title: The Economy view's "Prod/t" column now reports deliveries, not production
status: open
severity: important
area: app
increment: 4
created: 2026-08-01
source: increment-4 final review of spec §2.1's stated consequence
affects:
  - src/app/views/EconomyView.vue
  - src/engine/systems/snapshot-system.ts
tags:
  - issue
  - ux
  - labelling
---

# "Prod/t" now reports deliveries, not production

Increment 4 changed what the stockpile's per-tick flow statistics mean. Goods no
longer land in the stockpile when they are made — they land when a hauler
delivers them. The spec states this consequence deliberately (§2.1):

> the stockpile's per-tick flow statistics now measure the **store's inflow**,
> not gross production. A forester filling its buffer contributes nothing to
> `productionRate` until a hauler delivers.

That is a defensible reading of a colony whose income is what actually arrives.
The problem is that the **column label was not revisited**. The Economy view's
chain table still heads that column `Prod/t` and fills it from
`stats.productionRate`, so the name now describes something the number no longer
measures.

## Failure scenario

A player staffs a forester fully and assigns no haulers. The forester produces
at full rate until its buffer fills, then stalls in `outputFull`. Throughout,
the Economy view shows:

- `Prod/t` — **0.00**, because nothing reached the store
- `Status` — `producing`, then `Output full`

So the table simultaneously reports that the stage is producing and that its
production is zero. The number is correct under the new semantics and the label
is wrong, which is the worst combination: it reads as a contradiction rather
than as information.

The haul-pressure line added in the same increment explains the *colony-level*
cause ("18 units waiting for collection — 2 stalled — 1 hauler on duty"), and it
is genuinely good. But it is a separate sentence above the table; it does not
correct a per-stage column that is telling the player the wrong thing.

## Proposed fix

Cheapest and probably sufficient: rename the column to what it measures —
`Delivered/t`, or `To store/t`. One word, and the contradiction disappears.

Worth considering instead: show **both**, since they are now genuinely different
quantities and the gap between them is exactly the haul backlog. A `Made/t`
column beside `Delivered/t` would make under-hauling visible per stage rather
than only in aggregate, which is the diagnostic the spec says this increment
owes the player. That needs gross production plumbed through the snapshot, which
it currently is not.

Do not "fix" this by reverting the flow-stat semantics. Store inflow is the
right meaning; only the label is wrong.
