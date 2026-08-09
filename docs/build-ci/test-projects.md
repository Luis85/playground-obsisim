# Test projects: why `npm test` is fast again, and what keeps balance honest

Resolves [OBS-6-04](../issues/2026-08-09-three-tests-are-nine-tenths-of-the-default-dev-loop.md).

## The decision

Three long-horizon tests in `tests/engine/balance.test.ts` simulate 12,000,
3,500 x2 and 9,000 ticks. Measured on this branch they were **~101s of a ~120s
suite**, so `npm test` had stopped being a save-cadence command and become a
commit-cadence one — a change in how every future increment gets developed,
adopted as a side effect of adding a measurement rather than as a decision.

The owner chose the issue note's second option, with one amendment:

1. **`tests/engine/balance.test.ts` gets its own vitest project**, named
   `balance`. Everything else is the `unit` project. `npm test` runs `unit`
   only and is back to ~14s.
2. **`npm run check:all` runs BOTH projects.** The inner watch/iterate loop got
   fast; the pre-commit gate did not, and is not supposed to. Its ~2 minutes is
   the accepted price of never committing a silent balance regression.
3. **CI runs them as separate jobs**, `test` and `balance`, so the ten-second
   suite reports in ten seconds while the two-minute one stays unconditional.

The constraint increment 5 established survives intact: **a balance number in a
spec is still reproducible by a command in `package.json`**, and that command
is still run by something other than a person's memory — by `check:all` before
every commit, and by CI on every pull request.

## What runs what

| Command | Project(s) | Files | Tests | Wall clock |
|---|---|---|---:|---:|
| `npm test` | `unit` | 35 | 619 | 13.8s |
| `npm run test:balance` | `balance` | 1 | 15 | 115.9s |
| `npm run test:coverage` | both (no filter) | 36 | 634 | ~120s |
| `npm run check:all` | both, as two runs | 36 | 634 | ~2 min |

619 + 15 = 634, which is what `vitest run` reported before the split. The
split moved tests between suites; it did not drop any.

`npm run balance:report` and `npm run balance:population` now select
`--project balance` instead of naming the file. A bare path filter
(`npx vitest run tests/engine/balance.test.ts`, the form
`.superpowers/sdd/conventions.md` uses for the 16-row haul sweep) still works
unchanged — the `unit` project excludes that file, so only `balance` matches it.

### Why `test:coverage` did *not* follow the split

It still runs unfiltered, so it still covers both projects and its numbers mean
exactly what they meant before. That was checked rather than assumed: with the
balance project excluded, `src/engine/**` measures 99.64 / 96.25 / 99.30 /
99.64 against floors of 90 / 85 / 90 / 90, and every other gated directory
clears its floor too — the long-horizon runs contribute nothing the rest of the
suite does not already reach (including it moves engine branch coverage by
0.01, *downward*). So a future decision to make the coverage job fast is
available and measured. It is not taken here, because the coverage job is not
the inner loop and changing what a coverage number covers is a second decision.

## Why a project split and not an env flag

A flag (`BALANCE=1`, the way `BALANCE_REPORT` already works) is cheaper and
gets the same ten seconds. It was rejected because it takes the sentinels with
it. `balance.test.ts` asserts `frozenSteps === 0` — OBS-6-02's permanently-zero
regression sentinel, whose symptom is a *quietly wrong measurement* and never
an error. Behind a flag it would run only when someone remembered to ask.

Confirmed rather than assumed. With `runPopulationScenario` mutated to record
one stalled tick:

- `npm run test:balance` exits 1 — `AssertionError: expected 1 to be +0`, in
  `|balance| tests/engine/balance.test.ts`.
- `npm test` exits 0, 619 passed.

That second line is the honest cost of the split, stated plainly: the fast
suite no longer covers balance at all. `check:all` is what makes that safe, and
**trimming `check:all` back to the fast suite would silently reverse this whole
decision** — so `scripts/check-test-projects.mjs` fails the build if anyone
does.

## The failure mode this is designed against

OBS-6-04 warns about a measurement that stops running without saying so. That
is not hypothetical here. **On 2026-08-09 GitHub Actions stopped running on
this repository entirely** — the last workflow run was at 08:08, twenty commits
were pushed after it with zero runs, and the pull request still displayed a
green check the whole time, because the check it was displaying came from
GitGuardian (a GitHub App) rather than from Actions. The workflow was `active`;
the stop was account-level.

So the wiring is built on the assumption that a job which does not run will
otherwise be mistaken for one that passed.

### `scripts/check-test-projects.mjs` (gate `check:test-projects`, CI job `lint`)

Runs in under a second — it uses `vitest list --filesOnly`, which resolves the
file sets without executing them. It asserts:

1. **Every `tests/**/*.test.ts` is matched by exactly one project.** A file
   matched by none is the silent stop in miniature: vitest does not complain,
   it just reports a suite with fewer tests in it, which looks exactly like a
   suite that always had fewer tests in it. The file lists come from `vitest
   list`, never from the `BALANCE_FILE` constant `vitest.config.ts` uses — a
   guard reading the same constant as the thing it guards proves nothing.
2. **The `balance` project matches at least one file.** `vitest run --project
   balance` over an empty set would exit 0 having measured nothing.
3. **`check:all` still runs `--project balance`**, resolving one level of
   `npm run` indirection.
4. **CI has a job running it**, that job carries no `if:` and no
   `continue-on-error`, and an aggregator job `needs` it.

Each of those seven checks was verified by breaking the thing it guards and
watching the gate go red.

### The `gate` aggregator job

A **skipped** GitHub Actions job is not a failed one. A required-checks list
made of `lint`/`test`/`balance`/… therefore passes when one of them is filtered
away or cancelled. `gate` runs `if: always()`, `needs` every other job, and
demands the literal string `success` from each — so skipped, cancelled and
never-dispatched all come out red. **`gate` is the status to require on the
branch.**

### What none of this can see

`gate` cannot fire if the workflow is never scheduled, which is precisely what
happened on 2026-08-09. No file in this repository can defend against Actions
being disabled at the account level. Two things outside the repo close that
gap, and both need a human:

- Require the `gate` check in branch protection. A required check that has
  never reported blocks the merge; a merge button that goes green with no runs
  does not.
- Treat "the PR is green" as a claim to check against the Actions tab, not a
  fact, whenever the last run is older than the last commit.

The local gate is the primary defence and the reason `check:all` stays slow: it
runs the balance project on the developer's machine before every commit,
whether or not CI is running at all.
