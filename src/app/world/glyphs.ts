import {
  Actor, BaseAlign, Color, Font, Rectangle, Text, TextAlign, vec,
  type Graphic, type Vector,
} from 'excalibur';
import { TILE } from './layout';
import { BUILDING_SIZE } from './graphics-cache';
import type { WorldTheme } from './theme';

// The second half of the Excalibur seam: every actor-and-graphic the scene
// hangs off an entity is built here, so `renderer.ts` is left with the
// diffing and lifecycle logic alone. Same exemption as renderer.ts and
// graphics-cache.ts — this module imports excalibur, so no vitest test may
// import it (docs/process/agent-workflow.md); `npm run smoke:world` is its
// only coverage.
//
// Everything here is a pure factory: it takes a theme and a geometry and
// returns detached actors. Parenting, positioning and visibility are the
// scene's business, so a glyph can be reused wherever it reads correctly.

const BAR_WIDTH = TILE * 0.8;
const BAR_HEIGHT = 5;
/** The dark bed a fill is read against — a gauge is only legible against its
 * own empty remainder. */
const GAUGE_TRACK = new Color(15, 18, 15, 0.55);

/**
 * A track-and-fill pair: the dark bed, plus the fill the scene scales to the
 * quantity. Both carry the same z as their parent and are added in order, so
 * the fill always lands on top of its own track.
 */
export interface Gauge { track: Actor; fill: Actor; }

/** Batch progress: a left-anchored bar across the foot of a building tile,
 * whose x-scale is the percent. */
export function progressGauge(theme: WorldTheme): Gauge {
  const shape = {
    pos: vec(-BAR_WIDTH / 2, BUILDING_SIZE / 2 - BAR_HEIGHT),
    anchor: vec(0, 0.5), width: BAR_WIDTH, height: BAR_HEIGHT, z: 2,
  };
  return {
    track: new Actor({ ...shape, color: GAUGE_TRACK }),
    fill: new Actor({ ...shape, color: Color.fromHex(theme.progressFill) }),
  };
}

/** The idle camp's tent — a place marker, not an entity: it never moves and
 * nothing is ever diffed against it. */
export function campTent(x: number, y: number): Actor {
  const tent = new Actor({ pos: vec(x * TILE, y * TILE), z: 1 });
  tent.graphics.use(new Text({
    text: '⛺',
    font: new Font({ family: 'sans-serif', size: 30, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
  }));
  return tent;
}

/** The selection highlight: an accent square around a whole tile. */
export function selectionRing(theme: WorldTheme): Actor {
  const ring = new Actor({ z: 2 });
  ring.graphics.use(new Rectangle({
    width: TILE, height: TILE, color: Color.Transparent,
    strokeColor: Color.fromHex(theme.accent), lineWidth: 3,
  }));
  return ring;
}

/** One hidden satellite dot for a colonist. A fixed-hue mark passes its
 * graphic here once; a mark whose hue varies passes null and is given one per
 * sync. */
export function satelliteDot(offset: Vector, graphic: Graphic | null): Actor {
  const dot = new Actor({ pos: offset, z: 3 });
  if (graphic !== null) dot.graphics.use(graphic);
  dot.graphics.visible = false;
  return dot;
}

/** The checkerboard's two tints, in the order `(x + y) % 2` indexes them. */
export function groundTints(theme: WorldTheme): Rectangle[] {
  return theme.ground.map((hex) => new Rectangle({ width: TILE, height: TILE, color: Color.fromHex(hex) }));
}
