import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = 'demo-vault/.obsidian/plugins/obsisim';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'copy-plugin-assets',
      closeBundle() {
        copyFileSync('manifest.json', `${outDir}/manifest.json`);
        copyFileSync('styles.css', `${outDir}/styles.css`);
      },
    },
  ],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['obsidian'],
      output: { exports: 'named' },
    },
    outDir,
    emptyOutDir: false,
    sourcemap: 'inline',
  },
});
