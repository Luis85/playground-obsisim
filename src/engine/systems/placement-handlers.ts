import type { BuildingDefId, CostMap, ResourceId } from '../../shared/content-types';
import type { Command } from '../../shared/commands';
import { CAMP_SITE_ID, legPositionOf } from '../../shared/haul';
import { autoPlacePosition, isTileBuildable, isUnderConstruction, relocationTicks, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import type { HaulTrip } from '../components';
import { buildingComponents } from '../spawn';
import { demolitionNotice, heldText, refundCostOf, refundInTrayOf } from './demolition';
import { heldAtOf } from './haul-claims';
import { destinationFor } from './haul-sites';
import { shelterWithRoom } from './population-handlers';
import { findBuilding, type CommandContext } from './command-handlers';

// The three commands that put a building somewhere, take it away again, or move
// it — split out of command-handlers.ts because that file was approaching the
// 500-line cap and these three are the ones that share a vocabulary (tiles,
// occupancy, the pending ledgers) the staffing commands never touch.

/**
 * Occupancy truth for this drain: live rows plus this drain's own claims.
 *
 * Filters `ctx.demolishedIds`, the same exclusion `findBuilding` already
 * applies: sim-ecs defers entity removal to the post-step sync, so a building
 * demolished earlier in this drain is still in `ctx.buildings` and its tile
 * would otherwise still read as occupied for the rest of the drain (OBS-6-01).
 */
function occupiedTiles(ctx: CommandContext): TileRef[] {
  return [
    ...ctx.buildings
      .filter((row) => !ctx.demolishedIds.has(row.building.id))
      .map((row) => ({ col: row.position.col, row: row.position.row })),
    ...ctx.claimedTiles,
  ];
}

/**
 * What every construction site the colony already has going still needs, per
 * resource — `Σ over sites of max(0, cost[r] − held[r])` (spec §2.3).
 *
 * Derived from live components at every call, stored nowhere, RESERVING
 * nothing: no claim is written and two haulers racing for the same log are
 * still resolved by the claim machinery that already does that. It is what
 * `pay` used to do implicitly — a second order used to see the first one's
 * cost gone from the ledger, and with the payment moved to delivery every
 * order in a drain would otherwise read the same untouched stock.
 *
 * Both halves of "the sites the colony has going" are needed and neither is
 * sufficient alone: `ctx.buildings` misses every site ordered earlier in THIS
 * drain (invisible to queries until the post-step sync), and
 * `pending.constructed` is only ever this drain's own. A pending site has
 * nothing delivered yet, so its shortfall is its whole cost.
 *
 * Skips `ctx.demolishedIds` for the reason `occupiedTiles` above does:
 * a site cancelled earlier in this drain is still in the query with its
 * `Construction` and its in-tray intact, and charging its shortfall against
 * the very order meant to replace it refuses a rebuild the colony can plainly
 * afford.
 *
 * Deliberately conservative by the amount in transit: a load already picked up
 * has left `Stockpile` and has not yet reached `held`, so it is counted
 * against the player twice. That is the safe direction — it never permits a
 * queue the colony cannot fund — and increment 10 deletes the check outright.
 */
function outstandingMaterials(ctx: CommandContext): CostMap {
  const outstanding: CostMap = {};
  const owe = (defId: BuildingDefId, held: (id: ResourceId) => number): void => {
    for (const [resource, amount] of Object.entries(BUILDINGS[defId].cost)) {
      const id = resource as ResourceId;
      outstanding[id] = (outstanding[id] ?? 0) + Math.max(0, amount - held(id));
    }
  };
  for (const row of ctx.buildings) {
    if (ctx.demolishedIds.has(row.building.id)) continue;
    if (!isUnderConstruction(row.construction.ticksLeft)) continue;
    owe(row.building.defId, (id) => row.input.amounts.get(id) ?? 0);
  }
  for (const site of ctx.pending.constructed) owe(site.defId, () => 0);
  return outstanding;
}

/**
 * §2.3's rule: an order is refused unless the colony holds its cost ON TOP OF
 * what every site already going still needs.
 *
 * `colonyStock`, not `toJSON`: materials are hauled from any site, so wood in
 * a storehouse funds a build exactly as camp wood does — the same reason the
 * nomad gate reads it.
 *
 * Quantified over the NEW cost's resources rather than over every resource in
 * the catalog. The question being asked is whether this order can be added to
 * the queue, and a colony that has drifted short on a material this order does
 * not want cannot fix that by being refused an unrelated building.
 *
 * An ORDER-TIME check, and it guarantees nothing about completion: it writes
 * nothing down, so goods it counted can leave for a meal or a sawmill before a
 * hauler collects them. Reserving hard enough to close that would mean holding
 * materials against food, which is a worse game than a queue that occasionally
 * stalls — and cancellation recovers it.
 */
function affordableWithQueue(ctx: CommandContext, cost: CostMap): boolean {
  const outstanding = outstandingMaterials(ctx);
  const stock = ctx.stockpile.colonyStock();
  return Object.entries(cost).every(([resource, amount]) => {
    const id = resource as ResourceId;
    return (stock[id] ?? 0) >= (outstanding[id] ?? 0) + amount;
  });
}

export function handleConstructBuilding(ctx: CommandContext, command: Extract<Command, { type: 'constructBuilding' }>): void {
  // Checked BEFORE the spawn, with the two below: neither an id nor a tile is
  // recoverable once the entity exists.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const def = BUILDINGS[command.buildingDefId];
  // Position resolves (and can refuse) before the spawn, same principle as ids.
  const occupied = occupiedTiles(ctx);
  let at = command.at ?? null;
  if (at === null) {
    at = autoPlacePosition(ctx.map, occupied);
    if (at === null) {
      ctx.notices.reject('No free tile left to build on.');
      return;
    }
  } else if (!isTileBuildable(ctx.map, occupied, at.col, at.row)) {
    ctx.notices.reject('Cannot build there.');
    return;
  }
  // The REFUSAL survives §2.3, only the PAYMENT goes: `pay` both tested and
  // debited, so deleting the call would quietly repeal "you cannot order what
  // you cannot pay for" — which is increment 10's product change, not a
  // side effect of moving the charge to delivery. Cumulative rather than a
  // plain `canAfford(def.cost)`, because the debit is what used to stop a
  // second order spending the first one's wood a second time.
  if (!affordableWithQueue(ctx, def.cost)) {
    ctx.notices.reject(`Cannot afford ${def.name}.`);
    return;
  }
  ctx.claimedTiles.push({ col: at.col, row: at.row });
  const id = ctx.ids.take();
  // Component list shared with the save-restore path (src/engine/spawn.ts) so a
  // building constructed in play cannot end up missing one — it already did,
  // with OutputBuffer (OBS-4-02).
  //
  // A SITE, not a finished building (§2.5): it occupies its tile from this
  // tick and is counted down by delivered materials, never by the order.
  ctx.spawn(...buildingComponents({ id, defId: def.id, col: at.col, row: at.row, constructionTicks: BALANCE.buildTicks }));
  // Recorded AFTER every rejection path above: a construction refused for
  // cost, tiles, or id exhaustion must not appear in this list, or homing
  // would shelter someone in a house that was never actually built.
  ctx.pending.constructed.push({ id, defId: def.id, col: at.col, row: at.row });
  // STARTED, not built: nothing has been paid, nothing has been delivered and
  // the thing on that tile is a hole in the ground. A success notice reading
  // "Built a House." beside a building that provides nothing is the same
  // false receipt OBS-4-07 was filed against.
  ctx.notices.succeed(`Started building a ${def.name}.`);
}

/**
 * The hauler walking to a building that has just been demolished.
 *
 * §2.7's other half of the split: this colonist is still a hauler, still
 * standing somewhere on the map, and perfectly able to carry what it holds — so
 * a load starts a `returning` leg from where the walk got to rather than being
 * banked from mid-route, which would teleport cargo out of a walking colonist's
 * hands and understate haul time in exactly the direction that flatters §4's
 * measurements. Empty-handed, there is nothing to dispose of and the trip ends.
 *
 * Both arms go through the components' own two entry points — `startLeg` for a
 * leg that begins, `cancel` for a trip that ends — so the six leg fields are
 * always written together.
 */
function turnBackOrCancel(ctx: CommandContext, trip: HaulTrip): void {
  if (trip.amount === 0) {
    trip.cancel();
    return;
  }
  const at = legPositionOf(trip);
  const dest = destinationFor(trip, at, ctx.sites(), heldAtOf(ctx.workers, ctx.stockpile));
  trip.startLeg('returning', at, dest, BALANCE.haulTilesPerTick);
}

export function handleDemolishBuilding(ctx: CommandContext, command: Extract<Command, { type: 'demolishBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const def = BUILDINGS[found.building.defId];
  // Read before `refundCostOf` — nothing mutates `found.construction` between
  // here and the notice below, and this is the same test that function uses
  // to decide whether there is anything to hand back, so the notice's opening
  // clause tracks its actual behaviour rather than guessing at it separately.
  const wasSite = isUnderConstruction(found.construction.ticksLeft);
  refundCostOf(ctx, found);
  // A SITE's in-tray is handed back instead — the goods a hauler delivered
  // toward a build the player has now cancelled. Banked at the camp before the
  // clear below empties the tray, and returned so both the `moved` clause and
  // this branch read one set of figures.
  const returned = refundInTrayOf(ctx, found);
  // Whatever ELSE was waiting in either tray dies with the building — decided
  // in OBS-4-07 for the out-tray, and extended to the IN-tray by §2.7 for the
  // same reason: neither is in the ledger, and a building left full of goods
  // should be expensive to bulldoze, since that is exactly the pressure haulers
  // exist to relieve, and a player who wants the goods kept already has the
  // non-destructive moveBuilding. The notice below names both losses instead of
  // hiding them — a mill holding only delivered wheat used to report that its
  // cost was refunded while silently deleting the wheat. Read here, before the
  // clear, purely to word that notice — the stockpile loops above are untouched
  // either way. Emptying the trays HERE rather than letting the entity carry
  // them off at the post-step sync is load-bearing for an unrelated reason:
  // HaulSystem runs later in this same tick and still sees the not-yet-removed
  // entity, so a buffer left full would have it dispatch a hauler at a building
  // that is already gone.
  //
  // `returned` is subtracted rather than the in-tray simply being skipped for a
  // site: a site's OUT-tray is empty by construction (it produces nothing), so
  // the two piles are disjoint today — and writing it this way keeps `lost`
  // meaning "what this demolition destroyed" whatever a future task puts in
  // either tray, instead of meaning it only while that stays true.
  const lost = heldText((id) => (
    (found.buffer.amounts.get(id) ?? 0) + (found.input.amounts.get(id) ?? 0) - (returned.get(id) ?? 0)
  ));
  found.buffer.amounts.clear();
  found.input.amounts.clear();
  // A storehouse's contents go the OTHER way, and the distinction is OBS-4-07's
  // own reasoning applied to a different fact: buffered goods are not yet colony
  // wealth, while a storehouse's contents ARE — they are in the ledger, they
  // count in colonyWealth, the player has already banked them. Destroying them
  // would drop a published wealth figure under a notice reading "cost refunded".
  // Unconditional because `spillTo` is a no-op for a building with no ledger
  // site, which is every building that is not a storehouse; it banks without
  // recording a delivery, so moving goods nobody hauled cannot inflate
  // Delivered/t. BEFORE the pending-ledger writes below only incidentally —
  // what matters is that it runs before any later command in this drain can
  // resolve sites, so no site outlives its building even for one command.
  // A cancelled site's delivered materials join this clause rather than the
  // `lost` one: `refundInTrayOf` put them at the camp, which is where a
  // demolished storehouse's stock goes too, so one sentence describes both.
  const moved = heldText((id) => ctx.stockpile.getAt(command.buildingId, id) + (returned.get(id) ?? 0));
  ctx.stockpile.spillTo(CAMP_SITE_ID, command.buildingId);
  // Read BEFORE the loop below nulls every matching home: this counts exactly
  // who the demolition displaces, for the notice.
  const displaced = ctx.workers.filter(({ home }) => home.buildingId === command.buildingId).length;
  for (const { job, home } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
    // Defensive, not load-bearing: rehome (PopulationSystem, later this same
    // tick) already zeroes a demolished shelter's residents on its own —
    // freeBeds excludes ctx.pending.demolished, so settleExistingHome's
    // free.get(homeId) ?? 0 falls through to eviction. Kept because it is
    // cheap and harmless. The colonist this can't protect is one ctx.workers
    // has no row for yet — spawned earlier this same tick — which the
    // pending.arrivals loop below exists to catch.
    if (home.buildingId === command.buildingId) home.buildingId = null;
  }
  ctx.removals.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.pending.demolished.add(command.buildingId);
  // Spec §2.8: the trip ends now, riding the same-tick demolishedIds machinery,
  // rather than lazily when the hauler reaches a tile with nothing on it — up to
  // 13 ticks later, all of them spent booked to a building the snapshot no
  // longer contains. A returning hauler is left alone: it is carrying its goods
  // to a site, which the demolition did not move. A fetching hauler whose
  // SOURCE is this building is cancelled here too, not left to its own
  // by-tile recheck in `fetchArrival` — nothing has been taken yet, so
  // `trip.cancel()` disposes of nothing, and waiting would leave it walking to
  // the vacated tile for up to a whole leg of wasted hauler-ticks.
  //
  // AFTER the two demolished-ledger writes above, deliberately: a loaded hauler
  // resolves a destination through `ctx.sites()`, and this building must already
  // be off that list — otherwise a hauler bound for a demolished storehouse
  // would be sent to bank into it.
  //
  // A third case besides the two above: a hauler still FETCHING whose TARGET
  // (the processor it means to deliver to) is this building, with its SOURCE
  // a different, still-live site. Neither clause above matches it — it is not
  // yet `outbound`, and its `sourceSiteId` names a depot that is not being
  // demolished. Left alone it resolves on its own (`fetchArrival` filters
  // `pending.demolished` from its target lookup and cancels cleanly), so
  // nothing is ever LOST — but for as long as it keeps walking, its
  // `sourceSiteId`/`plannedAmount` still reserve real stock at that live
  // depot for a delivery that can never happen, which blocks every OTHER
  // hauler from that stock, not merely this one. `trip.cancel()`, same as the
  // other two: nothing has been taken yet, so there is nothing to dispose of.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) turnBackOrCancel(ctx, trip);
    else if (trip.phase === 'fetching' && trip.sourceSiteId === command.buildingId) trip.cancel();
    else if (trip.phase === 'fetching' && trip.targetId === command.buildingId) trip.cancel();
  }
  // Colonists spawned EARLIER THIS TICK are not in ctx.workers — the query
  // cannot see them until the post-step sync — so a nomad welcomed before this
  // demolition keeps a homeId pointing at the building being removed unless
  // something reaches them through the pending ledger. Since increment 6's
  // Task 8 wires nomad welcoming, ctx.pending.arrivals genuinely fills:
  // recruitWorker and demolishBuilding in one drain is a reachable pair, not
  // a hypothetical.
  //
  // AFTER the two demolished-ledger writes above, deliberately:
  // reseatArrivalsOf re-seats through shelterWithRoom, which skips
  // pending.demolished — re-seating any earlier would hand the arrival a bed in
  // the very house being removed.
  reseatArrivalsOf(ctx, command.buildingId);
  ctx.notices.succeed(demolitionNotice(def.name, lost, moved, displaced, wasSite));
}

/**
 * Move this drain's own arrivals out of a house that just stopped sheltering,
 * into whichever house still has room. Both ways a house stops sheltering call
 * it: `handleMoveBuilding` (in transit) and `handleDemolishBuilding` (gone).
 *
 * A nomad welcomed EARLIER THIS SAME DRAIN is invisible to `ctx.workers` — the
 * query cannot see an entity until the post-step sync — so `rehome`
 * (PopulationSystem, later this tick) has no row for them and can neither
 * evict nor re-house them: it walks `ctx.colonists`, which this arrival is not
 * yet part of. Only the pending ledger can still reach them.
 *
 * Both halves are load-bearing. Nulling alone stops the dangling homeId the v5
 * load guard refuses (and the phantom occupant it would add to a house nobody
 * lives in) but leaves the arrival homeless for the rest of the tick even when
 * another house stands empty — a paused player watches that contradiction
 * until they step again. Re-seating alone would leave the old id in place when
 * no bed is left anywhere.
 *
 * Null first, then re-seat, in that order: `shelterWithRoom` folds
 * `ctx.pending.arrivals` in itself and reads them LIVE, so an arrival still
 * pointing at its old house would be counted against a bed it no longer holds.
 * The same liveness is what makes this safe for several displaced arrivals at
 * once — each one re-seated counts against its new house on the next call.
 */
function reseatArrivalsOf(ctx: CommandContext, buildingId: number): void {
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId !== buildingId) continue;
    home.buildingId = null;
    home.buildingId = shelterWithRoom(ctx.shelters(), ctx.occupancy(), ctx.pending);
  }
}

