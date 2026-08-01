---
id: OBS-4-06
title: The Economy view's "Prod/t" column now reports deliveries, not production
status: resolved
severity: important
area: app
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4 final review of spec §2.1's stated consequence
affects:
  - src/app/views/EconomyView.vue
  - src/app/views/DashboardView.vue
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

## Resolution

Took the cheap fix: the column is now headed **`Delivered/t`** in both tables
that show it — `EconomyView.vue`'s chain table and `DashboardView.vue`'s
resource table. No engine or snapshot change; `stats.productionRate` still
feeds it, because store inflow is still the right number.

`DashboardView.vue` was not in this note's `affects` list but had the same
`Prod/t` heading over the same field, so it was renamed too. A rename in one
table only would have left the two views disagreeing about what the statistic
is called.

### The failure scenario named a label the Economy view does not have

The scenario above says the `Status` column reads `producing`, then
`Output full`. It does not: `stageStatuses` emits only `ok`, `unstaffed` and
`⚠ starved`. `producing`/`outputFull` are the per-building `state`, shown in
the Buildings table and the selection panel, not in the chain table.

The contradiction is real, and slightly sharper than recorded — the row read
`ok` beside `0.00`, so the table said the stage was *fine* and delivering
nothing, with no indication the two facts were connected.

### Why `Delivered/t` and not `To store/t`

Store inflow is not exclusively hauler deliveries: `stockpile.add` is also
called by the demolition refund and by unassigning a hauler who is carrying a
load. Both are goods arriving at the store, so `Delivered/t` is honest about
all three, and hauler delivery is the only one that occurs in steady play —
the other two are one-off events inside a rolling window average.

### Still open as a design question, deliberately

The note's richer option — a `Made/t` column beside `Delivered/t`, so the haul
backlog is visible per stage rather than only in the aggregate haul-pressure
line — is **not** done here. It needs gross production plumbed through the
snapshot, which does not exist today: goods are made into a building's
`OutputBuffer` and nothing records that flow. That is a feature, not a label
fix, and it is raised as a candidate for increment 5's scope rather than
smuggled in under an issue note.

### Coverage

Three tests in `tests/app/economy-view.test.ts` — the heading in each table,
and a fully staffed forester with a full buffer and no haulers reading `ok`
against `0.00` delivered. The last one uses deliberately distinct values (0
delivered, 0.50 consumed, 4 in stock) after a first draft using all-zero rates
survived a mutation that pointed the column at `consumptionRate`. All four
mutations fail the suite now: either heading reverted to `Prod/t`, and the
column bound to `consumptionRate` or to `stock`.

## Superseded in increment 5: refunds no longer count as deliveries

The "Why `Delivered/t` and not `To store/t`" section above argued that a
demolition refund belongs in the column, because `Delivered/t` was honest
about every way goods reach the store. Increment 5 reversed that, in
`47a4803`: `Stockpile.refund` now banks the construction cost without
recording into `producedThisTick`, so only goods a hauler actually carried
count as delivered.

The reversal is not a disagreement with the reasoning — it is that the
reasoning's premise expired. That argument was made while `Delivered/t` stood
alone, and the very next section of this note deferred `Made/t` to increment 5
as "a feature, not a label fix". Increment 5 built it. With both columns
present the gap between them *is* the haul backlog, which is the whole point
of having added `Made/t`, and a refund can push `Delivered/t` above `Made/t` —
a backlog below zero, which is not a state the colony can be in.

The distinction now drawn is whether a hauler carried the goods, not whether
they arrived. So the other two `stockpile.add` callers keep counting: a hauler
depositing at the end of a leg, and a released hauler dropping the load it was
already carrying. Both moved real goods along a real leg. A refund conjures
them from a structure that no longer exists.

Raised by a Codex review of PR #7 against `snapshot-system.ts`, which observed
that delivered could exceed gross production. Recorded here rather than only
in the commit, because this note is where the original decision lives.
