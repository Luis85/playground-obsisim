---
id: OBS-4-05
title: Parallel agents share one git index, so explicit-path staging does not prevent collisions
status: Done
severity: minor
area: process
increment: 4
created: 2026-08-01
resolved: 2026-08-01
source: increment-4, collision between the carried-load fix and Task 17
affects:
  - .claude/skills/subagent-driven-development
tags:
  - process
  - tooling
type: Issue
parent: "[[Engineering Quality and Balance Tooling]]"
order: 70
started: ""
finished: ""
horizon: ""
start: ""
due: ""
---

# Parallel agents share one git index

Increment 4 was executed by dispatching subagents that work concurrently in a
single checkout. They therefore share one working tree **and one git index**,
and that is enough for one agent's commit to capture another's work.

## What happened

Two agents ran at once: one fixing carried-load visibility (touching
`src/app/world/`, `styles.css`, `tests/app/`), one adding acceptance-criteria
tests (touching `tests/engine/systems/haul-system.test.ts`). No file overlap.

The fix agent ran `git add <explicit paths>` and then `git commit`. Between
those two commands the other agent staged its own file. The commit picked up the
index as it stood, sweeping 90 unrelated lines of
`tests/engine/systems/haul-system.test.ts` into commit `ff9e065`.

It was caught immediately and corrected forward in `3308eca`, restoring the
other agent's content as an uncommitted working-tree change. Both agents
independently confirmed no work was lost, and
`git diff 7418446 HEAD -- tests/engine/systems/haul-system.test.ts` was verified
empty afterwards. Cost: one redundant commit pair in the history.

## Why the existing mitigation is insufficient

Agents were already instructed to **stage by explicit path**, never `git add -A`
or `git add .`, precisely to avoid sweeping in foreign work. That instruction was
followed. It does not help, because `git commit` without a pathspec commits
*whatever is in the index*, not what that agent staged. Explicit-path staging
narrows what you add; it does not narrow what you commit.

## Mitigations, in increasing order of cost

1. **Commit by pathspec.** `git commit <path> -m …` commits the working-tree
   contents of those paths and ignores the index entirely. This is a one-word
   change to the agent contract and closes the specific race above. Used by the
   controller for the remainder of the increment with no further collisions.
2. **Serialise agents that write.** Reviewers and read-only agents can overlap
   freely; only one writer at a time. Costs wall-clock, and was the working
   assumption for much of this increment anyway.
3. **Give each writing agent its own worktree.** `git worktree` per agent
   removes the shared index and the shared tree together. The most robust
   option, and the only one that also stops a reviewer from seeing another
   agent's half-finished edits — a separate problem that recurred throughout
   this increment and had to be papered over by telling reviewers not to run
   the test suite.

Option 1 should be adopted immediately; option 3 is the real fix.

## Resolution

Option 1 is adopted as the standing contract and now has a durable home:
`docs/process/agent-workflow.md`. Every commit on the increment-5 branch used
`git commit <path> -m …`, and the rule is written down with the `ff9e065`
collision as its justification, so it survives the branch that learned it —
which was the actual risk, since the instruction previously lived only in
increment briefs.

The doc also records the one wrinkle pathspec commits have: a **new** file must
be `git add`-ed once before it can be named in a pathspec commit, which is a
narrow re-opening of the same race. Doing that `git add` immediately before the
commit, rather than at the start of the work, keeps the window to a moment.

Option 3 (a `git worktree` per writing agent) is **not** done and remains the
real fix — it removes the shared index and the shared tree together, and also
stops a reviewer seeing another agent's half-finished edits. It is recorded as
the thing to adopt the next time more than one agent writes concurrently.
Increment 5's issue clearing was executed by a single writer, so the race could
not arise and building worktree infrastructure for it would have been
speculative.