export function handleMoveBuilding(ctx: CommandContext, command: Extract<Command, { type: 'moveBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const { to } = command;
  // Own tile first: it IS occupied (by the mover), so isTileBuildable would
  // reject it anyway — the explicit check just makes the no-op reject
  // independent of that coincidence. occupiedTiles includes the mover's old
  // tile, which a move to any DIFFERENT tile never matches.
  const own = found.position.col === to.col && found.position.row === to.row;
  if (own || !isTileBuildable(ctx.map, occupiedTiles(ctx), to.col, to.row)) {
    ctx.notices.reject('Cannot move there.');
    return;
  }
  // Read BEFORE overwriting found.position: doing this after would measure a
  // zero-distance move against the tile the building already occupies.
  const moved = Math.hypot(to.col - found.position.col, to.row - found.position.row);
  found.position.col = to.col;
  found.position.row = to.row;
  // Distance-scaled downtime: relocation used to be free and instant, which let
  // a player cluster at the camp and never feel haul pressure. Replaces any
  // remaining downtime rather than adding to it — accumulating would let a
  // player trap a building by accident.
  found.relocation.ticksLeft = relocationTicks(moved, BALANCE.relocationTilesPerTick);
  reseatArrivalsOf(ctx, command.buildingId);
  // Haulers already walking to this building now have a different journey, so
  // each one starts a fresh leg from WHERE IT HAS GOT TO — `legPositionOf`, the
  // same interpolation a cancellation resting place uses — to the new tile.
  // Not `haulTicks(to, …)`: that prices a walk from the CAMP, which was only
  // ever right while the camp was the one place a trip could begin, and since
  // increment 7 an outbound hauler routinely sets off from a storehouse it
  // fetched a supply load at. And through `HaulTrip.startLeg`, the one way a leg
  // may begin, so both endpoints and legTicks are refreshed together with the
  // charge: leaving them frozen on the OLD tile would
  // draw the dot along a line nobody is walking, hand a later `cancel()` a
  // legTicks that no longer spans its own endpoints, and give
  // `buildingArrival`'s demolition branch a standing tile the hauler never
  // reached.
  //
  // A returning hauler is deliberately left alone. Its leg is a walk between
  // two tiles frozen when the leg began, and it is honestly priced whatever the
  // building does afterwards — including when the building being moved IS the
  // depot it is walking to, since a relocating storehouse stops being a store
  // site and `depositArrival` turns the load for a site that still exists on
  // arrival. That costs it the rest of the walk, which is the same price
  // demolition already charges, and changing it is a gameplay-visible decision
  // rather than this fix's business.
  //
  // A fetching hauler whose SOURCE is the building being moved is cancelled,
  // not left alone: nothing has been taken yet, so `trip.cancel()` disposes of
  // nothing, and leaving it walking to the vacated tile would waste up to a
  // whole leg of hauler-ticks before `fetchArrival`'s own by-tile recheck
  // caught it.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) {
      trip.startLeg('outbound', legPositionOf(trip), to, BALANCE.haulTilesPerTick);
    } else if (trip.phase === 'fetching' && trip.sourceSiteId === command.buildingId) {
      trip.cancel();
    }
  }
  ctx.notices.succeed(`Moved the ${BUILDINGS[found.building.defId].name}.`);
}
