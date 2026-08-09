---
id: OBS-6-06
title: The homeless work-power penalty is invisible in the view that exists to explain low output
status: resolved
severity: minor
area: app
increment: 6
created: 2026-08-09
resolved: 2026-08-09
source: increment-6 whole-branch review, recorded in the final fix pass — the strongest candidate of the deferred minors
affects:
  - src/app/labels.ts
  - src/app/views/PopulationView.vue
---

# The homeless work-power penalty is invisible in the Population view

**Status:** resolved 2026-08-09 (`771be59`, `b4e0644`), by both suggested fixes
— the label first, then the Delivered column. See
[Resolution](#resolution-771be59-b4e0644).

## What happens

A homeless colonist delivers half their work: `BALANCE.homelessFactor` is `0.5`,
and `commuteFactor(null, …)` returns it for anyone with no home. Nothing in the
app says so.

Two places could and neither does:

- **The Home column** renders `commuteLabel` (`src/app/labels.ts:71`). A housed
  colonist gets all three parts — `#9 · 12.0 tiles · 70%`. A homeless one gets
  the bare word `Homeless`. The percentage — the only part that states the cost
  — is dropped on precisely the colonist paying the largest one.
- **The Efficiency column** (`PopulationView.vue:107`) renders
  `w.efficiency`, which is the hunger-derived value alone. `workerWorkPower`
  multiplies that by the tool multiplier and by the commute factor
  (`content/balance.ts`), and that product is never shown per colonist.

So a colonist can read `100%` under Efficiency while contributing `0.5`.

The number is not absent from the whole app — `BuildingsView` shows each
building's summed `workPower`, which folds it in — but it is absent from the
per-colonist view, unattributable to anyone, and impossible to trace back to
housing from the building total.

## Why it matters

The Population view's stated job is to explain low output. Homelessness is the
single largest per-colonist multiplier in the game and the one the player has
the clearest lever over (build a house, or move one). A player looking at a
colony producing half what they expect can read every column in this view and
find nothing that accounts for it.

It is also the one commute case the player cannot infer. A housed colonist's
`70%` is stated outright; the homeless case renders a word where every other row
renders a number, which reads as "not applicable" rather than "worst possible".

## Suggested resolution

Smallest honest fix, and it needs no new snapshot field: give the homeless
branch of `commuteLabel` the same percentage the housed branch already gets.
`commuteFactor` collapses to `homelessFactor` for a null home, so
`ColonistSnapshot.commuteFactor` already carries `0.5` — the label just declines
to print it.

```
Homeless · 50%
```

Keep the word: it names the cause, and the doc comment's reasoning for branching
on `homeId` rather than on a zero distance still holds (a colonist housed next
door also measures 0 tiles).

Worth considering alongside it: a "Delivered" column showing the full
`efficiency × tool × commute` product, so the view has one number that matches
what the simulation actually spends. That is a bigger change — it duplicates
`workerWorkPower`'s expression in a third place unless the snapshot carries the
product — so it should be decided on its own rather than smuggled in with the
label fix.

Whichever is chosen, the test to write is the discriminating one: a homeless
colonist and a colonist housed at commute-factor 1.0 in the same table, so a
label that prints a percentage for one and not the other fails.

## Resolution (771be59, b4e0644)

Both changes shipped, in the order the note suggested.

**The label first (`771be59`).** `commuteLabel` (`src/app/labels.ts`) gives the
homeless branch the same percentage the housed branch already printed:
`Homeless · 50%` in place of the bare word. No new snapshot field — the factor
was already published on `ColonistSnapshot.commuteFactor`, only the label
declined to print it. `tests/app/population-view.test.ts`'s existing commute
test, which already put a homeless colonist and a commute-factor-1.0 colonist
in the same table, had its assertion rewritten to require the percentage;
verified red against the pre-fix branch (`expected 'Homeless' to be 'Homeless
· 50%'`) before being restored.

**The Delivered column second (`b4e0644`).** The note treated this as the
bigger change, reasoning a "Delivered" column would duplicate
`workerWorkPower`'s expression in a third place unless the snapshot carried
the product — checked before being accepted, and found not to hold:
`buildEntitySections` was already computing that product per colonist inside
its own `workerSnaps` map, only feeding it into the per-building sum and never
publishing it. `ColonistSnapshot.deliveredWorkPower` publishes that existing
value; `PopulationView` gains a Delivered column beside Efficiency (not a
replacement — Efficiency is hunger alone and stays what the world renderer
colors a colonist's dot by). `deliveredWorkPower` is `null`, not `0`, for
anyone with no `buildingId`, which covers both the idle case and the hauler
case (a hauler's `buildingId` is null by construction; their throughput is
carried capacity, not work power) — a mutation dropping that guard made a
commute-neutral hauler read a fabricated `1` in the test, which pinned the
guard as load-bearing rather than decorative.

**One gap the two commits opened and a third, `4a338ce`, closed the same day:**
gating `deliveredWorkPower` on `buildingId === null` alone was not enough. A
worker whose workplace was mid-relocation has a real `buildingId`, so the
first version of the column read a full `1.00` for a crew that
`ProductionSystem` was, in the same tick, skipping entirely — the exact
mechanism/display disagreement this note exists to name, reintroduced by the
fix meant to close it. `deliveredWorkPowerOf` now takes the set of relocating
building ids and returns `0` — a measured zero, not `null`'s "does not apply"
— for anyone assigned to one, and `BuildingSnapshot.workPower` (which predates
this note and had no relocation gate at all) now sums that same function
instead of a second, separately-gated `workerWorkPower` call. See `OBS-6-08`
for what is deliberately left standing on the engine side of that same
boundary.

Test: a homeless colonist and a colonist at commute-factor 1.0 in the same
table now show `Homeless · 50%` beside `#9 · 12.0 tiles · 70%`, and Efficiency
100% beside Delivered 0.50 on the staffed-homeless row — the exact
juxtaposition the note named, made legible instead of hidden behind one
misleading cell.
