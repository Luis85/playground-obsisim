import { describe, expect, it } from 'vitest';
import { describePick, layoutWorld, pickBuildingAt, TILE } from '../../src/app/world/layout';
import { CAMP_COLS } from '../../src/shared/placement';
import { CAMP_TILE } from '../../src/shared/haul';
import type { ColonistSnapshot } from '../../src/shared/snapshot';
import { makeBuilding, makeSnapshot, makeWorker } from './fixtures';

// The layout invariants the world view stands on (spec §2.3): determinism
// (same snapshot, same layout), stability across snapshots (a worker whose
// post is unchanged never moves — layoutWorld's `previous` carries the slot
// memory), and containment (everything inside the grid the renderer sizes
// its ground and camera by).

/** Every worker present in both layouts and unmoved — the stability check. */
function unmoved(before: ReturnType<typeof layoutWorld>, after: ReturnType<typeof layoutWorld>, ids: number[]) {
  for (const id of ids) {
    const was = before.colonists.find((w) => w.id === id)!;
    expect(after.colonists.find((w) => w.id === id)).toMatchObject({ x: was.x, y: was.y });
  }
}

describe('layoutWorld', () => {
  it('is deterministic: same snapshot -> deep-equal layout', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1), makeBuilding(4, { defId: 'mill' })],
      colonists: [makeWorker(2, { buildingId: 1 }), makeWorker(3)],
    });
    expect(layoutWorld(snapshot)).toEqual(layoutWorld(snapshot));
  });

  it('is a fixpoint: relayout with itself as previous changes nothing', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { workers: 1 })],
      colonists: [makeWorker(2, { buildingId: 1 }), makeWorker(3)],
    });
    const fresh = layoutWorld(snapshot);
    expect(layoutWorld(snapshot, fresh)).toEqual(fresh);
  });

  it('renders each building exactly at its snapshot tile', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 5, row: 2 }), makeBuilding(2, { col: 6, row: 2 })],
    }));
    expect(layout.buildings.map((b) => [b.id, b.col, b.row])).toEqual([[1, 5, 2], [2, 6, 2]]);
  });

  it('takes its dimensions from the snapshot map', () => {
    const layout = layoutWorld(makeSnapshot({ map: { cols: 30, rows: 20 } }));
    expect(layout.cols).toBe(30);
    expect(layout.rows).toBe(20);
  });

  it('a moved building takes its standing crew with it (same slots, new cell)', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 5, row: 3, workers: 2 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { col: 9, row: 7, workers: 2 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }), before);
    for (const id of [10, 11]) {
      const was = before.colonists.find((w) => w.id === id)!;
      const now = after.colonists.find((w) => w.id === id)!;
      expect(now.slot).toBe(was.slot); // slot memory survives the move
      expect(now.x - was.x).toBeCloseTo(4); // 9 - 5
      expect(now.y - was.y).toBeCloseTo(4); // 7 - 3
    }
  });

  it('contains pathological idle crowds inside the camp band of the fixed map', () => {
    const crowd = Array.from({ length: 40 }, (_, i) => makeWorker(i + 1));
    const layout = layoutWorld(makeSnapshot({ colonists: crowd }));
    const spots = new Set<string>();
    for (const w of layout.colonists) {
      expect(w.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(3); // CAMP_COLS
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(layout.rows);
      spots.add(`${w.x},${w.y}`);
    }
    expect(spots.size).toBe(40);
  });

  it('clusters assigned workers inside their building cell', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 4, workers: 2 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    });
    const layout = layoutWorld(snapshot);
    const cell = layout.buildings[0];
    for (const w of layout.colonists) {
      expect(w.x).toBeGreaterThan(cell.col);
      expect(w.x).toBeLessThan(cell.col + 1);
      expect(w.y).toBeGreaterThan(cell.row);
      expect(w.y).toBeLessThan(cell.row + 1);
    }
    expect(layout.colonists[0].x).not.toBe(layout.colonists[1].x);
  });

  it('staffing another slot never moves the workers already there', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 4, workers: 2 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 4, workers: 3 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 }), makeWorker(12, { buildingId: 1 })],
    }), before);
    unmoved(before, after, [10, 11]);
  });

  it('an arrival colliding with a held slot takes a free one instead (review round 4)', () => {
    // 5 and 9 both hash to slot 1 at a 4-slot building; 9 probes to 2. When 1
    // arrives (hashing to 1 as well), the holders stand still and 1 must end
    // up somewhere distinct — never stacked on a parked colleague.
    const before = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(2, { workerSlots: 4, workers: 2 })],
      colonists: [makeWorker(5, { buildingId: 2 }), makeWorker(9, { buildingId: 2 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(2, { workerSlots: 4, workers: 3 })],
      colonists: [makeWorker(1, { buildingId: 2 }), makeWorker(5, { buildingId: 2 }), makeWorker(9, { buildingId: 2 })],
    }), before);
    unmoved(before, after, [5, 9]);
    const spots = after.colonists.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(3);
  });

  it('a lower-id worker joining leaves the existing crew in place', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 4, workers: 2 })],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 4, workers: 3 })],
      colonists: [makeWorker(9, { buildingId: 1 }), makeWorker(10, { buildingId: 1 }), makeWorker(11, { buildingId: 1 })],
    }), before);
    unmoved(before, after, [10, 11]);
  });

  it('spaces grandfathered over-capacity rosters inside their cell by dot diameter', () => {
    // a save from before a slot retuning may legally carry more workers than
    // workerSlots — overflow fills diameter-spaced shelf rows (review rounds
    // 5 and 8: 11 workers at a 2-slot def must all be visible and hoverable)
    const crew = Array.from({ length: 11 }, (_, i) => makeWorker(10 + i, { buildingId: 1 }));
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 2, workers: crew.length })],
      colonists: crew,
    }));
    const cell = layout.buildings[0];
    for (const w of layout.colonists) {
      expect(w.x).toBeGreaterThan(cell.col);
      expect(w.x).toBeLessThan(cell.col + 1);
      expect(w.y).toBeGreaterThan(cell.row);
      expect(w.y).toBeLessThan(cell.row + 1);
    }
    // pairwise center distance >= 0.2 tiles (~10 px): individually pickable
    for (const a of layout.colonists) {
      for (const b of layout.colonists) {
        if (a.id >= b.id) continue;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        expect(distance, `workers ${a.id}/${b.id} too close`).toBeGreaterThanOrEqual(0.2);
      }
    }
  });

  it('contains even pathological rosters far past capacity, on distinct spots', () => {
    const crew = Array.from({ length: 20 }, (_, i) => makeWorker(10 + i, { buildingId: 1 }));
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 2, workers: crew.length })],
      colonists: crew,
    }));
    const cell = layout.buildings[0];
    const spots = new Set<string>();
    for (const w of layout.colonists) {
      expect(w.x).toBeGreaterThan(cell.col);
      expect(w.x).toBeLessThan(cell.col + 1);
      expect(w.y).toBeGreaterThan(cell.row);
      expect(w.y).toBeLessThan(cell.row + 1);
      spots.add(`${w.x},${w.y}`);
    }
    expect(spots.size).toBe(crew.length);
  });

  it('shrinking an over-capacity roster leaves the remaining crew in place (review round 3)', () => {
    const overCapacity = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 2, workers: 3 })],
      colonists: [makeWorker(1, { buildingId: 1 }), makeWorker(2, { buildingId: 1 }), makeWorker(3, { buildingId: 1 })],
    }));
    const shrunk = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { workerSlots: 2, workers: 2 })],
      colonists: [makeWorker(1, { buildingId: 1 }), makeWorker(2, { buildingId: 1 }), makeWorker(3)],
    }), overCapacity);
    unmoved(overCapacity, shrunk, [1, 2]);
  });

  it('parks idle workers at the camp, left of the plots', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1)],
      colonists: [makeWorker(10), makeWorker(11), makeWorker(12)],
    });
    const layout = layoutWorld(snapshot);
    const minPlotCol = Math.min(...layout.buildings.map((b) => b.col));
    const spots = layout.colonists.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(3);
    for (const w of layout.colonists) {
      expect(w.x).toBeLessThan(minPlotCol);
    }
    // the camp anchor sits with its campers, inside the grid
    expect(layout.camp.x).toBeLessThan(minPlotCol);
    expect(layout.camp.y).toBeGreaterThan(0);
    expect(layout.camp.y).toBeLessThan(layout.rows);
  });

  it('crossing the camp baseline leaves existing campers in place (review round 3)', () => {
    const six = [3, 7, 12, 15, 21, 26].map((id) => makeWorker(id));
    const before = layoutWorld(makeSnapshot({ colonists: six }));
    const after = layoutWorld(makeSnapshot({ colonists: [...six, makeWorker(30)] }), before);
    unmoved(before, after, [3, 7, 12, 15, 21, 26]);
    const spots = after.colonists.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(7);
  });

  it('a worker going idle leaves the existing campers in place', () => {
    const before = layoutWorld(makeSnapshot({ colonists: [makeWorker(10), makeWorker(11)] }));
    const after = layoutWorld(makeSnapshot({ colonists: [makeWorker(9), makeWorker(10), makeWorker(11)] }), before);
    unmoved(before, after, [10, 11]);
  });

  it('carries state, progress, efficiency and tool coverage through', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { state: 'producing', progressPct: 40, batchActive: true })],
      colonists: [makeWorker(10, { buildingId: 1, efficiency: 0.5, toolTicks: 7 })],
    });
    const layout = layoutWorld(snapshot);
    expect(layout.buildings[0]).toMatchObject({ state: 'producing', progressPct: 40, batchActive: true });
    expect(layout.colonists[0]).toMatchObject({ efficiency: 0.5, tooled: true, at: 1 });
    expect(layout.tile).toBe(TILE);
  });

  it('reports each worker\'s post: the building id, or null at the camp', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1)],
      colonists: [makeWorker(10, { buildingId: 1 }), makeWorker(11), makeWorker(12, { buildingId: 99 })],
    }));
    const at = new Map(layout.colonists.map((w) => [w.id, w.at]));
    expect(at.get(10)).toBe(1);
    expect(at.get(11)).toBeNull(); // idle
    expect(at.get(12)).toBeNull(); // orphaned assignment falls back to camp
  });

  it('carries each colonist\'s life stage and whether they have a home', () => {
    // The renderer draws a mark per stage and a mark for homelessness, and it
    // only ever sees the layout — so the layout has to publish both. Read
    // straight off the snapshot, never re-derived from ageTicks: stageOf needs
    // BALANCE.lifeBands, and a second derivation here could disagree with the
    // engine's own about where a band starts.
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'house', beds: 4, occupants: 2, state: 'housing', workerSlots: 0 })],
      colonists: [
        makeWorker(10, { stage: 'child', homeId: 1 }),
        makeWorker(11, { stage: 'adult', homeId: 1 }),
        makeWorker(12, { stage: 'elder', homeId: null }),
      ],
    }));
    const byId = new Map(layout.colonists.map((c) => [c.id, c]));
    expect(byId.get(10)).toMatchObject({ stage: 'child', homeless: false });
    expect(byId.get(11)).toMatchObject({ stage: 'adult', homeless: false });
    expect(byId.get(12)).toMatchObject({ stage: 'elder', homeless: true });
  });

  it('describes a shelter by who lives in it, not by a batch it can never run', () => {
    // A house has no recipe and no worker slots, so the producer wording read
    // "0/0 workers — housing" and "no active batch" — three lines, none of
    // them about the only thing a house does.
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'house', beds: 4, occupants: 3, state: 'housing', workerSlots: 0 })],
    });
    const lines = describePick(snapshot, { kind: 'building', id: 1 });
    expect(lines[0]).toBe('House');
    expect(lines.join(' ')).toContain('3/4 residents');
    expect(lines.join(' ')).not.toContain('workers');
    expect(lines.join(' ')).not.toContain('batch');
  });

  it('still describes a producer by its crew and its batch', () => {
    // The control: a house must not have rewritten every building's tooltip.
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'bakery', workers: 1, workerSlots: 2, state: 'producing', batchActive: true, progressPct: 55 })],
    });
    const lines = describePick(snapshot, { kind: 'building', id: 1 });
    expect(lines.join(' ')).toContain('1/2 workers');
    expect(lines.join(' ')).toContain('batch 55%');
    expect(lines.join(' ')).not.toContain('residents');
  });

  it('pickBuildingAt resolves the exact tile and nothing else', () => {
    const layout = layoutWorld(makeSnapshot({ buildings: [makeBuilding(1, { col: 5, row: 2 })] }));
    expect(pickBuildingAt(layout, 5.5, 2.5)).toEqual({ kind: 'building', id: 1 });
    expect(pickBuildingAt(layout, 6.5, 2.5)).toBeNull();  // adjacent tile, no building
    expect(pickBuildingAt(layout, 4.99, 2.5)).toBeNull(); // one tile left
    expect(pickBuildingAt(layout, 5.5, layout.rows - 0.5)).toBeNull(); // empty grass
  });

  it('keeps every placement inside the reported grid', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => makeBuilding(id)),
      colonists: [10, 11, 12, 13, 14, 15, 16, 17].map((id) => makeWorker(id)),
    }));
    for (const b of layout.buildings) {
      expect(b.col).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeLessThan(layout.cols);
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.row).toBeLessThan(layout.rows);
    }
    for (const w of layout.colonists) {
      expect(w.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(layout.cols);
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(layout.rows);
    }
  });
});

