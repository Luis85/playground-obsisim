import type { ResourceId } from '../../shared/content-types';
import { isUnderConstruction } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import type { Claims } from './haul-claims';
import type { HaulBuildingRow, StaffedSet } from './haul-dispatch';

/**
 * WHAT A CONSTRUCTION SITE WANTS, AND WHO MAY FEED IT (spec §2.5).
 *
 * Split out of `haul-dispatch.ts` the same way `haul-claims.ts`,
 * `haul-sites.ts` and `haul-transfer.ts` were, and along the same kind of
 * seam: everything here answers a question about a SITE, and nothing here
 * decides anything. `chooseJob`, the candidate builders and the `begin*`
 * family stay there, where the three kinds of work are decided.
 *
 * Both halves are read by BOTH ENDS OF A SUPPLY LEG — `supplyCandidates`
 * (haul-dispatch.ts) when it sizes a dispatch, and `unload` (haul-system.ts)
 * when the hauler gets there — which is the reason they are one exported rule
 * each rather than a pair of expressions written out at each end. §2.5 of
 * increment 7 has the argument: a recheck that is a second copy of its filter
 * is a recheck that will eventually stop matching it.
 */

/**
 * A SITE's want: its `cost` map, walked by proportional shortfall, taking the
 * first material that still has room NOTHING HAS CLAIMED.
 *
 * CLAIMS ENTER THE RATIO; THEY DO NOT MERELY FILTER THE CANDIDATES, and the
 * difference is the whole reason two materials can walk to one site at once.
 * `InputBuffer.shortestOf` ranks on `held / wanted` — physical amounts alone —
 * so an empty 20-wood/10-plank site reads both materials at 0, the strict `<`
 * hands the tie to whichever comes first in `RESOURCE_IDS`, and wood wins. A
 * hauler claiming 10 wood has DELIVERED nothing, so `held` is still 0, both
 * ratios are still 0, wood still has unclaimed room, and the next hauler picks
 * wood again: the delivery serializes one material at a time, which biases the
 * hauler-count readings §4.1 takes. Ranking on `(held + claimed) / cost` reads
 * that same site at 0.5 wood against 0 planks and sends the second hauler for
 * planks.
 *
 * A LOCAL WALK RATHER THAN AN EDIT TO `shortestOf`, deliberately: that method
 * lives on `InputBuffer` and takes a `RecipeDef`, which a site does not have —
 * its demand is a cost map — and every other caller of it would inherit a
 * claim-awareness none of them asked for.
 *
 * Ties break by `RESOURCE_IDS` order through the same strict `<`, so a site's
 * choice and a recipe's are derived one way and cannot disagree.
 */
export function siteNeedOf(row: HaulBuildingRow, claims: Claims): { resource: ResourceId; room: number } | null {
  const { cost } = BUILDINGS[row.building.defId];
  let best: { resource: ResourceId; room: number } | null = null;
  let bestRatio = Infinity;
  for (const id of RESOURCE_IDS) {
    const wanted = cost[id];
    if (wanted === undefined) continue;
    const claimed = claims.input(row.building.id, id);
    const room = inputRoomOf(row, id) - claimed;
    if (room <= 0) continue;
    const ratio = ((row.input.amounts.get(id) ?? 0) + claimed) / wanted;
    if (ratio < bestRatio) {
      best = { resource: id, room };
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * How much of ONE resource this building can still physically take, before any
 * claim is netted off. Exported because `unload` (haul-system.ts) must ask the
 * identical question on arrival: dispatch sizing and arrival placement are the
 * two ends of one leg, and a second copy of this rule is exactly how an offer
 * of 18 more units meets a tray that will only accept 12 — a livelock rather
 * than a shortfall.
 *
 * A SITE'S ROOM IS ITS COST, not `BALANCE.inputBufferCap`. The cap exists
 * because a producer's in-tray is a buffer against haul latency and a bigger
 * one just parks goods; a site's tray is the BILL, and a mill costs 30 units
 * against a 12-unit cap. Per-resource for the same reason: a site owes 20 wood
 * AND 10 planks, and neither total says anything about the other.
 */
export function inputRoomOf(row: HaulBuildingRow, resource: ResourceId): number {
  if (!isUnderConstruction(row.construction.ticksLeft)) return row.input.room(BALANCE.inputBufferCap);
  const wanted = BUILDINGS[row.building.defId].cost[resource] ?? 0;
  return Math.max(0, wanted - (row.input.amounts.get(resource) ?? 0));
}

/**
 * May a supply load be aimed at this building, and put into it on arrival?
 *
 * ONE DERIVATION, TWO READERS, the same shape `StaffedSet` itself is: dispatch
 * asks it in `supplyCandidates` (haul-dispatch.ts) and arrival asks it in
 * `unload` (haul-system.ts). Exempting only dispatch is worse than exempting
 * neither — haulers walk to a site that refuses the load and the goods walk
 * back — and two verbatim copies of this expression is how the recheck stops
 * matching what it rechecks (§2.5 of increment 7).
 *
 * WHY THE SITE EXEMPTION IS PRINCIPLED, rather than a hole punched in a rule
 * that was in the way: increment 7 §2.6 gates supply on staffing because goods
 * in an `InputBuffer` are out of the spendable ledger and die with the
 * building, so a colony short of adults would otherwise drain its stock into a
 * mill that cannot use it. NEITHER HALF HOLDS FOR A SITE — §2.6 refunds a
 * cancelled site's delivered materials in full (`refundInTrayOf`,
 * demolition.ts), and a site consumes what it is given by COMPLETING rather
 * than by working, so there is no worker for it to be waiting on. A site can
 * also never satisfy the staffing test: Task 2b refuses to assign a worker to
 * one, and a house or storehouse def has `workerSlots: 0` regardless.
 *
 * If a later increment adds a builder role, or takes that refund away, this
 * exemption must be revisited — both of its premises would have moved.
 */
export function acceptsSupply(row: HaulBuildingRow, staffed: StaffedSet): boolean {
  return isUnderConstruction(row.construction.ticksLeft) || staffed.has(row.building.id);
}
