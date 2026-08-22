import type { BuildingDefId } from '../../shared/content-types';
import type { LifeStage } from '../../shared/population';
import type { BuildingState } from '../../shared/snapshot';

export type VarReader = (name: string) => string;

export interface WorldTheme {
  background: string;
  ground: [string, string];
  buildingFill: Record<BuildingDefId, string>;
  buildingGlyph: Record<BuildingDefId, string>;
  stateRing: Record<BuildingState, string>;
  colonistColors: string[];
  workerToolRing: string;
  /** Batch progress fill — bright cream so it reads on green tiles. */
  progressFill: string;
  /** A hauler's carried load, when the load came OUT of a building's output
   * buffer. The world palette's production language is
   * already spoken for — red/orange/green for building health and state,
   * purple for the output-full stall, cream for tools and progress,
   * blue-violet for interaction (accent) — so cyan is the in-transit hue,
   * distinct from all of them. It is deliberately the SAME cyan as
   * stateRing.relocating (see resolveWorldTheme): a carried load and a
   * relocating building are both "in transit" and share a colour on
   * purpose — that match is not a coincidence to be tidied away. Still
   * never mistaken for the cream tool ring it sits flush against on a
   * tooled hauler. */
  carriedLoad: string;
  /**
   * A hauler's carried load when it did NOT come out of a building — i.e.
   * colony stock drawn from the camp or a storehouse and being carried IN to
   * a building that needs it. Its own hue beside `carriedLoad`, because the
   * whole point of the pair is that flow direction reads at a glance (§2.10);
   * which of the two a dot wears is decided by the snapshot's `haulPickedUp`
   * and never by the job kind, which is frozen at dispatch.
   *
   * Deliberately the SAME brown as `stateRing.storing`, the way `carriedLoad`
   * deliberately matches `stateRing.relocating`: goods sitting in a depot and
   * goods walking out of one are the same goods, and that match is not a
   * coincidence to be tidied away. Every vault hue is spoken for elsewhere,
   * and the two nearest free candidates would have collided on a single dot —
   * the child mark's yellow (#e6c84a) is one RGB unit off the vault orange.
   */
  carriedInput: string;
  /** Interactive accent — the selection ring and the valid-ghost tint. */
  accent: string;
  /** Danger — the blocked-ghost tint (the same resolved red the
   * starving-colonist gradient starts from). */
  danger: string;
  /**
   * Life-stage marks. Adults carry none — they are the baseline the other
   * two are read against, and a mark on every colonist would be noise.
   *
   * Keyed by `Exclude<LifeStage, 'adult'>` rather than the literal union, the
   * same move NOMAD_REJECTIONS makes over PopulationBlocker: a fourth band
   * added to LifeStage becomes a compile error here instead of an unmarked
   * dot nobody notices.
   */
  stageMark: Record<Exclude<LifeStage, 'adult'>, string>;
  /** A colonist with nowhere to live. */
  homelessMark: string;
}

// Excalibur's ex.Color.fromHex accepts "#rrggbb" and "#rrggbbaa" — pairs of
// hex digits, with an optional leading '#' — and NOTHING else: no "#rgb"
// shorthand, no rgb()/rgba() function syntax at all. Checked directly against
// Excalibur's own source (node_modules/excalibur/build/esm/excalibur.development.js,
// Color.fromHex's regex `^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$`),
// not assumed — so "a value fromHex can parse" is narrower than "a valid CSS
// colour", and this file still needs to normalize before handing colours off.
const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
// getComputedStyle() on an unregistered custom property returns the token
// stream verbatim, in whatever syntax the theme author (or the browser)
// wrote it in — including rgb()/rgba() with either the legacy comma-separated
// channels or the modern space-separated form, and either a fourth
// comma-separated alpha or a trailing "/ alpha". A single pattern matches all
// of those: '[,\s]' between channels accepts comma OR whitespace, and the
// optional tail after the third channel accepts either alpha spelling. The
// alpha group itself is consumed, never asserted on further — this file has
// no use for a colour's transparency, so the pattern only needs to recognise
// "this text names an rgb()/rgba() call with three numeric channels", not
// validate it as strict CSS grammar.
const RGB_FN = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/i;

function clampByte(channel: number): number {
  return Math.min(255, Math.max(0, Math.round(channel)));
}

function toHexByte(channel: string): string {
  return clampByte(Number(channel)).toString(16).padStart(2, '0');
}

