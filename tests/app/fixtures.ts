import type { ResourceStats, Snapshot } from '../../src/shared/snapshot';
import { RESOURCE_IDS } from '../../src/engine/content/resources';
import { BALANCE } from '../../src/engine/content/balance';
import type { ResourceId } from '../../src/shared/content-types';
import type { BuildingSnapshot, ColonistSnapshot } from '../../src/shared/snapshot';
import { CAMP_TILE } from '../../src/shared/haul';

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
    tick: 0, lastRecruitTick: -30, lastBirthTick: -50, map: { cols: 24, rows: 16 }, stockpile: stockedWith(), colonyWealth: 0,
    mealsPerHead: 0,
    population: 0, idleAdults: 0, homeless: 0, beds: { total: 0, occupied: 0 },
    demographics: { children: 0, adults: 0, elders: 0 },
    buildings: [], colonists: [], notices: [],
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
    inputBuffered: 0, stored: 0, storage: 0, relocatingTicks: 0, constructionTicks: 0,
    beds: 0, occupants: 0, constructionNeeds: {},
    ...overrides,
  };
}

export function makeWorker(id: number, overrides: Partial<ColonistSnapshot> = {}): ColonistSnapshot {
  return {
    id, hunger: 0, starvingTicks: 0, efficiency: 1, buildingId: null, hauling: false,
    haulTargetId: null, haulPhase: 'idle', haulTicksLeft: 0,
    haulKind: null, haulPickedUp: false, haulLegTicks: 0,
    haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0,
    // The camp tile, never (0, 0) — `HaulTrip` seeds an idle hauler's resting
    // position there for the same reason (see its own doc comment), and a
    // fixture defaulting to the map's corner would make a layout case that
    // draws an idle hauler pass against a tile no hauler ever stands on.
    haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row,
    carrying: 0, toolTicks: 0, ageTicks: BALANCE.lifeBands.matureTicks, stage: 'adult', homeId: null,
    // Consistent with `homeId: null` above: a homeless colonist has no bed to
    // measure a distance from, and takes the flat homeless charge instead. A
    // fixture claiming full work power for a homeless worker would be a lie
    // the next case built on.
    commuteTiles: 0, commuteFactor: BALANCE.homelessFactor,
    // Consistent with `buildingId: null` above: nobody is assigned by
    // default, so there is no building this colonist delivers work power to.
    deliveredWorkPower: null,
    ...overrides,
  };
}
