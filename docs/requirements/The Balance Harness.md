---
type: PBI
parent: "[[Validated Balance]]"
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

# The Balance Harness

`tests/support/balance-harness.ts` runs a scenario through the real engine, headless, and reports what a building made, delivered, and lost to stalls or relocation; `npm run balance:report` prints the full distance/hauler sweep for tuning by eye. Its first measurement corrected Increment 4's own claim about hauler coverage: one hauler serves a building out to leg ~4, two by leg 8, three by leg 13 (the far corner) — not "one hauler roughly sustains one far producer."

Spec: `docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md` §2.1-2.2
