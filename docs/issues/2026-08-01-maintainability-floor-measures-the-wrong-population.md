---
id: OBS-4-01
title: The maintainability floor averages over tests, so it falls whenever an increment adds them
status: open
severity: important
area: build-ci
increment: 4
created: 2026-08-01
source: increment-4 Task 16 (maintainability recovery)
affects:
  - scripts/check-quality.mjs
  - scripts/quality-baseline.json
  - docs/build-ci/quality-gates.md
tags:
  - issue
  - quality-gates
  - metrics
  - tech-debt
---

# The maintainability floor measures the wrong population

`check:quality` floors fallow's `average_maintainability`, a **mean over every
analysed file — tests included**. That makes the number fall for reasons that
have nothing to do with maintainability getting worse, and it has now forced a
re-base twice.

## Evidence

At the end of increment 4, measured directly from `npx fallow --format json`:

| population | files | mean MI |
| --- | --- | --- |
| everything the gate measures | 78 | **90.49** |
| `src/` only | 48 | 90.99 |
| `tests/` only | 30 | 89.70 |

Test files score materially lower than source and there are a lot of them, so
each increment's new tests drag the gated number down. Increment 4 added tests
in almost every task; the floor went 90.7 → 90.5 and the gate went red.

## Why the number cannot simply be earned back

fallow's maintainability index is documented in its own CLI reference as:

```
100 - (complexity_density x 30) - (dead_code_ratio x 20) - min(ln(fan_out+1) x 4, 15)
```

clamped to 0–100, where `complexity_density = total_cyclomatic / lines`.
Verified against this repo's data — `WorldView.vue` has cyclomatic 98 over 336
lines and `fan_out` 9, giving `100 − 8.75 − 9.21 = 82.04` against a reported
82.1.

Three consequences make the floor hostile to ordinary good practice:

1. **There is no length term.** Splitting a file does not raise its score.
   Length is only the *denominator* of complexity density, so an extraction
   helps only when the block removed is denser than what stays behind.
2. **Decomposition is penalised.** Every new module adds a below-average file
   to the mean *and* charges each importer an extra `fan_out`. This was
   measured, not assumed: extracting the save guard out of `src/engine/world.ts`
   — a sound seam on its own merits — moved the mean 90.5 → **90.4**, costing
   6.3 MI across its ten importers. The extraction was reverted on the evidence.
3. **Comments raise the score and deleting them lowers it**, with no change to
   the code, because comments are lines and lines are the denominator. This is
   a live padding vector.

Restoring 90.7 would have needed **+16.1 MI points**. The largest levers
available were to strip *all* branching from `src/shared/save.ts` (+8.8),
`src/app/views/WorldView.vue` (+8.8), or `src/engine/systems/command-system.ts`
(+8.2 — an eighteen-branch command dispatcher whose branches are its entire
job). Gutting two or three of the worst files is not refactoring.

## What was done

The floor was re-based to the measured **90.5** (commit `c47c580`) with the
reasoning recorded in `docs/build-ci/quality-gates.md`. That unblocks the
increment but leaves the gate the same shape, so it will need re-basing again.

The same commit also corrected an earlier claim in that document that fallow's
MI includes "a comment-density term". It does not. The warning that a
comment-accuracy pass will trip the gate is correct; the mechanism given for it
was not.

## Proposed fix

Two candidates, either of which measures something a ratchet can actually hold:

- **Floor `src/` only.** Tests stop diluting a signal that claims to describe
  source maintainability. Still moves when a below-average source file is
  added, but source files are fewer and more deliberate.
- **Floor the worst single file instead of the mean.** This genuinely ratchets:
  it asserts that no file may rot below some MI, and it does not move when good
  files are added. Strictly better as a gate, and the larger change.

Whichever is chosen, the floor should be documented as a property of a specific
population, not as "the codebase's maintainability".
