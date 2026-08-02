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

Two failure modes recur, both found again in increment 5:

- **Indistinguishable fixture values.** A test asserting `0.00` where the wrong
  field also holds `0` proves nothing. Increment 5's first draft of the
  `Delivered/t` test survived a mutation pointing the column at
  `consumptionRate`; it was fixed by giving the three fields distinct values (0
  delivered, 0.50 consumed, 4 in stock).
- **The assertion never reaches the code path.** Increment 5's first
  test-only-system case placed the unknown system *last*, where nothing follows
  it, so a mutation that mis-ranked unknown systems changed nothing observable.

Where an integration test cannot isolate a rule, export the rule and unit-test
it directly — `cheapestHaulerToRelease` is exported for exactly that reason,
because the integration test could not separate its phase term from its
tiebreak.

**No vitest test may import `src/app/world/renderer.ts` or `graphics-cache.ts`.**
Excalibur throws on import outside a browser. Their only coverage is
`npm run smoke:world`, which is why that suite's strength is load-bearing.

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
