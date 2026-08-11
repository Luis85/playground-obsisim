import type { ResourceId } from '../../shared/content-types';
import { HaulTrip, Home, JobAssignment } from '../components';
import type { Stockpile } from '../resources';

/**
 * The claim ledger: what haulers already in flight have spoken for, so a
 * dispatch decision can size against what is genuinely free rather than
 * against what is physically there.
 *
 * Split out of `haul-dispatch.ts` for the line budget, along the seam the four
 * claims already draw: everything here answers "what is already spoken for",
 * and nothing here decides anything. `chooseJob`, the candidate builders and
 * the `begin*` family stay there, which is where the three kinds of work are
 * decided. The row shapes travel with it because they exist to be traversed by
 * these lookups and by nothing else.
 */

/** Just the trip. The narrowest row any claim reads, and the one the
 * cancellation paths outside `HaulSystem` can supply: `CommandContext.workers`
 * and `PopulationContext.colonists` both carry a live `HaulTrip` and neither
 * carries a hauler's home. */
export interface TripRow { trip: HaulTrip; }

export interface HaulWorkerRow extends TripRow { job: JobAssignment; home: Home; }

/**
 * The four claims §2.6 requires, each derived from LIVE components on every
 * call rather than snapshotted at the top of the tick. That is what makes
 * dispatch a pure function of world state — and it is also what makes a trip
 * dispatched earlier in this same tick visible to the next hauler, without a
 * second same-tick bookkeeping path to keep in step with the first.
 *
 * It follows that any intent a hauler holds has to be reconstructible from its
 * own components: an intent recorded nowhere is not a claim, however firmly a
 * comment says it is.
 */
export interface Claims {
  /** Units of a building's output buffer already spoken for by haulers on
   * their way to it — of BOTH kinds, since a supply hauler loads output on
   * arrival too. */
  output(buildingId: number): number;
  /** Units of input room at a building already promised by supply haulers,
   * so every idle hauler in the colony does not leave for the same empty mill
   * on the same tick. */
  input(buildingId: number): number;
  /** A site's occupancy as a destination lookup must see it: what it
   * physically holds, plus what returning haulers have been promised room
   * for. A trip releases its own reservation (by clearing `destSiteId`)
   * before resolving a new destination, so nothing counts itself twice. */
  heldAt(siteId: number): number;
  /** A site's occupancy counting only what will CERTAINLY be there: physical
   * stock plus loads already in a hauler's HANDS — `heldAt` minus its one
   * intention term. NOT a tidier `heldAt`: the drain needs this quantity and
   * staging room needs the other; `haul-transfer.ts` has the reasoning. */
  inHandAt(siteId: number): number;
  /** A site's stock of one resource, less what fetching haulers have already
   * planned to take out of it. */
  unclaimedAt(siteId: number, resource: ResourceId): number;
  /** Units of ONE resource already walking toward a site, on a trip of any
   * kind — the site-level twin of `input`, and for the identical reason:
   * without it every idle hauler transfers into the same deficit on the same
   * tick. */
  inboundAt(siteId: number, resource: ResourceId): number;
  /**
   * Units a site is about to LOSE: what fetching haulers have planned to take
   * out of it, across every resource and every kind — `unclaimedAt` with the
   * resource filter removed.
   *
   * The pair is not a duplication. `unclaimedAt` bounds STOCK, which is
   * per-resource; this bounds HEADROOM, which is measured across every
   * resource, so no per-resource claim can bound it. The drain's `drainNeed`
   * is sized against this one, and without it every idle hauler reads the same
   * "below the floor" condition and schedules its own removal for room another
   * hauler is already freeing.
   */
  plannedOutAt(siteId: number): number;
}

/** One pass over the haulers, adding whatever the caller says each one claims.
 * Shared by all four lookups so there is exactly one traversal to get wrong. */
