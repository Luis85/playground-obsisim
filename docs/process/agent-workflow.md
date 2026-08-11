# Working agreements for agent-driven increments

Increments 3–5 were built by dispatching subagents against a written plan. Each
rule below exists because breaking it cost something real, and the cost is named
so the rule can be argued with rather than merely obeyed.

## Git

**Commit by pathspec — `git commit <path> -m …`, never `git add` + bare
`git commit`.**

Parallel agents share one working tree *and one git index*. Staging by explicit
path is not enough: `git commit` with no pathspec commits whatever is in the
index, not what you staged. In increment 4 two agents with no file overlap
collided anyway — one staged between the other's `git add` and `git commit`, and
90 unrelated lines were swept into `ff9e065`, corrected forward in `3308eca`.
Committing by pathspec ignores the index entirely and closes the race.

A new file must still be `git add`-ed once before it can be named in a pathspec
commit. Do that immediately before the commit, not at the start of the work.

**The real fix is a worktree per writing agent** (`git worktree`), which removes
the shared index and the shared tree together, and additionally stops a reviewer
from seeing another agent's half-finished edits — a separate problem that
recurred through increment 4 and had to be papered over by telling reviewers not
to run the suite. Adopt it the next time more than one agent writes at once.
Serialising writers is the cheaper middle option. See OBS-4-05.

## Tests

**Mutation-test every test: break the feature, confirm the test fails, restore.**

Increment 4 shipped several tests that passed with the feature entirely removed
— including one guarding user-visible behaviour that survived deletion against
all 364 tests. A test that has never been seen to fail is a claim, not evidence.

Five failure modes recur — the first two found again in increment 5, the third
in increment 7, and the last two in increment 8:

- **Indistinguishable fixture values.** A test asserting `0.00` where the wrong
  field also holds `0` proves nothing. Increment 5's first draft of the
  `Delivered/t` test survived a mutation pointing the column at
  `consumptionRate`; it was fixed by giving the three fields distinct values (0
  delivered, 0.50 consumed, 4 in stock).
- **The assertion never reaches the code path.** Increment 5's first
  test-only-system case placed the unknown system *last*, where nothing follows
  it, so a mutation that mis-ranked unknown systems changed nothing observable.
- **Every clause of a compound boolean needs its own fixture.** The two rules
  above are not enough on their own: increment 7's whole-branch review found
  ten defects of this one shape. Each was a single clause inside a condition
  whose OTHER clause was gated — so mutating the *whole* condition reddened the
  gated chain regardless of the untested clause, and that whole-condition
  mutation looked like coverage. `worthMoving`'s `|| movable >= held` (a
  gated first clause hid an untested escape hatch that could strand goods
  permanently) and `remainderHome`'s exact-fit boundary (a gated capacity
  check hid an untested `>` vs `>=`) both shipped this way. Test each clause
  with a fixture where the *other* clause is false, so this one alone has to
  carry the assertion.
- **One hauler cannot test a bound that only the tenth would breach.** A rule
  that sizes a claim reads the same answer for every agent dispatched inside one
  tick, because physical state does not move until somebody *arrives* — so a
  fixture with one or two haulers passes identically whether the bound is
  reservation-aware or not. Increment 8 shipped three such terms in drafts and
  found a fourth in review: `starving` derived from an empty in-tray alone (every
  idle hauler promoted to the same building), `drainNeed` unnetted against
  `plannedOutAt` (ten haulers schedule all 60 units of a depot for removal
  instead of the 12 that restore its floor), and `surplus` sized from physical
  stock rather than `unclaimedAt` (two haulers claim the same units). Each cost a
  review round on the spec alone. **Ask of every bound: if ten idle agents were
  dispatched on the same tick, would this have stopped the tenth?** — and write
  the fixture with as many agents as it takes to answer, which is usually three,
  not two: two is the smallest number that can double-book, and three is the
  smallest that can show the bound *ending*.
- **A test that passes with the feature inert.** `storehouse balance` asserted
  `chainDepot.storedAtEnd > 0` and `made > plain * 1.05`. Both passed with the
  transfer mechanic never once dispatched: a depot that fills to 60 of 60 and
  stops satisfies `> 0` exactly as well as one that turns over, and the one-off
  buffer cleared the 5% margin on its own. Ten tasks of machinery were built,
  instrumented and reviewed before anyone asked whether it ran. The other four
  entries are about a test that cannot distinguish the bug from the fix; this one
  is about a test that cannot distinguish the feature from its absence. **Assert
  that the mechanism fired** — a count of the thing happening, pinned against a
  control where it cannot happen — not only that the world looks as though it
  might have. The fix that caught it is worth naming as the method: the
  counter-assertion was added **first and seen red** (`expected 0 to be greater
  than 0` at `3cd1df4`) before any dispatch change was made.

Where an integration test cannot isolate a rule, export the rule and unit-test
it directly — `cheapestHaulerToRelease` is exported for exactly that reason,
because the integration test could not separate its phase term from its
tiebreak.

**No vitest test may import `src/app/world/renderer.ts`, `graphics-cache.ts`
or `glyphs.ts`.** Excalibur throws on import outside a browser. Their only
coverage is `npm run smoke:world`, which is why that suite's strength is
load-bearing. The list grows whenever the renderer is split for the line
budget — `glyphs.ts` joined it in increment 7 — so extend it in the same
commit as the split, or the rule silently stops covering the code it exists
for. `src/app/world/layout.ts` is deliberately NOT on it: it is plain
TypeScript, it is where the geometry belongs, and it is unit-tested.

**Change one thing per fixture phase**, and say so in the phase's name when it
must change several. Nearly every smoke check has the shape
`!after.equals(before)`, so a phase that moves five things at once keeps the
comparison true for reasons unrelated to the check's name. The haul phases did
exactly that, and the check named "the hauler returns to camp carrying its load"
would have stayed green with the load marker entirely absent — verified, not
assumed (OBS-4-04). Splitting them into four single-change phases fixed it.

Mutation-test smoke checks the same way as unit tests: disable the feature in
`renderer.ts` or `layout.ts` and confirm the named check — and only that check —
goes red.

## Briefs

**Pre-flight every task brief against the real files before dispatching.**

Roughly half of increment 4's briefs contained an error — a helper that did not
exist, a wrong expected value, a positional parameter that would have silently
corrupted eight call sites. Implementers caught them only because they were told
to push back rather than guess. Keep telling them that, and keep checking the
brief against the code first.

## Quality gates

**Never `--update` a baseline to make a gate pass.** As of increment 5
`check:quality --update` enforces this itself: it refuses to write a loosened
value without `--update --allow-regression`, and refuses pinned-at-zero breaches
even then. The rule predates the enforcement because discipline alone was not
working — increment 5's own gate rewrite tripped `complexFunctions` 0 → 1 and
`--update` locked the regression without a word.

**Never pad comments to buy maintainability points.** Fallow's MI has no length
term; comments are lines and lines are the denominator of complexity density, so
padding raises the score without improving anything. See
`docs/build-ci/quality-gates.md`.
