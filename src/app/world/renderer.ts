import {
  Actor, BaseAlign, Circle, Color, DisplayMode, Engine, Font, GraphicsGroup,
  Rectangle, Text, TextAlign, TileMap, vec, type Vector,
} from 'excalibur';
import type { WorldRendererFactory } from './renderer-key';
import { layoutWorld, TILE, type PlacedBuilding, type PlacedWorker, type WorldLayout } from './layout';
import { efficiencyBucket, resolveWorldTheme, type WorldTheme } from './theme';

// The Excalibur end of the renderer seam: the only module that imports
// excalibur (spec §2.5), exempt from unit tests — it needs a real canvas
// runtime; the logic lives in the tested pure modules. Everything visual is
// derived per sync from the layout; between syncs Excalibur just renders.

const WORKER_RADIUS = 7;
const WORKER_SPEED = 90; // px/s walk speed toward a new post
const BUILDING_SIZE = TILE * 1.5;
const BAR_WIDTH = TILE * 1.2;
const BAR_HEIGHT = 5;

// Draw order, back to front: ground tilemap (default z 0), building tiles and
// the camp tent (z 1), progress bars (z 2), workers on top of everything (z 3).
interface BuildingBundle { root: Actor; bar: Actor; track: Actor; }
interface WorkerBundle { actor: Actor; target: Vector; }

/**
 * Building and worker looks are shared, lazily-built graphics: seven defs x
 * three states and five efficiency buckets x tooled-or-not. Actors swap
 * between cached variants instead of re-rasterizing anything per entity.
 */
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

/**
 * Owns the scene contents: diffs each layout against the live actors by
 * entity id — spawn what is new, update what changed, kill what is gone.
 * Nothing is rebuilt wholesale.
 */
class WorldScene {
  private ground: TileMap | null = null;
  private groundKey = '';
  private camp: Actor | null = null;
  private buildings = new Map<number, BuildingBundle>();
  private workers = new Map<number, WorkerBundle>();
  private cache: GraphicCache;
  private lastLayout: WorldLayout | null = null;

  constructor(private engine: Engine, private theme: WorldTheme) {
    this.cache = new GraphicCache(theme);
  }

  sync(layout: WorldLayout): void {
    this.lastLayout = layout;
    this.syncGround(layout);
    this.syncCamp(layout);
    for (const b of layout.buildings) this.upsertBuilding(b);
    for (const w of layout.workers) this.upsertWorker(w);
    this.prune(this.buildings, layout.buildings, (bundle) => bundle.root.kill());
    this.prune(this.workers, layout.workers, (bundle) => bundle.actor.kill());
    this.fitCamera(layout);
  }

  /** Re-frame after a pane resize — no snapshot arrives for that, and while
   * the sim is paused none ever would (review finding on PR #4). */
  refit(): void {
    if (this.lastLayout) this.fitCamera(this.lastLayout);
  }

  /** Kill and forget every actor whose entity left the snapshot. */
  private prune<T>(live: Map<number, T>, placed: { id: number }[], kill: (bundle: T) => void): void {
    const seen = new Set<number>();
    for (const item of placed) seen.add(item.id);
    for (const [id, bundle] of live) {
      if (!seen.has(id)) {
        kill(bundle);
        live.delete(id);
      }
    }
  }

  /** The checkered ground only rebuilds when the grid grows. */
  private syncGround(layout: WorldLayout): void {
    const key = `${layout.cols}x${layout.rows}`;
    if (key === this.groundKey) return;
    this.groundKey = key;
    this.ground?.kill();
    this.ground = new TileMap({ tileWidth: TILE, tileHeight: TILE, columns: layout.cols, rows: layout.rows });
    const tints: Rectangle[] = [];
    for (const hex of this.theme.ground) {
      tints.push(new Rectangle({ width: TILE, height: TILE, color: Color.fromHex(hex) }));
    }
    for (const tile of this.ground.tiles) {
      tile.addGraphic(tints[(tile.x + tile.y) % 2]);
    }
    this.engine.currentScene.add(this.ground);
  }

  /** A tent marks the idle camp as a place; it never moves. */
  private syncCamp(layout: WorldLayout): void {
    if (this.camp) return;
    this.camp = new Actor({ pos: vec(layout.camp.x * TILE, layout.camp.y * TILE), z: 1 });
    this.camp.graphics.use(new Text({
      text: '⛺',
      font: new Font({ family: 'sans-serif', size: 30, textAlign: TextAlign.Center, baseAlign: BaseAlign.Middle }),
    }));
    this.engine.currentScene.add(this.camp);
  }