/** Turns a matched rgb()/rgba() call's three channel captures into "#rrggbb". */
function rgbToHex(r: string, g: string, b: string): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/**
 * Normalizes whatever getComputedStyle() handed back into the "#rrggbb" form
 * ex.Color.fromHex actually parses (see HEX6's own comment above for what
 * fromHex accepts), or returns null when the value is not one of the
 * syntaxes this file knows how to normalize — the caller (`pick`, below)
 * falls back to a hardcoded literal in that case.
 *
 * hsl()/hsla() are deliberately NOT handled here. Converting them is real
 * arithmetic — hue/saturation/lightness to RGB — not a regex reshuffle like
 * the two cases below, and it would add an untested-in-practice branch to a
 * function that sits under this repo's complexFunctions=0 gate for the sake
 * of a syntax Obsidian's own default themes do not emit. A theme authored
 * with hsl() custom properties still falls back to the hardcoded literal, the
 * same as before this fix — a real but narrow, and now documented, gap in
 * "one palette, two renderers" for that one theme, rather than a silent one.
 */
function normalizeColor(value: string): string | null {
  if (HEX6.test(value)) return value;
  const short = value.match(HEX3);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = value.match(RGB_FN);
  if (rgb) return rgbToHex(rgb[1], rgb[2], rgb[3]);
  return null;
}

/** A depot's sacks and crates. Named once because two things wear it on
 * purpose — see `carriedInput` and `stateRing.storing`. */
const STORE_BROWN = '#a9835a';

// Obsidian themes expose their palette as CSS variables; whatever syntax a
// theme writes a colour in (6-digit hex, "#rgb" shorthand, or an rgb()/rgba()
// call — see normalizeColor above), the resolved value is normalized to the
// "#rrggbb" form ex.Color.fromHex parses. hsl()/hsla(), anything genuinely
// unparseable, and the empty string a missing property reads back as, all
// still fall back to the hardcoded literal — that is what keeps this file's
// own guarantee, "a missing property degrades rather than breaks", true.
function pick(read: VarReader, name: string, fallback: string): string {
  const value = read(name).trim();
  return normalizeColor(value) ?? fallback;
}

const BUILDING_FILL: Record<BuildingDefId, string> = {
  gatherersHut: '#7d9464', farm: '#b0913f', mill: '#a2793d', bakery: '#b06a4e',
  forester: '#4e7a52', sawmill: '#8a6a49', workshop: '#6f6f85', house: '#c9a66b',
  storehouse: '#6e5b3e',
};

export const BUILDING_GLYPHS: Record<BuildingDefId, string> = {
  gatherersHut: '🧺', farm: '🌾', mill: '⚙️', bakery: '🍞',
  forester: '🌲', sawmill: '🪚', workshop: '🔨', house: '🏠',
  storehouse: '📦',
};

function mixHex(from: string, to: string, t: number): string {
  let mixed = '#';
  for (let i = 1; i < 7; i += 2) {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    mixed += Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
  }
  return mixed;
}

const COLONIST_BUCKETS = 5;
const BUCKET_CEILINGS = [0.35, 0.55, 0.75, 0.95];

export function efficiencyBucket(efficiency: number): number {
  const index = BUCKET_CEILINGS.findIndex((ceiling) => efficiency < ceiling);
  return index === -1 ? COLONIST_BUCKETS - 1 : index;
}

/*
 * Task 13 (spec §2.9, "one palette, two renderers"): every name passed to
 * `pick()` below used to be an Obsidian vault variable read directly
 * (`--color-red`, `--color-green`, ...). It is now an `--obsisim-*` custom
 * property that `styles.css` defines once on `.obsisim` — for a var-sourced
 * one, CSS nests the SAME Obsidian lookup with the SAME hex fallback this
 * file used to carry inline (`--obsisim-color-danger: var(--color-red,
 * #e0533d);`); for one with no vault counterpart (the construction amber,
 * the storehouse brown, the two creams, the unstaffed grey, the elder
 * silver), it is a plain literal. Either way the browser hands this
 * function ONE already-resolved value per name — it no longer needs to know
 * which Obsidian variable, if any, stands behind it — and the hex literal
 * still passed as `pick()`'s third argument is UNCHANGED: it is what this
 * function falls back to if the property fails to resolve at all (no
 * stylesheet loaded, or called before `.obsisim` is mounted around the
 * queried element), which is what keeps this file's own guarantee — a
 * missing property degrades rather than breaks — true after this task
 * exactly as it was before it.
 */
