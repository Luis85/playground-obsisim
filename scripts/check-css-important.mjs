#!/usr/bin/env node
// !important ratchet over styles.css (comments excluded): any new use fails
// unless baselined with a reason; baselined files may shrink but never grow.
import { readFileSync, writeFileSync } from 'node:fs';
import { reportGateResult } from './gate-result.mjs';

const BASELINE_PATH = 'scripts/css-important-baseline.json';
const FILES = ['styles.css'];
const update = process.argv.includes('--update');

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const counts = new Map();
for (const file of FILES) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  counts.set(file, (css.match(/!important/g) ?? []).length);
}

if (update) {
  const files = {};
  for (const [file, count] of counts) {
    if (count > 0) files[file] = { count, reason: baseline.files[file]?.reason ?? 'TODO: justify or re-scope' };
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(`css baseline updated (${Object.keys(files).length} entries)`);
  process.exit(0);
}

const failures = [];
for (const [file, count] of counts) {
  const allowed = baseline.files[file]?.count ?? 0;
  if (count > allowed) {
    failures.push(`${file}: ${count} !important (allowed ${allowed}) — re-scope by specificity or CSS variables`);
  } else if (baseline.files[file] && count < allowed) {
    failures.push(`${file}: baseline is stale (${allowed} -> ${count}) — re-lock with --update`);
  }
}

reportGateResult('CSS !important guard', failures, 'CSS !important guard ok');
