---
id: OBS-6-04
title: Three long-horizon balance tests are nine tenths of the default dev loop
status: open
severity: important
area: tests
increment: 6
created: 2026-08-09
source: increment-6 review of Task 12, raised again in the Task 12 fix pass — filed rather than fixed because retiming the suite is a decision about how every future increment is developed
affects:
  - tests/engine/balance.test.ts
  - package.json
  - vitest.config.ts
---

# Three long-horizon balance tests are nine tenths of the default dev loop

## What happens

`npm test` runs the whole suite unconditionally, and the whole suite is now
dominated by three tests that simulate 12,000, 3,500 x2 and 9,000 ticks.

Measured on this branch at the `birthFoodPerHead: 12` retune:

| what | files | tests | wall clock |
| --- | ---: | ---: | ---: |
| `npm test` | 35 | 607 | **119.5s** |
| everything except `tests/engine/balance.test.ts` | 34 | 592 | **9.9s** |

Inside that one file:

| test | duration |
| --- | ---: |
| `a colony feeding itself settles at its FOOD CHAIN…` | 60.3s |
| `a birth burst becomes a retirement bulge one generation later` | 22.6s |
| `that ceiling is the chain PRODUCING, not the harness under-hauling it` | 17.8s |
| the other 12 tests in the file (haul gradient, relocation, commute) | ~18s |

**Three `it` blocks are ~101 seconds of a ~120 second suite.** The other 604
tests finish in ten.

## Why it matters

The cost is not the CI minutes. It is that the *inner loop* changed character.
Before increment 6 the suite was fast enough to run on every save; at two
minutes it is fast enough to run before a commit and no more. That is a
different development style, and it was adopted as a side effect of adding a
measurement rather than as a decision — nobody chose it, and nothing records
that it happened.

The second-order effect is worse than the wait. A suite that is slow to run is
a suite that gets run less, filtered more (`-t`), and eventually trusted on the
strength of the last full run rather than this one. Increment 6 already has one
hazard of that shape recorded — the population report deliberately re-runs its
scenarios rather than sharing them across `it` blocks, precisely because `-t`
filtering makes cross-test dependencies reachable by accident.

## Why this is filed rather than fixed

Because every obvious remedy is a policy decision with a real downside, and the
task that found this had no mandate to pick one:

- **Move them behind an env flag**, the way the two `BALANCE_REPORT` printers
  already are. Cheap, and the suite returns to ten seconds — but a measurement
  that only runs when someone remembers to ask is a measurement that goes stale
  silently, which is the failure mode `frozenSteps` and the sweep regression
  exist to prevent. Increment 5's whole thesis is that a balance claim must be
  re-derivable, and a gate nobody trips is not.
- **Move them to a separate project/workspace** (`vitest --project balance`),
  run in CI and on demand but not by `npm test`. Keeps them unconditional
  *somewhere*, at the cost of two commands where there was one, and of a suite
  that can be green locally while a balance regression sits unreported.
- **Shorten the horizons.** The 12,000 ticks is not padding — §4.1 argues it is
  the minimum that spans a full generation plus enough of the next to tell an
  oscillation from a plateau, and the retune's trough assertion needs the
  second wave. Halving it would make the plateau claim unfalsifiable.
- **Sample less often.** Does not help: the cost is `world.step()`, not the
  sampling.

## Suggested resolution

Decide it at the start of an increment rather than inside a task, and record
the choice where the next person will read it (`docs/build-ci/`). The second
option is the most likely: a `balance` vitest project, `npm test` fast again,
and CI running both — plus a line in the increment checklist that says the
balance project must be green before a spec's §4 is quoted.

Whatever is chosen, the constraint that must survive it is the one increment 5
established: **a balance number in a spec has to be reproducible by a command
in `package.json`**, and that command has to be run by something other than a
person's memory.
