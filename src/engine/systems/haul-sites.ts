import { CAMP_SITE_ID, CAMP_TILE, legPositionOf, nearestSiteWithRoom, type StoreSite } from '../../shared/haul';
import type { TileRef } from '../../shared/placement';
import type { HaulTrip } from '../components';
import type { PendingChanges, Stockpile } from '../resources';

/**
 * A building that can store goods, as `storeSitesOf` needs it to build the
 * `StoreSite[]` `HaulSystem` will haul against. `capacity` is resolved by the
 * caller (`BUILDINGS[defId].storage`) rather than carried as a `defId` here —
 * the same choice `ShelterRow` makes for `beds` in population-handlers.ts —
 * so this module stays free of a content-catalog dependency.
 */
export interface StoreSiteRow {
  id: number;
  col: number;
  row: number;
  capacity: number;
  /** A storehouse in transit stores nothing until it lands — `beds.total`'s
   * existing rule for a relocating house (increment 6), applied to storage. */
  relocating: boolean;
}

/**
 * The camp as a `StoreSite`: always present in every site list, always
 * unbounded, and therefore the destination no resolution can fail to find.
 *
 * Frozen, and shared rather than rebuilt per call, because `storeSitesOf`
 * hands it out inside the array every hauler resolves against — a caller that
 * could write to it would give the camp a capacity, which is the one thing
 * that would make `destinationFor`'s terminating fallback able to fail.
 * Module-private: both readers are here, and the camp reaches every other
 * caller inside the site list `storeSitesOf` returns.
 */
const CAMP_STORE_SITE: StoreSite = Object.freeze({
  id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null,
});

/**
 * Store sites right now: the camp, then every live storehouse — what
 * `HaulSystem` needs in order to answer "where can this load go" (spec §2.3,
 * §2.7).
 *
 * Two exclusions apply to a storehouse row, each borrowed from a rule that
 * already governs the same tick elsewhere in this engine:
 *
 * - `relocating`: a building mid-move provides none of its service — the
 *   same rule `beds.total` already applies to a relocating house.
 * - `pending.demolished`: `CommandSystem` runs before `HaulSystem`, and a
 *   demolished entity survives in every query until the post-step sync (see
 *   `PendingChanges` in resources.ts). Without this exclusion a hauler would
 *   be dispatched to a shed that is already gone.
 *
 * Deliberately does NOT fold in `pending.constructed`, unlike homing's
 * shelters (`CommandContext.shelters` in command-system.ts). A colonist left
 * homeless beside a house built this tick is a contradiction the player can
 * SEE in one snapshot, so homing must close it the same tick. A hauler not
 * yet routing to a shed built this tick is invisible: the shed simply becomes
 * a site next tick, one tick later than it could have, and nothing about that
 * gap is observable. Simpler wins where the cost of waiting is that small.
 *
 * The camp always leads, at `CAMP_SITE_ID` with unbounded capacity; the
 * storehouses that follow are ascending by id — the same tie-break-to-id
 * determinism every other selection in `src/shared/haul.ts` commits to, so
 * the result never depends on `rows`' own order (the second test above
 * passes `rows` out of id order on purpose).
 */
export function storeSitesOf(rows: readonly StoreSiteRow[], pending: PendingChanges): StoreSite[] {
  const storehouses = rows
    .filter((row) => !row.relocating && !pending.demolished.has(row.id))
    .map((row): StoreSite => ({ id: row.id, col: row.col, row: row.row, capacity: row.capacity }))
    .sort((a, b) => a.id - b.id);
  return [CAMP_STORE_SITE, ...storehouses];
}

