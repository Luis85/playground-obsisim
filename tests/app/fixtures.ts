import type { ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import type { ResourceId } from '../../src/shared/content-types';

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const stockpile = Object.fromEntries(
    RESOURCE_IDS.map((id) => [id, { stock: 0, productionRate: 0, consumptionRate: 0, netFlow: 0, stockValue: 0 }]),
  ) as Record<ResourceId, ResourceStats>;
  return {
    tick: 0, lastRecruitTick: -30, stockpile, colonyWealth: 0,
    population: 0, idleWorkers: 0, buildings: [], workers: [], notices: [],
    ...overrides,
  };
}
