import { createSystem, queryComponents, Read, ReadResource, Write, WriteResource } from 'sim-ecs';
import type { StoreSite } from '../../shared/haul';
import { haulDistance } from '../../shared/haul';
import { isRelocating, type TileRef } from '../../shared/placement';
import { commuteFactor } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation } from '../components';
import { PendingChanges, Stockpile } from '../resources';
import { arrivesAt, claimsOf, type Claims, type HaulWorkerRow } from './haul-claims';
import type { DispatchInputs, HaulBuildingRow, StaffedSet } from './haul-dispatch';
import { chooseJob, storeSitesFrom } from './haul-dispatch';
import { bankLoad, destinationFor } from './haul-sites';
import { siteDemandFrom } from './haul-transfer';

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

/** Everything the leg handlers below read, gathered once per tick. */
interface TickContext {
  stockpile: Stockpile;
  byId: ReadonlyMap<number, HaulBuildingRow>;
  sites: readonly StoreSite[];
  siteById: ReadonlyMap<number, StoreSite>;
  staffed: StaffedSet;
  claims: Claims;
  /** Buildings demolished by `CommandSystem` earlier in this same tick. Entity
   * removal is deferred to the post-step drain, so every one of them is still
   * in `byId` — see `targetRowOf`. */
  demolished: ReadonlySet<number>;
}

/** A site's occupancy as this tick's lookups must see it, in the shape
 * `destinationFor` takes. */
function heldAtIn(ctx: TickContext): (siteId: number) => number {
  return (siteId) => ctx.claims.heldAt(siteId);
}

/**
 * The building this trip is aimed at, or undefined when it is not there to be
 * aimed at any more.
 *
 * `pending.demolished` is filtered here rather than at each arrival, and that
 * exclusion is the same one `storeSitesOf` already applies to a store site:
 * `CommandSystem` runs before this system and entity removal is deferred, so
 * `byId` answers for a building demolished moments ago. Without it a fetching
 * hauler passes its recheck, takes the goods, and walks a full outbound leg to
 * a tile with nothing on it.
 */
function targetRowOf(ctx: TickContext, trip: HaulTrip): HaulBuildingRow | undefined {
  if (trip.targetId === null || ctx.demolished.has(trip.targetId)) return undefined;
  return ctx.byId.get(trip.targetId);
}

/** Turn for home from wherever this hauler is standing, carrying whatever it
 * holds. The one exit from a leg that both arrival handlers share. */
function turnForHome(ctx: TickContext, trip: HaulTrip, at: TileRef): void {
  trip.startLeg('returning', at, destinationFor(trip, at, ctx.sites, heldAtIn(ctx)), BALANCE.haulTilesPerTick);
}

/**
 * A transfer's tail, and the one leg with no counterpart in the supply path.
 *
 * A ZERO TAKE ENDS THE TRIP WHERE IT STANDS. A supply trip that finds its
 * source spent carries on to its target building and finishes as an ordinary
 * collect run; a transfer has no building to carry on to and nothing in its
 * hands, so there is nothing left for it to do. `cancel()` disposes of nothing
 * here precisely because `trip.amount` is zero — that is what makes it safe,
 * and it is the reason this branch may not be widened.
 *
 * The return leg goes to the RESERVED destination, never through
 * `destinationFor`. Re-resolving would release this trip's own reservation and
 * take it again, which is exactly the double-count `destinationFor` documents
 * — but worse, it would discard a room reservation that has been held since
 * dispatch and re-decide against a world several ticks older than the one the
 * candidate was sized in. The one case that CANNOT be honoured is a
 * destination demolished while this hauler walked to the source: nothing is
 * left to reserve, so a fresh resolution is all there is.
 */
function transferOnward(ctx: TickContext, trip: HaulTrip, at: TileRef): void {
  if (trip.amount === 0) {
    trip.cancel();
    return;
  }
  const dest = ctx.siteById.get(trip.destSiteId);
  if (dest === undefined) {
    turnForHome(ctx, trip, at);
    return;
  }
  trip.startLeg('returning', at, dest, BALANCE.haulTilesPerTick);
}

