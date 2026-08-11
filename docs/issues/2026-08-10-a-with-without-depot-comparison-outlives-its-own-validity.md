---
id: OBS-7-05
title: A with/without-depot comparison in the population harness is confounded by a colonist-id shift over any horizon that outlives a founder
status: Open
severity: minor
area: tests
increment: 7
created: 2026-08-10
source: increment-7 task 14 (measure), found while taking §4.1's fourth reading — the 12-house pair is byte-identical at 4,000 ticks and is not at 12,000
affects:
  - tests/support/population-harness.ts
  - tests/engine/balance.test.ts
type: Issue
parent: "[[The Balance Harness]]"
order: 230
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# A with/without-depot comparison outlives its own validity

## What happens

Two 12,000-tick runs of the same population scenario, differing only in
`storehouses: 0` against `storehouses: 2`, produce different sample series —
`JSON.stringify(samples)` differs — while `storedAtEnd` is 0 in **both**, so the
depots did nothing and cannot be what moved the curve.

They did not move it. Adding two storehouses spawns two more entities, which
shifts every colonist's id by two. `lifespanFor(id, bands)` jitters each
colonist's lifespan by id, so every founder in the second run draws a slightly
different lifespan from its counterpart in the first. Before the first old-age
death — around tick 5,700 — the two runs are indistinguishable; after it, they
diverge for a reason that has nothing whatever to do with a depot.

At 4,000 ticks the same pair *is* byte-identical, which is why this went
unnoticed until a reading was taken at a generation's length.

## Why it matters

The reading it nearly spoiled is a real one and a careful one. §4.1's fourth
question asks whether `birthFoodPerHead: 12` still holds with a live depot in the
colony over a full generation, and 12,000 ticks is chosen precisely so two birth
waves fit inside it. That horizon is, by construction, longer than a founder
lives — so the confound is not an edge case at that fixture, it is guaranteed.

The reading as recorded is honest because every figure it quotes — peak, final,
trough, births, deaths of old age, starvation deaths, minimum meals per head —
agrees across all four runs. What is *not* available at that horizon is a tighter
comparison: anything asserting sample-for-sample equality, or reading a small
difference as an effect, would be measuring lifespan jitter.

This will bite again. The natural next use of this harness is exactly the same
shape — "run the colony with and without the thing this increment added, over a
generation" — and the entity-id shift happens for any scenario field that spawns
entities, not only for depots.

## Suggested resolution

Record it where the next person will read it, and prefer a design that removes
it over a rule that remembers it.

The doc comment on `PopulationScenario.storehouses`
(`tests/support/population-harness.ts`) already carries the *placement* trap —
that a small colony's depot is never nearest to anything, so `storedAtEnd` is 0
and the comparison compares a run against itself. This is its sibling and
belongs beside it: **below the first old-age death a with/without pair is
comparable digit for digit; above it, only aggregate outcomes are.**

The structural fix, if a future increment needs the tighter comparison, is to
stop deriving lifespan jitter from the entity id. A colonist-scoped salt that
does not move when unrelated entities are spawned — a birth ordinal, say —
would make the two runs comparable at any horizon. That is a change to
`lifespanFor` and therefore to what every existing population figure means, so
it should be taken deliberately by an increment that needs it rather than
folded into a test-support fix.

Whichever way it goes, the assertion that catches the confound is cheap: run
the pair at a horizon **below** the first old-age death and require them
identical there. That pins the harness's determinism without pinning the
jitter.

## Status after increment 8 — the cheap guard landed, the structural fix did not

**Half done, deliberately, and the halves are named so the next reader does not
have to diff for them.**

**Landed.** The cheap assertion this section asked for exists:
`tests/engine/balance.test.ts`, *"a with/without-depot pair is identical below
the turnover horizon"* — the same population scenario at `storehouses: 0` and
`storehouses: 2` over 2,400 ticks, `JSON.stringify(samples)` required equal,
plus `births` and `deathsByStarvation`. Three premises are **asserted rather
than reasoned**, which is what makes it a determinism guard instead of a claim
that depots change nothing: `deathsByOldAge === 0` in both arms (inside the
window by measurement, not by arithmetic), `births > 0` (a pair that never bred
would match trivially), and `storedAtEnd === 0` in both.

The sibling doc comment this section asked for is on
`PopulationScenario.storehouses` beside the placement trap, in the words this
section chose: **below the first old-age death a with/without pair is comparable
digit for digit; above it, only aggregate outcomes are.**

**One thing the fix taught that this issue did not know.** The horizon is a
property of the *fixture*, not a constant. `spawnFounders` in the population
harness starts its adults at `matureTicks`, so retirement falls at elapsed 4,500
and the earliest old-age death at 4,700; the *balance* harness's founders
(`BALANCE.startingAgeTicks`) put the same two events at 3,000 and 3,200. Doing
that arithmetic to decide a run is safe is how increment 8's own §4.2 drafted a
4,800-tick run described as "still below the first old-age death" when every
founder had in fact died by then. Both harnesses now carry the arithmetic in a
comment and the tests assert `deathsByOldAge` instead of trusting it.

**Not landed, and out of scope by §2.13.** The structural fix — a colonist-scoped
salt (a birth ordinal) replacing the entity id in `lifespanFor` — was not
attempted. It redefines what every existing population figure means, so it still
belongs to an increment that needs the tighter comparison rather than to a
test-support fix. **This issue therefore stays `Open` at `minor`**: the confound
is guarded and documented, and it is not removed.
