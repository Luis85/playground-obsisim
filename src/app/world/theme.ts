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
  /** A hauler's carried load. The world palette's production language is
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

const HEX = /^#[0-9a-f]{6}$/i;

// Obsidian themes expose their palette as CSS variables; anything that is not
// a plain 6-digit hex (hsl(), rgb(), empty) falls back so ex.Color.fromHex
// always gets input it can parse.
function pick(read: VarReader, name: string, fallback: string): string {
  const value = read(name).trim();
  return HEX.test(value) ? value : fallback;
}

const BUILDING_FILL: Record<BuildingDefId, string> = {
  gatherersHut: '#7d9464', farm: '#b0913f', mill: '#a2793d', bakery: '#b06a4e',
  forester: '#4e7a52', sawmill: '#8a6a49', workshop: '#6f6f85', house: '#c9a66b',
};

export const BUILDING_GLYPHS: Record<BuildingDefId, string> = {
  gatherersHut: '🧺', farm: '🌾', mill: '⚙️', bakery: '🍞',
  forester: '🌲', sawmill: '🪚', workshop: '🔨', house: '🏠',
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

export function resolveWorldTheme(read: VarReader): WorldTheme {
  const red = pick(read, '--color-red', '#e0533d');
  const green = pick(read, '--color-green', '#3cb46e');
  return {
    background: pick(read, '--background-primary', '#20242b'),
    ground: ['#55714a', '#4d6743'],
    buildingFill: BUILDING_FILL,
    buildingGlyph: BUILDING_GLYPHS,
    stateRing: {
      producing: green,
      waitingForInput: pick(read, '--color-orange', '#e5a63a'),
      unstaffed: '#8f8f8f',
      // Purple, deliberately outside the green/orange production language: this
      // building is not short of anything, it has nowhere to put what it made.
      outputFull: pick(read, '--color-purple', '#8f6fbf'),
      // Cyan-adjacent, matching the carried-load hue: both say "in transit".
      // Required now (not deferred to the UI task that otherwise owns this
      // file): tests/app/world-theme.test.ts already pins every stateRing
      // entry pairwise-distinct, and graphics-cache indexes stateRing[b.state]
      // unconditionally, so adding 'relocating' to BuildingState without a
      // ring color here would fail that pre-existing test AND leave a real
      // building genuinely in that state with an undefined ring at runtime.
      relocating: pick(read, '--color-cyan', '#4bbfd4'),
      // A house never produces or stalls, it shelters — its own hue, not
      // borrowed from the production language above (green/orange/purple) or
      // the in-transit cyan. Same requirement as relocating just above: the
      // BuildingState union gained 'housing' this task, so a ring color is
      // needed now, not deferred to the task that draws the house on canvas.
      housing: pick(read, '--color-blue', '#4c8bf5'),
    },
    colonistColors: Array.from({ length: COLONIST_BUCKETS }, (_, i) => mixHex(red, green, i / (COLONIST_BUCKETS - 1))),
    workerToolRing: '#f2ecdd',
    progressFill: '#f5efdc',
    carriedLoad: pick(read, '--color-cyan', '#4bbfd4'),
    accent: pick(read, '--interactive-accent', '#7c8cf0'),
    danger: red,
    stageMark: {
      // The last bright vault hue nothing else claims. Red, orange and green
      // are the building rings, purple the output-full stall, cyan the
      // in-transit pair, blue the housing ring, cream the tools and the
      // progress bar, blue-violet the accent — yellow and pink are what is
      // left, and yellow is the one that reads as "new".
      child: pick(read, '--color-yellow', '#e6c84a'),
      // NOT a vault hue, deliberately. Pink is the only one still free and it
      // goes to homelessMark below, which is a problem the player can act on;
      // an elder is not a warning, they are simply out of the workforce, so a
      // neutral silver ("grey hair") says it without borrowing an alarm
      // colour. Hardcoded the way unstaffed, the ground tints and the two
      // creams are — well clear of the unstaffed grey (#8f8f8f), which sits
      // on buildings rather than colonists in any case.
      elder: '#b9c2d0',
    },
    // The last vault hue, and the right register for it: homelessness is a
    // live problem, but it is not the ghost's blocked-red, so it gets its own
    // alarm rather than a second meaning for one already on screen.
    homelessMark: pick(read, '--color-pink', '#e0619e'),
  };
}
