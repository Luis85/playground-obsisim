import { createSystem, queryComponents, Read, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { StoreSite } from '../../shared/haul';
import { CAMP_SITE_ID, haulDistance, nearestSiteWithRoom } from '../../shared/haul';
import type { TileRef } from '../../shared/placement';
import { commuteFactor } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Relocation } from '../components';
import { PendingChanges, Stockpile } from '../resources';
import type { Claims, DispatchInputs, HaulBuildingRow, HaulWorkerRow, StaffedSet } from './haul-dispatch';
import { chooseJob, claimsOf } from './haul-dispatch';
import { storeSitesOf, type StoreSiteRow } from './haul-sites';

/**
 * What THIS hauler carries per trip. A hauler's output is goods moved, so
 * their commute costs them the same fraction of it that a worker's costs them
 * of production — ProductionSystem never sees a hauler (no buildingId), so
 * without this their commute would be decorative. Rounded, floored at 1: a
 * hauler who shows up carries something.
 *
 * The distance is `haulDistance`, the camp-store measure, and it stays
 * camp-relative deliberately: increment 6 measured its commute gradient
 * against exactly this function, and haulers belong to no site for a
 * site-relative version to measure from.
 *
 * Every site that reserves or takes capacity must call this — the claim map,
 * the dispatch-time candidate sizing, and the load. A reservation computed
 * from the flat BALANCE.haulCarryCapacity while the load uses this would claim
 * 6 for a hauler taking 3, leaving goods unclaimed and other haulers sent
 * away: a scheduling penalty stacked on top of the commute, which is not what
 * this models.
 */
export function haulerCapacity(homeTile: TileRef | null): number {
  const tiles = homeTile === null ? null : haulDistance(homeTile.col, homeTile.row);
  const factor = commuteFactor(tiles, BALANCE.commute, BALANCE.homelessFactor);
  return Math.max(1, Math.round(BALANCE.haulCarryCapacity * factor));
}

/** Where a hauler sleeps, or null when nowhere — the input haulerCapacity
 * charges. Resolved against the same building rows the haul targets come from,
 * so a house is just another row here. */
function homeTileOf(homeId: number | null, byId: ReadonlyMap<number, HaulBuildingRow>, pending: PendingChanges): TileRef | null {
  if (homeId === null) return null;
  const row = byId.get(homeId);
  // A house built earlier THIS tick is absent from the query until the
  // post-step sync, yet homing has already seated its residents. Without this
  // fallback a hauler housed on the construction tick resolves to no tile and
  // takes the homeless carry capacity, while the snapshot published moments
  // later reports them housed. ProductionSystem folds the same pending tiles
  // into its own map; here byId carries whole rows a pending building has no
  // counterpart for, so the tile is resolved on its own.
  return row === undefined ? pending.tileOf(homeId) : row.position;
}

/**
 * The buildings that are places goods can be dropped, in the shape
 * `storeSitesOf` takes. Capacity is resolved from the catalog HERE rather than
 * inside that helper — the same split command-system.ts makes for a shelter's
 * beds, which keeps the site law free of a content dependency.
 */
function storeRowsOf(rows: readonly HaulBuildingRow[]): StoreSiteRow[] {
  return rows
    .filter((row) => BUILDINGS[row.building.defId].storage > 0)
    .map((row) => ({
      id: row.building.id,
      col: row.position.col,
      row: row.position.row,
      capacity: BUILDINGS[row.building.defId].storage,
      relocating: row.relocation.ticksLeft > 0,
    }));
}

/** Everything the leg handlers below read, gathered once per tick. */
interface TickContext {
  stockpile: Stockpile;
  byId: ReadonlyMap<number, HaulBuildingRow>;
  sites: readonly StoreSite[];
  siteById: ReadonlyMap<number, StoreSite>;
  staffed: StaffedSet;
  claims: Claims;
}

/** The camp: always in the site list, always unbounded, and therefore the
 * destination no resolution can fail to find. */