function sumOverTrips(workers: readonly TripRow[], claimOf: (trip: HaulTrip) => number): number {
  let total = 0;
  for (const { trip } of workers) total += claimOf(trip);
  return total;
}

/**
 * `Claims.heldAt`, on its own — a site's occupancy as a destination lookup must
 * see it: what it physically holds, plus what returning haulers have been
 * promised room for.
 *
 * Exported separately from `claimsOf` because the two cancellation paths that
 * bank a load outside `HaulSystem` need exactly this one lookup and none of the
 * other three. Building the whole `Claims` object for them would drag in
 * `capacityOf`, and with it a hauler's home tile and the pending-construction
 * map — none of which any occupancy answer reads.
 */
export function heldAtOf(workers: readonly TripRow[], stockpile: Stockpile): (siteId: number) => number {
  return (siteId) => stockpile.totalAt(siteId) + sumOverTrips(workers, (trip) => reservedAt(trip, siteId));
}

/**
 * What one trip has reserved of one site's room. Two terms, and they are
 * disjoint by construction: `plannedAmount` is zeroed the moment `takeAt`
 * returns a real figure, and `amount` is zero until then.
 *
 * The second term is GATED ON KIND, and the gate is not cosmetic. A transfer
 * reserves its destination at DISPATCH, but spends its whole fetch leg at
 * `phase === 'fetching'` with `amount === 0` — the leg during which that
 * reservation is the only thing standing between two haulers and the same
 * headroom. A supply trip's `destSiteId` is CAMP_SITE_ID for that same leg
 * (`beginTrip` sets it; `turnForHome` resolves it for real only on the
 * return), so an ungated clause would have every supply fetch in the colony
 * reserving room at the camp — harmless, because the camp is unbounded, and
 * therefore exactly the kind of wrong that survives to become load-bearing.
 *
 * A DESTINATION THAT RELOCATES MID-RETURN LEAVES THIS RESERVATION AIMED AT A
 * SITE THE HAULER WILL NOT REACH, and that is bought rather than missed.
 *
 * The window is exact. `handleMoveBuilding` deliberately leaves a `returning`
 * trip alone, so its leg stays frozen on the OLD tile while the site keeps its
 * id and moves. `storeSitesOf` drops the site for the countdown, and
 * ProductionSystem decrements that countdown BEFORE HaulSystem reads it, so a
 * move costing R ticks is off the site list for R - 1 of them — for a one-tile
 * move, none at all (ProductionSystem's worked-through-zero comment). Off the
 * list is not merely unrouted-to: every reader reaches these lookups through
 * the site LIST, so an absent site's occupancy cannot be asked at all. With L
 * ticks left on the return leg when the move tick ends, the reservation is
 * therefore observable for L - (R - 1) ticks — from the site rejoining the list
 * to the hauler reaching the vacated tile and re-resolving. Usually nonempty: a
 * building is carried at half a hauler's walking speed.
 *
 * Every error it causes points ONE WAY — the site reads FULLER than it will be.
 * `heldAt` over-reserves room, which §2.4 buys in as many words: the worst case
 * is a load not dispatched. `inboundAt` over-states what is walking in, so a
 * deficit is under-stated and a staging load is refused for those few ticks —
 * the same safe direction `SiteLedger.deficit`'s own clamp already chose, and
 * no consumer starves for it, since supply serves a building from any site and
 * never consults site demand. `inHandAt` over-states occupancy, so `drainNeed`
 * can fire a drain that would not otherwise exist (47 of 60 against a floor of
 * 12 reads 53 and drains 5). That last one ACTS on the stale intention, and it
 * is still the trade this engine makes: the units are carried to the camp,
 * conserved and still spendable, once — `plannedOutAt` nets the next hauler's
 * answer — where the intention `inHandAt` refuses to count is the one that may
 * bring NOTHING. Staleness here is of address, not of existence.
 *
 * Nothing can read a site EMPTIER: this only ever adds, and only at the one id
 * a trip names. Nothing can lose the load either — `depositArrival` compares
 * the frozen tile, turns the hauler for a live site, and it CARRIES the load
 * there (`a depot that moves mid-return is walked to`, and `a returning hauler
 * re-resolving a moved depot does not count its own reservation`, both in
 * haul-dispatch.test.ts).
 *
 * The fix a reader will reach for — drop a reservation whose frozen leg tile no
 * longer matches the live site — pays for that in the one direction that is not
 * free. A depot moved away and straight back (`does not deposit into a
 * destination that is in transit`) would have this trip's room released
 * mid-leg, promised to another hauler, and then taken from the load it was held
 * for when the tiles match again on arrival: exactly the double-booking the
 * reservation exists to prevent. Over-reserving costs a trip; under-reserving
 * costs the trip already promised.
 */