/**
 * Arrival at the SOURCE of a supply or transfer trip. Both ends are rechecked
 * before anything is taken, because a leg takes ticks and the world moves
 * during them: the demolition handler cancels trips OUTBOUND to a building, and
 * a fetching hauler is walking to a source, so nothing else catches a target
 * that has gone. The source is rechecked by TILE rather than by id — a
 * storehouse that relocates keeps its id and moves, and an id-keyed `takeAt`
 * would draw goods out of a building standing somewhere the hauler is not.
 *
 * THE TILE HALF OF THAT RECHECK IS DEFENSE-IN-DEPTH, and this is a verified
 * claim rather than an assumed one: `handleMoveBuilding` cancels every
 * `fetching` trip whose `sourceSiteId` is the building it moves, a storehouse
 * mid-move is off `storeSitesOf` for the whole countdown, and a trip is never
 * persisted — so nothing leaves a fetching trip aimed at a tile its own source
 * has left, and `source === undefined` answers first in every case that
 * remains. Deleting the two tile comparisons passes the entire suite, which
 * says the branch is unreachable, not that it is untested. Kept for the reason
 * `buildingArrival` keeps its demolished-target branch: the rule that makes it
 * unreachable lives in another handler, one edit away from not doing so.
 *
 * Nothing has been picked up yet, so either recheck failing is a clean cancel:
 * no load, no disposal, no remainder.
 *
 * A TRANSFER IS ADMITTED BEFORE THE BUILDING LOOKUP CAN REFUSE IT. Its
 * `targetId` is null by construction — it is going to a site, not to a
 * building — so `targetRowOf` can only ever miss, and an unconditional guard
 * here would cancel EVERY transfer on arrival at its own source, with the
 * mechanic looking merely inert rather than broken.
 */
