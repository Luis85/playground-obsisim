import {
  Actor, BaseAlign, Circle, Color, Font, Rectangle, Text, TextAlign, vec,
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
/** Inside the building tile's own state ring, so a store's gauge reads as
 * part of that tile rather than as something overlapping it. */
const STORE_RADIUS = BUILDING_SIZE / 2 - 3;

/**
 * A track-and-fill pair: the dark bed, plus the fill scaled to a 0-1 reading.
 * Both carry the same z as their parent and are added in order, so the fill
 * always lands on top of its own track.
 */
export interface Gauge {
  track: Actor;
  fill: Actor;
  /** Show or hide the whole gauge, and set the fill to a 0-1 reading. */
  set(shown: boolean, reading: number): void;
}

function gauge(track: Actor, fill: Actor, axis: (f: number) => Vector): Gauge {
  return {
    track,
    fill,
    set(shown: boolean, reading: number): void {
      track.graphics.isVisible = shown;
      fill.graphics.isVisible = shown;
      // Clamped away from an exact 0: a zero scale draws nothing at all, and a
      // gauge that vanishes when empty is indistinguishable from one that was
      // never there.
      fill.scale = axis(Math.min(Math.max(reading, 0.001), 1));
    },
  };
}

/** Batch progress: a left-anchored bar across the foot of a building tile,
 * growing along x alone so its height stays a constant. */
export function progressGauge(theme: WorldTheme): Gauge {
  const shape = {
    pos: vec(-BAR_WIDTH / 2, BUILDING_SIZE / 2 - BAR_HEIGHT),
    anchor: vec(0, 0.5), width: BAR_WIDTH, height: BAR_HEIGHT, z: 2,
  };
  return gauge(
    new Actor({ ...shape, color: GAUGE_TRACK }),
    new Actor({ ...shape, color: Color.fromHex(theme.progressFill) }),
    (f) => vec(f, 1),
  );
}

/**
 * A store's fill: a ring that grows from the tile's centre to the track ring
 * at its edge as the depot fills. Deliberately the same two colours as
 * `progressGauge` — a fill gauge is a fill gauge, and a second gauge language
 * would be a second thing for the player to learn. It is a RING rather than a
 * second bar because the quantity is not a batch: a bar at the foot of the
 * tile would read as progress toward something finishing.
 */
export function storeGauge(theme: WorldTheme): Gauge {
  const ring = (color: Color) => {
    const actor = new Actor({ z: 2 });
    // Unfilled: the building's own glyph has to stay readable through it.
    actor.graphics.use(new Circle({
      radius: STORE_RADIUS, color: Color.Transparent, strokeColor: color, lineWidth: 3,
    }));
    return actor;
  };
  return gauge(ring(GAUGE_TRACK), ring(Color.fromHex(theme.progressFill)), (f) => vec(f, f));
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

/** The plural "highlight" pulse (spec §2.3): a translucent accent glow over a
 * subject that a panel row lit up without selecting — a Population panel
 * clicks one colonist into a `selectionRing`, but "3 colonists have no bed" in
 * Attention names several at once, none of them selected, and no Inspector.
 * Deliberately a FILLED square rather than the selection ring's outline, so
 * the two read as different things at a glance rather than one looking like a
 * flickering copy of the other. Same accent hue as the selection ring on
 * purpose — both mean "the canvas is pointing at this" — just spoken in a
 * different register (opacity is set on `graphics`, the same knob `setGhost`
 * already turns for its own translucent preview). */
export function highlightPulse(theme: WorldTheme): Actor {
  const pulse = new Actor({ z: 2 });
  pulse.graphics.use(new Rectangle({ width: TILE * 1.1, height: TILE * 1.1, color: Color.fromHex(theme.accent) }));
  pulse.graphics.opacity = 0.35;
  return pulse;
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
