import type { ResourceId } from '../shared/content-types';
import type { SavedBuilding, SavedColonist, SaveGameV6 } from '../shared/save';
import { MAX_SAVED_COUNTER } from '../shared/save';
import type { ResourceStats, Snapshot } from '../shared/snapshot';
import { stageOf } from '../shared/population';
import { BALANCE, colonistEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import { OutputBuffer } from './components';
import type { BuildingFacts, ColonistFacts } from './snapshot-builder';
import { buildEntitySections } from './snapshot-builder';
import { clampedBuffer, clampedProgress, clampedRelocation } from './spawn';
import { restoredColonists } from './restore';

/**
 * The snapshot a restored (or freshly created) colony shows before its first
 * tick. The UI must never see a null snapshot, and a restored engine starts
 * PAUSED — so this is not a placeholder that a tick will shortly correct, it
 * is what the player looks at for as long as they leave the game paused.
 *
 * That is why it goes through the same two shared paths the live world does:
 * `restoredColonists` (the load-time clamps and repairs `buildColonyPrepWorld`
 * spawns entities from) and `buildEntitySections` (the aggregation
 * SnapshotSystem publishes from). Anything derived here independently would be
 * a second source of truth that the first tick silently overwrites.
 *
 * Split out of world.ts when that file approached the 500-line cap; it was
 * already a self-contained save -> Snapshot projection with no world-building
 * concerns, the same mechanical split save-guard.ts came from.
 */
export function buildInitialSnapshot(save: SaveGameV6): Snapshot {
  const colonistFacts = restoredColonists(save).map(colonistFactsOfSaved);
  const buildingFacts = save.buildings.map(buildingFactsOfSaved);
  const {
    colonists, buildings, population, idleAdults, homeless, beds, demographics, mealsPerHead,
  } = buildEntitySections(colonistFacts, buildingFacts, save.stockpile as Record<string, number>);
  const tick = Math.min(save.tick, MAX_SAVED_COUNTER); // same clamp as the spawned clock
  return {
    tick,
    lastRecruitTick: Math.min(save.lastRecruitTick, tick),
    lastBirthTick: Math.min(save.lastBirthTick, tick),
    mealsPerHead,
    map: { cols: save.map.cols, rows: save.map.rows },
    ...stockpileSections(save.stockpile),
    population,
    idleAdults,
    homeless,
    beds,
    demographics,
    buildings,
    colonists,
    notices: [],
  };
}

/**
 * One restored colonist's facts. `restoredColonists` has already applied every
 * clamp and repair, so this is a pure projection — nothing here may decide
 * anything the spawned entity would decide differently.
 */
function colonistFactsOfSaved(saved: SavedColonist): ColonistFacts {
  return {
    id: saved.id,
    hunger: saved.hunger,
    starvingTicks: saved.starvingTicks,
    efficiency: colonistEfficiency(saved.hunger),
    buildingId: saved.buildingId,
    hauling: saved.hauling,
    // a restored colony's haulers start at the camp: HaulTrip never enters the save
    haulTargetId: null, haulPhase: 'idle' as const, haulTicksLeft: 0,
    haulLegTicks: 0, haulPickupCol: 0, haulPickupRow: 0,
    carrying: 0, carryingResource: null,
    toolTicks: saved.toolTicks,
    ageTicks: saved.ageTicks,
    stage: stageOf(saved.ageTicks, BALANCE.lifeBands),
    homeId: saved.homeId,
  };
}

/**
 * One restored building's facts, under the same clamps `buildingComponents`
 * applies — so the seeded snapshot's buffered total matches the buffer the
 * spawned entity actually holds (an over-cap saved buffer trims to the cap
 * here too, not just in the world).
 */
function buildingFactsOfSaved(saved: SavedBuilding): BuildingFacts {
  const buffer = new OutputBuffer(clampedBuffer(saved.buffer, BALANCE.outputBufferCap));
  return {
    id: saved.id,
    defId: saved.defId,
    col: saved.col, row: saved.row,
    workerSlots: BUILDINGS[saved.defId].workerSlots,
    progress: clampedProgress(saved.defId, saved.progress),
    batchActive: saved.batchActive,
    buffered: buffer.total(),
    buffer: Object.fromEntries(buffer.amounts) as Partial<Record<ResourceId, number>>,
    // Carried AS WRITTEN, unlike `buffer` and `progress` above, and that is a
    // scoped gap rather than an oversight: nothing in `buildEntitySections`
    // reads either field yet, so there is no seeded figure for a clamp to
    // correct. The load-time authority on both already exists elsewhere —
    // `buildingComponents` trims an over-cap in-tray, `seedStoredGoods` spills
    // an over-capacity `stored` to the camp — and spec §2.9's remaining bullet
    // (the paused colony's wealth and meals-per-head, which must aggregate the
    // camp WITH every restored `stored` map) is what gives these two a reader
    // and these clamps something to be measured against.
    inputBuffer: saved.inputBuffer,
    stored: saved.stored,
    relocatingTicks: clampedRelocation(saved.relocatingTicks ?? 0),
  };
}

/** Per-resource stats and the wealth they sum to, from a saved stockpile. */
function stockpileSections(saved: SaveGameV6['stockpile']): Pick<Snapshot, 'stockpile' | 'colonyWealth'> {
  const stockpile = {} as Record<ResourceId, ResourceStats>;
  let colonyWealth = 0;
  for (const resourceId of RESOURCE_IDS) {
    const stock = saved[resourceId] ?? 0;
    const stockValue = stock * RESOURCES[resourceId].value;
    colonyWealth += stockValue;
    stockpile[resourceId] = { stock, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
  }
  return { stockpile, colonyWealth };
}
