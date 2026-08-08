import {
  BaseAlign, Circle, Color, Font, GraphicsGroup, Rectangle, Text, TextAlign, vec,
} from 'excalibur';
import type { GhostPreview } from './renderer-key';
import { TILE, type PlacedBuilding } from './layout';
import type { WorldTheme } from './theme';

export const COLONIST_RADIUS = 7;
export const BUILDING_SIZE = TILE - 4;

/**
 * Building and colonist looks are shared, lazily-built graphics: seven defs x
 * three states and five efficiency buckets x tooled-or-not. Actors swap
 * between cached variants instead of re-rasterizing anything per entity.
 */
export class GraphicCache {
  private buildings = new Map<string, GraphicsGroup>();
  private colonists = new Map<string, Circle>();
  private ghosts = new Map<string, GraphicsGroup>();

  constructor(private theme: WorldTheme) {}

  building(b: PlacedBuilding): GraphicsGroup {
    const key = `${b.defId}/${b.state}`;
    let group = this.buildings.get(key);
    if (!group) {
      // useAnchor: false — members are placed by explicit offset from the
      // actor position; negative offsets center the rect, the glyph's own
      // Center/Middle alignment centers it, and useBounds keeps the text's
      // odd glyph bounds out of the group's bounding box (culling).
      group = new GraphicsGroup({
        useAnchor: false,
        members: [
          {
            graphic: new Rectangle({
              width: BUILDING_SIZE, height: BUILDING_SIZE,
              color: Color.fromHex(this.theme.buildingFill[b.defId]),
              strokeColor: Color.fromHex(this.theme.stateRing[b.state]), lineWidth: 3,
            }),
            offset: vec(-BUILDING_SIZE / 2, -BUILDING_SIZE / 2),
          },
          {
            graphic: new Text({
              text: this.theme.buildingGlyph[b.defId],
              font: new Font({ family: 'sans-serif', size: 26, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
            }),
            offset: vec(0, 0),
            useBounds: false,
          },
        ],
      });
      this.buildings.set(key, group);
    }
    return group;
  }

  colonist(bucket: number, tooled: boolean): Circle {
    const key = `${bucket}/${tooled}`;
    let circle = this.colonists.get(key);
    if (!circle) {
      circle = new Circle({
        radius: COLONIST_RADIUS,
        color: Color.fromHex(this.theme.colonistColors[bucket]),
        strokeColor: tooled ? Color.fromHex(this.theme.workerToolRing) : undefined,
        lineWidth: tooled ? 2 : 0,
      });
      this.colonists.set(key, circle);
    }
    return circle;
  }

  /** Ghost looks are cached per (def, validity), like building looks. */
  ghost(ghost: GhostPreview): GraphicsGroup {
    const key = `${ghost.defId}/${ghost.valid}`;
    let group = this.ghosts.get(key);
    if (!group) {
      group = new GraphicsGroup({
        useAnchor: false,
        members: [
          {
            // Fill IS the feedback: accent when buildable, danger when not —
            // exactly the WorldLegend's ghost chips (spec: "accent-tinted
            // when valid"). The def's own color would read as an ordinary
            // translucent building; the glyph still says WHAT is placed.
            graphic: new Rectangle({
              width: BUILDING_SIZE, height: BUILDING_SIZE,
              color: Color.fromHex(ghost.valid ? this.theme.accent : this.theme.danger),
              strokeColor: Color.fromHex(ghost.valid ? this.theme.accent : this.theme.danger), lineWidth: 3,
            }),
            offset: vec(-BUILDING_SIZE / 2, -BUILDING_SIZE / 2),
          },
          {
            graphic: new Text({
              text: this.theme.buildingGlyph[ghost.defId],
              font: new Font({ family: 'sans-serif', size: 26, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
            }),
            offset: vec(0, 0),
            useBounds: false,
          },
        ],
      });
      this.ghosts.set(key, group);
    }
    return group;
  }
}
