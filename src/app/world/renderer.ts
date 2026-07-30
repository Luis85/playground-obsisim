import {
  Actor, BaseAlign, Circle, Color, DisplayMode, Engine, Font, GraphicsGroup,
  Rectangle, Text, TextAlign, TileMap, vec,
} from 'excalibur';
import type { Snapshot } from '../../shared/snapshot';
import type { WorldRenderer, WorldRendererFactory } from './renderer-key';
import { layoutWorld, TILE, type PlacedBuilding, type PlacedWorker, type WorldLayout } from './layout';
import { efficiencyBucket, resolveWorldTheme, type WorldTheme } from './theme';

const WORKER_RADIUS = 7;
const WORKER_SPEED = 90; // px/s walk speed toward a new post
const BUILDING_SIZE = TILE * 1.5;
const BAR_WIDTH = TILE * 1.2;
const BAR_HEIGHT = 5;

interface BuildingBundle { root: Actor; bar: Actor; state: string; }
interface WorkerBundle { actor: Actor; bucket: number; tooled: boolean; target: { x: number; y: number }; }

/** Building/worker looks are shared graphics, built lazily per variant. */
class GraphicCache {
  private buildings = new Map<string, GraphicsGroup>();
  private workers = new Map<string, Circle>();

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

  worker(bucket: number, tooled: boolean): Circle {
    const key = `${bucket}/${tooled}`;
    let circle = this.workers.get(key);
    if (!circle) {
      circle = new Circle({
        radius: WORKER_RADIUS,
        color: Color.fromHex(this.theme.workerColors[bucket]),
        strokeColor: tooled ? Color.fromHex(this.theme.workerToolRing) : undefined,
        lineWidth: tooled ? 2 : 0,
      });
      this.workers.set(key, circle);
    }
    return circle;
  }
}

class ExcaliburWorldRenderer implements WorldRenderer {
  private engine: Engine;
  private cache: GraphicCache;
  private theme: WorldTheme;
  private ground: TileMap | null = null;
  private groundKey = '';
  private buildings = new Map<number, BuildingBundle>();
  private workers = new Map<number, WorkerBundle>();
  private running = true;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.theme = resolveWorldTheme((name) => getComputedStyle(host).getPropertyValue(name));
    this.cache = new GraphicCache(this.theme);
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    this.engine = new Engine({
      canvasElement: canvas,
      displayMode: DisplayMode.FillContainer,
      backgroundColor: Color.fromHex(this.theme.background),
      suppressConsoleBootMessage: true,
      suppressPlayButton: true,
    });
    void this.engine.start();
  }

  sync(snapshot: Snapshot): void {
    if (this.disposed) return;
    const layout = layoutWorld(snapshot);
    this.syncGround(layout);
    this.syncBuildings(layout.buildings);
    this.syncWorkers(layout.workers);
    this.fitCamera(layout);
  }

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    void this.engine.start();
  }

  stop(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.engine.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.stop();
    this.engine.dispose();
  }

  private syncGround(layout: WorldLayout): void {
    const key = `${layout.cols}x${layout.rows}`;
    if (key === this.groundKey) return;
    this.groundKey = key;
    this.ground?.kill();
    this.ground = new TileMap({ tileWidth: TILE, tileHeight: TILE, columns: layout.cols, rows: layout.rows });
    const tints = this.theme.ground.map((hex) => new Rectangle({ width: TILE, height: TILE, color: Color.fromHex(hex) }));
    for (const tile of this.ground.tiles) {
      tile.addGraphic(tints[(tile.x + tile.y) % 2]);
    }
    this.engine.currentScene.add(this.ground);
  }

  private syncBuildings(placed: PlacedBuilding[]): void {
    const seen = new Set<number>();
    for (const b of placed) {
      seen.add(b.id);
      let bundle = this.buildings.get(b.id);
      if (!bundle) {
        bundle = this.spawnBuilding(b);
        this.buildings.set(b.id, bundle);
      }
      if (bundle.state !== b.state) {
        bundle.state = b.state;
        bundle.root.graphics.use(this.cache.building(b));
      }
      bundle.bar.graphics.isVisible = b.batchActive;
      bundle.bar.scale = vec(Math.max(b.progressPct / 100, 0.001), 1);
    }
    this.removeAbsent(this.buildings, seen, (bundle) => bundle.root.kill());
  }

  private spawnBuilding(b: PlacedBuilding): BuildingBundle {
    const root = new Actor({ pos: vec((b.col + 0.5) * TILE, (b.row + 0.5) * TILE), z: 1 });
    root.graphics.use(this.cache.building(b));
    const bar = new Actor({
      pos: vec(-BAR_WIDTH / 2, BUILDING_SIZE / 2 - BAR_HEIGHT),
      anchor: vec(0, 0.5), width: BAR_WIDTH, height: BAR_HEIGHT,
      color: Color.fromHex(this.theme.stateRing.producing), z: 2,
    });
    root.addChild(bar);
    this.engine.currentScene.add(root);
    return { root, bar, state: b.state };
  }

  private syncWorkers(placed: PlacedWorker[]): void {
    const seen = new Set<number>();
    for (const w of placed) {
      seen.add(w.id);
      const target = { x: w.x * TILE, y: w.y * TILE };
      const bucket = efficiencyBucket(w.efficiency);
      const bundle = this.workers.get(w.id);
      if (!bundle) {
        const actor = new Actor({ pos: vec(target.x, target.y), z: 3 });
        actor.graphics.use(this.cache.worker(bucket, w.tooled));
        this.engine.currentScene.add(actor);
        this.workers.set(w.id, { actor, bucket, tooled: w.tooled, target });
        continue;
      }
      if (bundle.bucket !== bucket || bundle.tooled !== w.tooled) {
        bundle.bucket = bucket;
        bundle.tooled = w.tooled;
        bundle.actor.graphics.use(this.cache.worker(bucket, w.tooled));
      }
      if (bundle.target.x !== target.x || bundle.target.y !== target.y) {
        bundle.target = target;
        bundle.actor.actions.clearActions();
        bundle.actor.actions.moveTo(vec(target.x, target.y), WORKER_SPEED);
      }
    }
    this.removeAbsent(this.workers, seen, (bundle) => bundle.actor.kill());
  }

  private removeAbsent<T>(map: Map<number, T>, seen: Set<number>, kill: (bundle: T) => void): void {
    for (const [id, bundle] of map) {
      if (!seen.has(id)) {
        kill(bundle);
        map.delete(id);
      }
    }
  }

  private fitCamera(layout: WorldLayout): void {
    const worldW = layout.cols * TILE;
    const worldH = layout.rows * TILE;
    const camera = this.engine.currentScene.camera;
    camera.pos = vec(worldW / 2, worldH / 2);
    camera.zoom = Math.min(this.engine.drawWidth / worldW, this.engine.drawHeight / worldH) * 0.95;
  }
}

export const createExcaliburWorldRenderer: WorldRendererFactory = (host) => new ExcaliburWorldRenderer(host);
