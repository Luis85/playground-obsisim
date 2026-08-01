import {
  Actor, BaseAlign, Circle, Color, DisplayMode, Engine, Font,
  Rectangle, Text, TextAlign, TileMap, vec, type Vector,
} from 'excalibur';
import type { Snapshot } from '../../shared/snapshot';
import type { GhostPreview, WorldRendererFactory } from './renderer-key';
import {
  layoutWorld, pickBuildingAt, TILE,
  type PlacedBuilding, type PlacedWorker, type WorldLayout, type WorldPick,
} from './layout';
import { BUILDING_SIZE, GraphicCache, WORKER_RADIUS } from './graphics-cache';
import { efficiencyBucket, resolveWorldTheme, type WorldTheme } from './theme';

// The Excalibur end of the renderer seam: the only module that imports
// excalibur (spec §2.5), exempt from unit tests — it needs a real canvas
// runtime; the logic lives in the tested pure modules. Everything visual is
// derived per sync from the layout; between syncs Excalibur just renders.
// Behavior is verified end to end by the browser smoke test
// (`npm run smoke:world`): boot-and-draw, walking, clock stop/start,
// pick() through the live camera, and clean dispose.

const WORKER_PICK_RADIUS = 11; // SCREEN px hover tolerance, world-converted per live zoom
const WORKER_SPEED = 90; // px/s walk speed toward a new post
const BAR_WIDTH = TILE * 0.8;
const BAR_HEIGHT = 5;

// Draw order, back to front: ground tilemap (default z 0), building tiles and
// the camp tent (z 1), progress bars and the selection ring (z 2), workers
// (z 3), the placement ghost on top of everything (z 4).
interface BuildingBundle { root: Actor; bar: Actor; track: Actor; }
interface WorkerBundle { actor: Actor; target: Vector; load: Actor; }

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
  private ghost: Actor | null = null;
  private selectionRing: Actor | null = null;
  private selectedId: number | null = null;

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
    this.applySelection();
  }

  /** Forget every entity actor — a colony reset reuses entity ids, so the
   * replacement colony must not inherit this scene's identity state. */
  clear(): void {
    for (const bundle of this.buildings.values()) bundle.root.kill();
    for (const bundle of this.workers.values()) bundle.actor.kill();
    this.buildings.clear();
    this.workers.clear();
    this.setGhost(null);
    this.selectionRing?.kill();
    this.selectionRing = null;
  }

  /** Re-frame after a pane resize — no snapshot arrives for that, and while
   * the sim is paused none ever would (review finding on PR #4). */
  refit(): void {
    if (this.lastLayout) this.fitCamera(this.lastLayout);
  }

  /**
   * The worker under a world-space point, tested against LIVE actor
   * positions — a walking dot is picked where it is drawn, not at the
   * layout target it has not reached yet (review round 7). Nearest wins.
   */
  workerAt(worldX: number, worldY: number): number | null {
    let bestId: number | null = null;
    // WORKER_PICK_RADIUS is a screen-space hover tolerance converted to the
    // live camera's zoom here — world-space distances shrink relative to a
    // fixed screen radius as the camera zooms out, so comparing against a
    // flat world-space radius made hover/pick accuracy zoom-dependent (only
    // visible once a layout needed zoom < 1 to fit, same trigger as the
    // fitCamera bug below). The || 1 guards a 0x0-measured host: fitCamera
    // would yield zoom 0 there, and dividing by it turns the radius infinite.
    const zoom = this.engine.currentScene.camera.zoom || 1;
    let bestD2 = (WORKER_PICK_RADIUS / zoom) ** 2;
    for (const [id, bundle] of this.workers) {
      const d2 = (bundle.actor.pos.x - worldX) ** 2 + (bundle.actor.pos.y - worldY) ** 2;
      if (d2 <= bestD2) {
        bestD2 = d2;
        bestId = id;
      }
    }
    return bestId;
  }

  setGhost(ghost: GhostPreview | null): void {
    if (ghost === null) {
      this.ghost?.kill();
      this.ghost = null;
      return;
    }
    if (this.ghost === null || this.ghost.isKilled()) {
      this.ghost = new Actor({ z: 4 });
      this.ghost.graphics.opacity = 0.55;
      this.engine.currentScene.add(this.ghost);
    }
    this.ghost.pos = vec((ghost.col + 0.5) * TILE, (ghost.row + 0.5) * TILE);
    this.ghost.graphics.use(this.cache.ghost(ghost));
  }

  setSelection(buildingId: number | null): void {
    this.selectedId = buildingId;
    this.applySelection();
  }

  /** The currently selected building's cell, or undefined when nothing is
   * selected or the selected id no longer exists in the layout. */
  private selectedCell(): PlacedBuilding | undefined {
    if (this.selectedId === null) return undefined;
    return this.lastLayout?.buildings.find((b) => b.id === this.selectedId);
  }

  /** Lazily (re)creates the ring actor, mirroring the ghost/building caches. */
  private ensureSelectionRing(): Actor {
    if (this.selectionRing === null || this.selectionRing.isKilled()) {
      this.selectionRing = new Actor({ z: 2 });
      this.selectionRing.graphics.use(new Rectangle({
        width: TILE, height: TILE, color: Color.Transparent,
        strokeColor: Color.fromHex(this.theme.accent), lineWidth: 3,
      }));
      this.engine.currentScene.add(this.selectionRing);
    }
    return this.selectionRing;
  }

  /** Re-applied on every sync: the ring follows a moved building and dies
   * with a demolished one (the view also clears its own selection state). */
  private applySelection(): void {
    const cell = this.selectedCell();
    if (!cell) {
      this.selectionRing?.kill();
      this.selectionRing = null;
      return;
    }
    const ring = this.ensureSelectionRing();
    ring.pos = vec((cell.col + 0.5) * TILE, (cell.row + 0.5) * TILE);
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

  /** The checkered ground rebuilds only once: the map is fixed per colony
   * now (spec §2.1), so cols/rows never change again after the first sync. */
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
    bundle.root.pos = vec((b.col + 0.5) * TILE, (b.row + 0.5) * TILE); // moves snap to the new tile
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
    // A carrying hauler reads as "loaded" at a glance, which is what makes the
    // flow direction legible: dots going out are empty, dots coming back are not.
    bundle.load.graphics.visible = w.carrying;
    this.walkWorker(bundle, target);
  }

  /** New workers appear in place — only reassignments walk (spec §2.4). */
  private spawnWorker(id: number, target: Vector): WorkerBundle {
    const actor = new Actor({ pos: target, z: 3 });
    this.engine.currentScene.add(actor);
    const load = new Actor({ pos: vec(0, -WORKER_RADIUS - 3), z: 3 });
    load.graphics.use(new Circle({ radius: 3, color: Color.fromHex(this.theme.carriedLoad) }));
    load.graphics.visible = false;
    actor.addChild(load);
    const bundle = { actor, target, load };
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

  /** Frame the whole grid with a small margin, re-checked every sync.
   * Sized from the screen's raw resolution, NOT engine.drawWidth/drawHeight —
   * those already divide by the current camera.zoom, so feeding them back
   * into a new zoom is self-referential: zoom_new = fit / zoom_old, which
   * alternates between the correct fit and 1 on every call instead of
   * landing on it. Harmless while the grid was small enough to stay fully
   * on screen at zoom 1 too, but the fixed 24x16 map is the first layout
   * that needs zoom < 1 to fit, so the wrong half of the oscillation crops
   * real content off screen (root cause of the world-smoke regression). */
  private fitCamera(layout: WorldLayout): void {
    const worldW = layout.cols * TILE;
    const worldH = layout.rows * TILE;
    const camera = this.engine.currentScene.camera;
    const { width, height } = this.engine.screen.resolution;
    camera.pos = vec(worldW / 2, worldH / 2);
    camera.zoom = Math.min(width / worldW, height / worldH) * 0.95;
  }
}