  private upsertBuilding(b: PlacedBuilding): void {
    const bundle = this.buildings.get(b.id) ?? this.spawnBuilding(b);
    // graphics are cached per (def, state): re-using the current one is trivial
    bundle.root.graphics.use(this.cache.building(b));
    bundle.track.graphics.isVisible = b.batchActive;
    bundle.bar.graphics.isVisible = b.batchActive;
    bundle.bar.scale = vec(Math.max(b.progressPct / 100, 0.001), 1);
  }

  private spawnBuilding(b: PlacedBuilding): BuildingBundle {
    const root = new Actor({ pos: vec((b.col + 0.5) * TILE, (b.row + 0.5) * TILE), z: 1 });
    root.graphics.use(this.cache.building(b));
    // batch progress: a dark track with a left-anchored fill bar on top,
    // the fill's x-scale being the percent (same z — insertion order wins)
    const barShape = {
      pos: vec(-BAR_WIDTH / 2, BUILDING_SIZE / 2 - BAR_HEIGHT),
      anchor: vec(0, 0.5), width: BAR_WIDTH, height: BAR_HEIGHT, z: 2,
    };
    const track = new Actor({ ...barShape, color: new Color(15, 18, 15, 0.55) });
    const bar = new Actor({ ...barShape, color: Color.fromHex(this.theme.progressFill) });
    root.addChild(track);
    root.addChild(bar);
    this.engine.currentScene.add(root);
    const bundle = { root, bar, track };
    this.buildings.set(b.id, bundle);
    return bundle;
  }

  private upsertWorker(w: PlacedWorker): void {
    const target = vec(w.x * TILE, w.y * TILE);
    const bundle = this.workers.get(w.id) ?? this.spawnWorker(w.id, target);
    bundle.actor.graphics.use(this.cache.worker(efficiencyBucket(w.efficiency), w.tooled));
    this.walkWorker(bundle, target);
  }

  /** New workers appear in place — only reassignments walk (spec §2.4). */
  private spawnWorker(id: number, target: Vector): WorkerBundle {
    const actor = new Actor({ pos: target, z: 3 });
    this.engine.currentScene.add(actor);
    const bundle = { actor, target };
    this.workers.set(id, bundle);
    return bundle;
  }

  /**
   * The layout allocates slots with memory (layoutWorld's `previous`), so a
   * target only ever changes on a real reassignment — following it is safe.
   */
  private walkWorker(bundle: WorkerBundle, target: Vector): void {
    if (bundle.target.equals(target)) return;
    bundle.target = target;
    bundle.actor.actions.clearActions();
    bundle.actor.actions.moveTo(target, WORKER_SPEED);
  }

  /** Frame the whole grid with a small margin, re-checked every sync. */
  private fitCamera(layout: WorldLayout): void {
    const worldW = layout.cols * TILE;
    const worldH = layout.rows * TILE;
    const camera = this.engine.currentScene.camera;
    camera.pos = vec(worldW / 2, worldH / 2);
    camera.zoom = Math.min(this.engine.drawWidth / worldW, this.engine.drawHeight / worldH) * 0.95;
  }
}

/**
 * Boots the engine into the host element and maps the seam's lifecycle onto
 * the engine clock: stop/start halt and resume rendering around hidden tabs,
 * dispose tears down the engine (and its WebGL context) with the view. The
 * palette is resolved against the host so the canvas inherits the vault
 * theme; a mid-session theme switch repaints on the next view open.
 */
export const createExcaliburWorldRenderer: WorldRendererFactory = (host) => {
  const theme = resolveWorldTheme((name) => getComputedStyle(host).getPropertyValue(name));
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  const engine = new Engine({
    canvasElement: canvas,
    displayMode: DisplayMode.FillContainer,
    backgroundColor: Color.fromHex(theme.background),
    suppressConsoleBootMessage: true,
    suppressPlayButton: true,
  });
  const scene = new WorldScene(engine, theme);
  // FillContainer tracks the host's size, but only the camera fit knows the
  // grid — refit on pane resizes, which emit no snapshots (none at all while
  // the sim is paused).
  const observer = new ResizeObserver(() => scene.refit());
  observer.observe(host);
  let running = true;
  let disposed = false;
  // fed back into layoutWorld so slot allocation remembers who stands where
  let last: WorldLayout | undefined;
  void engine.start();

  return {
    sync(snapshot) {
      if (disposed) return;
      last = layoutWorld(snapshot, last);
      scene.sync(last);
    },
    start() {
      if (disposed || running) return;
      running = true;
      void engine.start();
    },
    stop() {
      if (disposed || !running) return;
      running = false;
      engine.stop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      engine.stop();
      engine.dispose();
    },
  };
};
