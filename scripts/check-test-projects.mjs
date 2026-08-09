#!/usr/bin/env node
/**
 * OBS-6-04 gate: the balance suite cannot stop running without saying so.
 *
 * Splitting `tests/engine/balance.test.ts` into its own vitest project bought
 * back a ten-second inner loop, and bought with it two ways for a measurement
 * to go quiet while everything still reads green:
 *
 *   1. A test file matched by NEITHER project. Vitest does not complain — it
 *      reports a suite with fewer tests in it, which looks exactly like a suite
 *      that always had fewer tests in it.
 *   2. A balance job that is skipped, filtered away, or never scheduled. A
 *      skipped GitHub Actions job is not a failed one, and this repository has
 *      already had every workflow stop running for a day while the PR kept its
 *      green check (the check was a GitHub App, not Actions).
 *
 * So this asserts the wiring itself, from outside it: the resolved file lists
 * come from `vitest list`, never from the same constant vitest.config.ts uses,
 * and the gate wiring is read out of package.json and the workflow rather than
 * assumed. It is deliberately a text check on those two files; see
 * docs/build-ci/test-projects.md for what it can and cannot see.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const WORKFLOW = '.github/workflows/ci.yml';
/** The project whose absence is the whole point of this gate. */
const GUARDED_PROJECT = 'balance';
const failures = [];

/** Every test file on disk, as repo-relative POSIX paths. */
function testFilesOnDisk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFilesOnDisk(path));
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path.split(sep).join('/'));
  }
  return found;
}

/**
 * What vitest itself resolves, per project. `--filesOnly` collects without
 * running, so this costs under a second even though the balance project it
 * describes takes two minutes to execute.
 */
function resolvedFiles() {
  const raw = execFileSync('npx', ['vitest', 'list', '--filesOnly', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const byFile = new Map();
  for (const row of JSON.parse(raw)) {
    const path = relative(process.cwd(), row.file).split(sep).join('/');
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push(row.projectName);
  }
  return byFile;
}

// --- 1. Every test file belongs to exactly one project ------------------------
const resolved = resolvedFiles();
for (const file of testFilesOnDisk('tests')) {
  const projects = resolved.get(file) ?? [];
  if (projects.length === 0) failures.push(`${file} is matched by NO vitest project — it runs in neither suite and nothing reports that`);
  else if (projects.length > 1) failures.push(`${file} is matched by ${projects.length} projects (${projects.join(', ')}) — its tests are counted twice`);
}

// --- 2. The guarded project is not an empty set -------------------------------
// `vitest run --project balance` over zero files would exit 0 with nothing run,
// which is the silent stop wearing a green tick.
const guardedCount = [...resolved.values()].filter((p) => p.includes(GUARDED_PROJECT)).length;
if (guardedCount === 0) failures.push(`the '${GUARDED_PROJECT}' project matches no files — a run of it would pass having measured nothing`);

// --- 3. The pre-commit gate still runs the guarded project --------------------
// The decision recorded in docs/build-ci/test-projects.md is that check:all
// covers BOTH projects and stays slow. Trimming it back to the fast suite would
// reverse that decision silently, so it fails here instead.
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
const guardedFlag = `--project ${GUARDED_PROJECT}`;
/** check:all's own text plus the text of every `npm run X` it delegates to. */
const gateText = (scripts['check:all'] ?? '')
  .split('&&')
  .map((step) => {
    const name = step.trim().replace(/^npm run /, '');
    return scripts[name] ?? step;
  })
  .join(' && ');
if (!gateText.includes(guardedFlag)) failures.push(`check:all no longer runs \`vitest ${guardedFlag}\` — the pre-commit gate stopped covering balance`);

// --- 4. CI runs it as a job that cannot be skipped into a pass ----------------
let workflow = '';
try {
  workflow = readFileSync(WORKFLOW, 'utf8');
} catch {
  failures.push(`${WORKFLOW} is missing — CI cannot be running the ${GUARDED_PROJECT} project`);
}
if (workflow) {
  // Top-level jobs, split on the two-space indent `jobs:` entries use.
  const jobs = new Map();
  let current = null;
  for (const line of workflow.split('\n')) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) current = header[1];
    else if (/^\S/.test(line)) current = null;
    if (current) jobs.set(current, `${jobs.get(current) ?? ''}${line}\n`);
  }

  const runners = [...jobs].filter(([, body]) => body.includes(guardedFlag) || /npm run test:balance/.test(body));
  if (runners.length === 0) failures.push(`${WORKFLOW} has no job running the ${GUARDED_PROJECT} project`);
  for (const [name, body] of runners) {
    // A conditional job reports "skipped", and a skipped job is not a failed
    // one — it is the exact shape this gate exists to refuse.
    if (/^\s{4}if:/m.test(body)) failures.push(`${WORKFLOW} job '${name}' is conditional; a skipped balance job must not be mistakable for a passing one`);
    if (body.includes('continue-on-error')) failures.push(`${WORKFLOW} job '${name}' sets continue-on-error, so a balance failure would report green`);
  }

  // The aggregator: one job that reads every other job's RESULT and fails
  // unless each is literally 'success'. Without it, a required check passes
  // when its dependencies are skipped or cancelled.
  const aggregators = [...jobs].filter(([, body]) => body.includes('needs.*.result'));
  if (aggregators.length === 0) failures.push(`${WORKFLOW} has no job asserting on needs.*.result — skipped jobs would report as passing`);
  for (const [name, body] of aggregators) {
    if (!/if:\s*always\(\)/.test(body)) failures.push(`${WORKFLOW} job '${name}' must be \`if: always()\`, or it is itself skipped when a dependency is`);
    for (const [runner] of runners) {
      if (!new RegExp(`needs:[^\\n]*\\b${runner}\\b`).test(body)) failures.push(`${WORKFLOW} job '${name}' does not list '${runner}' in needs, so a skipped balance job would not reach it`);
    }
  }
}

if (failures.length) {
  console.error(`Test-project wiring failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`test projects ok — ${resolved.size} files, ${guardedCount} in '${GUARDED_PROJECT}', gate and CI both run it`);
