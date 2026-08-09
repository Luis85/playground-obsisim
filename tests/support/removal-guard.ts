import { afterEach } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { RemovalLedger } from '../../src/engine/resources';

/**
 * Fails any test that queued an entity removal and never applied it.
 *
 * WHY THIS SHAPE. Since OBS-6-02 a death or a demolition only reaches the
 * world through `RemovalLedger` + `applyRemovals`, and a tick driven by a bare
 * `await world.step()` performs the first half and skips the second. Five test
 * sites have now made that mistake, each found by hand, one at a time.
 *
 * The obvious guard — an eslint ban on bare `world.step()` in tests — was
 * costed and rejected. There are ~56 such calls across nine files and only the
 * handful in worlds running CommandSystem or PopulationSystem can queue
 * anything, so a ban is ~50 false positives held back by an allowlist that
 * rots as fixtures change, and it says nothing about a sixth site that reaches
 * the same state through some new helper.
 *
 * This asserts the STATE instead of the syntax, which makes it silent for
 * every test that never removes anybody — no allowlist, nothing to keep in
 * sync — and loud for exactly the tests where a dropped removal changed what
 * was being measured. It is also indifferent to HOW a test drove the tick,
 * which is what lets `tests/engine/systems/command-system.test.ts` keep its
 * deliberate exception: that file calls `applyRemovals` by hand rather than
 * `stepTick`, because a snapshot refresh would erase the same-tick deferrals a
 * dozen of its cases assert on. It drains, so it passes here, unexempted.
 *
 * WHAT IT CANNOT DO. It only fires once something is actually queued, so it
 * cannot see a bare step in a world where nothing ever dies — the balance
 * harness's `runScenario` is exactly that today. The drain there is upkeep the
 * guard will start protecting the day a scenario outlives a founder or issues
 * a demolition, and not before. That is the deliberate trade for the ~50
 * false positives a syntactic rule would have cost.
 */
const loaded = new Set<RemovalLedger>();

const queueRemoval = RemovalLedger.prototype.remove;
RemovalLedger.prototype.remove = function trackedRemove(this: RemovalLedger, entity: Readonly<IEntity>): void {
  loaded.add(this);
  queueRemoval.call(this, entity);
};

afterEach(() => {
  // `drain` rather than a peek: it is the ledger's own public reader, so this
  // measures the real queue rather than a mirror of it that could drift, and
  // emptying a ledger whose world the test is finished with costs nothing.
  const stranded = [...loaded].reduce((sum, ledger) => sum + ledger.drain().length, 0);
  loaded.clear();
  if (stranded > 0) {
    throw new Error(
      `RemovalLedger guard: ${stranded} entity removal(s) were queued during this test and never applied, `
      + 'so the entities are still in the world and every assertion after that point measured a colony where '
      + 'nothing can die and nothing can be demolished. A bare `await world.step()` does not drain the ledger: '
      + 'drive the tick with `stepTick` (tests/engine/fixtures.ts), or call `applyRemovals(world)` after the '
      + "step the way command-system.test.ts's `ticker` does.",
    );
  }
});
