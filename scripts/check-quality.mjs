#!/usr/bin/env node
// Fallow quality ratchet: counters may shrink but not grow; floors may rise but
// not drop; structural counters and criticalComplexity are pinned at 0 — bumping
// them is an architecture decision (ADR territory), not a metric trade-off.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE_PATH = 'scripts/quality-baseline.json';
const update = process.argv.includes('--update');

if (existsSync('coverage')) {
  console.error(
    'check:quality must run without a coverage/ directory: fallow switches to istanbul coverage and CRAP-based counts skew. Delete coverage/ and re-run.',
  );
  process.exit(1);
}

const raw = execFileSync('npx', ['fallow', '--format', 'json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const report = JSON.parse(raw);

const current = {
  deadCodeIssues: report.check.summary.total_issues,
  circularDependencies: report.check.summary.circular_dependencies,
  reExportCycles: report.check.summary.re_export_cycles,
  boundaryViolations: report.check.summary.boundary_violations,
  cloneGroups: report.dupes.stats.clone_groups,
  duplicatedLines: report.dupes.stats.duplicated_lines,
  complexFunctions: report.health.summary.functions_above_threshold,
  criticalComplexity: report.health.summary.severity_critical_count,
  maintainability: report.health.summary.average_maintainability,
};

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`quality baseline locked: ${JSON.stringify(current)}`);
  process.exit(0);
}

const PINNED_AT_ZERO = ['circularDependencies', 'reExportCycles', 'boundaryViolations', 'criticalComplexity'];
const SHRINK_ONLY = ['deadCodeIssues', 'cloneGroups', 'duplicatedLines', 'complexFunctions'];
const FLOORS = ['maintainability'];

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const failures = [];
const improvements = [];

for (const key of PINNED_AT_ZERO) {
  if (current[key] > 0) failures.push(`${key}: ${current[key]} (pinned at 0 — fix the finding, do not bump the baseline)`);
}
for (const key of SHRINK_ONLY) {
  if (current[key] > baseline[key]) failures.push(`${key}: ${baseline[key]} -> ${current[key]} (counters may not grow)`);
  else if (current[key] < baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}
for (const key of FLOORS) {
  if (current[key] < baseline[key]) failures.push(`${key}: ${baseline[key]} -> ${current[key]} (floors may not drop)`);
  else if (current[key] > baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}

if (failures.length) {
  console.error(`Quality ratchet failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
if (improvements.length) {
  console.log(
    `Unlocked improvements — lock them in with \`npm run check:quality -- --update\`:\n${improvements.map((f) => `  - ${f}`).join('\n')}`,
  );
}
console.log('quality ratchet ok');