function fetchArrival(ctx: TickContext, trip: HaulTrip, capacity: number): void {
  const row = targetRowOf(ctx, trip);
  const source = ctx.siteById.get(trip.sourceSiteId);
  if ((row === undefined && trip.kind !== 'transfer') || trip.resource === null) {
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
  //
  // Capped at CURRENT capacity, not `plannedAmount` alone — the same recheck
  // `loadOutput` already applies on the outbound leg (spec §2.5): a hauler's
  // home can be demolished, relocated or reassigned while it walks, and
  // `plannedAmount` is sized against the capacity it had at DISPATCH. Without
  // this cap a hauler dispatched housed, then made homeless mid-leg, still
  // picks up the housed amount. The gap this leaves in the SOURCE claim
  // (`unclaimedAt` subtracts `plannedAmount`, not the capped take) is real but
  // momentary: `plannedAmount` is zeroed two lines below, so the very next
  // tick's claim is rebuilt from live components and reads the true number —
  // it does not persist the way a genuine over-reservation would.
  trip.amount = ctx.stockpile.takeAt(trip.sourceSiteId, trip.resource, Math.min(trip.plannedAmount, capacity));
  trip.plannedAmount = 0;
  // `row` is undefined HERE only for a transfer: the guard above cancelled
  // every other kind whose target had gone, so this is the kind test and not a
  // second, weaker one.
  if (row === undefined) {
    transferOnward(ctx, trip, source);
    return;
  }
  // Nothing left to deliver: the trip carries on to the building and finishes
  // as an ordinary collect run.
  if (trip.amount === 0) trip.resource = null;
  trip.startLeg('outbound', source, row.position, BALANCE.haulTilesPerTick);
}

/**
 * Put a supply load into the building it was fetched for.
 *
 * Staffing and relocation are both DISPATCH-TIME filters (`needOf` refuses
 * both) and the world moves during a leg: the target's last worker can be
 * unassigned, retire or die while this hauler walks, or the target can be sent
 * into relocation by `handleMoveBuilding` — which retargets an ALREADY
 * outbound leg to the building's new tile and re-prices it from wherever the
 * hauler is standing, so a short retarget can land the hauler before a long
 * relocation countdown ends. Neither cancels the trip the way a demolition
 * does. Unloading anyway parks goods in a building that cannot use them —
 * providing no service while still banking a delivery — and loses them if it
 * is demolished mid-relocation: exactly what each rule prevents, defeated by
 * travel time. The load stays in hand instead; `pickedUp` stays false, so it
 * is an undelivered remainder and goes home to its source.
 */
function unload(ctx: TickContext, trip: HaulTrip, row: HaulBuildingRow): void {
  if (trip.kind !== 'supply' || trip.resource === null || trip.amount === 0) return;
  if (!ctx.staffed.has(row.building.id) || isRelocating(row.relocation.ticksLeft)) return;
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
  const row = targetRowOf(ctx, trip);
  // Demolished while this hauler walked. An empty trip simply ends; a hauler
  // holding a load is still standing on the map and perfectly able to carry it,
  // so it walks that load somewhere rather than having it teleported away.
  //
  // No live path reaches this branch: `handleDemolishBuilding` already walks
  // every outbound trip targeting the building it removes and turns it back
  // (or cancels it) that same tick, before HaulSystem runs, so an outbound
  // trip's target is never freshly gone by the time it could arrive here.
  // Kept anyway as defense-in-depth — a demolished target must never be able
  // to silently drop a load — and if some future caller ever does reach it,
  // it must go through `turnForHome`, exactly as below.
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
 * walked to. It is `arrivesAt`, the same predicate `inHandAt` filters its
 * returning term with — one rule asked at both ends of a leg, so a site that
 * moved cannot be counted as certain by the drain and then refused here.
 *
 * The second exit is a destination that still exists but can no longer take the
 * WHOLE load. Reservation covers every hauler-driven way a site fills and §2.7
 * records that no non-trip path can currently consume reserved room, so this is
 * defense-in-depth — but the alternative is `bankWithSpill`, which banks what
 * fits and forwards the rest to the camp past a hauler standing right there,
 * and a teleport is not an acceptable failure mode for a rule that is merely
 * expected to be unreachable.
 *
 * THE RECHECK IS `heldAt(dest) > capacity`, NOT `heldAt(dest) + amount >
 * capacity`. `heldAt` counts `phase === 'returning' && destSiteId === dest` as
 * `amount`, so THIS TRIP'S OWN LOAD IS ALREADY INSIDE THE FIGURE: a 4-unit
 * transfer arriving at a 60-capacity depot physically holding 56 reads
 * `heldAt === 60`, and adding its own 4 again asks `64 > 60` and turns a
 * correctly reserved arrival away from the room reserved for it. Every exact
 * fit fails that way, silently. The question this must ask is not "does my load
 * fit" — it was made to fit at dispatch — but "did something else eat my room",
 * and that is what comparing the reservation-inclusive figure against the
 * capacity directly asks. `destinationFor` meets the same boundary from the
 * other side and resolves it by releasing the trip's reservation first; its doc
 * comment is the precedent rather than something to rediscover.
 */
function depositArrival(ctx: TickContext, trip: HaulTrip): void {
  const at = { col: trip.legToCol, row: trip.legToRow };
  const dest = ctx.siteById.get(trip.destSiteId);
  const arrived = arrivesAt(trip, dest);
  const roomLeft = dest === undefined || dest.capacity === null || ctx.claims.heldAt(dest.id) <= dest.capacity;
  if (!arrived || !roomLeft) {
    if (trip.amount === 0) trip.cancel();
    else turnForHome(ctx, trip, at);
    return;
  }
  bankLoad(ctx.stockpile, dest, trip);
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
    input: Write(InputBuffer), relocation: Read(Relocation), production: Read(Production),
  }),
  workers: queryComponents({ job: Read(JobAssignment), trip: Write(HaulTrip), home: Read(Home) }),
  pending: ReadResource(PendingChanges),
})
  .withName('HaulSystem')
  .withRunFunction(({ stockpile, buildings, workers, pending }) => {
    const buildingRows = [...buildings.iter()];
    const byId = new Map(buildingRows.map((row) => [row.building.id, row]));
    const workerRows = [...workers.iter()];
    const sites = storeSitesFrom(buildingRows, pending);
    // Built here rather than inside the context below because the claims need
    // it too: `inHandAt` drops a returning reservation whose site has moved out
    // from under it, which is a question about a site's LIVE tile. One map,
    // read by that claim and by every arrival handler.
    const siteById = new Map(sites.map((site) => [site.id, site]));
    const capacityOf = (row: HaulWorkerRow) => haulerCapacity(homeTileOf(row.home.buildingId, byId, pending));
    const claims = claimsOf(workerRows, stockpile, siteById, capacityOf);
    // ONE derivation, read by the dispatch filter and by the arrival recheck.
    // They are the same rule seen from two ends of a leg, so a second copy of
    // this expression is how the recheck stops matching what it rechecks.
    const staffed: StaffedSet = new Set(workerRows.map((row) => row.job.buildingId));
    const ctx: TickContext = {
      stockpile,
      byId,
      sites,
      siteById,
      staffed,
      claims,
      demolished: pending.demolished,
    };
    // Once per tick rather than once per idle hauler, which is where it used to
    // be rebuilt. It is derived from building positions, staffing and the site
    // list — nothing a dispatch touches — so hoisting it changes no answer, and
    // it is what pays for `chooseJob` asking about drains on every dispatch
    // tick instead of only on an idle one.
    const demand = siteDemandFrom(sites, buildingRows, staffed);
    const inputs: DispatchInputs = { buildings: buildingRows, sites, staffed, claims, demand };

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
      if (trip.phase === 'fetching') fetchArrival(ctx, trip, capacity);
      else if (trip.phase === 'outbound') buildingArrival(ctx, trip, capacity);
      else depositArrival(ctx, trip);
    }
  })
  .build();
