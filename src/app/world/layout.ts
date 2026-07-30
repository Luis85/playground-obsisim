import type { Snapshot, BuildingState, WorkerSnapshot } from '../../shared/snapshot';
import type { BuildingDefId } from '../../shared/content-types';
import { BUILDINGS } from '../../engine/content';

export const TILE = 48;

// Fixed geography (tile coords): idle camp on the left, building plots to the
// right of it, one-tile gutters between plots. Placement depends only on ids
// and remembered slots, so the world never reshuffles under the player
// (spec §2.3).
//
//   col: 0    1    2    3    4    5    6    ...
//   row 0     ⛺ (camp anchor)
//   row 1     [camp][camp]     [plot]     [plot]  ...
//   row 2     [camp][camp]
//   ...                        [plot]     [plot]  ...
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
  /** The worker's post: a building id, or null for the idle camp. */
  at: number | null;
  /** The slot held at that post — fed back via `previous` to stay put. */
  slot: number;
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
interface Placement { at: number | null; slot: number; spot: Spot; }

const CAMP_ANCHOR: Spot = { x: CAMP_COL0 + 1, y: 0.75 };
const CAMP_MIN_SPOTS = 6;

function byId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
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

/** The slots each worker held at each post in the previous layout. */
function heldSlots(previous?: WorldLayout): Map<number | null, Map<number, number>> {
  const held = new Map<number | null, Map<number, number>>();
  for (const w of previous?.workers ?? []) {
    const post = held.get(w.at) ?? new Map<number, number>();
    post.set(w.id, w.slot);
    held.set(w.at, post);
  }
  return held;
}

/**
 * Slot allocation with memory: a worker still at the same post keeps the
 * exact slot it held; only newcomers allocate, id-keyed (id modulo span,
 * probing upward across free slots in id order). Positions derive from the
 * slot alone (never from roster size), so holders stand still through any
 * arrival, departure, or roster-size change — the stability spec §2.3 asks
 * for, and the collision-free arrivals its review demanded.
 */
function allocateSlots(members: WorkerSnapshot[], base: number, held?: Map<number, number>): Map<number, number> {
  const slots = new Map<number, number>();
  const taken = new Set<number>();
  for (const m of members) {
    const kept = held?.get(m.id);
    if (kept !== undefined && !taken.has(kept)) {
      slots.set(m.id, kept);
      taken.add(kept);
    }
  }
  const span = Math.max(base, members.length);
  let probeSpan = span;
  for (const s of taken) probeSpan = Math.max(probeSpan, s + 1);
  for (const m of members) {
    if (slots.has(m.id)) continue;
    let slot = m.id % span;
    while (taken.has(slot)) slot = (slot + 1) % probeSpan; // taken < probeSpan, so a free slot exists
    taken.add(slot);
    slots.set(m.id, slot);
  }
  return slots;
}

/** Van der Corput base-2: unique in [0,1) per n, maximally spread. */
function vanDerCorput(n: number): number {
  let value = 0;
  for (let digit = 0.5; n > 0; n = Math.floor(n / 2), digit /= 2) {
    value += digit * (n % 2);
  }
  return value;
}

/**
 * Position is a pure function of (cell, capacity, slot) — never roster size,
 * which would move colleagues when staffing changes. Regular slots line the
 * cell's south edge; overflow slots (grandfathered over-capacity saves,
 * legal after a slot retuning) take a shelf above it on a low-discrepancy
 * sequence: unique x per slot, so no accepted roster ever stacks actors.
 */
function buildingSpot(cell: PlacedBuilding, capacity: number, slot: number): Spot {
  if (slot < capacity) {
    return { x: cell.col + (slot + 1) / (capacity + 1), y: cell.row + 0.85 };
  }
  return { x: cell.col + 0.12 + 0.76 * vanDerCorput(slot - capacity + 1), y: cell.row + 0.35 };
}

export interface WorldPick {
  kind: 'building' | 'worker';
  id: number;
}

/** Tooltip lines for a picked entity, from the current snapshot. */
export function describePick(snapshot: Snapshot, pick: WorldPick): string[] {
  if (pick.kind === 'building') {
    const b = snapshot.buildings.find((candidate) => candidate.id === pick.id);
    if (!b) return [];
    return [
      BUILDINGS[b.defId].name,
      `${b.workers}/${b.workerSlots} workers — ${b.state}`,
      b.batchActive ? `batch ${b.progressPct}%` : 'no active batch',
    ];
  }
  const w = snapshot.workers.find((candidate) => candidate.id === pick.id);
  if (!w) return [];
  return [
    `Worker #${w.id}`,
    `efficiency ${Math.round(w.efficiency * 100)}% — hunger ${Math.round(w.hunger)}`,
    w.toolTicks > 0 ? `tooled (${w.toolTicks}t left)` : 'no tool',
  ];
}

/**
 * Hit-test the building visual (1.5-tile square on the cell center) under a
 * tile-space point. Buildings never move, so the layout is their truth —
 * workers walk, so the renderer hit-tests them against live actor positions
 * before falling back to this.
 */
export function pickBuildingAt(layout: WorldLayout, x: number, y: number): WorldPick | null {
  for (const b of layout.buildings) {
    if (Math.abs(x - (b.col + 0.5)) <= 0.75 && Math.abs(y - (b.row + 0.5)) <= 0.75) {
      return { kind: 'building', id: b.id };
    }
  }
  return null;
}

function campSpot(slot: number): Spot {
  return { x: CAMP_COL0 + (slot % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(slot / CAMP_PER_ROW) };
}

export function layoutWorld(snapshot: Snapshot, previous?: WorldLayout): WorldLayout {
  const cellById = placeBuildings(snapshot);
  const held = heldSlots(previous);
  const sorted = [...snapshot.workers].sort(byId);
  const placements = new Map<number, Placement>();

  const rosters = new Map<number, WorkerSnapshot[]>();
  for (const w of sorted) {
    if (w.buildingId === null || !cellById.has(w.buildingId)) continue;
    const mates = rosters.get(w.buildingId) ?? [];
    mates.push(w);
    rosters.set(w.buildingId, mates);
  }
  for (const b of snapshot.buildings) {
    const cell = cellById.get(b.id)!;
    const slots = allocateSlots(rosters.get(b.id) ?? [], b.workerSlots, held.get(b.id));
    for (const [id, slot] of slots) {
      placements.set(id, { at: b.id, slot, spot: buildingSpot(cell, b.workerSlots, slot) });
    }
  }

  const idle = sorted.filter((w) => !placements.has(w.id));
  const campSlots = allocateSlots(idle, CAMP_MIN_SPOTS, held.get(null));
  let maxCampSlot = CAMP_MIN_SPOTS - 1;
  for (const [id, slot] of campSlots) {
    placements.set(id, { at: null, slot, spot: campSpot(slot) });
    maxCampSlot = Math.max(maxCampSlot, slot);
  }

  const workers: PlacedWorker[] = sorted.map((w) => {
    const p = placements.get(w.id)!;
    return { id: w.id, x: p.spot.x, y: p.spot.y, at: p.at, slot: p.slot, efficiency: w.efficiency, tooled: w.toolTicks > 0 };
  });
  const plotRows = Math.ceil(cellById.size / PLOTS_PER_ROW);
  const campRows = Math.ceil((maxCampSlot + 1) / CAMP_PER_ROW);
  const rows = Math.max(MIN_ROWS, PLOT_ROW0 + 2 * plotRows + 1, campRows + 3);
  return { tile: TILE, cols: COLS, rows, camp: CAMP_ANCHOR, buildings: [...cellById.values()], workers };
}
