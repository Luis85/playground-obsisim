import { configDefaults, defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

/**
 * The one file the `balance` project owns, named once and read by both
 * projects — the `unit` project excludes exactly what the `balance` project
 * includes. Two literals could drift apart and leave this file matched by
 * NEITHER project, which vitest reports as a suite that simply has fewer tests
 * in it. `scripts/check-test-projects.mjs` asserts the partition anyway, on the
 * resolved file lists rather than on this constant, because a guard that reads
 * the same constant as the thing it guards proves nothing (OBS-6-04).
 */
const BALANCE_FILE = 'tests/engine/balance.test.ts';

export default defineConfig({
  test: {
    // OBS-6-04. Three long-horizon tests in balance.test.ts were ~101s of a
    // ~120s suite, so `npm test` had quietly become a commit-cadence command
    // instead of a save-cadence one. Splitting them into their own project
    // gives back the fast inner loop WITHOUT the flag approach's cost: the
    // balance file still runs unconditionally, just under its own name, so
    // `frozenSteps` and the rest of its permanently-zero sentinels keep
    // running rather than waiting for someone to remember an env var.
    // `check:all` runs both projects; see docs/build-ci/test-projects.md.
    projects: [
      {
        plugins: [vue()],
        test: {
          name: 'unit',
          environment: 'node',
          // Applies to EVERY test file, which is the whole point: the removal
          // guard has to reach worlds built by helpers nobody has written yet.
          // See the file's own header for why it asserts ledger state rather
          // than banning bare `world.step()` calls.
          //
          // Written out per project rather than spread from a shared constant,
          // and that is not a style choice: vitest does not merge a root `test`
          // block into `projects` entries, so each one needs its own — and
          // fallow resolves this path by reading the literal. Behind a spread
          // it stopped seeing the reference and reported removal-guard.ts as an
          // unused file, which the dead-code ratchet caught.
          setupFiles: ['./tests/support/removal-guard.ts'],
          exclude: [...configDefaults.exclude, BALANCE_FILE],
        },
      },
      {
        plugins: [vue()],
        test: {
          name: 'balance',
          environment: 'node',
          // Same guard, same reasons — and a balance project running without it
          // would be a hole exactly where the longest simulations are.
          setupFiles: ['./tests/support/removal-guard.ts'],
          include: [BALANCE_FILE],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/engine/**', 'src/shared/**', 'src/app/**'],
      thresholds: {
        // the sim is the product: gate it hard. Views are gated by the LOC guard
        // and BuildingsView's interaction tests; their coverage floor comes later.
        'src/engine/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/shared/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/app/stores/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});
