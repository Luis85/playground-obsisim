---
type: PBI
parent: "[[Increment 1.5 - Hardening and Polish]]"
order: 10
status: Done
tags:
  - game-design
  - engineering
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Save-Migration Seam

Loading a save becomes migrate, then validate: a versioned save of any known version runs through an ordered chain of migration steps up to the latest version before the existing catalog-aware validator ever sees it. A migration step that throws degrades to "start fresh," never to "cannot open" — migrations are hand-written code running on old, real player data, so that is the failure mode most likely to actually happen. Built one increment before it was needed, so Increment 2's first new save fields didn't route every existing save through the corrupt-backup path.

Spec: `docs/superpowers/specs/2026-07-30-increment-1.5-hardening-and-polish.md` §2.1
