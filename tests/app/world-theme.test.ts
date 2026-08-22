import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { efficiencyBucket, resolveWorldTheme } from '../../src/app/world/theme';
import { BUILDING_IDS } from '../../src/engine/content/buildings';

// The theme contract the renderer relies on: every color it forwards to
// ex.Color.fromHex must be a 6-digit hex, whatever the vault's CSS variables
// contain (themes are free to use hsl()/rgb()/garbage — those must fall back,
// never pass through). The reader function is injected, so these tests never
// need a DOM. The same resolved palette also feeds the WorldView legend, so
// a fallback here is a legend chip color too — one source of truth.
//
// Task 13 (spec §2.9, "one palette, two renderers"): theme.ts no longer reads
// an Obsidian vault variable (`--color-green`) directly — it reads an
// `--obsisim-*` custom property that styles.css defines on `.obsisim`, and
// THAT declaration is what nests the vault lookup (see styles.css's own
// comment on the token block). The tests below that used to feed
// `--color-green` etc. now feed the `--obsisim-*` name theme.ts actually
// reads, and a new describe block below reads both files' source text to
// assert the two cannot drift apart: every token name theme.ts passes to
// `pick()` has to be one styles.css actually declares.

const HEX = /^#[0-9a-f]{6}$/i;
const none = () => '';