/**
 * An undelivered supply remainder goes back where it CAME from, not to
 * whatever site is nearest: routing it onward would turn camp wheat into depot
 * stock without it ever being consumed — the store-to-store transfer §2.13
 * excludes. `!pickedUp && amount > 0` is exactly this case, because a hauler
 * only loads output with empty hands.
 *
 * Null when the source no longer exists (demolished, or in transit — it is
 * simply absent from `sites`) or filled while the load was away. Both fall
 * through to the ordinary nearest-with-room search below, which is what makes
 * "bank into a storehouse that is not a live site" inexpressible rather than
 * merely avoided (§2.4 invariant 2).
 *
 * The room check is `nearestSiteWithRoom` itself, called against a single-site
 * list rather than reimplemented here — a single-element list never reaches
 * its `closer` tie-break, so this is exactly "does the source have room for
 * the whole remainder", with no distance comparison able to change the
 * answer. That is deliberate rather than incidental: an inline second copy of
 * the identical `heldAt(id) + amount > capacity` boundary once shipped here
 * without the exact-fit test `nearestSiteWithRoom`'s own suite carries — this
 * call inherits that test instead of needing a second one.
 */
function remainderHome(trip: HaulTrip, sites: readonly StoreSite[], heldAt: (siteId: number) => number): StoreSite | null {
  const source = sites.find((site) => site.id === trip.sourceSiteId);
  if (trip.pickedUp || trip.amount === 0 || source === undefined) return null;
  return nearestSiteWithRoom(source.col, source.row, [source], heldAt, trip.amount);
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
 *
 * Shared by the three callers that must agree about where a load ends up: the
 * two arrival handlers that start a return leg, and `bankCarriedLoad` below,
 * which banks for a hauler that has stopped existing as one.
 */
export function destinationFor(
  trip: HaulTrip, from: TileRef, sites: readonly StoreSite[], heldAt: (siteId: number) => number,
): StoreSite {
  trip.destSiteId = CAMP_SITE_ID;
  const dest = remainderHome(trip, sites, heldAt)
    ?? nearestSiteWithRoom(from.col, from.row, sites, heldAt, trip.amount)
    ?? CAMP_STORE_SITE;
  trip.destSiteId = dest.id;
  return dest;
}

/**
 * Put what a hauler is holding into a resolved site.
 *
 * `addAt` for goods the ledger has never counted, `refundAt` for a supply
 * remainder the colony already owned — recording the second as a delivery
 * would inflate `Delivered/t` for a round trip that produced nothing (§2.4).
 * `pickedUp` is the only thing that tells the two apart by the time a load
 * reaches a site, which is why it is a field on the trip rather than a
 * judgement each banking site makes for itself.
 */
export function bankLoad(stockpile: Stockpile, dest: StoreSite, trip: HaulTrip): void {
  if (trip.resource === null || trip.amount <= 0) return;
  if (trip.pickedUp) stockpile.addAt(dest, trip.resource, trip.amount);
  else stockpile.refundAt(dest, trip.resource, trip.amount);
}

/**
 * Dispose of a load when NOBODY IS LEFT TO WALK IT — the hauler stopped being
 * a hauler (`handleUnassignHauler`) or stopped being alive (`standDown`).
 * §2.7's split: the other two cancellation paths leave a hauler standing on
 * the map, and those start a `returning` leg instead, because banking from
 * mid-route teleports cargo out of a walking colonist's hands.
 *
 * Resolved through `destinationFor`, not banked at the camp by reflex: a
 * remainder belongs back at the site it was drawn from, and §2.4's invariants
 * then cover the two ways that site can have moved on underneath the trip — it
 * filled while the hauler walked, or it was demolished earlier in this same
 * drain. Neither loses a unit and neither can create a ledger site with no
 * building behind it.
 *
 * Reads `legPositionOf` BEFORE the caller's `cancel()`, which clears the leg:
 * the distance a fallback destination is chosen by is measured from where the
 * hauler actually stopped, the same law the cancellation itself uses.
 */
export function bankCarriedLoad(
  stockpile: Stockpile, trip: HaulTrip, sites: readonly StoreSite[], heldAt: (siteId: number) => number,
): void {
  if (trip.resource === null || trip.amount <= 0) return;
  bankLoad(stockpile, destinationFor(trip, legPositionOf(trip), sites, heldAt), trip);
}