/** Whether a tile cell falls inside the grid — used by tileAt so the bounds
 * check reads as one thing instead of a four-term guard at the call site. */
function inBounds(col: number, row: number, layout: WorldLayout): boolean {
  return col >= 0 && col < layout.cols && row >= 0 && row < layout.rows;
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
  let fatalListener: ((message: string) => void) | null = null;
  // fed back into layoutWorld so slot allocation remembers who stands where
  let last: WorldLayout | undefined;
  let lastSnapshot: Snapshot | null = null;

  const teardown = () => {
    observer.disconnect();
    try {
      engine.stop();
      engine.dispose();
    } catch {
      // a failed engine may throw again on teardown — nothing left to save
    }
  };
  // An async boot rejection would otherwise escape WorldView's try/catch as
  // an unhandled rejection with no fallback UI (spec §2.2).
  const fail = (error: unknown) => {
    if (disposed) return;
    disposed = true;
    teardown();
    canvas.remove();
    fatalListener?.(error instanceof Error ? error.message : String(error));
  };
  // All engine-clock operations are serialized behind the async boot, so a
  // fast tab switch or view close can never race a start() still in flight.
  let clock = engine.start().catch(fail);

  // A NEW snapshot object at the same or an earlier tick means a new timeline
  // (colony reset — including resetting a save still at tick 0): the fresh
  // world reuses entity ids, so held slots and id-keyed actors from the old
  // colony must not carry over (review rounds 9–10). The engine emits exactly
  // one snapshot object per tick, so a running session never trips this.
  const resetOnNewTimeline = (snapshot: Snapshot) => {
    if (lastSnapshot !== null && snapshot.tick <= lastSnapshot.tick) {
      scene.clear();
      last = undefined;
    }
  };

  return {
    sync(snapshot) {
      if (disposed || snapshot === lastSnapshot) return;
      resetOnNewTimeline(snapshot);
      lastSnapshot = snapshot;
      last = layoutWorld(snapshot, last);
      scene.sync(last);
    },
    pick(pageX, pageY): WorldPick | null {
      if (disposed || last === undefined) return null;
      const world = engine.screen.pageToWorldCoordinates(vec(pageX, pageY));
      const workerId = scene.workerAt(world.x, world.y);
      if (workerId !== null) return { kind: 'worker', id: workerId };
      return pickBuildingAt(last, world.x / TILE, world.y / TILE);
    },
    tileAt(pageX, pageY) {
      if (disposed || last === undefined) return null;
      const world = engine.screen.pageToWorldCoordinates(vec(pageX, pageY));
      const col = Math.floor(world.x / TILE);
      const row = Math.floor(world.y / TILE);
      return inBounds(col, row, last) ? { col, row } : null;
    },
    setGhost(ghost) {
      if (!disposed) scene.setGhost(ghost);
    },
    setSelection(buildingId) {
      if (!disposed) scene.setSelection(buildingId);
    },
    onFatal(listener) {
      fatalListener = listener;
    },
    start() {
      if (disposed || running) return;
      running = true;
      clock = clock.then(() => (running && !disposed ? engine.start() : undefined)).catch(fail);
    },
    stop() {
      if (disposed || !running) return;
      running = false;
      clock = clock
        .then(() => {
          if (!running && !disposed) engine.stop();
        })
        .catch(fail);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void clock.then(teardown, teardown);
    },
  };
};
