import type { ResourceId } from '../shared/content-types';
import type { SavedBuilding, SavedColonist, SaveGameV7 } from '../shared/save';
import { MAX_SAVED_COUNTER } from '../shared/save';
import type { ResourceStats, Snapshot } from '../shared/snapshot';
import { stageOf } from '../shared/population';
import { isUnderConstruction } from '../shared/placement';
import { BALANCE, colonistEfficiency } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { RESOURCES, RESOURCE_IDS } from './content/resources';
import { CAMP_TILE } from '../shared/haul';
import { OutputBuffer } from './components';
import type { ColonistFacts } from './snapshot-builder';
import { buildEntitySections } from './snapshot-builder';
import type { BuildingFacts } from './snapshot-buildings';
import { clampedBuffer, clampedConstruction, clampedProgress, clampedRelocation, clampedToCost, restoredInputBuffer } from './spawn';
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
export function buildInitialSnapshot(save: SaveGameV7): Snapshot {
  const colonistFacts = restoredColonists(save).map(colonistFactsOfSaved);
  const buildingFacts = save.buildings.map(buildingFactsOfSaved);
  const stock = colonyStockOfSaved(save);
  const {
    colonists, buildings, population, idleAdults, homeless, beds, demographics, mealsPerHead,
  } = buildEntitySections(colonistFacts, buildingFacts, stock);
  const tick = Math.min(save.tick, MAX_SAVED_COUNTER); // same clamp as the spawned clock
  return {
    tick,
    lastRecruitTick: Math.min(save.lastRecruitTick, tick),
    lastBirthTick: Math.min(save.lastBirthTick, tick),
    mealsPerHead,
    map: { cols: save.map.cols, rows: save.map.rows },
    ...stockpileSections(stock),
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
    // A restored colony's haulers are on no trip at all: HaulTrip never enters
    // the save, so every leg field is the cleared one a fresh `HaulTrip` carries.
    haulTargetId: null, haulPhase: 'idle' as const, haulTicksLeft: 0,
    haulKind: null, haulPickedUp: false, haulLegTicks: 0,
    haulLegFromCol: 0, haulLegFromRow: 0, haulLegToCol: 0, haulLegToRow: 0,
    // ...but NOT their resting position. `HaulTrip` defaults `atCol`/`atRow` to
    // the CAMP TILE precisely because a hauler beginning at (0, 0) would price
    // and draw its first leg from the map's corner — and this function projects
    // the saved colonist directly, never touching the component the spawn path
    // builds, so a numeric zero here would put every idle hauler in that corner
    // for as long as a restored (and therefore PAUSED) colony sits unticked.
    haulAtCol: CAMP_TILE.col, haulAtRow: CAMP_TILE.row,
    carrying: 0, carryingResource: null,
    toolTicks: saved.toolTicks,
    ageTicks: saved.ageTicks,
    stage: stageOf(saved.ageTicks, BALANCE.lifeBands),
    homeId: saved.homeId,
  };
}

/**
 * One restored building's facts, under the same clamps the spawn and restore
 * paths apply — so every seeded figure matches what the spawned entity and the
 * seeded ledger actually hold. All three piles go through their own authority:
 * `clampedBuffer` for the out-tray (`buildingComponents`), `restoredInputBuffer`
 * for the in-tray (the same), and `clampedBuffer` against the def's `storage`
 * for the ledger share (`seedStoredGoods`).
 *
 * `stored` is the one whose clamp is visible to a player rather than merely
 * defensive: a depot saved at 60 under a `storehouseCapacity` since retuned
 * DOWN to 30 must read 30 of 30 with the balance standing at the camp, not 60
 * of 30 — which is what a straight projection shows and what the first tick
 * would then silently correct under a paused player's eyes. Where those spilled
 * goods land is `colonyStockOfSaved`'s business, below.
 */
