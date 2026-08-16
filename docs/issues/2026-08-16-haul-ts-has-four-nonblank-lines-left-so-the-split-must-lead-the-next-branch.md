---
id: OBS-10-03
title: src/shared/haul.ts sits four nonblank lines under the hard 500-line cap, so the next supply change has nowhere to be written and the split must lead that branch
status: Open
severity: important
area: shared
increment: 10
created: 2026-08-16
source: increment-10 whole-branch review — recorded rather than acted on, because a pure move would churn the two functions that review had just verified line by line and would buy no behaviour
affects:
  - src/shared/haul.ts
  - tests/shared/haul.test.ts
  - scripts/loc-baseline.json
type: Issue
parent: "[[Construction as Work]]"
order: 340
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# haul.ts has four nonblank lines left, and that is a gate rather than headroom

## What happens

`src/shared/haul.ts` is **496 nonblank lines of a hard 500** — measured at
f12de56 with `grep -cve '^\s*$' src/shared/haul.ts`, which is the same count
`npm run check:loc` takes (`scripts/check-loc.mjs`, `maxLoc: 500` in
`scripts/loc-baseline.json`, whose `files` map is **empty**: no file in this
repository is exempt).

Increment 10 spent that headroom deliberately and it was the right place to spend
it — `SupplyCandidate.siteAge`, one comparator term, the two-phase
`nextSupplyTarget`, and the docs that explain why age cannot be a comparator term
and why phase 1 is two steps. Those explanations are the file's whole convention:
every ranking rule in it is argued where it lives.

**Four lines does not fund the next such argument.** The next change to supply
selection — any of the three remedies OBS-10-01 records, a route function that is
a path rather than a formula, a staging gate from OBS-8-06 — arrives with a
paragraph attached, and there is no room for one. The gate then makes the choice
that a designer should be making: shrink an explanation, or split under pressure.

## Why it matters

- **The failure mode is a bad edit, not a red build.** `check:loc` will fail
  honestly, and the tempting fixes are all worse than the split: trimming a
  doc comment that a review paid for, `--update`ing the baseline (forbidden by
  this repo's quality rules, and it would put the first entry into an empty
  exemption map), or wedging the new rule somewhere it does not belong.
- **The file is the spatial law of hauling and is meant to stay cheap to test.**
  `docs/requirements/Roads and Pathfinding.md` already turns on where that law
  lives. A file at its cap is one that resists exactly the change that feature
  will need.
- **It is a structural debt with a deadline attached**, which is why it is filed
  as `important` and not as a tidy-up: the deadline is the next commit that
  touches supply ranking, whenever that is.

## Why it was NOT done on this branch

The move that suggests itself — lift `compareSupplyCandidates`, `nextSupplyTarget`
and `supplyRouteDistance` into their own module — is a pure move with **zero
behavioural value**, and it would land on top of the two functions increment 10's
review had just verified line by line: the transitivity argument, the two-phase
selector, the `starving && siteAge === null` term. Moving them would re-open that
verification for nothing, in the same commit range that established it.

**Splitting first is cheap and splitting last is expensive**, and this branch was
the "last" end of that. So the constraint is carried forward instead.

## What a successor must do

**Make the split the first commit on the next branch that touches supply, before
any behaviour change on that branch.** Both halves of that sentence are the
point:

- **First**, so it is reviewable as a move: identical function bodies, imports
  and re-exports only, and a diff a reviewer can read as "nothing changed".
- **Before the behaviour**, so the change that follows is written against a file
  with room in it and can carry its own explanation, which is the thing this note
  exists to protect.

The three functions above are the natural unit — they are the supply *selection*
order, and the collect side (`compareHaulCandidates`) does not move with them.
`tests/shared/haul.test.ts` follows the same seam. Nothing here argues for
trimming a single line of the existing doc comments: the file is too long because
it holds two subjects, not because it explains them too well.
