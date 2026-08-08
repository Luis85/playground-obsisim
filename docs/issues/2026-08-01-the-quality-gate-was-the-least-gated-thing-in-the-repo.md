---
id: OBS-5-02
title: The quality gate was the least-gated thing in the repo
status: resolved
severity: important
area: build-ci
increment: 5
created: 2026-08-01
resolved: 2026-08-01
source: five holes found across increment 5 — two by its own reviews, three by Codex on PR #7, two of them in fixes for the earlier ones
affects:
  - scripts/check-quality.mjs
  - tests/scripts/check-quality.test.ts
tags:
  - issue
  - build-ci
  - process
---

# The quality gate was the least-gated thing in the repo

`scripts/check-quality.mjs` decides whether every other quality rule holds. Over
one increment, **five** ways to pass it while a counter was silently switched off
were found — and two of those were introduced by the fixes for the previous ones.
No single fix is interesting; the pattern is.

| # | Hole | Found by |
| --- | --- | --- |
| 1 | Floored a *mean* over all files, so it fell whenever tests were added and penalised decomposition | increment 4 review (OBS-4-01) |
| 2 | Pinned-at-zero breaches were only exercised through `--update`, so dropping them from the normal path left four structural counters ungated with every test green | increment 5 whole-branch review |
| 3 | `--update` re-locked a baseline **missing** a gated key, and the normal run's own error text advised running `--update` | Codex, PR #7 |
| 4 | Fix for #3 checked key *presence* only, so a **non-numeric** value reopened it | Codex, PR #7 |
| 5 | Every check validated `baseline`; **`current` was never validated**, so a renamed fallow field would disable a counter | this audit |

## The single root cause

The gate decides by comparing two numbers. JavaScript's relational operators
return `false` when either side is `undefined` or `NaN` — in **both** directions.
So for any gated key whose operand is not a number:

```js
current[key] > baseline[key]   // false — no regression recorded
current[key] < baseline[key]   // false — no improvement recorded
current[key] > 0               // false — no pinned breach recorded
```

The key vanishes from the ratchet without producing a single message, and the run
prints `quality ratchet ok`. Holes 3, 4 and 5 are the same sentence with a
different way of making an operand not-a-number: absent, wrong type, unmeasured.

That is why fixing them one at a time kept failing. A guard written against
*missing* keys does not cover *malformed* ones, and one written against a bad
baseline does not cover a bad report.

## What is guarded now

Both operands, symmetrically, before any comparison runs:

- **Baseline** — every gated key must be present and `Number.isFinite`. Unknown
  keys are rejected too, so a renamed metric cannot sit in the file looking
  locked while being ignored. Escapable only via `--allow-regression`, which is
  a judged trade-off that must be written down.
- **Report** — every gated key must resolve to a finite number from fallow's
  summary. **No escape in any mode**, including `--update --allow-regression`: a
  number the gate could not measure is not a number it can lock. This is a broken
  toolchain, not a metric trade-off, and the distinction is the point.

Every exit path in the script now has a test — including the two that never had
one (the `coverage/` refusal and the missing-baseline normal run). 29 tests.

## Verification

Each guard is mutation-tested: neutralise it, confirm the tests that name it fail,
restore. The `current`-side guard was verified this way — removing it fails
exactly the three tests that cover it and no others.

One incidental bug was found and fixed while writing those tests: `report()`
aliased the module-level `SRC`/`TESTS`/`SCRIPTS` fixtures into `file_scores`, so a
test that damaged the report poisoned the shared constants for every test after
it in the file. It now copies. That is worth noting because it is the same
species as everything above — a test that passes for a reason unrelated to what
it names.

## What this does not fix

The gate is still a comparison engine, and the next new gated metric can
reintroduce the pattern if it is added without extending both validators. The
durable guard is the audit habit rather than any one check: when adding a metric
to `GATED`, ask what happens if *either* operand is not a number, and write the
test that answers it.
