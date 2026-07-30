import { describe, expect, it } from 'vitest';
import { layoutWorld, pickBuildingAt, TILE } from '../../src/app/world/layout';
import { makeSnapshot } from './fixtures';
import type { BuildingSnapshot, WorkerSnapshot } from '../../src/shared/snapshot';

// The layout invariants the world view stands on (spec §2.3): determinism
// (same snapshot, same layout), stability across snapshots (a worker whose
// post is unchanged never moves — layoutWorld's `previous` carries the slot
// memory), and containment (everything inside the grid the renderer sizes
// its ground and camera by).

function building(id: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId: 'farm', workers: 0, workerSlots: 4, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0,
    ...overrides,
  };
}

function worker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return { id, hunger: 0, efficiency: 1, buildingId: null, toolTicks: 0, ...overrides };
}

/** Every worker present in both layouts and unmoved — the stability check. */
function unmoved(before: ReturnType<typeof layoutWorld>, after: ReturnType<typeof layoutWorld>, ids: number[]) {
  for (const id of ids) {
    const was = before.workers.find((w) => w.id === id)!;
    expect(after.workers.find((w) => w.id === id)).toMatchObject({ x: was.x, y: was.y });
  }
}

describe('layoutWorld', () => {
  it('is deterministic: same snapshot -> deep-equal layout', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1), building(4, { defId: 'mill' })],
      workers: [worker(2, { buildingId: 1 }), worker(3)],
    });
    expect(layoutWorld(snapshot)).toEqual(layoutWorld(snapshot));
  });

  it('is a fixpoint: relayout with itself as previous changes nothing', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { workers: 1 })],
      workers: [worker(2, { buildingId: 1 }), worker(3)],
    });
    const fresh = layoutWorld(snapshot);
    expect(layoutWorld(snapshot, fresh)).toEqual(fresh);
  });

  it('places buildings on distinct plots in id order, row-major', () => {
    const buildings = [1, 2, 3, 4, 5, 6].map((id) => building(id));
    const { buildings: placed, rows } = layoutWorld(makeSnapshot({ buildings }));
    const cells = placed.map((b) => `${b.col},${b.row}`);
    expect(new Set(cells).size).toBe(6);
    // 5 plots per row: sixth building starts the second plot row
    expect(placed[5].row).toBe(placed[0].row + 2);
    expect(placed[5].col).toBe(placed[0].col);
    expect(rows).toBeGreaterThanOrEqual(placed[5].row + 2);
  });

  it('constructing a new building moves no existing placement', () => {
    const base = makeSnapshot({ buildings: [building(1), building(2)] });
    const grown = makeSnapshot({ buildings: [building(1), building(2), building(9)] });
    const before = layoutWorld(base).buildings;
    const after = layoutWorld(grown).buildings;
    for (const b of before) {
      expect(after.find((a) => a.id === b.id)).toMatchObject({ col: b.col, row: b.row });
    }
  });

  it('clusters assigned workers inside their building cell', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    });
    const layout = layoutWorld(snapshot);
    const cell = layout.buildings[0];
    for (const w of layout.workers) {
      expect(w.x).toBeGreaterThan(cell.col);
      expect(w.x).toBeLessThan(cell.col + 1);
      expect(w.y).toBeGreaterThan(cell.row);
      expect(w.y).toBeLessThan(cell.row + 1);
    }
    expect(layout.workers[0].x).not.toBe(layout.workers[1].x);
  });

  it('staffing another slot never moves the workers already there', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 3 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { buildingId: 1 })],
    }), before);
    unmoved(before, after, [10, 11]);
  });

  it('an arrival colliding with a held slot takes a free one instead (review round 4)', () => {
    // 5 and 9 both hash to slot 1 at a 4-slot building; 9 probes to 2. When 1
    // arrives (hashing to 1 as well), the holders stand still and 1 must end
    // up somewhere distinct — never stacked on a parked colleague.
    const before = layoutWorld(makeSnapshot({
      buildings: [building(2, { workerSlots: 4, workers: 2 })],
      workers: [worker(5, { buildingId: 2 }), worker(9, { buildingId: 2 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [building(2, { workerSlots: 4, workers: 3 })],
      workers: [worker(1, { buildingId: 2 }), worker(5, { buildingId: 2 }), worker(9, { buildingId: 2 })],
    }), before);
    unmoved(before, after, [5, 9]);
    const spots = after.workers.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(3);
  });

  it('a lower-id worker joining leaves the existing crew in place', () => {
    const before = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    }));
    const after = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 3 })],
      workers: [worker(9, { buildingId: 1 }), worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    }), before);
    unmoved(before, after, [10, 11]);
  });

  it('keeps grandfathered over-capacity rosters inside their cell, on distinct spots', () => {
    // a save from before a slot retuning may legally carry more workers than
    // workerSlots — overflow slots take an in-cell shelf on unique positions,
    // even for extreme rosters (review round 5: 11 workers at a 2-slot def)
    const crew = Array.from({ length: 11 }, (_, i) => worker(10 + i, { buildingId: 1 }));
    const layout = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 2, workers: crew.length })],
      workers: crew,
    }));
    const cell = layout.buildings[0];
    const spots = new Set<string>();
    for (const w of layout.workers) {
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
      buildings: [building(1, { workerSlots: 2, workers: 3 })],
      workers: [worker(1, { buildingId: 1 }), worker(2, { buildingId: 1 }), worker(3, { buildingId: 1 })],
    }));
    const shrunk = layoutWorld(makeSnapshot({
      buildings: [building(1, { workerSlots: 2, workers: 2 })],
      workers: [worker(1, { buildingId: 1 }), worker(2, { buildingId: 1 }), worker(3)],
    }), overCapacity);
    unmoved(overCapacity, shrunk, [1, 2]);
  });

  it('parks idle workers at the camp, left of the plots', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1)],
      workers: [worker(10), worker(11), worker(12)],
    });
    const layout = layoutWorld(snapshot);
    const minPlotCol = Math.min(...layout.buildings.map((b) => b.col));
    const spots = layout.workers.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(3);
    for (const w of layout.workers) {
      expect(w.x).toBeLessThan(minPlotCol);
    }
    // the camp anchor sits with its campers, inside the grid
    expect(layout.camp.x).toBeLessThan(minPlotCol);
    expect(layout.camp.y).toBeGreaterThan(0);
    expect(layout.camp.y).toBeLessThan(layout.rows);
  });

  it('crossing the camp baseline leaves existing campers in place (review round 3)', () => {
    const six = [3, 7, 12, 15, 21, 26].map((id) => worker(id));
    const before = layoutWorld(makeSnapshot({ workers: six }));
    const after = layoutWorld(makeSnapshot({ workers: [...six, worker(30)] }), before);
    unmoved(before, after, [3, 7, 12, 15, 21, 26]);
    const spots = after.workers.map((w) => `${w.x},${w.y}`);
    expect(new Set(spots).size).toBe(7);
  });

  it('a worker going idle leaves the existing campers in place', () => {
    const before = layoutWorld(makeSnapshot({ workers: [worker(10), worker(11)] }));
    const after = layoutWorld(makeSnapshot({ workers: [worker(9), worker(10), worker(11)] }), before);
    unmoved(before, after, [10, 11]);
  });

  it('carries state, progress, efficiency and tool coverage through', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { state: 'producing', progressPct: 40, batchActive: true })],
      workers: [worker(10, { buildingId: 1, efficiency: 0.5, toolTicks: 7 })],
    });
    const layout = layoutWorld(snapshot);
    expect(layout.buildings[0]).toMatchObject({ state: 'producing', progressPct: 40, batchActive: true });
    expect(layout.workers[0]).toMatchObject({ efficiency: 0.5, tooled: true, at: 1 });
    expect(layout.tile).toBe(TILE);
  });

  it('reports each worker\'s post: the building id, or null at the camp', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [building(1)],
      workers: [worker(10, { buildingId: 1 }), worker(11), worker(12, { buildingId: 99 })],
    }));
    const at = new Map(layout.workers.map((w) => [w.id, w.at]));
    expect(at.get(10)).toBe(1);
    expect(at.get(11)).toBeNull(); // idle
    expect(at.get(12)).toBeNull(); // orphaned assignment falls back to camp
  });

  it('pickBuildingAt finds the tile under the cursor and nothing in the gutter', () => {
    // workers are hit-tested by the renderer against live actor positions
    // (they walk); buildings never move, so the layout is their truth
    const layout = layoutWorld(makeSnapshot({ buildings: [building(1), building(2)] }));
    const cell = layout.buildings[0];
    expect(pickBuildingAt(layout, cell.col + 0.5, cell.row + 0.5)).toEqual({ kind: 'building', id: 1 });
    // the gutter midpoint sits between the two buildings' 1.5-tile visuals
    expect(pickBuildingAt(layout, cell.col + 1.5, cell.row + 0.5)).toBeNull();
    // and the empty grass south of the plots picks nothing
    expect(pickBuildingAt(layout, cell.col + 0.5, layout.rows - 0.5)).toBeNull();
  });

  it('keeps every placement inside the reported grid', () => {
    const layout = layoutWorld(makeSnapshot({
      buildings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => building(id)),
      workers: [10, 11, 12, 13, 14, 15, 16, 17].map((id) => worker(id)),
    }));
    for (const b of layout.buildings) {
      expect(b.col).toBeGreaterThanOrEqual(0);
      expect(b.col).toBeLessThan(layout.cols);
      expect(b.row).toBeGreaterThanOrEqual(0);
      expect(b.row).toBeLessThan(layout.rows);
    }
    for (const w of layout.workers) {
      expect(w.x).toBeGreaterThan(0);
      expect(w.x).toBeLessThan(layout.cols);
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(layout.rows);
    }
  });
});
