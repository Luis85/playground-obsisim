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
    // External, not inline: an inline base64 map made main.js ~1.5 MB when the
    // real code is ~159 kB, so the artifact budget was measuring sourcemap bytes
    // and sat at 99.4% with ~9 kB of headroom — any new source file tripped it.
    // Debuggability is unchanged (the map ships beside main.js in the vault).
    sourcemap: true,
  },
});
