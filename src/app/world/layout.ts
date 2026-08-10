import type { Snapshot, BuildingSnapshot, BuildingState, ColonistSnapshot } from '../../shared/snapshot';
import type { LifeStage } from '../../shared/population';
import type { BuildingDefId } from '../../shared/content-types';
import { BUILDINGS } from '../../engine/content';
import { CAMP_TILE, legPositionOf } from '../../shared/haul';

export const TILE = 48;

// Geography is sim truth now (increment 3): buildings render at their
// snapshot col/row, and the grid dims come from snapshot.map. Only the
// colonist spots stay derived — id-keyed and slot-stable (spec §2.3 of
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
  /** Units this building holds as a store, against what it could hold — the
   * two numbers the fill gauge is drawn from. `storage` is 0 for everything
   * that is not a storehouse, which is also how the renderer knows there is
   * no gauge to draw. */
  stored: number;
  storage: number;
}

export interface PlacedColonist {
  id: number;
  /** Tile-space coordinates (fractional): px = x * TILE. */
  x: number;
  y: number;
  /** The colonist's post: a building id, or null for the idle camp. */
  at: number | null;
  /** The slot held at that post — fed back via `previous` to stay put. */
  slot: number;
  efficiency: number;
  tooled: boolean;
  carrying: boolean;
  /**
   * Whether the load in hand came OUT of a building's output buffer, rather
   * than in from a store. Read off the snapshot's `haulPickedUp` and never
   * off `haulKind`: the job kind is frozen at dispatch and stops describing
   * the cargo exactly when the round trip works — a `supply` trip that
   * unloaded and then collected output carries goods out while still
   * labelled `supply` (spec §2.10). Meaningless unless `carrying`.
   */
  carryingOut: boolean;
  /**
   * Copied off the snapshot, never re-derived from `ageTicks`: `stageOf` needs
   * BALANCE.lifeBands, and a second derivation on the view side is a second
   * opinion about where a band starts — the renderer would mark someone a
   * child the Population view calls an adult.
   */
  stage: LifeStage;
  /** Nowhere to live. Its own boolean rather than a `homeId`, because that is
   * the whole of what the canvas encodes — which house is nobody's business
   * from a 14 px dot. */
  homeless: boolean;
  /**
   * True when this dot was placed by a haul trip rather than by the slot
   * machinery. The renderer walks these at whatever speed reaches the next
   * point before the next snapshot, instead of the fixed pixel rate it uses
   * for a cosmetic reassignment walk — a trip's steps have a simulated
   * duration and the dot must respect it (OBS-4-09).
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
  colonists: PlacedColonist[];
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
      stored: b.stored, storage: b.storage,
    });
  }
  return cellById;
}

/** The slots each colonist held at each post in the previous layout. */
function heldSlots(previous?: WorldLayout): Map<number | null, Map<number, number>> {
  const held = new Map<number | null, Map<number, number>>();
  for (const w of previous?.colonists ?? []) {
    if (w.slot === HAULER_SLOT) continue;
    const post = held.get(w.at) ?? new Map<number, number>();
    post.set(w.id, w.slot);
    held.set(w.at, post);
  }
  return held;
}

/**
 * Slot allocation with memory: a colonist still at the same post keeps the
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
 * the rendered dot diameter, so up to nine extra colonists stay individually
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
  // 'colonist', not 'worker': this names the PERSON picked off the canvas, and
  // spec 2.1's line is that the person is a colonist while work is still work.
  // It was the last world-layer name for a person, sitting one file away from
  // `workerSlots` and `tooledWorkers`, which genuinely do name employment — so
  // the two senses of "worker" were adjacent and indistinguishable at a glance.
  kind: 'building' | 'colonist';
  id: number;
}

/**
 * Tooltip lines for one building. A shelter answers a different question from
 * a producer: it has no recipe and no slots, so the producer wording rendered
 * as "0/0 workers — housing" and "no active batch" — three lines, not one of
 * them about the only thing a house does.
 *
 * Split on `beds > 0`, the same test every shelter rule in the engine uses,
 * rather than on `state === 'housing'`: a house being MOVED publishes
 * 'relocating', and who lives there is still the fact worth reporting.
 */
function describeBuilding(b: BuildingSnapshot): string[] {
  const name = BUILDINGS[b.defId].name;
  if (b.beds > 0) return [name, `${b.occupants}/${b.beds} residents — ${b.state}`];
  return [
    name,
    `${b.workers}/${b.workerSlots} workers — ${b.state}`,
    b.batchActive ? `batch ${b.progressPct}%` : 'no active batch',
  ];
}

/** Tooltip lines for a picked entity, from the current snapshot. */
export function describePick(snapshot: Snapshot, pick: WorldPick): string[] {
  if (pick.kind === 'building') {
    const b = snapshot.buildings.find((candidate) => candidate.id === pick.id);
    return b === undefined ? [] : describeBuilding(b);
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
 * floor-and-match is correct — colonists are still hit-tested live by the
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
 * staff, and must never displace a colonist's remembered slot.
 *
 * Takes a bare tile rather than a PlacedBuilding because a hauler's position
 * is a remembered or interpolated tile, not a building that is necessarily
 * still standing there: a leg endpoint, a fractional point between two of
 * them, or the tile a cancelled trip left the hauler resting on.
 */
function haulerSpot(tile: { col: number; row: number }): Spot {
  return { x: tile.col + 0.5, y: tile.row + 1.05 };
}

/**
 * Where a hauler's dot is RIGHT NOW: `legPositionOf` along the leg it is
 * walking, from the ticks the engine says remain against the total it
 * charged.
 *
 * Increment 4 placed an outbound hauler at its target and let the renderer walk
 * there at a fixed 90 px/s. That is 1.875 tiles/s against a simulation moving
 * the hauler 4 tiles/s at 1x — and over 8x faster at 4x speed — so the dot was
 * still in open ground when the trip flipped legs, and turned round without
 * ever reaching the building it was sent to (OBS-4-09). Deriving the position
 * from `haulTicksLeft` makes the two clocks identical by construction, at every
 * game speed, and needs no notion of speed here at all.
 *
 * No phase has a case of its own, and neither end is the camp. Every leg
 * freezes BOTH its endpoints when it begins (§2.10), so 'fetching', 'outbound'
 * and 'returning' are one interpolation between two published tiles — which is
 * the only shape that can draw this increment's trips at all. A depot-to-
 * building leg touches the camp at neither end, and a leg may begin from an
 * arbitrary fractional tile a cancellation or a mid-leg re-price left behind.
 * The endpoints are read from the snapshot rather than re-asked of the
 * building, for the reason `haulLegTicks` is: either end can move mid-leg, and
 * re-deriving it would draw the walk to a point this hauler never stood at
 * (OBS-5-01).
 */
function haulSpot(w: ColonistSnapshot): Spot {
  return haulerSpot(legPositionOf({
    ticksLeft: w.haulTicksLeft, legTicks: w.haulLegTicks,
    legFromCol: w.haulLegFromCol, legFromRow: w.haulLegFromRow,
    legToCol: w.haulLegToCol, legToRow: w.haulLegToRow,
  }));
}

/**
 * Where a hauler with no leg running rests — its own `haulAtCol`/`haulAtRow`,
 * the only fields that mean anything while `haulPhase` is 'idle'. Null when
 * that tile is the camp: the camp band owns slot machinery that spreads its
 * crowd, and a hauler standing there is one of that crowd, whereas a depot has
 * no slots and one dot on its doorstep is the whole answer.
 *
 * Read ONLY from here, never beside a running leg. Mid-leg these still hold
 * the tile the current trip started from — a plausible tile, not a sentinel —
 * so a reader that forgets the guard draws a dot somewhere real and looks
 * fine.
 */
function restSpot(w: ColonistSnapshot): Spot | null {
  if (w.haulAtCol === CAMP_TILE.col && w.haulAtRow === CAMP_TILE.row) return null;
  return haulerSpot({ col: w.haulAtCol, row: w.haulAtRow });
}

/**
 * Haulers stand on their leg, or at the depot a finished or cancelled trip
 * left them at. Only an idle hauler (no leg running) can fall through to the
 * camp allocation below, and only when `restSpot` says its resting tile IS
 * the camp.
 *
 * A hauler whose target has been demolished stays on its own leg rather than
 * falling through: `turnBackOrCancel` and the demolish loop
 * (placement-handlers.ts) can leave `targetId` pointing at a building that no
 * longer exists while the hauler is still genuinely walking a leg it froze
 * before the demolition — the leg is real even once the target is gone, so
 * `haulSpot` still answers it correctly. `at: null` here means only "no slot
 * machinery", never "camp".
 *
 * Its own function (not inlined in layoutWorld) purely to keep that
 * orchestrator's complexity within the project's gate.
 */
function placeHaulers(sorted: ColonistSnapshot[], cellById: Map<number, PlacedBuilding>, placements: Map<number, Placement>): void {
  for (const w of sorted) {
    if (!w.hauling) continue;
    if (w.haulPhase === 'idle') {
      const rest = restSpot(w);
      if (rest !== null) placements.set(w.id, { at: null, slot: HAULER_SLOT, spot: rest });
      continue;
    }
    if (w.haulTargetId === null || !cellById.has(w.haulTargetId)) {
      placements.set(w.id, { at: null, slot: HAULER_SLOT, spot: haulSpot(w) });
      continue;
    }
    placements.set(w.id, { at: w.haulTargetId, slot: HAULER_SLOT, spot: haulSpot(w) });
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

  const colonists: PlacedColonist[] = sorted.map((w) => {
    const p = placements.get(w.id)!;
    return {
      id: w.id, x: p.spot.x, y: p.spot.y, at: p.at, slot: p.slot,
      efficiency: w.efficiency, tooled: w.toolTicks > 0,
      carrying: w.carrying > 0, carryingOut: w.haulPickedUp,
      stage: w.stage, homeless: w.homeId === null,
      travelling: p.slot === HAULER_SLOT,
    };
  });
  return { tile: TILE, cols, rows, camp: CAMP_ANCHOR, buildings: [...cellById.values()], colonists };
}
