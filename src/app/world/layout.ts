import type { Snapshot, BuildingState, WorkerSnapshot } from '../../shared/snapshot';
import type { BuildingDefId } from '../../shared/content-types';

export const TILE = 48;

// Fixed geography (tile coords): idle camp on the left, building plots to the
// right of it, one-tile gutters between plots. Placement depends only on ids,
// so the world never reshuffles under the player (spec §2.3).
const PLOTS_PER_ROW = 5;
const PLOT_COL0 = 4;
const PLOT_ROW0 = 1;
const CAMP_COL0 = 1;
const CAMP_PER_ROW = 2;
const MIN_ROWS = 7;
const COLS = PLOT_COL0 + PLOTS_PER_ROW * 2;

export interface PlacedBuilding {
  id: number;
  defId: BuildingDefId;
  col: number;
  row: number;
  state: BuildingState;
  progressPct: number;
  batchActive: boolean;
}

export interface PlacedWorker {
  id: number;
  /** Tile-space coordinates (fractional): px = x * TILE. */
  x: number;
  y: number;
  /**
   * The worker's post: a building id, or null for the idle camp. The
   * renderer keeps a worker parked while `at` is unchanged, so slot-math
   * shifts (a span stretching or shrinking) never make bystanders walk.
   */
  at: number | null;
  efficiency: number;
  tooled: boolean;
}

export interface WorldLayout {
  tile: number;
  cols: number;
  rows: number;
  /** Tile-space anchor of the idle camp, for the renderer's camp marker. */
  camp: { x: number; y: number };
  buildings: PlacedBuilding[];
  workers: PlacedWorker[];
}

interface Spot { x: number; y: number; }

const CAMP_ANCHOR: Spot = { x: CAMP_COL0 + 1, y: 0.75 };
const CAMP_MIN_SPOTS = 6;

function byId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

/**
 * Deterministic id-keyed slots: preferred slot = id modulo span, probing
 * upward on collision in id order (members must arrive id-sorted). Keying to
 * the worker's own id — never its rank in the current set — means arrivals
 * and departures disturb a neighbor only on a hash collision, not always.
 */
function stableSlots(members: { id: number }[], span: number): Map<number, number> {
  const slots = new Map<number, number>();
  const taken = new Set<number>();
  for (const m of members) {
    let slot = m.id % span;
    while (taken.has(slot)) slot = (slot + 1) % span; // members <= span, so a free slot exists
    taken.add(slot);
    slots.set(m.id, slot);
  }
  return slots;
}

/** Plot index = rank in id order, row-major — construction appends, never moves. */
function placeBuildings(snapshot: Snapshot): Map<number, PlacedBuilding> {
  const cellById = new Map<number, PlacedBuilding>();
  const sorted = [...snapshot.buildings].sort(byId);
  for (const [rank, b] of sorted.entries()) {
    cellById.set(b.id, {
      id: b.id,
      defId: b.defId,
      col: PLOT_COL0 + 2 * (rank % PLOTS_PER_ROW),
      row: PLOT_ROW0 + 2 * Math.floor(rank / PLOTS_PER_ROW),
      state: b.state,
      progressPct: b.progressPct,
      batchActive: b.batchActive,
    });
  }
  return cellById;
}

/**
 * One spot per assigned worker, along the south edge of the building's cell,
 * on id-keyed slots (see stableSlots). The span divides the cell by slot
 * capacity, but stretches for grandfathered over-capacity rosters (a save
 * from before a slot retuning may legally carry more workers than
 * workerSlots), so every spot stays inside the cell.
 */
function assignedSpots(snapshot: Snapshot, cellById: Map<number, PlacedBuilding>): Map<number, Spot> {
  const rosters = new Map<number, WorkerSnapshot[]>();
  for (const w of [...snapshot.workers].sort(byId)) {
    if (w.buildingId === null || !cellById.has(w.buildingId)) continue;
    const mates = rosters.get(w.buildingId) ?? [];
    mates.push(w);
    rosters.set(w.buildingId, mates);
  }
  const spots = new Map<number, Spot>();
  for (const b of snapshot.buildings) {
    const cell = cellById.get(b.id)!;
    const mates = rosters.get(b.id) ?? [];
    const span = Math.max(b.workerSlots, mates.length);
    for (const [id, slot] of stableSlots(mates, span)) {
      spots.set(id, { x: cell.col + (slot + 1) / (span + 1), y: cell.row + 0.85 });
    }
  }
  return spots;
}

export function layoutWorld(snapshot: Snapshot): WorldLayout {
  const cellById = placeBuildings(snapshot);
  const assigned = assignedSpots(snapshot, cellById);
  const sorted = [...snapshot.workers].sort(byId);
  // Campers get id-keyed slots too — a colleague heading to work or a fresh
  // recruit must not reshuffle the whole camp. The span stretches only when
  // the camp outgrows its baseline capacity.
  const idle = sorted.filter((w) => !assigned.has(w.id));
  const campSpan = Math.max(CAMP_MIN_SPOTS, idle.length);
  const campSlots = stableSlots(idle, campSpan);
  const workers: PlacedWorker[] = [];
  for (const w of sorted) {
    const slot = campSlots.get(w.id);
    const spot = slot === undefined
      ? assigned.get(w.id)!
      : { x: CAMP_COL0 + (slot % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(slot / CAMP_PER_ROW) };
    const at = slot === undefined ? w.buildingId : null;
    workers.push({ id: w.id, x: spot.x, y: spot.y, at, efficiency: w.efficiency, tooled: w.toolTicks > 0 });
  }
  const plotRows = Math.ceil(cellById.size / PLOTS_PER_ROW);
  const campRows = Math.ceil(campSpan / CAMP_PER_ROW);
  const rows = Math.max(MIN_ROWS, PLOT_ROW0 + 2 * plotRows + 1, campRows + 3);
  return { tile: TILE, cols: COLS, rows, camp: CAMP_ANCHOR, buildings: [...cellById.values()], workers };
}
