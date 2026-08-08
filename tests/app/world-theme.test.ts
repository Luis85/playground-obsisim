import { describe, expect, it } from 'vitest';
import { efficiencyBucket, resolveWorldTheme } from '../../src/app/world/theme';
import { BUILDING_IDS } from '../../src/engine/content/buildings';

// The theme contract the renderer relies on: every color it forwards to
// ex.Color.fromHex must be a 6-digit hex, whatever the vault's CSS variables
// contain (themes are free to use hsl()/rgb()/garbage — those must fall back,
// never pass through). The reader function is injected, so these tests never
// need a DOM. The same resolved palette also feeds the WorldView legend, so
// a fallback here is a legend chip color too — one source of truth.

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
    const theme = resolveWorldTheme((name) => (name === '--color-green' ? ' #11aa55 ' : ''));
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
    for (const color of theme.workerColors) expect(color).toMatch(HEX);
    expect(theme.workerToolRing).toMatch(HEX);
    expect(theme.progressFill).toMatch(HEX);
    expect(theme.ground[0]).toMatch(HEX);
    expect(theme.ground[1]).toMatch(HEX);
    expect(theme.background).toMatch(HEX);
  });

  it('resolves accent from --interactive-accent with a hex fallback', () => {
    const themed = resolveWorldTheme((name) => (name === '--interactive-accent' ? '#123abc' : ''));
    expect(themed.accent).toBe('#123abc');
    const fallback = resolveWorldTheme(() => '');
    expect(fallback.accent).toBe('#7c8cf0');
  });

  it('danger is the resolved red', () => {
    const themed = resolveWorldTheme((name) => (name === '--color-red' ? '#aa1122' : ''));
    expect(themed.danger).toBe('#aa1122');
    expect(themed.workerColors[0]).toBe('#aa1122'); // same source as starving-worker red
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
    expect(efficiencyBucket(1.5)).toBe(theme.workerColors.length - 1);
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