describe('hauler placement', () => {
  // (8,4) is hypot(6,4) = 7.21 tiles from the camp, so haulTicks at 2 tiles/tick
  // is ceil(7.21/2) = 4. Every leg below is 4 ticks long.
  const LEG_TICKS = 4;
  const DOOR = { col: 8, row: 4 };
  // A store site that is NOT the camp — the endpoint the old camp-anchored
  // geometry could not express at either end of a leg.
  const DEPOT = { col: 14, row: 9 };
  // Both endpoints of each leg, frozen the way the engine freezes them. The
  // layout reads these and nothing else while a leg is running: no phase has
  // a case of its own and neither end is assumed to be the camp.
  const outboundLeg = {
    haulLegFromCol: CAMP_TILE.col, haulLegFromRow: CAMP_TILE.row,
    haulLegToCol: DOOR.col, haulLegToRow: DOOR.row,
  };
  const returnLeg = {
    haulLegFromCol: DOOR.col, haulLegFromRow: DOOR.row,
    haulLegToCol: CAMP_TILE.col, haulLegToRow: CAMP_TILE.row,
  };
  const haulSnapshot = (overrides: Partial<ColonistSnapshot>) => makeSnapshot({
    buildings: [makeBuilding(1, { defId: 'forester', col: DOOR.col, row: DOOR.row })],
    // Default: an outbound hauler that has ARRIVED (0 ticks left), which is the
    // doorstep case the placement tests below were written against. The leg
    // total and both endpoints come off the snapshot — haulSpot never recomputes
    // them from the building's live tile (OBS-5-01); the dedicated "building
    // moved mid-leg" test below is the one that overrides them.
    colonists: [makeWorker(20, {
      hauling: true, haulPhase: 'outbound', haulTicksLeft: 0,
      haulLegTicks: LEG_TICKS, ...outboundLeg,
      ...overrides,
    })],
  });
  const haulerIn = (snapshot: ReturnType<typeof makeSnapshot>) =>
    layoutWorld(snapshot).colonists.find((w) => w.id === 20)!;

  it('stands an arrived outbound hauler at the building it walked to', () => {
    const layout = layoutWorld(haulSnapshot({ haulTargetId: 1 }));
    const hauler = layout.colonists.find((w) => w.id === 20)!;
    const cell = layout.buildings.find((b) => b.id === 1)!;
    expect(hauler.at).toBe(1);
    expect(hauler.x).toBeCloseTo(cell.col + 0.5);
    expect(hauler.y).toBeGreaterThan(cell.row + 0.5); // on the doorstep, not in the crew's spots
  });

  it('sends a hauler that finished its return leg back to the camp', () => {
    const hauler = haulerIn(haulSnapshot({
      haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 0, carrying: 6, ...returnLeg,
    }));
    expect(hauler.x).toBeLessThan(CAMP_COLS);
    expect(hauler.carrying).toBe(true);
  });

  // OBS-4-09. The dot used to be walked at a fixed 90 px/s with no relation to
  // the trip's simulated duration — 1.875 tiles/s against a sim moving it 4,
  // and over 8x adrift at 4x speed. It was still in open ground when the trip
  // flipped legs, so it turned round without ever reaching the building.
  // Position is now derived from the leg's remaining ticks, so the two clocks
  // agree by construction at any speed.
  it('places a just-dispatched hauler at the camp end of its leg, not already at its target', () => {
    const justSent = haulerIn(haulSnapshot({ haulTargetId: 1, haulTicksLeft: LEG_TICKS }));
    // The camp end derived rather than hardcoded: a return leg that has ARRIVED
    // stands on exactly the tile an outbound leg departs from.
    const arrivedHome = haulerIn(haulSnapshot({
      haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 0, carrying: 6, ...returnLeg,
    }));
    expect(justSent.x).toBeCloseTo(arrivedHome.x);
    expect(justSent.y).toBeCloseTo(arrivedHome.y);
    // ...and nowhere near the door it is walking toward
    const arrivedThere = haulerIn(haulSnapshot({ haulTargetId: 1 }));
    expect(Math.hypot(justSent.x - arrivedThere.x, justSent.y - arrivedThere.y)).toBeGreaterThan(1);
  });

  it('advances an outbound hauler monotonically from camp to doorstep', () => {
    const at = (ticksLeft: number) => haulerIn(haulSnapshot({ haulTargetId: 1, haulTicksLeft: ticksLeft }));
    const xs = [LEG_TICKS, 3, 2, 1, 0].map((t) => at(t).x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]); // never stalls, never doubles back
    }
    // Halfway through the leg it is genuinely halfway across, not at either end.
    const half = at(LEG_TICKS / 2);
    expect(half.x).toBeCloseTo((xs[0] + xs[xs.length - 1]) / 2);
  });

  it('turns for home from the building, never from open ground', () => {
    // The exact reversal this issue is about: on the tick the trip flips, the
    // sim has the hauler AT the building with a full return leg ahead of it.
    const arrived = haulerIn(haulSnapshot({ haulTargetId: 1, haulTicksLeft: 0 }));
    const turning = haulerIn(haulSnapshot({
      haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: LEG_TICKS, carrying: 6, ...returnLeg,
    }));
    expect(turning.x).toBeCloseTo(arrived.x);
    expect(turning.y).toBeCloseTo(arrived.y);
  });

  it('walks a returning hauler back along the same line it came out on', () => {
    const out = (t: number) => haulerIn(haulSnapshot({ haulTargetId: 1, haulTicksLeft: t }));
    const back = (t: number) => haulerIn(haulSnapshot({
      haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: t, carrying: 6, ...returnLeg,
    }));
    // Same fraction of the leg travelled, opposite direction: one tick out of
    // four is the mirror of three ticks left on the way home.
    expect(back(3).x).toBeCloseTo(out(1).x);
    expect(back(3).y).toBeCloseTo(out(1).y);
  });

  it('marks a hauler mid-trip as travelling, and an idle worker as not', () => {
    // The flag the renderer uses to pick trip-duration pacing over the cosmetic
    // reassignment walk — without it the dot falls behind its own trip again.
    expect(haulerIn(haulSnapshot({ haulTargetId: 1, haulTicksLeft: 2 })).travelling).toBe(true);
    expect(haulerIn(haulSnapshot({ haulTargetId: null, haulPhase: 'idle' })).travelling).toBe(false);
  });

  it('keeps a hauler at the doorstep of its target while the crew hold their own distinct spots', () => {
    const building = makeBuilding(1, { defId: 'forester', col: DOOR.col, row: DOOR.row, workerSlots: 2 });
    const arrived = { hauling: true, haulTargetId: 1, haulPhase: 'outbound' as const, haulTicksLeft: 0, haulLegTicks: LEG_TICKS, ...outboundLeg };
    // The doorstep is a pure function of the leg's own `to` tile (see
    // haulerSpot): derive its exact coordinates from a layout with only the
    // hauler present, rather than hardcoding the cell's offset here.
    const haulerAlone = layoutWorld(makeSnapshot({
      buildings: [building],
      colonists: [makeWorker(20, arrived)],
    }));
    const doorstep = haulerAlone.colonists.find((w) => w.id === 20)!;

    const layout = layoutWorld(makeSnapshot({
      buildings: [building],
      colonists: [
        makeWorker(1, { buildingId: 1 }),
        makeWorker(2, { buildingId: 1 }),
        makeWorker(20, arrived),
      ],
    }));

    const hauler = layout.colonists.find((w) => w.id === 20)!;
    expect(hauler.x).toBeCloseTo(doorstep.x); // exactly the doorstep, crew or no crew
    expect(hauler.y).toBeCloseTo(doorstep.y);

    const crewSpots = new Set(
      layout.colonists.filter((w) => w.id !== 20).map((w) => `${w.x.toFixed(2)},${w.y.toFixed(2)}`),
    );
    expect(crewSpots.size).toBe(2); // the crew occupy their own distinct spots
    expect(crewSpots.has(`${hauler.x.toFixed(2)},${hauler.y.toFixed(2)}`)).toBe(false); // ...and the hauler stands apart from all of them
  });

  it('parks an outbound hauler at the camp only once its target has vanished (present-target control)', () => {
    const present = layoutWorld(haulSnapshot({ haulTargetId: 1 }));
    const stillOutbound = present.colonists.find((w) => w.id === 20)!;
    const cell = present.buildings.find((b) => b.id === 1)!;
    expect(stillOutbound.at).toBe(1); // control: a standing target keeps the hauler at its doorstep...
    expect(stillOutbound.y).toBeGreaterThan(cell.row + 0.5); // ...not camped

    const vanished = layoutWorld(haulSnapshot({ haulTargetId: 99 }));
    expect(vanished.colonists.find((w) => w.id === 20)!.at).toBeNull(); // only the vanished target falls back to camp
  });

  it('a former hauler joining the crew at its old target never keeps the hauler sentinel slot', () => {
    // Cross-frame regression for heldSlots' `if (w.slot === HAULER_SLOT) continue;`
    // guard: a hauler's placement carries the sentinel slot (-1). Without the
    // guard, allocateSlots would look up that sentinel by id and hand it right
    // back once the same worker becomes real crew at the same building.
    const building = makeBuilding(1, { defId: 'forester', col: DOOR.col, row: DOOR.row, workerSlots: 4 });
    const before = layoutWorld(makeSnapshot({
      buildings: [building],
      colonists: [makeWorker(20, {
        hauling: true, haulTargetId: 1, haulPhase: 'outbound', haulTicksLeft: 0,
        haulLegTicks: LEG_TICKS, ...outboundLeg,
      })],
    }));
    const wasHauler = before.colonists.find((w) => w.id === 20)!;
    expect(wasHauler.at).toBe(1); // sanity: this frame is the doorstep case, its placement carries the sentinel

    const after = layoutWorld(makeSnapshot({
      buildings: [building],
      colonists: [makeWorker(20, { buildingId: 1 })], // same id, now genuine crew at the same building
    }), before);

    const crew = after.colonists.find((w) => w.id === 20)!;
    const cell = after.buildings.find((b) => b.id === 1)!;
    expect(crew.slot).toBeGreaterThanOrEqual(0); // a real crew slot, never the hauler sentinel (-1)
    expect(crew.x).toBeGreaterThan(cell.col); // a crew spot inside the cell (the sentinel collapses x to cell.col)
    expect(crew.x).toBeLessThan(cell.col + 1);
    expect(crew.y).toBeLessThan(wasHauler.y); // on the crew row, above the doorstep line it stood on a moment ago
  });

  // OBS-5-01. handleMoveBuilding deliberately never retargets a RETURNING
  // trip (the goods are already in hand, bound for a camp that did not move),
  // so haulTicksLeft/haulLegTicks/the pickup tile still describe the 4-tick
  // leg this hauler actually started from (8,4) — even though the snapshot
  // below reports building 1 relocated to the far corner out from under it.
  // haulSpot must draw the leg that was actually walked, not the one the
  // building's new tile would imply.
  it('draws a returning hauler on the leg it actually walked, not the one its building\'s new tile implies', () => {
    const snapshot = makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'forester', col: 23, row: 15 })], // moved mid-leg, far corner
      colonists: [makeWorker(20, {
        hauling: true, haulTargetId: 1, haulPhase: 'returning', haulTicksLeft: 2, carrying: 6,
        haulLegTicks: LEG_TICKS, ...returnLeg, // frozen at the ORIGINAL (8,4) -> camp leg
      })],
    });
    const hauler = layoutWorld(snapshot).colonists.find((w) => w.id === 20)!;
    // Halfway through the ORIGINAL 4-tick leg (2 of 4 remain), walking the
    // (8,4)->camp(2,0) line: tile (5,2), plus the doorstep offset. The old,
    // buggy computation re-derives both endpoint and total from the building's
    // CURRENT tile: haulTicks(23, 15, …) = 13, so legProgress(2, 13) ≈ 0.846 —
    // 85% home on a line from the far-corner door, not the door this hauler
    // actually left.
    expect(hauler.x).toBeCloseTo(5.5);
    expect(hauler.y).toBeCloseTo(3.05);
  });

  // The three states a hauler's dot can be in, and the fields that place each
  // (Task 10 step 3's layout half). The two field pairs fail in opposite ways:
  // the leg endpoints read 0,0 on a cleared trip and are obviously wrong at a
  // glance, while `haulAt*` mid-leg holds the tile the trip STARTED from — a
  // plausible tile, not a sentinel — so a dot placed from it looks fine.
  it('draws a mid-leg hauler between the leg\'s own endpoints, never from the tile it last stood still on', () => {
    // Three DISTINCT tiles, so no reader can pass by picking the wrong pair:
    // the leg runs depot(14,9) -> door(8,4) while `haulAt` still reads (5,12).
    const hauler = haulerIn(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'forester', col: DOOR.col, row: DOOR.row })],
      colonists: [makeWorker(20, {
        hauling: true, haulTargetId: 1, haulPhase: 'fetching', haulKind: 'supply',
        haulTicksLeft: 3, haulLegTicks: LEG_TICKS,
        haulLegFromCol: DEPOT.col, haulLegFromRow: DEPOT.row,
        haulLegToCol: DOOR.col, haulLegToRow: DOOR.row,
        haulAtCol: 5, haulAtRow: 12,
      })],
    }));
    // A quarter of the way along (1 of 4 ticks spent): (12.5, 7.75), plus the
    // doorstep offset. Reading `haulAt` instead would put it at (5.5, 13.05),
    // reading either endpoint alone at (14.5, 10.05) or (8.5, 5.05).
    expect(hauler.x).toBeCloseTo(13);
    expect(hauler.y).toBeCloseTo(8.8);
    expect(hauler.travelling).toBe(true);
  });

  it('parks a hauler idle at the camp among the campers, in a real camp slot', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'forester', col: DOOR.col, row: DOOR.row })],
      colonists: [
        makeWorker(20, { hauling: true, haulPhase: 'idle', haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row }),
        makeWorker(21),
      ],
    }));
    const hauler = layout.colonists.find((w) => w.id === 20)!;
    const camper = layout.colonists.find((w) => w.id === 21)!;
    expect(hauler.at).toBeNull();
    expect(hauler.slot).toBeGreaterThanOrEqual(0); // a real camp slot, not the hauler sentinel
    expect(hauler.x).toBeLessThan(CAMP_COLS);
    // The camp band is the only thing with slot machinery, and this is why the
    // camp case goes through it: an idle hauler must not stack on a camper.
    expect(`${hauler.x},${hauler.y}`).not.toBe(`${camper.x},${camper.y}`);
  });

  it('stands a hauler idle at a depot on the depot\'s doorstep, not back at the camp', () => {
    // The case the camp-anchored geometry could never express, and the one a
    // player reads as a colonist teleporting home. `haulLegTicks` and both
    // endpoints are left at their cleared 0 — an idle dot must not come from
    // them either.
    const idleAt = (col: number, row: number) => layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, {
        defId: 'storehouse', col: DEPOT.col, row: DEPOT.row, workerSlots: 0,
        state: 'storing', stored: 24, storage: 60,
      })],
      colonists: [makeWorker(20, { hauling: true, haulPhase: 'idle', haulAtCol: col, haulAtRow: row })],
    }));
    const depotLayout = idleAt(DEPOT.col, DEPOT.row);
    const resting = depotLayout.colonists.find((w) => w.id === 20)!;
    const depot = depotLayout.buildings.find((b) => b.id === 1)!;
    expect(resting.x).toBeCloseTo(depot.col + 0.5);
    expect(resting.y).toBeGreaterThan(depot.row + 0.5); // on the doorstep, below the cell
    // The control: the same code path still camps a hauler resting at the camp.
    const atCamp = idleAt(CAMP_TILE.col, CAMP_TILE.row).colonists.find((w) => w.id === 20)!;
    expect(atCamp.x).toBeLessThan(CAMP_COLS);
  });

  it('reads a carried load\'s direction off haulPickedUp, never off the job kind', () => {
    const trip = (pickedUp: boolean) => haulerIn(makeSnapshot({
      buildings: [makeBuilding(1, { defId: 'bakery', col: DOOR.col, row: DOOR.row })],
      colonists: [makeWorker(20, {
        hauling: true, haulTargetId: 1, haulPhase: 'returning', haulKind: 'supply',
        carrying: 4, haulTicksLeft: 2, haulLegTicks: LEG_TICKS, ...returnLeg,
        haulPickedUp: pickedUp,
      })],
    }));
    // BOTH are `supply` trips, deliberately: a marker driven by haulKind calls
    // them the same thing, and the round trip this increment is named for —
    // supply out, collected output home — is exactly the one it draws
    // backwards (spec §2.10).
    expect(trip(true)).toMatchObject({ carrying: true, carryingOut: true });
    expect(trip(false)).toMatchObject({ carrying: true, carryingOut: false });
  });

  it('carries a store\'s fill and its capacity through to the canvas', () => {
    // Four distinct piles on one building, so a gauge wired to the wrong one
    // cannot pass: stored 24, capacity 60, output buffer 7, in-tray 3.
    const layout = layoutWorld(makeSnapshot({
      buildings: [makeBuilding(1, {
        defId: 'storehouse', workerSlots: 0, state: 'storing',
        stored: 24, storage: 60, buffered: 7, inputBuffered: 3,
      })],
    }));
    expect(layout.buildings[0]).toMatchObject({ state: 'storing', stored: 24, storage: 60 });
  });
});
