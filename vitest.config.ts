import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    // Applies to EVERY test file, which is the whole point: the removal guard
    // has to reach worlds built by helpers nobody has written yet. See the
    // file's own header for why it asserts ledger state rather than banning
    // bare `world.step()` calls.
    setupFiles: ['./tests/support/removal-guard.ts'],
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