function reservedAt(trip: HaulTrip, siteId: number): number {
  if (trip.destSiteId !== siteId) return 0;
  if (trip.phase === 'returning') return trip.amount;
  if (trip.kind === 'transfer' && trip.phase === 'fetching') return trip.plannedAmount;
  return 0;
}

export function claimsOf(
  workers: readonly HaulWorkerRow[], stockpile: Stockpile, capacityOf: (row: HaulWorkerRow) => number,
): Claims {
  // ONE traversal expression behind both outgoing claims, asked two different
  // questions: `unclaimedAt` passes a resource filter, `plannedOutAt` passes
  // none. Two hand-written loops with the same phase-and-source predicate is
  // how the pair drifts apart, and they must not — a site's stock and its
  // headroom are drawn down by exactly the same trips.
  const plannedOut = (siteId: number, matches: (trip: HaulTrip) => boolean) => sumOverTrips(workers, (trip) => (
    trip.phase === 'fetching' && trip.sourceSiteId === siteId && matches(trip) ? trip.plannedAmount : 0
  ));
  return {
    output: (buildingId) => {
      let total = 0;
      for (const row of workers) {
        const heading = row.trip.phase === 'fetching' || row.trip.phase === 'outbound';
        if (heading && row.trip.targetId === buildingId) total += capacityOf(row);
      }
      return total;
    },
    input: (buildingId) => sumOverTrips(workers, (trip) => (
      trip.kind === 'supply' && trip.targetId === buildingId
        ? trip.plannedAmount + (trip.phase === 'outbound' ? trip.amount : 0)
        : 0
    )),
    heldAt: heldAtOf(workers, stockpile),
    // `reservedAt` again, its intention clause shut off by the phase test
    // rather than by a second copy of its gate that could drift from it.
    inHandAt: (siteId) => stockpile.totalAt(siteId)
      + sumOverTrips(workers, (trip) => (trip.phase === 'returning' ? reservedAt(trip, siteId) : 0)),
    unclaimedAt: (siteId, resource) => stockpile.getAt(siteId, resource) - plannedOut(siteId, (trip) => trip.resource === resource),
    // `reservedAt` again, narrowed to ONE resource: what is walking toward a
    // site is exactly the per-resource slice of the reservation term `heldAt`
    // already adds to that site's stock. Deliberately the SAME function rather
    // than a second predicate of the same shape, so the two can never disagree
    // about which trips are inbound — and so the kind asymmetry documented
    // there governs here too. It is worth restating in this direction: a
    // RETURNING load lands at `destSiteId` whatever kind of trip carried it,
    // so a collect walking wheat home to a depot genuinely meets that depot's
    // wheat demand and must shrink its deficit. Counting only transfers left
    // an empty depot with a wheat demand of 12 and a six-unit collect already
    // walking back to it reading a deficit of 12, dispatching two staging
    // transfers on top, and landing at 18.
    inboundAt: (siteId, resource) => sumOverTrips(workers, (trip) => (
      trip.resource === resource ? reservedAt(trip, siteId) : 0
    )),
    plannedOutAt: (siteId) => plannedOut(siteId, () => true),
  };
}
