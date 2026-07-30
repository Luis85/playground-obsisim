import { describe, expect, it } from 'vitest';
import { efficiencyBucket, resolveWorldTheme } from '../../src/app/world/theme';
import { BUILDING_IDS } from '../../src/engine/content/buildings';

// The theme contract the renderer relies on: every color it forwards to
// ex.Color.fromHex must be a 6-digit hex, whatever the vault's CSS variables
// contain (themes are free to use hsl()/rgb()/garbage — those must fall back,
// never pass through). The reader function is injected, so these tests never
// need a DOM.

const HEX = /^#[0-9a-f]{6}$/i;
const none = () => '';

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
    expect(theme.ground[0]).toMatch(HEX);
    expect(theme.ground[1]).toMatch(HEX);
    expect(theme.background).toMatch(HEX);
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
