import type { Snapshot, BuildingState, ColonistSnapshot } from '../../shared/snapshot';
import type { BuildingDefId } from '../../shared/content-types';
import { BUILDINGS } from '../../engine/content';
import { legProgress } from '../../shared/haul';

export const TILE = 48;

// Geography is sim truth now (increment 3): buildings render at their
// snapshot col/row, and the grid dims come from snapshot.map. Only the
// worker spots stay derived — id-keyed and slot-stable (spec §2.3 of
// increment 2 still governs them).
const CAMP_COL0 = 1;
const CAMP_PER_ROW = 2;

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
  carrying: boolean;
  /**
   * True while this worker is mid-haul. The renderer walks these at whatever
   * speed reaches the next point before the next snapshot, instead of the fixed
   * pixel rate it uses for a cosmetic reassignment walk — the trip has a
   * simulated duration and the dot must respect it (OBS-4-09).
   */
  travelling: boolean;
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
const HAULER_SLOT = -1;

function byId(a: { id: number }, b: { id: number }): number {
  return a.id - b.id;
}

/** Buildings render exactly where the sim says they stand. */
function placeBuildings(snapshot: Snapshot): Map<number, PlacedBuilding> {
  const cellById = new Map<number, PlacedBuilding>();
  for (const b of snapshot.buildings) {
    cellById.set(b.id, {
      id: b.id, defId: b.defId, col: b.col, row: b.row,
      state: b.state, progressPct: b.progressPct, batchActive: b.batchActive,
    });
  }
  return cellById;
}

