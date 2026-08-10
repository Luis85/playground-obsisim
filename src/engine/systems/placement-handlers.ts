import type { ResourceId } from '../../shared/content-types';
import type { Command } from '../../shared/commands';
import { legPositionOf } from '../../shared/haul';
import { autoPlacePosition, isTileBuildable, relocationTicks, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { buildingComponents } from '../spawn';
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

export function handleConstructBuilding(ctx: CommandContext, command: Extract<Command, { type: 'constructBuilding' }>): void {
  // Checked BEFORE pay(): refusing after payment would swallow the cost.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const def = BUILDINGS[command.buildingDefId];
  // Position resolves (and can refuse) BEFORE pay(), same principle as ids.
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
  if (!ctx.stockpile.pay(def.cost)) {
    ctx.notices.reject(`Cannot afford ${def.name}.`);
    return;
  }
  ctx.claimedTiles.push({ col: at.col, row: at.row });
  const id = ctx.ids.take();
  // Component list shared with the save-restore path (src/engine/spawn.ts) so a
  // building constructed in play cannot end up missing one — it already did,
  // with OutputBuffer (OBS-4-02).
  ctx.spawn(...buildingComponents({ id, defId: def.id, col: at.col, row: at.row }));
  // Recorded AFTER every rejection path above: a construction refused for
  // cost, tiles, or id exhaustion must not appear in this list, or homing
  // would shelter someone in a house that was never actually built.
  ctx.pending.constructed.push({ id, defId: def.id, col: at.col, row: at.row });
  ctx.notices.succeed(`Built a ${def.name}.`);
}

/** What a demolished building's buffer held, worded for the success notice:
 * resource names from the same catalog `BUILDINGS` comes from, in catalog
 * order — the determinism rule `OutputBuffer.fullestResource` also uses — and
 * comma-separated. Empty when the buffer held nothing; the caller decides
 * whether that is worth a clause of its own. */
function bufferLossText(amounts: ReadonlyMap<ResourceId, number>): string {
  const parts: string[] = [];
  for (const id of RESOURCE_IDS) {
    const amount = amounts.get(id) ?? 0;
    if (amount > 0) parts.push(`${amount} ${RESOURCES[id].name}`);
  }
  return parts.join(', ');
}

export function handleDemolishBuilding(ctx: CommandContext, command: Extract<Command, { type: 'demolishBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const def = BUILDINGS[found.building.defId];
  // Full refund — flagged balance knob (increment 5 owns tuning). refund(),
  // not add(): the building was never hauled to, so this must not inflate
  // the Economy view's Delivered/t (Stockpile.refund's doc comment says why).
  // Active batch progress is simply lost with the entity.
  for (const [resource, amount] of Object.entries(def.cost)) {
    ctx.stockpile.refund(resource as ResourceId, amount);
  }
  // Whatever was waiting in the buffer dies with the building — decided in
  // OBS-4-07, against refunding it: a building left full of uncollected goods
  // should be expensive to bulldoze, since that is exactly the pressure
  // haulers exist to relieve, and a player who wants the goods kept already
  // has the non-destructive moveBuilding. The notice below names the loss
  // instead of hiding it. Read here, before the clear, purely to word that
  // notice — the stockpile loop above is untouched either way. Emptying the
  // buffer HERE rather than letting the entity carry it off at the post-step
  // sync is load-bearing for an unrelated reason: HaulSystem runs later in
  // this same tick and still sees the not-yet-removed entity, so a buffer
  // left full would have it dispatch a hauler at a building that is already
  // gone.
  const lost = bufferLossText(found.buffer.amounts);
  found.buffer.amounts.clear();
  // Read BEFORE the loop below nulls every matching home: this counts exactly
  // who the demolition displaces, for the notice.
  const displaced = ctx.workers.filter(({ home }) => home.buildingId === command.buildingId).length;
  for (const { job, trip, home } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
    // Defensive, not load-bearing: rehome (PopulationSystem, later this same
    // tick) already zeroes a demolished shelter's residents on its own —
    // freeBeds excludes ctx.pending.demolished, so settleExistingHome's
    // free.get(homeId) ?? 0 falls through to eviction. Kept because it is
    // cheap and harmless. The colonist this can't protect is one ctx.workers
    // has no row for yet — spawned earlier this same tick — which the
    // pending.arrivals loop below exists to catch.
    if (home.buildingId === command.buildingId) home.buildingId = null;
    // Spec §2.8: the trip cancels now, riding the same-tick demolishedIds
    // machinery, rather than lazily when the hauler reaches a tile with nothing
    // on it — up to 13 ticks later, all of them spent booked to a building the
    // snapshot no longer contains. Outbound only: a returning hauler is carrying
    // those goods to the camp, which did not move, and resetting it would
    // destroy the load (mirrors handleMoveBuilding's guard below).
    //
    // Empty-handed only, for that same reason: since increment 7 an OUTBOUND
    // hauler can be carrying a supply load it fetched from a store, and
    // cancelling that here would destroy goods the colony already owned. One
    // still walks to the demolished tile and finds nothing there, which is
    // where HaulSystem turns it for home with its load intact.
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId && trip.amount === 0) trip.cancel();
  }
  ctx.removals.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.pending.demolished.add(command.buildingId);
  // Colonists spawned EARLIER THIS TICK are not in ctx.workers — the query
  // cannot see them until the post-step sync — so a nomad welcomed before this
  // demolition keeps a homeId pointing at the building being removed unless
  // something reaches them through the pending ledger. Since Task 8 wires nomad
  // welcoming, ctx.pending.arrivals genuinely fills: recruitWorker and
  // demolishBuilding in one drain is a reachable pair, not a hypothetical.
  //
  // AFTER the two demolished-ledger writes above, deliberately:
  // reseatArrivalsOf re-seats through shelterWithRoom, which skips
  // pending.demolished — re-seating any earlier would hand the arrival a bed in
  // the very house being removed.
  reseatArrivalsOf(ctx, command.buildingId);
  // A zero-units clause would be noise on the common case, so the empty
  // buffer keeps the plain wording rather than gaining an empty ", lost."
  let notice = lost === ''
    ? `Demolished the ${def.name} — cost refunded.`
    : `Demolished the ${def.name} — cost refunded, ${lost} lost.`;
  if (displaced > 0) notice += ` — ${displaced} colonist(s) displaced.`;
  ctx.notices.succeed(notice);
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
  // A returning or fetching hauler is deliberately left alone. Its leg is a
  // walk between two tiles frozen when the leg began, and it is honestly priced
  // whatever the building does afterwards — including when the building being
  // moved IS the depot it is walking to, since a relocating storehouse stops
  // being a store site and `depositArrival` turns the load for a site that
  // still exists on arrival. That costs it the rest of the walk, which is the
  // same price demolition already charges, and changing it is a
  // gameplay-visible decision rather than this fix's business.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) {
      trip.startLeg('outbound', legPositionOf(trip), to, BALANCE.haulTilesPerTick);
    }
  }
  ctx.notices.succeed(`Moved the ${BUILDINGS[found.building.defId].name}.`);
}