function buildingFactsOfSaved(saved: SavedBuilding): BuildingFacts {
  const buffer = new OutputBuffer(clampedBuffer(saved.buffer, BALANCE.outputBufferCap));
  const constructionTicks = clampedConstruction(saved.constructionTicks);
  return {
    id: saved.id,
    defId: saved.defId,
    col: saved.col, row: saved.row,
    workerSlots: BUILDINGS[saved.defId].workerSlots,
    progress: clampedProgress(saved.defId, saved.progress),
    batchActive: saved.batchActive,
    buffered: buffer.total(),
    buffer: Object.fromEntries(buffer.amounts) as Partial<Record<ResourceId, number>>,
    // Through `restoredInputBuffer`, so a SITE's tray is bounded by its bill
    // and a finished building's by `inputBufferCap` — the same choice
    // `buildingComponents` makes for the entity standing beside this row. Fix
    // one and not the other and a restored 30-unit site holds 30 while the
    // screen says 12.
    inputBuffer: Object.fromEntries(
      restoredInputBuffer(saved.inputBuffer, saved.defId, constructionTicks),
    ) as Partial<Record<ResourceId, number>>,
    // Trimmed to what this def can hold TODAY — 0 for anything that is not a
    // store, which is what a hand-edited save or a `storage` retuned to nothing
    // leaves behind.
    stored: Object.fromEntries(clampedBuffer(saved.stored, BUILDINGS[saved.defId].storage)) as Partial<Record<ResourceId, number>>,
    relocatingTicks: clampedRelocation(saved.relocatingTicks ?? 0),
    constructionTicks,
  };
}

/**
 * The ledger a restored colony actually holds, per resource: the camp PLUS
 * every building's `stored`.
 *
 * `save.stockpile` is the CAMP alone from v6 on (`Stockpile.toJSON`, whose
 * camp-only reading is what makes the v5 migration a no-op), and a storehouse's
 * contents are serialized off its own building record. Reading the camp alone
 * here — which is what this function replaces — showed a colony reopened with
 * its planks in a depot a short wealth figure, a meals-per-head the birth gate
 * disagreed with, and a build palette refusing buildings it could afford, for
 * as long as the player left the restored (and therefore paused) engine alone.
 *
 * Summed from the SAVED `stored` maps rather than from the clamped facts above,
 * and the two totals are equal by construction: what a store can no longer hold
 * SPILLS TO THE CAMP rather than being trimmed away (`seedStoredGoods`), and
 * the camp is a term of this same sum. The clamp is observable in
 * `BuildingSnapshot.stored`, never in the colony's total — which is exactly the
 * conservation `seedStoredGoods` promises, restated on the reading side.
 *
 * `inputBuffer` is deliberately NOT a term: in-tray goods are outside the
 * ledger. The one exception is `siteExcessOfSaved` below — materials a SITE may
 * no longer hold BECOME ledger at load, and this sum is the only thing standing
 * between that refund and a paused colony showing it missing from `stockpile`
 * and from `colonyWealth` until the first tick rebuilt the snapshot from the
 * live `Stockpile`. Same rule as `stored`'s spill, applied to the second spill
 * the restore performs.
 */
function colonyStockOfSaved(save: SaveGameV7): Record<ResourceId, number> {
  const stock = {} as Record<ResourceId, number>;
  for (const resourceId of RESOURCE_IDS) {
    let total = save.stockpile[resourceId] ?? 0;
    for (const building of save.buildings) {
      total += building.stored[resourceId] ?? 0;
      total += siteExcessOfSaved(building, resourceId);
    }
    stock[resourceId] = total;
  }
  return stock;
}

/**
 * One resource's worth of materials `refundTrimmedMaterials` (restore.ts) banks
 * at the camp for this record — 0 for a finished building, and 0 for a site
 * whose tray is within its bill. Derived through `clampedToCost`, the same
 * authority the restore refunds against, so the two cannot disagree about how
 * much was declined.
 */
function siteExcessOfSaved(saved: SavedBuilding, resourceId: ResourceId): number {
  if (!Object.hasOwn(BUILDINGS, saved.defId)) return 0;
  if (!isUnderConstruction(clampedConstruction(saved.constructionTicks))) return 0;
  const kept = clampedToCost(saved.inputBuffer, saved.defId).get(resourceId) ?? 0;
  return Math.max(0, (saved.inputBuffer[resourceId] ?? 0) - kept);
}

/** Per-resource stats and the wealth they sum to, from the colony's ledger. */
function stockpileSections(stock: Readonly<Record<ResourceId, number>>): Pick<Snapshot, 'stockpile' | 'colonyWealth'> {
  const stockpile = {} as Record<ResourceId, ResourceStats>;
  let colonyWealth = 0;
  for (const resourceId of RESOURCE_IDS) {
    const held = stock[resourceId];
    const stockValue = held * RESOURCES[resourceId].value;
    colonyWealth += stockValue;
    stockpile[resourceId] = { stock: held, deliveredRate: 0, madeRate: 0, consumptionRate: 0, netFlow: 0, stockValue };
  }
  return { stockpile, colonyWealth };
}
