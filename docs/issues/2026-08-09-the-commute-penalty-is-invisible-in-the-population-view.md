---
id: OBS-6-06
title: The homeless work-power penalty is invisible in the view that exists to explain low output
status: open
severity: minor
area: app
increment: 6
created: 2026-08-09
source: increment-6 whole-branch review, recorded in the final fix pass — the strongest candidate of the deferred minors
affects:
  - src/app/labels.ts
  - src/app/views/PopulationView.vue
---

# The homeless work-power penalty is invisible in the Population view

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
