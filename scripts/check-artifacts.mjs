#!/usr/bin/env node
// Post-build gate (does not build): artifacts exist and are non-empty, versions
// are in sync, minAppVersion present, bundles within byte budgets. Bump a budget
// deliberately, with a reason in the PR, when a real dependency pushes it up.
import { readFileSync, statSync } from 'node:fs';

const DIR = 'demo-vault/.obsidian/plugins/obsisim';
// main.js: 5 MB — excalibur@0.32 adds ~2.8 MB (code + inline sourcemap) to a
// 1.5 MB bundle; measured in spec 2026-07-30-increment-2 §2.1.
const BUDGETS = { 'main.js': 5_000_000, 'styles.css': 50_000, 'manifest.json': 10_000 };
const failures = [];

for (const [name, budget] of Object.entries(BUDGETS)) {
  let size = null;
  try {
    size = statSync(`${DIR}/${name}`).size;
  } catch {
    failures.push(`${name} missing — run npm run build first`);
  }
  if (size === 0) failures.push(`${name} is empty`);
  else if (size !== null && size > budget) failures.push(`${name} is ${size} bytes, over its ${budget}-byte budget`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
if (pkg.version !== manifest.version) failures.push(`version desync: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
if (!manifest.minAppVersion) failures.push('manifest.json missing minAppVersion');

if (failures.length) {
  console.error(`Artifact smoke failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('artifact smoke ok');
