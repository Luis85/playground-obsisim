import { describe, expect, it } from 'vitest';
import { layoutWorld, TILE } from '../../src/app/world/layout';
import { makeSnapshot } from './fixtures';
import type { BuildingSnapshot, WorkerSnapshot } from '../../src/shared/snapshot';

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

describe('layoutWorld', () => {
  it('is deterministic: same snapshot -> deep-equal layout', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1), building(4, { defId: 'mill' })],
      workers: [worker(2, { buildingId: 1 }), worker(3)],
    });
    expect(layoutWorld(snapshot)).toEqual(layoutWorld(snapshot));
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

  it('clusters assigned workers inside their building cell, by slot capacity', () => {
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
    const two = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 2 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 })],
    });
    const three = makeSnapshot({
      buildings: [building(1, { workerSlots: 4, workers: 3 })],
      workers: [worker(10, { buildingId: 1 }), worker(11, { buildingId: 1 }), worker(12, { buildingId: 1 })],
    });
    const before = layoutWorld(two).workers;
    const after = layoutWorld(three).workers;
    for (const w of before) {
      expect(after.find((a) => a.id === w.id)).toMatchObject({ x: w.x, y: w.y });
    }
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
  });

  it('carries state, progress, efficiency and tool coverage through', () => {
    const snapshot = makeSnapshot({
      buildings: [building(1, { state: 'producing', progressPct: 40, batchActive: true })],
      workers: [worker(10, { buildingId: 1, efficiency: 0.5, toolTicks: 7 })],
    });
    const layout = layoutWorld(snapshot);
    expect(layout.buildings[0]).toMatchObject({ state: 'producing', progressPct: 40, batchActive: true });
    expect(layout.workers[0]).toMatchObject({ efficiency: 0.5, tooled: true });
    expect(layout.tile).toBe(TILE);
  });

  it('keeps every placement inside the reported grid', () => {
    const snapshot = makeSnapshot({
      buildings: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((id) => building(id)),
      workers: [10, 11, 12, 13, 14, 15, 16, 17].map((id) => worker(id)),
    });
    const layout = layoutWorld(snapshot);
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
