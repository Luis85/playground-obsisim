#!/usr/bin/env node
// LOC ratchet over src/**/*.{ts,vue}: new files above the cap fail; baselined
// hotspots may shrink but never grow; stale baseline entries fail (keeps the
// baseline minimal and honest). Ported from specorator's check-loc gate.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportGateResult } from './gate-result.mjs';

const BASELINE_PATH = 'scripts/loc-baseline.json';
const update = process.argv.includes('--update');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|vue)$/.test(entry)) yield path;
  }
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const maxLoc = baseline.maxLoc;
const counts = new Map();
for (const file of walk('src')) {
  const loc = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  counts.set(file.replaceAll('\\', '/'), loc);
}

if (update) {
  const files = {};
  for (const [file, loc] of [...counts].sort()) {
    if (loc > maxLoc) files[file] = { loc, reason: baseline.files[file]?.reason ?? 'TODO: justify or split' };
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ maxLoc, files }, null, 2)}\n`);
  console.log(`loc baseline updated (${Object.keys(files).length} entries)`);
  process.exit(0);
}

const failures = [];
for (const [file, loc] of counts) {
  const entry = baseline.files[file];
  if (loc <= maxLoc) {
    if (entry) failures.push(`${file}: baseline entry is stale (now ${loc} <= ${maxLoc}) — remove it`);
  } else if (!entry) {
    failures.push(`${file}: ${loc} nonblank lines exceeds the ${maxLoc} cap — split it, or baseline it with a reason`);
  } else if (loc > entry.loc) {
    failures.push(`${file}: grew ${entry.loc} -> ${loc}; grandfathered files may only shrink`);
  }
}
for (const file of Object.keys(baseline.files)) {
  if (!counts.has(file)) failures.push(`${file}: baseline entry is stale (file deleted) — remove it`);
}

reportGateResult('LOC guard', failures, `LOC guard ok (${counts.size} files, cap ${maxLoc})`);
