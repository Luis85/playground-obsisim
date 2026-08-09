import { describe, expect, it } from 'vitest';
import { RemovalLedger } from '../../src/engine/resources';

describe('removal guard', () => {
  it('is installed in every test worker', () => {
    // The guard lives in `tests/support/removal-guard.ts` and reaches tests
    // only through `setupFiles` in vitest.config.ts. Deleting that one line
    // disables it everywhere, silently and with the whole suite still green —
    // which is the exact failure mode it exists to prevent, so it needs a
    // check of its own.
    //
    // Asserting on the PATCHED PROTOTYPE, not on the module: importing
    // removal-guard.ts here would prove only that the file exists, since the
    // module is already cached in this worker. `RemovalLedger.prototype.remove`
    // is the guard's own wrapper if and only if the setup file actually ran.
    expect(RemovalLedger.prototype.remove.name).toBe('trackedRemove');
  });
});
