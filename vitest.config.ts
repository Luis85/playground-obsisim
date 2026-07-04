import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
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
