#!/usr/bin/env node
// Fallow quality ratchet: counters may shrink but not grow; floors may rise but
// not drop; structural counters and criticalComplexity are pinned at 0 — bumping
// them is an architecture decision (ADR territory), not a metric trade-off.
//
// The maintainability floor is the WORST SINGLE src/ file, not a mean over every
// analysed file. A mean falls whenever an increment adds an ordinary file — the
// overall mean sits above both the src/ and tests/ means, propped up by a handful
// of trivial build scripts — so it dropped for reasons unrelated to maintainability
// getting worse, and it penalised decomposition. See docs/build-ci/quality-gates.md.
//
// Most of the comparison runs at module scope on purpose: fallow scores CRAP per
// *function*, and a branchy helper with no test coverage trips the very
// complexFunctions counter this script gates. Keep extracted helpers trivial.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASELINE_PATH = 'scripts/quality-baseline.json';
const update = process.argv.includes('--update');
const allowRegression = process.argv.includes('--allow-regression');

if (existsSync('coverage')) {
  console.error(
    'check:quality must run without a coverage/ directory: fallow switches to istanbul coverage and CRAP-based counts skew. Delete coverage/ and re-run.',
  );
  process.exit(1);
}

// Test seam: point at a saved fallow report instead of shelling out, so the
// gate's own failure modes can be exercised without corrupting the working tree.
const reportOverride = process.env.FALLOW_REPORT_JSON;
const raw = reportOverride
  ? readFileSync(reportOverride, 'utf8')
  : // shell:true on Windows: npx is npx.cmd there, and execFileSync without a
    // shell fails with spawnSync ENOENT (static args, so no quoting hazard)
    execFileSync('npx', ['fallow', '--format', 'json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
const report = JSON.parse(raw);

const mean = (scores) =>
  Math.round((scores.reduce((sum, f) => sum + f.maintainability_index, 0) / scores.length) * 100) / 100;
const lower = (a, b) => (b.maintainability_index < a.maintainability_index ? b : a);
const byScore = (a, b) => a.maintainability_index - b.maintainability_index;
const since = (before) => (before === undefined ? '' : ` (was ${before})`);

const fileScores = report.health.file_scores;
const srcScores = fileScores.filter((f) => f.path.startsWith('src/'));
const testScores = fileScores.filter((f) => f.path.startsWith('tests/'));

// A floor over an empty set passes vacuously, so a fallow config that stopped
// matching src/ would silently disable the gate rather than fail it.
if (srcScores.length === 0) {
  console.error(
    `No src/ files in fallow's file_scores (${fileScores.length} files analysed). The maintainability floor would pass vacuously, so this is a hard failure.`,
  );
  process.exit(1);
}

const worstSrc = srcScores.reduce(lower);

const current = {
  deadCodeIssues: report.check.summary.total_issues,
  circularDependencies: report.check.summary.circular_dependencies,
  reExportCycles: report.check.summary.re_export_cycles,
  boundaryViolations: report.check.summary.boundary_violations,
  cloneGroups: report.dupes.stats.clone_groups,
  duplicatedLines: report.dupes.stats.duplicated_lines,
  complexFunctions: report.health.summary.functions_above_threshold,
  criticalComplexity: report.health.summary.severity_critical_count,
  worstSrcFileMaintainability: worstSrc.maintainability_index,
};

// Tracked, printed against its locked value, never gated: enough to notice broad
// drift the worst-file floor cannot see, without putting a mean back on the ratchet.
const reported = {
  srcMean: mean(srcScores),
  testsMean: testScores.length ? mean(testScores) : null,
  overallMean: mean(fileScores),
};

const PINNED_AT_ZERO = ['circularDependencies', 'reExportCycles', 'boundaryViolations', 'criticalComplexity'];
const SHRINK_ONLY = ['deadCodeIssues', 'cloneGroups', 'duplicatedLines', 'complexFunctions'];
const FLOORS = ['worstSrcFileMaintainability'];
const GATED = [...PINNED_AT_ZERO, ...SHRINK_ONLY, ...FLOORS];

const hasBaseline = existsSync(BASELINE_PATH);
const baseline = hasBaseline ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

// Validated BEFORE the --update branch: a baseline missing a gated entry has
// no value to compare against, so every comparison against it below silently
// passes (current[key] > undefined and current[key] < undefined are both
// false) and --update would re-lock whatever the current number happens to
// be, with no regression ever detected. Only meaningful once a baseline
// already exists — the first --update creates one from nothing.
const known = new Set([...GATED, 'reported']);
const schemaErrors = [];
if (hasBaseline) {
  const unknown = Object.keys(baseline).filter((key) => !known.has(key));
  if (unknown.length) schemaErrors.push(`baseline has entries the gate does not read: ${unknown.join(', ')}`);
  const missing = GATED.filter((key) => !(key in baseline));
  if (missing.length) schemaErrors.push(`baseline is missing gated entries: ${missing.join(', ')} (re-lock with --update --allow-regression)`);
}

const failures = [];
const improvements = [];
const regressions = [];
const pinnedBreaches = [];

for (const key of PINNED_AT_ZERO) {
  if (current[key] > 0) pinnedBreaches.push(`${key}: ${current[key]} (pinned at 0 — fix the finding, do not bump the baseline)`);
}
for (const key of SHRINK_ONLY) {
  if (current[key] > baseline[key]) regressions.push(`${key}: ${baseline[key]} -> ${current[key]} (counters may not grow)`);
  else if (current[key] < baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}
for (const key of FLOORS) {
  if (current[key] < baseline[key])
    regressions.push(`${key}: ${baseline[key]} -> ${current[key]}, worst is ${worstSrc.path} (floors may not drop)`);
  else if (current[key] > baseline[key]) improvements.push(`${key}: ${baseline[key]} -> ${current[key]}`);
}

if (update) {
  // --update locks whatever it measures, so on its own it will happily write a
  // regression into the baseline and turn a red gate green. Refuse by default.
  if (schemaErrors.length && !allowRegression) {
    console.error(
      `Refusing to re-lock a malformed baseline:\n${schemaErrors.map((f) => `  - ${f}`).join('\n')}\nA missing gated entry has no value to compare against, so the ratchet cannot see a regression in it. Re-run with --allow-regression and record why in docs/build-ci/quality-gates.md.`,
    );
    process.exit(1);
  }
  if (pinnedBreaches.length) {
    console.error(
      `Refusing to lock a baseline with pinned-at-zero breaches (no --allow-regression escape: raising these is an ADR decision, not a baseline edit):\n${pinnedBreaches.map((f) => `  - ${f}`).join('\n')}`,
    );
    process.exit(1);
  }
  if (regressions.length && !allowRegression) {
    console.error(
      `Refusing to lock a baseline that loosens the ratchet:\n${regressions.map((f) => `  - ${f}`).join('\n')}\nFix the regression, or re-run with --allow-regression and record why in docs/build-ci/quality-gates.md.`,
    );
    process.exit(1);
  }
  const locked = { ...current, reported };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(locked, null, 2)}\n`);
  console.log(`quality baseline locked: ${JSON.stringify(locked)}`);
  process.exit(0);
}

if (!hasBaseline) {
  console.error(`Missing ${BASELINE_PATH} — lock one with \`npm run check:quality -- --update\`.`);
  process.exit(1);
}

// schemaErrors was computed above (before the --update branch) so both paths
// see the same malformed-baseline check.
failures.push(...schemaErrors, ...pinnedBreaches, ...regressions);

const was = baseline.reported ?? {};
console.log(
  `maintainability floor: worst src/ file is ${current.worstSrcFileMaintainability} (${worstSrc.path}), floor ${baseline.worstSrcFileMaintainability}`,
);
console.log(
  `  not gated — src mean ${reported.srcMean}${since(was.srcMean)}, tests mean ${reported.testsMean}${since(was.testsMean)}, overall mean ${reported.overallMean}${since(was.overallMean)}`,
);
console.log(
  `  closest to the floor — ${[...srcScores].sort(byScore).slice(0, 3).map((f) => `${f.maintainability_index} ${f.path}`).join(', ')}`,
);

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
