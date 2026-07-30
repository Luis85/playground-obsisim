import type { ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import type { ResourceId } from '../../src/shared/content-types';

/**
 * A full stockpile with the given resources' `stock` set, everything else at
 * zero. Every RESOURCE_IDS entry is always present (with productionRate,
 * consumptionRate, netFlow, and stockValue all zeroed) so a test can index
 * any ResourceId on the result without an extra existence check — the real
 * Snapshot.stockpile is a complete Record too, never a sparse partial one.
 */
export function stockedWith(stocks: Partial<Record<ResourceId, number>> = {}): Record<ResourceId, ResourceStats> {
  return Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: stocks[id] ?? 0, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
}

/** A minimal, valid Snapshot for app-layer tests, overridable field by field. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: 0, lastRecruitTick: -30, stockpile: stockedWith(), colonyWealth: 0,
    population: 0, idleWorkers: 0, buildings: [], workers: [], notices: [],
    ...overrides,
  };
}
