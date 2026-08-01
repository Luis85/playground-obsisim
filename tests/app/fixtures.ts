import type { ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import type { ResourceId } from '../../src/shared/content-types';
import type { BuildingSnapshot, WorkerSnapshot } from '../../src/shared/snapshot';

/**
 * A full stockpile with the given resources' `stock` set, everything else at
 * zero. Every RESOURCE_IDS entry is always present (with deliveredRate,
 * madeRate, consumptionRate, netFlow, and stockValue all zeroed) so a test can
 * index any ResourceId on the result without an extra existence check — the
 * real Snapshot.stockpile is a complete Record too, never a sparse partial one.
 */
export function stockedWith(stocks: Partial<Record<ResourceId, number>> = {}): Record<ResourceId, ResourceStats> {
  return Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: stocks[id] ?? 0, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
}

/** A minimal, valid Snapshot for app-layer tests, overridable field by field. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: 0, lastRecruitTick: -30, map: { cols: 24, rows: 16 }, stockpile: stockedWith(), colonyWealth: 0,
    population: 0, idleWorkers: 0, buildings: [], workers: [], notices: [],
    ...overrides,
  };
}

/** A building snapshot on an id-keyed default tile (the legacy plot pattern,
 * unique per id < 41) so multi-building fixtures never stack. */
export function makeBuilding(id: number, overrides: Partial<BuildingSnapshot> = {}): BuildingSnapshot {
  return {
    id, defId: 'farm', col: 4 + 2 * ((id - 1) % 5), row: 1 + 2 * (Math.floor((id - 1) / 5) % 8),
    workers: 0, workerSlots: 4, state: 'unstaffed',
    progress: 0, batchActive: false, progressPct: 0, tooledWorkers: 0, workPower: 0, buffered: 0,
    ...overrides,
  };
}

export function makeWorker(id: number, overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id, hunger: 0, efficiency: 1, buildingId: null, hauling: false,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0, carrying: 0, toolTicks: 0,
    ...overrides,
  };
}