export function resolveWorldTheme(read: VarReader): WorldTheme {
  const red = pick(read, '--obsisim-color-danger', '#e0533d');
  const green = pick(read, '--obsisim-state-producing', '#3cb46e');
  return {
    background: pick(read, '--obsisim-color-background', '#20242b'),
    ground: [pick(read, '--obsisim-color-ground-a', '#55714a'), pick(read, '--obsisim-color-ground-b', '#4d6743')],
    buildingFill: BUILDING_FILL,
    buildingGlyph: BUILDING_GLYPHS,
    stateRing: {
      producing: green,
      waitingForInput: pick(read, '--obsisim-state-waiting', '#e5a63a'),
      unstaffed: pick(read, '--obsisim-state-unstaffed', '#8f8f8f'),
      // Purple, deliberately outside the green/orange production language: this
      // building is not short of anything, it has nowhere to put what it made.
      outputFull: pick(read, '--obsisim-state-output-full', '#8f6fbf'),
      // A site is not a stall, not a home, not a store — its own hue, checked
      // FIRST in the precedence chain (snapshot-buildings.ts's buildingState),
      // so it gets its own ring rather than borrowing the relocating cyan it
      // sits beside here. Every named vault colour is already claimed (see
      // `storing`'s own comment below), so this is hardcoded the same way
      // `storing` and `unstaffed` are: a warm scaffolding amber, distinct from
      // both the waiting-for-input orange and the storehouse brown it sits
      // between in this object. Required now, same reason `relocating` below
      // was required in the task that added it: tests/app/world-theme.test.ts
      // pins every stateRing entry pairwise-distinct, and graphics-cache
      // indexes stateRing[b.state] unconditionally, so adding
      // 'underConstruction' to BuildingState without a ring color here would
      // fail that pre-existing test AND leave a real site with an undefined
      // ring at runtime.
      underConstruction: pick(read, '--obsisim-state-under-construction', '#cf8b2f'),
      // Cyan-adjacent, matching the carried-load hue: both say "in transit".
      // Required now (not deferred to the UI task that otherwise owns this
      // file): tests/app/world-theme.test.ts already pins every stateRing
      // entry pairwise-distinct, and graphics-cache indexes stateRing[b.state]
      // unconditionally, so adding 'relocating' to BuildingState without a
      // ring color here would fail that pre-existing test AND leave a real
      // building genuinely in that state with an undefined ring at runtime.
      relocating: pick(read, '--obsisim-state-relocating', '#4bbfd4'),
      // A house never produces or stalls, it shelters — its own hue, not
      // borrowed from the production language above (green/orange/purple) or
      // the in-transit cyan. Same requirement as relocating just above: the
      // BuildingState union gained 'housing' this task, so a ring color is
      // needed now, not deferred to the task that draws the house on canvas.
      housing: pick(read, '--obsisim-state-housing', '#4c8bf5'),
      // A storehouse is neither a stall nor a home, so it gets its own hue
      // too — but every named vault colour is already spoken for above
      // (green/orange/purple/cyan/blue for the other states, and yellow/pink
      // are claimed below by the child mark and homelessMark), so this is
      // hardcoded like unstaffed's grey and elder's silver: a warm brown, the
      // register a depot's sacks and crates actually read as.
      storing: pick(read, '--obsisim-state-storing', STORE_BROWN),
    },
    colonistColors: Array.from({ length: COLONIST_BUCKETS }, (_, i) => mixHex(red, green, i / (COLONIST_BUCKETS - 1))),
    workerToolRing: pick(read, '--obsisim-color-tool-ring', '#f2ecdd'),
    progressFill: pick(read, '--obsisim-color-progress-fill', '#f5efdc'),
    // Deliberately the SAME token as stateRing.relocating, read a second
    // time rather than a second CSS custom property declared — see this
    // field's own doc comment above (WorldTheme.carriedLoad) for why a
    // carried load and a relocating building share a colour on purpose.
    carriedLoad: pick(read, '--obsisim-state-relocating', '#4bbfd4'),
    // Same move as carriedLoad just above: the SAME token as
    // stateRing.storing, not a second declaration — see carriedInput's own
    // doc comment for why that match is deliberate.
    carriedInput: pick(read, '--obsisim-state-storing', STORE_BROWN),
    accent: pick(read, '--obsisim-color-accent', '#7c8cf0'),
    danger: red,
    stageMark: {
      // The last bright vault hue nothing else claims. Red, orange and green
      // are the building rings, purple the output-full stall, cyan the
      // in-transit pair, blue the housing ring, cream the tools and the
      // progress bar, blue-violet the accent — yellow and pink are what is
      // left, and yellow is the one that reads as "new".
      child: pick(read, '--obsisim-mark-child', '#e6c84a'),
      // NOT a vault hue, deliberately. Pink is the only one still free and it
      // goes to homelessMark below, which is a problem the player can act on;
      // an elder is not a warning, they are simply out of the workforce, so a
      // neutral silver ("grey hair") says it without borrowing an alarm
      // colour. Hardcoded the way unstaffed, the ground tints and the two
      // creams are — well clear of the unstaffed grey (#8f8f8f), which sits
      // on buildings rather than colonists in any case.
      elder: pick(read, '--obsisim-mark-elder', '#b9c2d0'),
    },
    // The last vault hue, and the right register for it: homelessness is a
    // live problem, but it is not the ghost's blocked-red, so it gets its own
    // alarm rather than a second meaning for one already on screen.
    homelessMark: pick(read, '--obsisim-mark-homeless', '#e0619e'),
  };
}
