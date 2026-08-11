---
id: OBS-8-04
title: A colony whose whole fleet carries below minTransferUnits cannot drain a saturated depot whose surplus clears the threshold
status: Open
severity: minor
area: engine
increment: 8
created: 2026-08-11
source: found twice independently — self-reported by increment-8 task C's implementer and adjudicated by its re-review as pre-existing, and raised as a Codex thread on PR #13 (haul-transfer.ts:346, "Let low-capacity fleets restore depot headroom") which asks for a fix rather than a note
affects:
  - src/engine/systems/haul-transfer.ts
  - src/engine/content/balance.ts
type: Issue
parent: "[[Storehouse-to-Storehouse Transfer]]"
order: 280
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# An all-small-hauler colony cannot drain a depot whose surplus clears the threshold

## What happens

`haulerCapacity` (`src/engine/systems/haul-system.ts`) is
`max(1, round(haulCarryCapacity × commuteFactor))`. With `haulCarryCapacity: 6`,
`homelessFactor: 0.5` and `commute.floor: 0.5`, it bottoms out at **3** — for a
hauler with no bed, or one commuting far enough to hit the floor.
`minTransferUnits` is **4**.

A full 60-unit depot with four or more surplus units of its fullest resource is
therefore stuck when *every* hauler in the colony is at 3:

- The drain's exemption does not fire. `siteDoingItsBest` is
  `surplus < minTransferUnits && surplus < drainNeed`, and the first clause is
  false — the site can offer a full-sized load, so it is not the site that is
  stuck.
- The flat gate refuses the trip. `movable = min(3, surplus, drainNeed) = 3`,
  below the threshold of 4, so `candidateOf` returns null.

If nothing else spends that resource, the depot stays saturated indefinitely and
every nearby collect deposit goes back to bypassing it — which is increment 7's
§4.3 defect, arriving through a fourth door.

## Why it matters, and what is *not* true of it

**It is pre-existing and was not worsened by this increment.** Review verified
that before `04623ae` an all-capacity-3 colony could drain nothing sub-threshold
either; the drain exemption added this round is strictly a *widening*, and every
state it refuses was already refused. The interaction is between
`minTransferUnits` and `haulerCapacity`'s floor, both of which predate transfer.

**Do not repeat the framing that this is "identical for staging". It is not**,
and the asymmetry is the entire basis of the exemption this increment added:

| refused transfer | what happens to the goods | recoverable? |
| --- | --- | --- |
| **staging** | the goods stay where they are, above nobody's demand at their current site; the ordinary **supply** job can still fetch them from there for any building that needs them | yes — a different job serves the same need |
| **drain** | nothing else restores the headroom. By construction a drainable holding sits *above* every nearby building's demand, so no supply candidate wants it; collect only ever adds. The site stays full | **no** — the refusal is permanent |

A refused staging transfer costs a shortcut. A refused drain costs the site.

**The one state where the site genuinely cannot help itself is already
covered.** The split-surplus depot — four consumers of four different inputs,
15 of each in 60 units against a demand of 12 each, four surpluses of 3 — drains
for a capacity-3 hauler today, because there `surplus < minTransferUnits` holds
and the exemption fires. There is a fixture for exactly that (`a hauler too
small to carry the threshold does not get the exemption`, whose second
non-vacuity half asserts the same small hauler *does* drain the split-surplus
depot). What this issue covers is the complement: a surplus at or above the
threshold with a fleet that cannot lift it.

## Suggested resolution

**Codex's framing, recorded as asked for rather than paraphrased away:** the
drain exemption "must also provide a path for such fleets". That is a stronger
claim than the internal review reached, and it is the right one to weigh first —
the internal review's answer was that a later full-capacity hauler will drain the
site, and that answer simply does not hold for a colony whose entire fleet is at
the floor.

Three shapes worth weighing, none free:

- **Gate the exemption on the fleet rather than on the site** — exempt when *no
  hauler in the colony* can clear the threshold. Correct in effect, but it makes
  a per-site dispatch decision depend on a colony-wide aggregate, which is a new
  kind of coupling in a rule set that has so far been strictly local.
- **Make `minTransferUnits` relative to the dispatching hauler's capacity**
  rather than absolute — e.g. exempt when `minTransferUnits > haulerCapacity`.
  Local and cheap, and it says the honest thing: a threshold no hauler can reach
  is not a threshold. It does widen the gate for staging too unless it is
  parameterised the way `minUnits` already is.
- **Retune `minTransferUnits` to 3.** Swept in §4.2 point 6 and this is the
  argument against: at 2 the corner chain reads 831 planks against 1,062 at the
  shipped 4 — the mechanic runs harder and does worse. 3 was not swept, and would
  have to be.

**Why this increment declined to fix it.** The drain gate was already narrowed
once this round after a Critical finding (`2622be2`), and §4.2 was measuring
those exact formulas at the time. Changing a dispatch formula immediately before
the task that measures it is the pattern §1.2 and §4.3 exist to prevent. Whatever
lands here re-opens the +81 / +126 / +222 / +343 table and must re-take it.