/** The slots each worker held at each post in the previous layout. */
function heldSlots(previous?: WorldLayout): Map<number | null, Map<number, number>> {
  const held = new Map<number | null, Map<number, number>>();
  for (const w of previous?.workers ?? []) {
    if (w.slot === HAULER_SLOT) continue;
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
function allocateSlots(members: ColonistSnapshot[], base: number, held?: Map<number, number>): Map<number, number> {
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
 * cell's south edge. Overflow slots (grandfathered over-capacity saves,
 * legal after a slot retuning) fill a 3-wide grid of shelf rows spaced for
 * the rendered dot diameter, so up to nine extra workers stay individually
 * visible and hoverable. Rosters even further past capacity fall back to
 * unique low-discrepancy spots on their own band: still contained and
 * distinct, though no longer diameter-spaced — a 48 px cell cannot hold a
 * dozen 14 px dots without contact. Every band has its own y, so no two
 * slots ever share a position.
 */
function buildingSpot(cell: PlacedBuilding, capacity: number, slot: number): Spot {
  if (slot < capacity) {
    return { x: cell.col + (slot + 1) / (capacity + 1), y: cell.row + 0.85 };
  }
  const k = slot - capacity;
  if (k < 9) {
    return { x: cell.col + 0.25 + 0.25 * (k % 3), y: cell.row + 0.58 - 0.22 * Math.floor(k / 3) };
  }
  return { x: cell.col + 0.1 + 0.8 * vanDerCorput(k - 8), y: cell.row + 0.47 };
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
  const w = snapshot.colonists.find((candidate) => candidate.id === pick.id);
  if (!w) return [];
  return [
    `Colonist #${w.id}`,
    `efficiency ${Math.round(w.efficiency * 100)}% — hunger ${Math.round(w.hunger)}`,
    w.toolTicks > 0 ? `tooled (${w.toolTicks}t left)` : 'no tool',
  ];
}

/**
 * Hit-test the tile under a tile-space point against the buildings' cells.
 * Buildings are 1-tile visuals now that adjacency is legal, so an exact
 * floor-and-match is correct — workers are still hit-tested live by the
 * renderer first, since they walk.
 */
export function pickBuildingAt(layout: WorldLayout, x: number, y: number): WorldPick | null {
  const col = Math.floor(x);
  const row = Math.floor(y);
  const b = layout.buildings.find((candidate) => candidate.col === col && candidate.row === row);
  return b ? { kind: 'building', id: b.id } : null;
}

/** Camp spots: two per row from the top of the band. Rosters past the
 * band's regular capacity take unique low-discrepancy spots on a bottom
 * shelf — even pathological idle crowds stay inside the fixed map. */
function campSpot(slot: number, rows: number): Spot {
  const capacity = CAMP_PER_ROW * (rows - 3);
  if (slot < capacity) {
    return { x: CAMP_COL0 + (slot % CAMP_PER_ROW) + 0.5, y: 1.5 + Math.floor(slot / CAMP_PER_ROW) };
  }
  return { x: CAMP_COL0 + 2 * vanDerCorput(slot - capacity + 1), y: rows - 0.75 };
}

/**
 * Where a hauler stands at a given tile: on the doorstep, below the crew's
 * spots. Deliberately outside the slot machinery — a hauler is a visitor, not
 * staff, and must never displace a worker's remembered slot.
 *
 * Takes a bare tile rather than a PlacedBuilding so `haulSpot` can also use it
 * for a returning hauler's frozen pickup point, which is a remembered tile,
 * not a building that is necessarily still standing there.
 */
function haulerSpot(tile: { col: number; row: number }): Spot {
  return { x: tile.col + 0.5, y: tile.row + 1.05 };
}

/**
 * Where a hauler's dot is RIGHT NOW: interpolated along its leg from the
 * ticks the engine says remain, against the leg total the engine charged.
 *
 * Increment 4 placed an outbound hauler at its target and let the renderer walk
 * there at a fixed 90 px/s. That is 1.875 tiles/s against a simulation moving
 * the hauler 4 tiles/s at 1x — and over 8x faster at 4x speed — so the dot was
 * still in open ground when the trip flipped legs, and turned round without
 * ever reaching the building it was sent to (OBS-4-09). Deriving the position
 * from `haulTicksLeft` makes the two clocks identical by construction, at every
 * game speed, and needs no notion of speed here at all.
 *
 * Both the leg's length (`haulLegTicks`) and a returning hauler's origin
 * (`haulPickupCol`/`haulPickupRow`) are read from the snapshot rather than
 * recomputed from the building's CURRENT tile. A returning trip is
 * deliberately left alone when its building moves — the goods are already in
 * hand, bound for a camp that did not move — so a recomputed
 * `haulTicks(cell.col, cell.row, …)` can silently disagree with the leg the
 * sim is actually running once that happens (OBS-5-01). An outbound leg's
 * `to` endpoint is still the building's live door: the engine DOES retarget an
 * outbound trip's ticks on a move (handleMoveBuilding), so that endpoint and
 * the leg total the snapshot publishes always agree.
 */
function haulSpot(w: ColonistSnapshot, cell: PlacedBuilding): Spot {
  const door = haulerSpot(cell);
  const pickup = haulerSpot({ col: w.haulPickupCol, row: w.haulPickupRow });
  const travelled = legProgress(w.haulTicksLeft, w.haulLegTicks);
  const from = w.haulPhase === 'outbound' ? CAMP_ANCHOR : pickup;
  const to = w.haulPhase === 'outbound' ? door : CAMP_ANCHOR;
  return { x: from.x + (to.x - from.x) * travelled, y: from.y + (to.y - from.y) * travelled };
}

/**
 * Haulers on a leg sit on the line between camp and building; idle ones fall
 * through to the camp allocation below, which is also where a hauler whose
 * target was demolished mid-trip ends up.
 *
 * Its own function (not inlined in layoutWorld) purely to keep that
 * orchestrator's complexity within the project's gate.
 */
function placeHaulers(sorted: ColonistSnapshot[], cellById: Map<number, PlacedBuilding>, placements: Map<number, Placement>): void {
  for (const w of sorted) {
    if (!w.hauling || w.haulTargetId === null || w.haulPhase === 'idle') continue;
    const cell = cellById.get(w.haulTargetId);
    if (cell === undefined) continue; // target demolished: the camp claims them
    placements.set(w.id, { at: w.haulTargetId, slot: HAULER_SLOT, spot: haulSpot(w, cell) });
  }
}

export function layoutWorld(snapshot: Snapshot, previous?: WorldLayout): WorldLayout {
  const { cols, rows } = snapshot.map;
  const cellById = placeBuildings(snapshot);
  const held = heldSlots(previous);
  const sorted = [...snapshot.colonists].sort(byId);
  const placements = new Map<number, Placement>();

  const rosters = new Map<number, ColonistSnapshot[]>();
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

  placeHaulers(sorted, cellById, placements);

  const idle = sorted.filter((w) => !placements.has(w.id));
  const campSlots = allocateSlots(idle, CAMP_MIN_SPOTS, held.get(null));
  for (const [id, slot] of campSlots) {
    placements.set(id, { at: null, slot, spot: campSpot(slot, rows) });
  }

  const workers: PlacedWorker[] = sorted.map((w) => {
    const p = placements.get(w.id)!;
    return {
      id: w.id, x: p.spot.x, y: p.spot.y, at: p.at, slot: p.slot,
      efficiency: w.efficiency, tooled: w.toolTicks > 0, carrying: w.carrying > 0,
      travelling: p.slot === HAULER_SLOT,
    };
  });
  return { tile: TILE, cols, rows, camp: CAMP_ANCHOR, buildings: [...cellById.values()], workers };
}
