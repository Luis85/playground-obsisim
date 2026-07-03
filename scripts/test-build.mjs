#!/usr/bin/env node
// Build the plugin and install it into an Obsidian vault's plugin folder.
// Default target is this repo's own .obsidian/plugins/obsisim so the
// repository can be opened directly as a vault; pass a path to target
// another vault (e.g. node scripts/test-build.mjs ~/vault/.obsidian/plugins/obsisim).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'demo-vault/.obsidian/plugins/obsisim';
const TARGET = process.argv[2] ?? '.obsidian/plugins/obsisim';

execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
mkdirSync(TARGET, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  copyFileSync(join(SOURCE, name), join(TARGET, name));
}
console.log(`test build installed into ${TARGET}`);
