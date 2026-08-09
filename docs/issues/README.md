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

## Open — increment 6 (survival & population)

| id | severity | title |
| --- | --- | --- |
| OBS-6-01 | minor | [A demolished tile is still occupied for the rest of the drain](2026-08-08-a-demolished-tile-is-still-occupied-for-the-rest-of-the-drain.md) |
| OBS-6-03 | minor | [An idle adult crossing the elder band retires silently, while a working one is announced](2026-08-08-an-idle-adult-retires-without-a-notice.md) |
| OBS-6-05 | minor | [The v4 migration conflates "has a shelter" with "has a usable one"](2026-08-09-migration-conflates-having-a-shelter-with-having-a-usable-one.md) |
| OBS-6-06 | minor | [The homeless work-power penalty is invisible in the Population view](2026-08-09-the-commute-penalty-is-invisible-in-the-population-view.md) |
| OBS-6-07 | minor | [Three correct-but-untested paths, and one net with a hole](2026-08-09-three-correct-paths-with-no-test-and-one-net-with-a-hole.md) |

## Resolved — increment 6

| id | severity | title |
| --- | --- | --- |
| OBS-6-02 | important | [Two colonists dying on the same tick freeze the whole simulation for a tick each](2026-08-08-simultaneous-deaths-freeze-the-simulation.md) |
| OBS-6-04 | important | [Three long-horizon balance tests are nine tenths of the default dev loop](2026-08-09-three-tests-are-nine-tenths-of-the-default-dev-loop.md) |

## Open — increment 5 (validated balance)

| id | severity | title |
| --- | --- | --- |

*Nothing open.*

## Resolved — increment 5

| id | severity | title |
| --- | --- | --- |
| OBS-5-01 | minor | [Moving a building desyncs the dot of a hauler already returning from it](2026-08-01-moving-a-building-desyncs-a-returning-haulers-dot.md) |
| OBS-5-02 | important | [The quality gate was the least-gated thing in the repo](2026-08-01-the-quality-gate-was-the-least-gated-thing-in-the-repo.md) |

## Open — increment 4 (logistics)

| id | severity | title |
| --- | --- | --- |

*Nothing open.* All nine increment-4 findings were cleared before increment 5's
feature work began.

## Resolved — increment 4

| id | severity | title |
| --- | --- | --- |
| OBS-4-01 | important | [The maintainability floor averages over tests](2026-08-01-maintainability-floor-measures-the-wrong-population.md) |
| OBS-4-02 | important | [Every component must be attached in two spawn sites](2026-08-01-every-component-needs-two-spawn-sites.md) |
| OBS-4-03 | minor | [Two haul tests run systems in the reverse of production order](2026-08-01-haul-system-tests-run-systems-in-the-wrong-order.md) |
| OBS-4-04 | minor | [Smoke checks compare whole frames](2026-08-01-smoke-checks-compare-whole-frames.md) |
| OBS-4-05 | minor | [Parallel agents share one git index](2026-08-01-parallel-agents-share-one-git-index.md) |
| OBS-4-06 | important | [The Economy view's "Prod/t" column now reports deliveries](2026-08-01-prod-per-tick-column-now-reports-deliveries.md) |
| OBS-4-07 | important | [Demolition destroys the output buffer](2026-08-01-demolition-destroys-the-output-buffer.md) |
| OBS-4-08 | minor | [Unassigning a hauler picks an arbitrary one](2026-08-01-unassign-hauler-picks-an-arbitrary-hauler.md) |
| OBS-4-09 | important | [The hauler dot animates at a fixed speed unrelated to the trip](2026-08-01-hauler-animation-outruns-the-simulated-trip.md) |