/** Parses a 6-digit hex color into its RGB channel bytes. */
function toRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** The smallest per-channel gap between two colors. Plain !== is too weak a
 * distinctness check: workerToolRing (#f2ecdd) and progressFill (#f5efdc)
 * were already unequal strings, only 1-3 RGB units apart per channel — and
 * that near-collision is exactly what let a carried load vanish into a
 * tooled worker's ring. Requiring a real minimum per-channel gap catches a
 * future palette edit that quietly closes the distance again. */
function minChannelDistance(a: string, b: string): number {
  const [ar, ag, ab] = toRgb(a);
  const [br, bg, bb] = toRgb(b);
  return Math.min(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
}

describe('resolveWorldTheme', () => {
  it('uses a CSS variable when it resolves to a hex color', () => {
    const theme = resolveWorldTheme((name) => (name === '--obsisim-state-producing' ? ' #11aa55 ' : ''));
    expect(theme.stateRing.producing).toBe('#11aa55');
  });

  it('falls back to a built-in hex when the variable is missing or not hex', () => {
    const missing = resolveWorldTheme(none);
    const garbage = resolveWorldTheme(() => 'hsl(120, 50%, 50%)');
    expect(missing.stateRing.producing).toMatch(HEX);
    expect(garbage.stateRing.producing).toBe(missing.stateRing.producing);
  });

  it.each(BUILDING_IDS)('defines a fill and a glyph for %s', (id) => {
    const theme = resolveWorldTheme(none);
    expect(theme.buildingFill[id]).toMatch(HEX);
    expect(theme.buildingGlyph[id].length).toBeGreaterThan(0);
  });

  it('defines a ring color for every building state and every worker bucket', () => {
    const theme = resolveWorldTheme(none);
    expect(theme.stateRing.producing).toMatch(HEX);
    expect(theme.stateRing.waitingForInput).toMatch(HEX);
    expect(theme.stateRing.unstaffed).toMatch(HEX);
    for (const color of theme.colonistColors) expect(color).toMatch(HEX);
    expect(theme.workerToolRing).toMatch(HEX);
    expect(theme.progressFill).toMatch(HEX);
    expect(theme.ground[0]).toMatch(HEX);
    expect(theme.ground[1]).toMatch(HEX);
    expect(theme.background).toMatch(HEX);
  });

  it('resolves accent from --obsisim-color-accent with a hex fallback', () => {
    const themed = resolveWorldTheme((name) => (name === '--obsisim-color-accent' ? '#123abc' : ''));
    expect(themed.accent).toBe('#123abc');
    const fallback = resolveWorldTheme(() => '');
    expect(fallback.accent).toBe('#7c8cf0');
  });

  it('danger is the resolved red', () => {
    const themed = resolveWorldTheme((name) => (name === '--obsisim-color-danger' ? '#aa1122' : ''));
    expect(themed.danger).toBe('#aa1122');
    expect(themed.colonistColors[0]).toBe('#aa1122'); // same source as starving-worker red
  });

  // Step 1 of this task's own brief: every stateRing/mark colour now reads an
  // `--obsisim-*` token rather than an Obsidian vault variable directly, and
  // BOTH halves of that contract need a test — the token is read when
  // present, and theme.ts's own hardcoded literal still applies when it is
  // not (a stylesheet that failed to load, or a call made before `.obsisim`
  // is mounted around the queried element).
  it('reads the new --obsisim-state-* tokens for the building-state ring', () => {
    const themed = resolveWorldTheme((name) => {
      switch (name) {
        case '--obsisim-state-waiting': return '#123456';
        case '--obsisim-state-output-full': return '#234567';
        case '--obsisim-state-under-construction': return '#345678';
        case '--obsisim-state-relocating': return '#456789';
        case '--obsisim-state-housing': return '#56789a';
        case '--obsisim-state-storing': return '#6789ab';
        default: return '';
      }
    });
    expect(themed.stateRing.waitingForInput).toBe('#123456');
    expect(themed.stateRing.outputFull).toBe('#234567');
    expect(themed.stateRing.underConstruction).toBe('#345678');
    expect(themed.stateRing.relocating).toBe('#456789');
    expect(themed.stateRing.housing).toBe('#56789a');
    expect(themed.stateRing.storing).toBe('#6789ab');
    // carriedLoad/carriedInput deliberately read the SAME tokens as
    // relocating/storing (see theme.ts's own comments on both fields) —
    // proving that here, rather than only via the fixed-literal test further
    // down, is what would catch a future edit that gave them their own
    // property and quietly split the "on purpose" match apart.
    expect(themed.carriedLoad).toBe('#456789');
    expect(themed.carriedInput).toBe('#6789ab');

    // And the fallback half: with every token absent, every one of these
    // still resolves to theme.ts's own hardcoded hex, unchanged by this task.
    const fallback = resolveWorldTheme(() => '');
    expect(fallback.stateRing.waitingForInput).toBe('#e5a63a');
    expect(fallback.stateRing.outputFull).toBe('#8f6fbf');
    expect(fallback.stateRing.underConstruction).toBe('#cf8b2f');
    expect(fallback.stateRing.relocating).toBe('#4bbfd4');
    expect(fallback.stateRing.housing).toBe('#4c8bf5');
    expect(fallback.stateRing.storing).toBe('#a9835a');
  });

  it('reads the new --obsisim-mark-* tokens for the demographic marks, with the same fallback', () => {
    const themed = resolveWorldTheme((name) => {
      switch (name) {
        case '--obsisim-mark-child': return '#111111';
        case '--obsisim-mark-elder': return '#222222';
        case '--obsisim-mark-homeless': return '#333333';
        default: return '';
      }
    });
    expect(themed.stageMark.child).toBe('#111111');
    expect(themed.stageMark.elder).toBe('#222222');
    expect(themed.homelessMark).toBe('#333333');

    const fallback = resolveWorldTheme(() => '');
    expect(fallback.stageMark.child).toBe('#e6c84a');
    expect(fallback.stageMark.elder).toBe('#b9c2d0');
    expect(fallback.homelessMark).toBe('#e0619e');
  });

  it('reads the new --obsisim-color-* tokens for background/ground/tool-ring/progress-fill', () => {
    const themed = resolveWorldTheme((name) => {
      switch (name) {
        case '--obsisim-color-background': return '#444444';
        case '--obsisim-color-ground-a': return '#555555';
        case '--obsisim-color-ground-b': return '#666666';
        case '--obsisim-color-tool-ring': return '#777777';
        case '--obsisim-color-progress-fill': return '#888888';
        default: return '';
      }
    });
    expect(themed.background).toBe('#444444');
    expect(themed.ground).toEqual(['#555555', '#666666']);
    expect(themed.workerToolRing).toBe('#777777');
    expect(themed.progressFill).toBe('#888888');

    const fallback = resolveWorldTheme(() => '');
    expect(fallback.background).toBe('#20242b');
    expect(fallback.ground).toEqual(['#55714a', '#4d6743']);
    expect(fallback.workerToolRing).toBe('#f2ecdd');
    expect(fallback.progressFill).toBe('#f5efdc');
  });

  it('gives the output-full stall its own ring, distinct from every other state', () => {
    const theme = resolveWorldTheme(() => '');
    expect(theme.stateRing.outputFull).toBe('#8f6fbf');
    const rings = Object.values(theme.stateRing);
    expect(new Set(rings).size).toBe(rings.length);
  });

  it('gives the relocating state its own ring colour', () => {
    const theme = resolveWorldTheme(() => '');
    expect(theme.stateRing.relocating).toMatch(HEX);
    expect(theme.stateRing.relocating).not.toBe(theme.stateRing.outputFull);
    expect(theme.stateRing.relocating).not.toBe(theme.stateRing.unstaffed);
  });

  it('gives a carried load its own colour, meaningfully distinct from the tool ring and the progress fill', () => {
    const theme = resolveWorldTheme(none);
    expect(theme.carriedLoad).toBe('#4bbfd4');
    expect(minChannelDistance(theme.carriedLoad, theme.workerToolRing)).toBeGreaterThan(3);
    expect(minChannelDistance(theme.carriedLoad, theme.progressFill)).toBeGreaterThan(3);
  });

  it('gives a load carried IN its own colour, well clear of every other mark a dot can wear', () => {
    const theme = resolveWorldTheme(none);
    // The pair is the whole encoding: if the two loads shared a hue, flow
    // direction would be unreadable and `haulPickedUp` pointless (§2.10).
    expect(minChannelDistance(theme.carriedInput, theme.carriedLoad)).toBeGreaterThan(3);
    // A single colonist can wear the load mark beside a stage mark, the
    // homeless mark and the tool ring at the same time, so the gap has to hold
    // against all of them — the vault orange was rejected for exactly this: it
    // is one RGB unit off the child mark's yellow.
    for (const other of [theme.stageMark.child, theme.stageMark.elder, theme.homelessMark, theme.workerToolRing]) {
      expect(minChannelDistance(theme.carriedInput, other)).toBeGreaterThan(3);
    }
  });

  // Deliberate, the same way carriedLoad matches stateRing.relocating above:
  // goods sitting in a depot and goods walking out of one are the same goods.
  // Pinned as equality so a palette edit cannot quietly split them apart.
  it('gives a load carried in from a store the storehouse\'s own colour, on purpose', () => {
    const theme = resolveWorldTheme(none);
    expect(theme.carriedInput).toBe(theme.stateRing.storing);
  });

  it('resolves the demographic tokens to concrete colours', () => {
    const theme = resolveWorldTheme(() => '');   // no vault variables: fallbacks
    expect(theme.buildingGlyph.house).toBe('🏠');
    expect(theme.homelessMark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.stageMark.child).toMatch(/^#[0-9a-f]{6}$/i);
    expect(theme.stageMark.elder).toMatch(/^#[0-9a-f]{6}$/i);
    // Discriminating: the two stage marks must differ from each other AND from
    // the hues already spoken for, or the canvas says two things with one colour.
    const claimed = [theme.workerToolRing, theme.progressFill, theme.carriedLoad, theme.accent, theme.danger];
    expect(theme.stageMark.child).not.toBe(theme.stageMark.elder);
    expect(claimed).not.toContain(theme.stageMark.child);
    expect(claimed).not.toContain(theme.stageMark.elder);
    expect(claimed).not.toContain(theme.homelessMark);
  });

  it('keeps the demographic marks off every building state ring as well', () => {
    // The brief's `claimed` list above covers the colonist-scale hues but not
    // the building rings, and a house is drawn beside the colonists standing
    // in it — a stage mark in the housing blue (or the relocating cyan) would
    // read as a property of the wrong object.
    const theme = resolveWorldTheme(() => '');
    const rings = Object.values(theme.stateRing);
    for (const mark of [theme.stageMark.child, theme.stageMark.elder, theme.homelessMark]) {
      expect(rings).not.toContain(mark);
    }
    expect(new Set([theme.stageMark.child, theme.stageMark.elder, theme.homelessMark]).size).toBe(3);
  });

  // Deliberate, not a coincidence: carriedLoad's doc comment (theme.ts) and
  // the relocating case in resolveWorldTheme both say "in transit" and
  // intentionally resolve to the same --color-cyan. Pinned as equality so a
  // future palette edit can't quietly split the two apart.
  it('gives the relocating state the same colour as a carried load, on purpose', () => {
    const theme = resolveWorldTheme(none);
    expect(theme.stateRing.relocating).toBe(theme.carriedLoad);
  });
});

describe('efficiencyBucket', () => {
  it('maps starving to the first bucket and healthy to the last', () => {
    const theme = resolveWorldTheme(none);
    expect(efficiencyBucket(0.2)).toBe(0);
    expect(efficiencyBucket(1.5)).toBe(theme.colonistColors.length - 1);
  });

  it('is monotonic in efficiency', () => {
    let last = -1;
    for (const eff of [0.2, 0.4, 0.6, 0.8, 1.0]) {
      const bucket = efficiencyBucket(eff);
      expect(bucket).toBeGreaterThanOrEqual(last);
      last = bucket;
    }
  });
});

/*
 * The by-eye half of spec §2.9's "light and dark come free from Obsidian's
 * variables... both themes are a verification step rather than an
 * assumption" cannot run here: this is a headless environment, there is no
 * Obsidian to load the vault into, and no light/dark theme to look at (see
 * this task's own report for the plain statement that step was not done).
 * What CAN run headlessly is the STRUCTURAL half of that same promise: every
 * `--obsisim-*` name theme.ts passes to `pick()` has to be a property
 * styles.css actually declares on `.obsisim`, or the "one palette" in "one
 * palette, two renderers" is a lie for that one colour — theme.ts's fallback
 * would fire on every real mount, silently, with nothing here to catch it.
 * Reading both files' source text and cross-referencing them is the
 * automated substitute this task's report describes.
 */
describe('CSS token coverage (spec §2.9 — one palette, two renderers)', () => {
  const themeSource = readFileSync(new URL('../../src/app/world/theme.ts', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
  // Every distinct `--obsisim-...` identifier theme.ts's own source text
  // mentions as a `pick()` call's second argument. A plain regex over the
  // whole file (not just resolveWorldTheme's body) is deliberately broader
  // than it needs to be: a token added anywhere in this file, not only
  // inside the one function this test suite otherwise exercises, still has
  // to be declared for the fallback promise above to hold.
  const tokenNames = [...new Set([...themeSource.matchAll(/'(--obsisim-[a-z-]+)'/g)].map((m) => m[1]))];

  it('reads at least one token per themed colour', () => {
    // A regression guard on the guard: if this ever reads 0, the regex
    // above stopped matching (a quoting style change in theme.ts) rather
    // than theme.ts having genuinely lost every token, and the loop below
    // would then vacuously pass on an empty list.
    expect(tokenNames.length).toBeGreaterThanOrEqual(18);
  });

  it.each(tokenNames)('%s is declared on .obsisim in styles.css', (name) => {
    expect(cssSource).toContain(`${name}:`);
  });
});
