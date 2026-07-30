#!/usr/bin/env node
// Build the plugin and install it into an Obsidian vault's plugin folder.
// Default target is this repo's own .obsidian/plugins/obsisim so the
// repository can be opened directly as a vault; pass a path to target
// another vault (e.g. node scripts/test-build.mjs ~/vault/.obsidian/plugins/obsisim).
//
// Uses Vite's Node API instead of spawning `npx vite build`: on Windows,
// npx is npx.cmd and execFileSync fails with spawnSync ENOENT.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';

const SOURCE = 'demo-vault/.obsidian/plugins/obsisim';
const TARGET = process.argv[2] ?? '.obsidian/plugins/obsisim';

await build(); // resolves vite.config.ts from the repo root
mkdirSync(TARGET, { recursive: true });
// main.js.map included: the sourcemap is external (see vite.config.ts), so an
// installed build needs it alongside main.js to stay debuggable
for (const name of ['main.js', 'main.js.map', 'manifest.json', 'styles.css']) {
  copyFileSync(join(SOURCE, name), join(TARGET, name));
}
console.log(`test build installed into ${TARGET}`);
