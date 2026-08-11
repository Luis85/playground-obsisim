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
  `pick() resolves buildings, colonists, and empty ground through the live camera (${JSON.stringify(probe)})`,
  probe.building > 0 && probe.colonist > 0 && probe.empty > 0,
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
  `reset clears the old colony (buildings gone, fresh colonists at camp) (${JSON.stringify(afterReset)})`,
  afterReset.building === 0 && afterReset.colonist > 0,
);

await step(15); // same-tick reset: a new snapshot at the same tick is a new timeline
await wait(400);
const afterSameTickReset = await page.evaluate(() => window.__probe());
check(
  // colonist > 0, not an exact count: the probe grid's nearest sample sits
  // within ~1px of the pick radius at this zoom — an exact count flips on
  // any TILE/margin/host change and would read as a renderer regression
  `same-tick reset also clears the previous colony (${JSON.stringify(afterSameTickReset)})`,
  afterSameTickReset.building === 0 && afterSameTickReset.colonist > 0,
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

// Storage and two-way haulage. One change per phase (see storeScene in the
// harness): the scene is a bakery, one hauler, and — from phase 21 — a depot,
// and each phase below moves exactly one field on one of them.
await step(20); // the store scene replaces the home scene: settle before measuring
await wait(4500); // the hauler walks back to the camp band at the cosmetic pace
await step(21); // a storehouse appears, drawn in the shared `unstaffed` grey
await wait(400);
const depotUnstaffed = await shot();

await step(22); // ONLY change: the depot's state, unstaffed -> storing
await wait(400);
const depotStoring = await shot();
// The `storing` ring is the one state colour this increment adds, and the
// depot's tile, glyph, fill and gauge are identical in both frames — so a
// `storing` that resolved to a colour already on screen leaves them equal.
check('the storing state has a ring colour of its own (only the depot\'s state differs)', !depotStoring.equals(depotUnstaffed));

await step(23); // ONLY change: the depot's `stored`, 15 of 60 -> 45 of 60
await wait(400);
const fuller = await shot();
// `storage` is 60 in both frames and `buffered`/`inputBuffered` are 0 in both,
// so a gauge reading any of those — or no gauge at all — leaves this pair
// identical. Only one wired to `stored` can tell them apart.
check('the storehouse fill gauge tracks `stored` (only that field differs)', !fuller.equals(depotStoring));

await step(24); // the hauler takes a supply leg out of the camp
await wait(1500);
const fromCamp = await shot();

await step(25); // ONLY change: the leg's `from` end, camp (2,0) -> depot (10,5)
await wait(1500);
const fromDepot = await shot();
// The check this whole increment turns on. Both frames are the same phase, the
// same leg length, the same ticks left and the same load; only the endpoint the
// leg began at differs. The camp-anchored geometry this replaces drew every
// outbound leg from the camp tent, so it produced the SAME frame twice.
check('a leg that began at a depot is drawn on the depot\'s line, not the camp\'s', !fromDepot.equals(fromCamp));

await step(26); // ONLY change: `haulPickedUp` false -> true, on a settled dot
await wait(400);
const carryingOut = await shot();
// `haulKind` is 'supply' in BOTH frames, deliberately: a direction marker
// driven by the job kind (frozen at dispatch) cannot tell them apart, and the
// round trip this increment is named for is exactly the case it draws
// backwards (spec §2.10).
check('a hauler carrying goods out reads differently from one carrying them in (only `haulPickedUp` differs)', !carryingOut.equals(fromDepot));

await step(27); // the trip ends: the hauler goes idle, resting at the camp
await wait(4500); // it walks back to the camp band at the cosmetic pace
const idleAtCamp = await shot();

await step(28); // ONLY change: `haulAt` moves from the camp tile to the depot's
await wait(1500);
const idleAtDepot = await shot();
// The state the camp-anchored geometry could never express: with idle haulers
// falling through to the camp band regardless of where they stopped, these two
// frames are identical — the colonist a player watches teleport home.
check('an idle hauler resting at a depot is drawn at the depot, not back at the camp', !idleAtDepot.equals(idleAtCamp));

await step(29); // a non-store building appears beside the depot, `stored` forced to 0
await wait(400);
const neighborEmpty = await shot();

await step(30); // ONLY change: that building's `stored`, 0 -> 50 (its `storage` stays 0)
await wait(400);
const neighborFull = await shot();
// The `storage > 0` gate has no fixture of its own elsewhere: a smoke check
// only pins that the gauge tracks `stored` (see above), which stays green
// even if the gauge were drawn on every building. This building's `storage`
// never leaves 0, so with the gate intact its `stored` moving must draw
// nothing — the two frames must be pixel-identical.
check('the fill gauge stays hidden on a non-store building however far `stored` moves (the `storage > 0` gate)', neighborFull.equals(neighborEmpty));

// A transfer names no building: `haulKind` is 'transfer' and `haulTargetId` is
// null for the whole round trip. One change per phase (see DRAIN_LEG in the
// harness): the leg, the load, the direction marker and every building are
// identical across the two frames below, and only the trip's identity moves.
await step(31); // the hauler walks a load home from the depot on a trip that NAMES a building
await wait(1500);
const namedTrip = await shot();

await step(32); // ONLY change: kind -> 'transfer' and target -> null (one fact, two fields)
await wait(1500);
const transfer = await shot();
// PIXEL-IDENTICAL is the claim, not merely "drawn somewhere". A transfer is a
// job kind, not a new entity (spec §2.10): no new colour, no new glyph, and
// `haulPickedUp` stays the direction marker. This frame goes red if a
// kind-driven branch is ever added to the marker, and equally if a null
// `haulTargetId` starts falling through to the camp band — the colonist a
// player would watch teleport home for the length of every transfer.
check('a transfer is drawn exactly like the same leg that names a building (no kind branch, no null-target fallback)', transfer.equals(namedTrip));

await step(33); // ONLY change: `haulTicksLeft`, 2 of 4 -> 0, on that same transfer
await wait(1500);
const transferArrived = await shot();
// What makes the equality above non-vacuous: the transfer's dot IS on the
// canvas, and it is positioned from the frozen leg despite naming no building.
// Without this, a transfer that vanished entirely would satisfy phase 32.
check('a transfer\'s dot advances along its own frozen leg though it names no building', !transferArrived.equals(transfer));

await step(34); // dispose()
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
