#!/usr/bin/env node
// Browser smoke test for the world renderer — the one piece unit tests cannot
// cover (it needs a real canvas/WebGL runtime). Builds the harness in
// scripts/world-smoke-harness/ with vite, drives the REAL Excalibur adapter in
// a Chromium, and asserts on rendering behavior via screenshots:
// boots and draws, walk animation runs, stop() freezes rendering, start()
// resumes it, sync scales to more entities, dispose() is clean, zero page
// errors throughout. Optional dev tool — NOT part of check:all.
//
// Requires playwright-core (not a project dependency):
//   npm install --no-save playwright-core
// and a Chromium binary; pass CHROMIUM=/path/to/chrome if the default
// playwright install location has none.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let chromiumPath = process.env.CHROMIUM ?? '';
if (!chromiumPath) {
  const candidate = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers', 'chromium');
  chromiumPath = existsSync(candidate) ? candidate : '';
}
if (!chromiumPath) {
  console.error('world-smoke: no Chromium found — set CHROMIUM=/path/to/chrome');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('world-smoke: playwright-core missing — run: npm install --no-save playwright-core');
  process.exit(1);
}

const { build } = await import('vite');
const dist = mkdtempSync(join(tmpdir(), 'obsisim-world-smoke-'));
await build({
  configFile: false,
  logLevel: 'warn',
  root: resolve('scripts/world-smoke-harness'),
  base: './',
  build: { outDir: dist, emptyOutDir: true },
});

// file:// pages block module scripts by default (CORS) — allow local files
const browser = await chromium.launch({
  executablePath: chromiumPath,
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const failures = [];
function check(name, ok) {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`);
  if (!ok) failures.push(name);
}
const shot = () => page.screenshot({ clip: { x: 0, y: 0, width: 800, height: 520 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n) => page.evaluate((i) => window.__step(i), n);

await page.goto(`file://${dist}/index.html`);
await page.waitForFunction(() => window.__ready, undefined, { timeout: 15000 });
await wait(500); // let the engine boot its first frames

const blank = await shot();
check('canvas exists and is sized', await page.evaluate(() => {
  const canvas = document.querySelector('#host canvas');
  return canvas !== null && canvas.width > 0 && canvas.height > 0;
}));

await step(0); // first colony
await wait(400);
const colony = await shot();
check('first sync draws the colony', !colony.equals(blank));

await step(1); // worker 12 reassigned -> walks
await wait(200);
const walkingA = await shot();
await wait(300);
const walkingB = await shot();
check('reassigned worker animates (frames differ mid-walk)', !walkingB.equals(walkingA));

await wait(2500); // walk (~2 tiles at 90 px/s) settles
const settledA = await shot();
await wait(300);
const settledB = await shot();
check('scene is static once the walk settles', settledB.equals(settledA));

const probe = await page.evaluate(() => window.__probe());
check(
  `pick() resolves buildings, workers, and empty ground through the live camera (${JSON.stringify(probe)})`,
  probe.building > 0 && probe.worker > 0 && probe.empty > 0,
);

await step(2); // stop()
await step(4); // sync more entities while stopped — must not render
await wait(400);
const stoppedA = await shot();
await wait(300);
const stoppedB = await shot();
check('stop() halts rendering (frames frozen despite new sync)', stoppedB.equals(stoppedA));

await step(3); // start()
await wait(600);
const resumed = await shot();
check('start() resumes and draws the grown colony', !resumed.equals(stoppedA));

await step(5); // colony reset: tick regresses, ids recycle
await wait(400);
const afterReset = await page.evaluate(() => window.__probe());
check(
  `reset clears the old colony (buildings gone, fresh workers at camp) (${JSON.stringify(afterReset)})`,
  afterReset.building === 0 && afterReset.worker > 0,
);

await step(6); // dispose()
await wait(300);
check('dispose() raises no errors', pageErrors.length === 0);

const harnessErrors = await page.evaluate(() => window.__errors);
check('no page errors during the whole run', pageErrors.length === 0 && harnessErrors.length === 0);
if (pageErrors.length > 0 || harnessErrors.length > 0) {
  console.error('errors:', [...pageErrors, ...harnessErrors].join('\n'));
}

await browser.close();
if (failures.length > 0) {
  console.error(`world-smoke: ${failures.length} assertion(s) failed`);
  process.exit(1);
}
console.log('world-smoke: all green');