function campOf(ctx: TickContext): StoreSite {
  return ctx.siteById.get(CAMP_SITE_ID)!;
}

/**
 * An undelivered supply remainder goes back where it CAME from, not to
 * whatever site is nearest: routing it onward would turn camp wheat into depot
 * stock without it ever being consumed — the store-to-store transfer §2.13
 * excludes. `!pickedUp && amount > 0` is exactly this case, because a hauler
 * only loads output with empty hands.
 */
function remainderHome(ctx: TickContext, trip: HaulTrip): StoreSite | null {
  const source = ctx.siteById.get(trip.sourceSiteId);
  if (trip.pickedUp || trip.amount === 0 || source === undefined) return null;
  const full = source.capacity !== null && ctx.claims.heldAt(source.id) + trip.amount > source.capacity;
  return full ? null : source;
}

/**
 * Where this load is going, with room RESERVED for it from the moment it is
 * chosen — which is what makes the load fit on arrival rather than needing a
 * rule for when it does not. Checking for room only at pickup lets two haulers
 * aim at a depot with room for one; re-resolving on arrival fixes the FULL
 * depot and misses the partially full one, splitting a load between a bank and
 * a forward nobody walks.
 *
 * The trip releases its own reservation first. Otherwise a hauler carrying six
 * to a depot holding 54 of 60 double-counts itself: its own six is already
 * reserved, the lookup reports 60, adding six again overflows, and the depot is
 * rejected for a load whose room was reserved for exactly this. Clearing
 * `destSiteId` IS the release, because reservations are a projection of live
 * components — every OTHER trip's reservation still counts.
 */
function destinationFor(ctx: TickContext, trip: HaulTrip, from: TileRef): StoreSite {
  trip.destSiteId = CAMP_SITE_ID;
  const heldAt = (siteId: number) => ctx.claims.heldAt(siteId);
  const dest = remainderHome(ctx, trip)
    ?? nearestSiteWithRoom(from.col, from.row, ctx.sites, heldAt, trip.amount)
    ?? campOf(ctx);
  trip.destSiteId = dest.id;
  return dest;
}

/** Turn for home from wherever this hauler is standing, carrying whatever it
 * holds. The one exit from a leg that both arrival handlers share. */
function turnForHome(ctx: TickContext, trip: HaulTrip, at: TileRef): void {
  trip.startLeg('returning', at, destinationFor(ctx, trip, at), BALANCE.haulTilesPerTick);
}

/**
 * Arrival at the SOURCE of a supply trip. Both ends are rechecked before
 * anything is taken, because a leg takes ticks and the world moves during
 * them: the demolition handler cancels trips OUTBOUND to a building, and a
 * fetching hauler is walking to a source, so nothing else catches a target
 * that has gone. The source is rechecked by TILE rather than by id — a
 * storehouse that relocates keeps its id and moves, and an id-keyed `takeAt`
 * would draw goods out of a building standing somewhere the hauler is not.
 *
 * Nothing has been picked up yet, so either recheck failing is a clean cancel:
 * no load, no disposal, no remainder.
 */
function fetchArrival(ctx: TickContext, trip: HaulTrip): void {
  const row = trip.targetId === null ? undefined : ctx.byId.get(trip.targetId);
  const source = ctx.siteById.get(trip.sourceSiteId);
  if (row === undefined || trip.resource === null) {
    trip.cancel();
    return;
  }
  if (source === undefined || source.col !== trip.legToCol || source.row !== trip.legToRow) {
    trip.cancel();
    return;
  }
  // What `takeAt` ACTUALLY returned, never the amount claimed at dispatch. A
  // source claim reserves stock against other HAULERS; it does not bind
  // `Stockpile.pay`, which spends camp-first across every site for
  // construction costs and meals — so a build ordered while this hauler walked
  // can legitimately have spent the wheat it set out to fetch. Carrying the
  // claimed figure regardless would create goods out of nothing.
  trip.amount = ctx.stockpile.takeAt(trip.sourceSiteId, trip.resource, trip.plannedAmount);
  trip.plannedAmount = 0;
  // Nothing left to deliver: the trip carries on to the building and finishes
  // as an ordinary collect run.
  if (trip.amount === 0) trip.resource = null;
  trip.startLeg('outbound', source, row.position, BALANCE.haulTilesPerTick);
}

