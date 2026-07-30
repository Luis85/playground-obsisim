import type { BuildingDefId } from '../../shared/content-types';
import type { BuildingState } from '../../shared/snapshot';

export type VarReader = (name: string) => string;

export interface WorldTheme {
  background: string;
  ground: [string, string];
  buildingFill: Record<BuildingDefId, string>;
  buildingGlyph: Record<BuildingDefId, string>;
  stateRing: Record<BuildingState, string>;
  workerColors: string[];
  workerToolRing: string;
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
  forester: '#4e7a52', sawmill: '#8a6a49', workshop: '#6f6f85',
};

const BUILDING_GLYPH: Record<BuildingDefId, string> = {
  gatherersHut: '🧺', farm: '🌾', mill: '⚙️', bakery: '🍞',
  forester: '🌲', sawmill: '🪚', workshop: '🔨',
};

function mixHex(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const lerp = (i: number) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t);
  return `#${[0, 1, 2].map((i) => lerp(i).toString(16).padStart(2, '0')).join('')}`;
}

const WORKER_BUCKETS = 5;
const BUCKET_CEILINGS = [0.35, 0.55, 0.75, 0.95];

export function efficiencyBucket(efficiency: number): number {
  const index = BUCKET_CEILINGS.findIndex((ceiling) => efficiency < ceiling);
  return index === -1 ? WORKER_BUCKETS - 1 : index;
}

export function resolveWorldTheme(read: VarReader): WorldTheme {
  const red = pick(read, '--color-red', '#e0533d');
  const green = pick(read, '--color-green', '#3cb46e');
  return {
    background: pick(read, '--background-primary', '#20242b'),
    ground: ['#55714a', '#4d6743'],
    buildingFill: BUILDING_FILL,
    buildingGlyph: BUILDING_GLYPH,
    stateRing: {
      producing: green,
      waitingForInput: pick(read, '--color-orange', '#e5a63a'),
      unstaffed: '#8f8f8f',
    },
    workerColors: Array.from({ length: WORKER_BUCKETS }, (_, i) => mixHex(red, green, i / (WORKER_BUCKETS - 1))),
    workerToolRing: '#f2ecdd',
  };
}
