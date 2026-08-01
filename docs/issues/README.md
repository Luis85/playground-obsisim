---
title: Issues
status: index
created: 2026-08-01
tags:
  - issue
  - index
---

# Issues

Open findings, one note per issue. Each note carries YAML frontmatter with an
`id`, `severity`, `area` and `status`, so this folder can be filtered from
Obsidian's search or a Dataview query without reading every file.

These are **not** a bug tracker of things that are broken in production. They
are findings from design and code review that were judged real, were not fixed
in the increment that found them, and would otherwise be lost when the branch
merged. Each note states the evidence, the failure scenario, and a proposed fix
— so picking one up does not mean re-deriving why it matters.

## Conventions

| field | meaning |
| --- | --- |
| `id` | `OBS-<increment>-<nn>`, stable once assigned |
| `status` | `open`, `in-progress`, `resolved`, `wontfix` |
| `severity` | `critical` / `important` / `minor` — impact if left alone, not urgency |
| `area` | `engine`, `app`, `world`, `shared`, `tests`, `build-ci`, `process` |
| `increment` | the increment during which it was found |
| `source` | which review or task surfaced it |
| `affects` | the files a fix would most likely touch |

When an issue is resolved, set `status: resolved`, add `resolved: <date>` and a
line naming the commit. Keep the note — the reasoning is worth more than the
folder being tidy.

## Open — increment 4 (logistics)

| id | severity | title |
| --- | --- | --- |
| OBS-4-02 | important | [Every component must be attached in two spawn sites](2026-08-01-every-component-needs-two-spawn-sites.md) |
| OBS-4-09 | important | [The hauler dot animates at a fixed speed unrelated to the trip](2026-08-01-hauler-animation-outruns-the-simulated-trip.md) |
| OBS-4-04 | minor | [Smoke checks compare whole frames](2026-08-01-smoke-checks-compare-whole-frames.md) |
| OBS-4-05 | minor | [Parallel agents share one git index](2026-08-01-parallel-agents-share-one-git-index.md) |
| OBS-4-08 | minor | [Unassigning a hauler picks an arbitrary one](2026-08-01-unassign-hauler-picks-an-arbitrary-hauler.md) |

Two of these are worth taking before increment 5 adds to them: **OBS-4-02**
because the same class of bug has already bitten twice, and **OBS-4-09**
because it is the one a player would actually notice — a hauler that turns
round in open ground before reaching the building it was sent to.

## Resolved — increment 4

| id | severity | title |
| --- | --- | --- |
| OBS-4-01 | important | [The maintainability floor averages over tests](2026-08-01-maintainability-floor-measures-the-wrong-population.md) |
| OBS-4-06 | important | [The Economy view's "Prod/t" column now reports deliveries](2026-08-01-prod-per-tick-column-now-reports-deliveries.md) |
| OBS-4-03 | minor | [Two haul tests run systems in the reverse of production order](2026-08-01-haul-system-tests-run-systems-in-the-wrong-order.md) |
| OBS-4-07 | important | [Demolition destroys the output buffer](2026-08-01-demolition-destroys-the-output-buffer.md) |