/**
 * Put a supply load into the building it was fetched for.
 *
 * Staffing is a DISPATCH-TIME filter and the world moves during a leg: the
 * target's last worker can be unassigned, retire or die while this hauler
 * walks, and none of those cancels the trip the way a demolition does.
 * Unloading anyway parks goods in a processor that cannot use them and loses
 * them if it is demolished — exactly what the staffing rule prevents, defeated
 * by travel time. The load stays in hand instead; `pickedUp` stays false, so it
 * is an undelivered remainder and goes home to its source.
 */
function unload(ctx: TickContext, trip: HaulTrip, row: HaulBuildingRow): void {
  if (trip.kind !== 'supply' || trip.resource === null || trip.amount === 0) return;
  if (!ctx.staffed.has(row.building.id)) return;
  const placed = Math.min(trip.amount, row.input.room(BALANCE.inputBufferCap));
  if (placed <= 0) return;
  row.input.add(trip.resource, placed);
  // Consumption is recorded HERE, not when the load left its site: this is the
  // moment the goods leave the colony's store for good, and it is the honest
  // successor to the consumption ProductionSystem used to record when it paid a
  // recipe out of the stockpile.
  ctx.stockpile.recordConsumed(trip.resource, placed);
  trip.amount -= placed;
  if (trip.amount === 0) trip.resource = null;
}

/**
 * Load the building's output buffer for the trip home — BOTH kinds do this,
 * and it is the round trip the increment is named for.
 *
 * The empty-hands guard is load-bearing rather than an optimisation: a hauler
 * still holding an undelivered remainder must carry THAT home rather than
 * mixing two resources in one pair of hands, which HaulTrip has no room to
 * represent.
 */
function loadOutput(trip: HaulTrip, row: HaulBuildingRow, capacity: number): void {
  if (trip.amount !== 0) return;
  const resource = row.buffer.fullestResource(RESOURCE_IDS);
  const taken = resource === null ? 0 : row.buffer.take(resource, capacity);
  trip.resource = taken > 0 ? resource : null;
  trip.amount = taken;
  trip.pickedUp = taken > 0;
}

/** Arrival at the target building: unload, then load, then pick a destination. */
function buildingArrival(ctx: TickContext, trip: HaulTrip, capacity: number): void {
  const row = trip.targetId === null ? undefined : ctx.byId.get(trip.targetId);
  // Demolished while this hauler walked. An empty trip simply ends; a hauler
  // holding a load is still standing on the map and perfectly able to carry it,
  // so it walks that load somewhere rather than having it teleported away.
  if (row === undefined) {
    if (trip.amount === 0) trip.cancel();
    else turnForHome(ctx, trip, { col: trip.legToCol, row: trip.legToRow });
    return;
  }
  unload(ctx, trip, row);
  loadOutput(trip, row, capacity);
  turnForHome(ctx, trip, row.position);
}

/**
 * Arrival at the destination site. The load fits by construction, because
 * choosing the destination reserved room for it — so the ordinary path is
 * simply bank, and stop.
 *
 * The one case reservation cannot cover is a destination that stopped EXISTING
 * — demolished, or sent into transit by a move. The load must then be CARRIED
 * wherever it ends up, so this starts a fresh leg rather than banking remotely:
 * the forward-to-camp guarantee is the last resort for paths with no hauler
 * left to walk, and using it here would teleport goods to the camp while their
 * hauler stands at the depot. The camp is unbounded and cannot vanish, so the
 * walk terminates.
 *
 * The comparison is against the TILE this leg was aimed at, not the site id: a
 * storehouse that finishes relocating mid-leg keeps its id and changes its
 * tile, so an id-only test would deposit the load at a depot the hauler never
 * walked to.
 */
