---
type: Feature
parent: "[[Logistics and Haulers]]"
order: 20
status: Open
increment: 7
tags:
  - game-design
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Two-Way Haul and Storage Buildings

Goods stop teleporting in the second direction. A recipe's inputs are no longer paid out of the colony ledger from anywhere on the map: every producing building has an input buffer, a hauler has to walk goods into it, and a building with nothing to work with reports `Waiting for input`. A supply trip and a collect trip are one round trip — the hauler carries inputs out and brings finished goods home on the same walk — so distance is now priced on the way in as well as the way out, and a processing building in the far corner is genuinely worse than one on the camp band. **Storehouses** are the answer the increment gives the player: a third kind of building, unstaffed, that is a second place goods may be dropped and picked up. The colony's goods stay one spendable ledger held at several tiles, so wealth, meals and construction costs count depot stock exactly as they count camp stock. Save v6 carries input buffers and storehouse contents.

**Shipped as Increment 7 (2026-08-10).** Two of the feature's three original parts are done. Roads and pathfinding — bundled here since Increment 4's out-of-scope list — were deferred a third time and now have their own note, as does the storehouse-to-storehouse transfer the measurements made the strongest case for.

## What the measurements changed

Nothing, and that is the recorded outcome rather than an absence of one. `npm run balance:report` re-ran Increment 5's sixteen-row raw-producer sweep at three commits and it is byte-identical at all of them, so this increment moved nothing it did not intend to. One constant — `inputBufferCap` — had a clear measured case for doubling and was retuned on a branch; a second measurement on a two-consumer chain showed the change halving the far consumer's output, because that cap is currently the dispatcher's only fairness floor. It stays at 12 until the ranking has a deliberate one. Spec §4.2 has both readings.

The storehouse measured worse than §1 of the spec argued: with no store-to-store transfer a depot can be filled by a building's output and never emptied, so it pays once and then stops, and beside a camp-fed processor it is a net loss. Spec §4.3 states the disagreement rather than editing §1 to match.

## Documentation

- Spec: `docs/superpowers/specs/2026-08-09-increment-7-two-way-haul-and-storage.md` — §4 records what the harness measured, §4.2 the retune that was tried and reversed, §4.3 where §1 and the numbers disagree
- Plan: `docs/superpowers/plans/2026-08-09-increment-7-two-way-haul-and-storage.md`
- `docs/superpowers/specs/2026-07-31-increment-4-logistics.md` §1.1, §1.2 — the half of "goods stop teleporting" that shipped first
- `docs/superpowers/specs/2026-08-08-increment-6-survival-and-population.md` §2.15
- See also: [[Storehouse-to-Storehouse Transfer]], [[Roads and Pathfinding]], [[Construction as Work]]
