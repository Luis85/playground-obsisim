import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Task 13's own gap analysis (this task's brief) found `.obsisim-world-screen`,
// `.obsisim-rail`, `.obsisim-stage`, `.obsisim-strip` and `.is-overlay` all
// carrying ZERO rules — the shell classes the components emit had no CSS at
// all, so criterion 7 ("below the width threshold the dock overlays") was
// only ever half true: the store flag and the class existed, the actual
// overlay did not. jsdom never loads this file (no test imports styles.css,
// and none should — a real cascade needs a real browser), so the only way to
// assert the FIX landed is to read the stylesheet's own source text, the way
// scripts/check-css-important.mjs already does for the !important gate.
// These are structural greps, not a CSS parser — deliberately: they are
// exactly as strong as the claims this task's report makes, no stronger, and
// the real verification (does it actually overlay, in a real pane, in a real
// theme) is the by-eye pass this task's report states was NOT performed.
// Comments stripped first, the same way scripts/check-css-important.mjs
// already does for its own regex-based read of this file — a selector-
// looking string inside a comment (this file has several, describing the
// very rules below) must not satisfy a check meant to find real CSS.
const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of the top-level rule whose selector exactly
 * matches `selector`. Every rule this file cares about here is written flat,
 * one per line, as `selector {` with a single space — so anchoring on
 * line-start (`^`, multiline) is enough to avoid a substring collision
 * (`.obsisim-dock` must not also match inside `.obsisim-dock.is-overlay` or
 * `.obsisim-dock-tabs`) without needing a real CSS parser. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.[\]]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`^${escaped} \\{([^}]*)\\}`, 'mg'))];
  if (matches.length === 0) throw new Error(`no rule found for ${selector}`);
  // The LAST such rule, not the first: `.obsisim-table td` is also the
  // second line of the earlier `.obsisim-table th,\n.obsisim-table td {`
  // compound selector, which — written one selector per line, this file's
  // own convention — satisfies a line-anchored match just as well as the
  // dedicated `.obsisim-table td { font-variant-numeric: ... }` rule this
  // test actually means to find, and CSS's own cascade already says the
  // later, more specific declaration is the one that wins in a browser too.
  return matches[matches.length - 1][1];
}

describe('styles.css — the world screen shell (spec §2.1 / §2.9)', () => {
  it('lays the four regions out on a grid, not document flow', () => {
    expect(ruleBody('.obsisim-world-screen')).toMatch(/display:\s*grid/);
  });

  it('gives the rail, stage, dock and strip a grid placement', () => {
    for (const selector of ['.obsisim-rail', '.obsisim-stage', '.obsisim-dock', '.obsisim-strip']) {
      expect(ruleBody(selector)).toMatch(/grid-area:/);
    }
  });

  // The half that was entirely missing: `.is-overlay` had zero rules, so the
  // dock sat in its grid column regardless of the class WorldScreen/DockBody
  // already wrote. `position: absolute` combined with spanning BOTH grid
  // axes (`1 / -1`) is what actually lifts it out of the "dock" column and
  // over the canvas — see styles.css's own comment on why the axis span is
  // required and not merely tidy (an absolutely-positioned grid item with a
  // named `grid-area` still takes THAT area as its containing block).
  it('.obsisim-dock.is-overlay is taken out of grid flow and anchored to the container', () => {
    const body = ruleBody('.obsisim-dock.is-overlay');
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(body).toMatch(/grid-row:\s*1\s*\/\s*-1/);
  });

  // Defect fix, criterion 7's other half: `.is-narrow` used to never
  // redefine the shell grid at all, so the rail (140-200px) and dock
  // (220-320px) columns stayed reserved even though the rail popover and
  // the dock overlay both take themselves out of flow with
  // `position: absolute` — which removes them from the grid's SIZING pass,
  // but does nothing to the explicit column widths above, which stay
  // reserved regardless of occupancy. This is a source-text assertion, the
  // same limitation this file's own top-of-file comment already states for
  // every other rule here: it can prove the narrow override rule EXISTS and
  // does not reserve the wide-mode column widths, but it cannot prove a
  // real browser actually paints the canvas at the width this rule implies
  // — that would need a real layout engine, which jsdom is not.
  it('gives narrow mode its own grid template that does not reserve the rail/dock column widths', () => {
    const body = ruleBody('.obsisim-world-screen.is-narrow');
    expect(body).toMatch(/grid-template-columns:/);
    // Not the wide-mode reservations — narrow's columns must not still
    // allocate the 140-200px rail or the 220-320px dock.
    expect(body).not.toMatch(/140px/);
    expect(body).not.toMatch(/200px/);
    expect(body).not.toMatch(/220px/);
    expect(body).not.toMatch(/320px/);
    // A single flexible column is what actually hands the stage the pane's
    // full width back.
    expect(body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  // M9 (whole-branch review): before this, the test's own name promised more
  // than its body checked. `container-type: inline-size` alone only makes
  // `.obsisim-world-screen` ELIGIBLE to be queried by a container query — it
  // says nothing about whether an `@container` rule actually exists anywhere
  // in the file, so a stylesheet that set the property and then never wrote
  // an `@container` block at all still passed. And the negative check only
  // ruled out `@media (min-width` / `@media (max-width` — anchored on the
  // parenthesis sitting directly after `@media`, so `@media screen and
  // (max-width: 720px)` (a form that reads the WINDOW exactly as much as the
  // bare form does) would have slipped through undetected.
  it('responds to the PANE width via a container query, never the window', () => {
    expect(css).toMatch(/container-type:\s*inline-size/);
    // An `@container` rule must actually exist, not merely be eligible to.
    expect(css).toMatch(/@container\s+[\w-]+\s*\(\s*(?:min|max)-width/);
    // No `@media` rule may key off a width, in ANY form — `[^{]*` covers
    // `screen and (max-width: …)` and any other prefix between `@media` and
    // the width condition, not just the bare `@media (max-width` shape.
    // `prefers-reduced-motion`'s own `@media` rule (tested below) contains
    // no `-width` substring, so it does not trip this.
    expect(css).not.toMatch(/@media[^{]*(?:min|max)-width/);
  });

  // The orphan this task removed: `.obsisim-world` (the deleted WorldView
  // wrapper's class) had one rule and nothing left in src/ emits that exact
  // class — confirmed by grepping src/ for `obsisim-world` and finding only
  // the `-host`/`-fallback`/`-tooltip`/`-legend`/`-screen`/`-tabs`-suffixed
  // classes that are still very much in use. This regex requires a word
  // boundary after `obsisim-world` so it does not also match any of those.
  it('has removed the orphaned .obsisim-world rule (no component ever emitted that exact class)', () => {
    expect(css).not.toMatch(/\.obsisim-world\s*\{/);
  });

  it('declares exactly the three named transitions, gated on prefers-reduced-motion', () => {
    const gated = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*)\n\}\n?$/.exec(css);
    expect(gated).not.toBeNull();
    const body = gated![1];
    expect(body).toMatch(/\.obsisim-dock-enter-active/); // 1. dock panel enter/leave
    expect(body).toMatch(/\.obsisim-attention-row-enter-active/); // 2. attention row appear
    expect(body).toMatch(/\.obsisim-vital-flash/); // 3. vitals value-change flash
  });

  it('keeps tabular-nums on every ticking number the brief names', () => {
    expect(ruleBody('.obsisim-table td')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(ruleBody('.obsisim-strip-chip')).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