function depositArrival(ctx: TickContext, trip: HaulTrip): void {
  const at = { col: trip.legToCol, row: trip.legToRow };
  const dest = ctx.siteById.get(trip.destSiteId);
  const arrived = dest !== undefined && dest.col === at.col && dest.row === at.row;
  if (!arrived) {
    if (trip.amount === 0) trip.cancel();
    else turnForHome(ctx, trip, at);
    return;
  }
  if (trip.resource !== null && trip.amount > 0) {
    // `addAt` for goods the ledger has never counted, `refundAt` for a supply
    // remainder the colony already owned — recording the second as a delivery
    // would inflate Delivered/t for a round trip that produced nothing.
    if (trip.pickedUp) ctx.stockpile.addAt(dest, trip.resource, trip.amount);
    else ctx.stockpile.refundAt(dest, trip.resource, trip.amount);
  }
  trip.cancel();
}

/**
 * Haulers carry finished goods out of the buildings that made them, and raw
 * goods back in — one trip, three legs at most: fetch from a store, walk to
 * the building, walk a load home to a store.
 *
 * Runs after ProductionSystem (goods produced this tick are claimable
 * immediately) and before StatsSystem (a deposit counts in this tick's flows).
 *
 * Every decision here is a pure function of world state: claims are recomputed
 * from live components each tick rather than remembered, and every tie-break
 * chain ends at an id, so entity iteration order cannot change which job a
 * hauler takes.
 */
export const HaulSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({
    building: Read(Building), position: Read(Position), buffer: Write(OutputBuffer),
    input: Write(InputBuffer), relocation: Read(Relocation),
  }),
  workers: queryComponents({ job: Read(JobAssignment), trip: Write(HaulTrip), home: Read(Home) }),
  pending: ReadResource(PendingChanges),
})
  .withName('HaulSystem')
  .withRunFunction(({ stockpile, buildings, workers, pending }) => {
    const buildingRows = [...buildings.iter()];
    const byId = new Map(buildingRows.map((row) => [row.building.id, row]));
    const workerRows = [...workers.iter()];
    const sites = storeSitesOf(storeRowsOf(buildingRows), pending);
    const capacityOf = (row: HaulWorkerRow) => haulerCapacity(homeTileOf(row.home.buildingId, byId, pending));
    const claims = claimsOf(workerRows, stockpile, capacityOf);
    // ONE derivation, read by the dispatch filter and by the arrival recheck.
    // They are the same rule seen from two ends of a leg, so a second copy of
    // this expression is how the recheck stops matching what it rechecks.
    const staffed: StaffedSet = new Set(workerRows.map((row) => row.job.buildingId));
    const ctx: TickContext = {
      stockpile,
      byId,
      sites,
      siteById: new Map(sites.map((site) => [site.id, site])),
      staffed,
      claims,
    };
    const inputs: DispatchInputs = { buildings: buildingRows, sites, staffed, claims };

    for (const row of workerRows) {
      if (!row.job.hauling) continue;
      // Read once per hauler per tick and handed to both the claim and the
      // load, so the two can never be computed from different numbers.
      const capacity = capacityOf(row);
      const { trip } = row;
      if (trip.phase === 'idle') {
        chooseJob(trip, { col: trip.atCol, row: trip.atRow }, inputs, capacity);
        continue; // a trip dispatched this tick starts walking next tick
      }
      trip.ticksLeft -= 1;
      if (trip.ticksLeft > 0) continue;
      if (trip.phase === 'fetching') fetchArrival(ctx, trip);
      else if (trip.phase === 'outbound') buildingArrival(ctx, trip, capacity);
      else depositArrival(ctx, trip);
    }
  })
  .build();
