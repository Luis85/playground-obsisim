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

await wait(400); // let the grow phase's frame settle first
const preMove = await shot();
await step(5); // the workerless sawmill moves to a fresh tile
await wait(300); // no walk to wait out — the building snaps
const moved = await shot();
check('a moved building is drawn at its new tile (no worker motion to hide behind)', !moved.equals(preMove));

// The haul phases change ONE thing each (see haulScene in the harness), so the
// three checks below fail for the reason they name. They used to compare frames
// across a phase that moved five things at once, and the load-marker check in
// particular would have stayed green with the marker entirely absent (OBS-4-04).
await step(6); // haul baseline: worker 12 idle at camp, already tooled
await wait(2500); // let worker 12 walk back from its old post and settle
const haulBase = await shot();

await step(7); // ONLY change: worker 12 becomes a hauler bound for building 1
await wait(400);
const outbound = await shot();
check('a hauler dispatched to a building changes the scene (worker 12 is the only difference)', !outbound.equals(haulBase));

await step(8); // ONLY change: the same hauler walks home, still empty
await wait(2500); // the walk back settles, so the next frame differs only by the marker
const homeEmpty = await shot();
check('a hauler walking home differs from one walking out', !homeEmpty.equals(outbound));

await step(9); // ONLY change: `carrying`, on a settled actor at the same tile
await wait(400);
const carrying = await shot();
check('the load marker is drawn on a carrying hauler (only `carrying` differs)', !carrying.equals(homeEmpty));

await step(10); // ONLY change: building 1 becomes relocating
await wait(400);
const relocating = await shot();
check('a relocating building is drawn differently (only its state differs)', !relocating.equals(carrying));

const preGhost = await shot();
await step(11); // ghost + selection on
await wait(300);
const ghostOn = await shot();
check('setGhost + setSelection draw over the scene', !ghostOn.equals(preGhost));

await step(12); // same tile, invalid tint
await wait(300);
const ghostInvalid = await shot();
check('an invalid ghost reads differently from a valid one', !ghostInvalid.equals(ghostOn));

await step(13); // both cleared
await wait(300);
const ghostOff = await shot();
check('clearing ghost and selection restores the scene', ghostOff.equals(preGhost));

await step(14); // colony reset: tick regresses, ids recycle
await wait(400);
const afterReset = await page.evaluate(() => window.__probe());
check(
  `reset clears the old colony (buildings gone, fresh workers at camp) (${JSON.stringify(afterReset)})`,
  afterReset.building === 0 && afterReset.worker > 0,
);

await step(15); // same-tick reset: a new snapshot at the same tick is a new timeline
await wait(400);
const afterSameTickReset = await page.evaluate(() => window.__probe());
check(
  // worker > 0, not an exact count: the probe grid's nearest sample sits
  // within ~1px of the pick radius at this zoom — an exact count flips on
  // any TILE/margin/host change and would read as a renderer regression
  `same-tick reset also clears the previous colony (${JSON.stringify(afterSameTickReset)})`,
  afterSameTickReset.building === 0 && afterSameTickReset.worker > 0,
);

// Demographics. One change per phase (see homeScene in the harness), so each
// check below fails for the reason it names and nothing else: the scene is two
// settled dots at the camp, and the only thing that moves is the house
// arriving, then one field on colonist 4.
const preHouse = await shot();

await step(16); // a house appears — nothing else moves
await wait(400);
const withHouse = await shot();
check('a house is drawn on the canvas', !withHouse.equals(preHouse));

await step(17); // ONE colonist's homeId becomes 1 — it stands where it stood
await wait(400);
const housed = await shot();
check('the homeless mark clears when a colonist moves in', !housed.equals(withHouse));

await step(18); // that SAME colonist's stage becomes 'child' — one field, one frame
await wait(400);
const withChild = await shot();
check('a child is drawn differently from an adult', !withChild.equals(housed));

await step(19); // that same colonist becomes 'elder' — one field, one frame
await wait(400);
const withElder = await shot();
// Against the ADULT frame as well as the child one, deliberately. `!==` the
// child frame alone is satisfied by an elder mark that is never drawn at all
// (no mark differs from a yellow one just as much as a silver one does) — the
// precise "green with the feature removed" failure OBS-4-04 is about. The
// adult frame is the unmarked baseline, so the pair pins both halves: the mark
// exists, and it is not the child's colour.
check(
  'an elder is drawn differently from a child and from an unmarked adult',
  !withElder.equals(withChild) && !withElder.equals(housed),
);

await step(20); // dispose()
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
