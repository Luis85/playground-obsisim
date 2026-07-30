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
  efficiency: number;
  tooled: boolean;
}

export interface WorldLayout {
  tile: number;
  cols: number;
  rows: number;
  buildings: PlacedBuilding[];
  workers: PlacedWorker[];
}

function placeBuildings(snapshot: Snapshot): Map<number, PlacedBuilding> {
  const cellById = new Map<number, PlacedBuilding>();
  [...snapshot.buildings]
    .sort((a, b) => a.id - b.id)
    .forEach((b, rank) => {
      cellById.set(b.id, {
        id: b.id,
        defId: b.defId,
        col: PLOT_COL0 + 2 * (rank % PLOTS_PER_ROW),
        row: PLOT_ROW0 + 2 * Math.floor(rank / PLOTS_PER_ROW),
        state: b.state,
        progressPct: b.progressPct,
        batchActive: b.batchActive,
      });
    });
  return cellById;
}

function placeWorker(
  w: WorkerSnapshot,
  snapshot: Snapshot,
  cellById: Map<number, PlacedBuilding>,
  idleRank: number,
): PlacedWorker {
  const base = { id: w.id, efficiency: w.efficiency, tooled: w.toolTicks > 0 };
  const cell = w.buildingId === null ? undefined : cellById.get(w.buildingId);
  if (cell === undefined) {
    return { ...base, x: CAMP_COL0 + (idleRank % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(idleRank / CAMP_PER_ROW) };
  }
  // Offsets divide the cell by slot capacity, not headcount, so filling an
  // empty slot never shifts the workers already standing there (spec §2.3).
  const slots = snapshot.buildings.find((b) => b.id === cell.id)!.workerSlots;
  const slot = snapshot.workers
    .filter((other) => other.buildingId === cell.id)
    .sort((a, b) => a.id - b.id)
    .findIndex((other) => other.id === w.id);
  return { ...base, x: cell.col + (slot + 1) / (slots + 1), y: cell.row + 0.85 };
}

export function layoutWorld(snapshot: Snapshot): WorldLayout {
  const cellById = placeBuildings(snapshot);
  let idleRank = 0;
  const workers = [...snapshot.workers]
    .sort((a, b) => a.id - b.id)
    .map((w) => {
      const isIdle = w.buildingId === null || !cellById.has(w.buildingId);
      return placeWorker(w, snapshot, cellById, isIdle ? idleRank++ : 0);
    });
  const plotRows = Math.ceil(cellById.size / PLOTS_PER_ROW);
  const campRows = Math.ceil(idleRank / CAMP_PER_ROW);
  const rows = Math.max(MIN_ROWS, PLOT_ROW0 + 2 * plotRows + 1, campRows + 3);
  return { tile: TILE, cols: COLS, rows, buildings: [...cellById.values()], workers };
}
