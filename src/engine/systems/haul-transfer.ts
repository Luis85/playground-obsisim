import type { ResourceId } from '../../shared/content-types';
import type { DemandSource, StoreSite } from '../../shared/haul';
import { CAMP_SITE_ID, siteDemandOf } from '../../shared/haul';
import { isRelocating, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import type { Claims } from './haul-claims';
import type { HaulBuildingRow, StaffedSet } from './haul-dispatch';

/**
 * Store-to-store transfer: the candidates, and the order they are ranked in.
 *
 * Split out of `haul-dispatch.ts` rather than added to it because that file is
 * at its useful size already and this is the largest single addition in the
 * increment — the claims and `chooseJob` stay there, where the other two kinds
 * of work are decided. Nothing here reads a component that dispatch does not
 * already have in hand.
 */

/**
 * One legal move of goods from one store site to another, sized and priced.
 * Both ends carry their tile, for the reason `SupplyCandidate` does: the
 * ordering ranks on the whole hauler → source → destination route, which is
 * not expressible from ids.
 */
export interface TransferCandidate {
  sourceSiteId: number;
  sourceCol: number;
  sourceRow: number;
  destSiteId: number;
  destCol: number;
  destRow: number;
  resource: ResourceId;
  movable: number;
  /** Which of §2.4's two classes this is: topping a site up toward what the
   * buildings around it eat (`true`), or freeing a bounded site's exhausted
   * headroom (`false`). Ranked on, and recorded on the trip for §4.2 —
   * a depot → camp move is legitimately either class, so it cannot be
   * reconstructed afterwards. */
  staging: boolean;
}

/**
 * The buildings a site's demand is derived from: staffed, not relocating, and
 * actually consuming something.
 *
 * Both exclusions are ENGINE conditions — `StaffedSet` and `Relocation` — and
 * filtering here rather than inside `siteDemandOf` is what keeps that law free
 * of them, exactly as `supplyCandidates` filters on `staffed` before it asks
 * `needOf` anything. Goods staged for a building nobody works are goods parked
 * where nothing will ever eat them.
 */
function demandSourcesOf(buildings: readonly HaulBuildingRow[], staffed: StaffedSet): DemandSource[] {
  const sources: DemandSource[] = [];
  for (const row of buildings) {
    if (!staffed.has(row.building.id) || isRelocating(row.relocation.ticksLeft)) continue;
    const { recipe } = BUILDINGS[row.building.defId];
    const inputs = recipe === null ? [] : (Object.keys(recipe.inputs) as ResourceId[]);
    if (inputs.length === 0) continue;
    sources.push({ col: row.position.col, row: row.position.row, inputs });
  }
  return sources;
}

/**
 * Per-site, per-resource demand — `siteDemandOf` with this engine's two
 * constants wired in, and the ONE place that wiring happens.
 */
export function siteDemandFrom(
  sites: readonly StoreSite[], buildings: readonly HaulBuildingRow[], staffed: StaffedSet,
): Map<number, Map<ResourceId, number>> {
  return siteDemandOf(sites, demandSourcesOf(buildings, staffed), {
    targetPerSource: BALANCE.siteStagingTarget, reserveFreeSpace: BALANCE.storehouseFreeFloor,
  });
}

/**
 * The four derived quantities every `movable` term is built from, each one
 * reservation-aware and none of them substituting for another (§2.4).
 *
 * The rule this closure exists to make hard to break: dispatch runs many
 * haulers within a single tick, and physical stock does not move until a
 * hauler ARRIVES, several legs later. So a term computed from raw
 * `getAt`/`totalAt` is identical for every hauler dispatched that tick, and the
 * quantity it bounds is spent as many times as there are idle haulers. Three
 * drafts of §2.4 shipped that bug in three different terms, each time because
 * a neighbouring term WAS reservation-aware and looked like it composed. It
 * does not: a claim on one quantity bounds that quantity and no other. The
 * test to apply to anything added here — if ten idle haulers were dispatched
 * on the same tick, would this term have stopped the tenth?
 */
interface SiteLedger {
  /** Claimed-net stock above local demand: what this site can spare. */
  surplus(siteId: number, resource: ResourceId): number;
  /** Demand not met by claimed-net stock or by transfers already walking in. */
  deficit(siteId: number, resource: ResourceId): number;
  /** Room a staging load may take: total occupancy, reservations included,
   * measured against the capacity LESS the free floor. Unbounded at the camp,
   * which keeps no floor. */
  room(site: StoreSite): number;
  /** Units that must leave a bounded site to restore its free floor, net of
   * the removals already scheduled. Both the drain's trigger and its cap — the
   * two cannot be separated, because occupancy does not fall until a fetching
   * hauler arrives, so a bare "below the floor" trigger schedules the whole
   * site for removal the moment several haulers are idle at once. */
  drainNeed(site: StoreSite): number;
}

function ledgerOf(claims: Claims, demand: ReadonlyMap<number, ReadonlyMap<ResourceId, number>>): SiteLedger {
  const demandFor = (siteId: number, resource: ResourceId) => demand.get(siteId)?.get(resource) ?? 0;
  // `occupancy` and `room` are DIFFERENT QUANTITIES, and the two expressions
  // below must not be tidied into one (§2.4).
  //
  // `room` asks how full a site is RIGHT NOW and counts every intention aimed
  // at it — that is what `heldAt`'s fetching-transfer term is for, and without
  // it two staging transfers dispatched on the same tick book the same headroom
  // and the second one's overflow is forwarded to the camp on arrival. Over-
  // reserving room costs nothing: the worst case is a load not dispatched.
  //
  // `occupancy` asks what will CERTAINLY be there, and may NOT count an
  // intention, because acting on one removes REAL goods. A fetching transfer
  // can bring zero: `takeAt` returns what is actually at the source, which
  // `Stockpile.pay` may have spent out from under the claim (camp-first, for a
  // build or a meal) or a demolition removed. A depot physically holding 42
  // with a 6-unit fetch aimed at it and a 6-unit collect returning to it reads
  // 54 under `heldAt` — free space 6 against a floor of 12 — and a 6-unit drain
  // goes out; if the fetch then takes nothing, the collect leaves the depot at
  // 48, exactly its ceiling, and the drain has removed six units that never
  // needed to move. Hence `inHandAt`: stock, plus loads already in a hauler's
  // hands, and no intentions.
  //
  // `plannedOutAt` is still netted out, and is not the same kind of term: a
  // scheduled removal is this rule's own doing rather than a guess about
  // another hauler's, and without it every idle hauler schedules the whole site
  // for removal on one tick.
  const occupancy = (site: StoreSite) => claims.inHandAt(site.id) - claims.plannedOutAt(site.id);
  return {
    surplus: (siteId, resource) => Math.max(0, claims.unclaimedAt(siteId, resource) - demandFor(siteId, resource)),
    // The inner `Math.max(0, ...)` is load-bearing: `unclaimedAt` CAN GO
    // NEGATIVE. `Stockpile.pay` spends camp-first across EVERY site — a
    // construction cost, a meal — so a site's physical stock can be drawn down
    // below what a fetching hauler has already claimed out of it, while that
    // trip keeps its original `plannedAmount` until it arrives (`takeAt` then
    // returns what is actually there, which is the recovery). Subtracting a
    // negative holding ADDS to the deficit, counting the now-missing stock and
    // the stale outgoing claim as two separate shortages: a site with a demand
    // of 12, stock spent from 6 to 0 and a 6-unit fetch claim against it reads
    // 18, and with idle haulers and a surplus elsewhere that stages a whole
    // extra load above what the site wants.
    //
    // The asymmetry with `surplus` above is deliberate, NOT an oversight to be
    // tidied away later: `surplus` is `max(0, unclaimedAt - demand)`, already 0
    // for any negative `unclaimedAt`, so clamping there would change nothing.
    // The deficit alone is the minimal correct change.
    deficit: (siteId, resource) => Math.max(
      0,
      demandFor(siteId, resource)
        - Math.max(0, claims.unclaimedAt(siteId, resource))
        - claims.inboundAt(siteId, resource),
    ),
    room: (site) => (site.capacity === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, site.capacity - BALANCE.storehouseFreeFloor - claims.heldAt(site.id))),
    drainNeed: (site) => (site.capacity === null
      ? 0
      : Math.max(0, BALANCE.storehouseFreeFloor - (site.capacity - occupancy(site)))),
  };
}

/** The floor a drain exempt from `minTransferUnits` still has to clear: a trip
 * that moves nothing is not a trip. NOT a balance knob — it is the arithmetic
 * fact that `movable` must be positive, which the threshold used to supply for
 * free. See `drainFrom` for when it is used instead of the threshold. */
const ANY_UNITS = 1;

/**
 * The threshold both classes are gated on: do not walk thirteen tiles to move
 * three units. There is deliberately NO "or it is everything the site holds"
 * escape hatch here, unlike `worthMoving` — that clause exists so a lone unit
 * at a depot can still reach a consumer, and staging keeps that route open
 * through the ordinary supply job. A tail too small to STAGE is not stranded;
 * it is left where it is, and supply can still fetch it.
 *
 * That argument is about staging, and `minUnits` is a parameter rather than the
 * constant because it is FALSE of a drain — `drainFrom` is the one caller that
 * lowers it, and the reasoning lives there beside the term it turns on.
 */
function candidateOf(
  source: StoreSite, dest: StoreSite, resource: ResourceId, movable: number, staging: boolean,
  minUnits: number = BALANCE.minTransferUnits,
): TransferCandidate | null {
  if (movable < minUnits) return null;
  return {
    sourceSiteId: source.id, sourceCol: source.col, sourceRow: source.row,
    destSiteId: dest.id, destCol: dest.col, destRow: dest.row,
    resource, movable, staging,
  };
}

/**
 * Staging (pull): every site that could fill part of one site's deficit for
 * one resource.
 *
 * `room` is a separate term from `deficit` and neither implies the other — a
 * deficit is measured in demand for ONE resource, room in total occupancy
 * across every resource. A depot 4 units below its staging ceiling with a
 * 12-unit wheat deficit has room for 4, and sizing the load on the deficit
 * alone would have `bankWithSpill` forward the excess to the camp: a silent
 * teleport of goods that had a hauler standing right there to walk them.
 */
function stageInto(
  dest: StoreSite, resource: ResourceId, sites: readonly StoreSite[],
  ledger: SiteLedger, capacity: number, out: TransferCandidate[],
): void {
  const deficit = ledger.deficit(dest.id, resource);
  // Nothing wanted here, so nothing can be staged here — and every `surplus`
  // below is a fresh traversal of every hauler in the colony, for each of
  // seven resources at each of several sites, rebuilt for each idle hauler.
  // Most (site, resource) pairs have no deficit at all, and this is what keeps
  // the cost proportional to the deficits that exist rather than to the square
  // of the site list. Behaviour is unchanged: a zero deficit makes `movable`
  // zero, which `candidateOf` already refuses.
  if (deficit <= 0) return;
  const room = ledger.room(dest);
  for (const source of sites) {
    // A site moving goods to itself is not a trip, and today it is also not
    // constructible: `deficit > 0` requires demand to exceed the claimed-net
    // holding and `surplus > 0` requires the reverse, so `min(deficit,
    // surplus)` is zero whenever the two ends coincide and no candidate would
    // be emitted anyway. No fixture can reach this line, and it is kept rather
    // than deleted for the reason `buildingArrival` keeps its demolished-target
    // branch: the arithmetic that makes it unreachable belongs to a
    // neighbouring rule, and a future term added to either side would turn a
    // silent self-transfer into a hauler walking a round trip to nowhere.
    if (source.id === dest.id) continue;
    const movable = Math.min(capacity, deficit, ledger.surplus(source.id, resource), room);
    const candidate = candidateOf(source, dest, resource, movable, true);
    if (candidate !== null) out.push(candidate);
  }
}

/**
 * What a drain would take: the largest claimed-net holding above local demand,
 * ties by catalog order — the tie-break `fullestResource` already uses.
 *
 * NOT "the resource this site has no demand for", which reintroduces the exact
 * defect this increment exists to remove: a depot between a farm and a mill
 * reaches 60 wheat against a wheat demand of 12 in ordinary play, because
 * COLLECT banks a producer's output at the nearest site with room and never
 * consults demand at all. Under a no-demand filter that depot has nothing to
 * drain and sits saturated for the rest of the game. Selecting on surplus
 * weakens nothing — surplus already refuses to drain below demand — and a
 * zero-demand resource is simply the case where the whole holding is surplus.
 */
function drainResource(site: StoreSite, ledger: SiteLedger): ResourceId | null {
  let best: ResourceId | null = null;
  let mostSurplus = 0;
  for (const resource of RESOURCE_IDS) {
    const surplus = ledger.surplus(site.id, resource);
    if (surplus > mostSurplus) {
      best = resource;
      mostSurplus = surplus;
    }
  }
  return best;
}

/**
 * Drain (push): bounded → unbounded, and only that. The destination is the
 * camp and only the camp, which is the termination proof rather than a
 * simplification — the camp is unbounded, so it has no free-space floor to
 * breach, so it never pushes, so nothing a drain moves can come back the same
 * way. The only route back is staging, which requires a real consumer's demand
 * and is bounded by consumption.
 *
 * No `roomAt` term, and the absence is a consequence: the destination is
 * always the camp, and the camp always has room.
 */
function drainFrom(
  source: StoreSite, sites: readonly StoreSite[], ledger: SiteLedger, capacity: number, out: TransferCandidate[],
): void {
  // `drainNeed` answers FIRST, and the order is load-bearing now that
  // `chooseJob` asks for drains on every dispatch tick rather than only on an
  // idle one. It is zero for the camp (unbounded) and for every bounded site
  // above its floor, which is almost all of them almost always — two
  // traversals of the hauler list per site, against the seven `surplus` calls
  // `drainResource` would otherwise make before discovering there was nothing
  // to buy. Behaviour is unchanged: a zero `drainNeed` makes `movable` zero,
  // which `candidateOf` already refuses.
  const need = ledger.drainNeed(source);
  if (need <= 0) return;
  const dest = sites.find((site) => site.id === CAMP_SITE_ID);
  const resource = drainResource(source, ledger);
  if (dest === undefined || resource === null) return;
  const surplus = ledger.surplus(source.id, resource);
  const movable = Math.min(capacity, surplus, need);
  // THE DRAIN'S ONE EXEMPTION FROM `minTransferUnits`, and it is an exemption
  // rather than a retune of the constant: the question is which candidates the
  // gate applies to, not what the number is.
  //
  // A drain does not buy a delivery, it buys ROOM. `candidateOf`'s argument
  // above — "a tail too small to move is not stranded, supply can still fetch
  // it" — is staging's escape and is no escape here: by construction this stock
  // sits ABOVE every nearby building's demand, so no supply trip wants it, and
  // no other rule restores the headroom. What a refused drain strands is not
  // the three units; it is the site.
  //
  // THE EXEMPTION IS THE SITE DOING THE BEST IT CAN, and the two clauses below
  // are the two halves of that sentence — both about the SURPLUS, which is the
  // only term of `min(capacity, surplus, need)` that is a property of the site
  // rather than of the hauler or of how far the site has slipped.
  // `surplus < minTransferUnits` says the site cannot offer a full-sized load
  // of even its fullest resource; `surplus < need` says that handing over all
  // of it still would not restore the floor. Together: it is giving everything
  // it can spare, the floor is STILL not restored, and refusing means refusing
  // forever. That is the four-input depot — 15 each of four resources in 60
  // units of capacity against a demand of 12 each, four surpluses of 3, not one
  // of them reaching 4 — saturated for the rest of the game under a flat gate,
  // refusing every short-hop collect deposit, which is increment 7's §4.3
  // defect arriving through a third door.
  //
  // NEITHER OF THE OTHER TWO TERMS EARNS THE EXEMPTION, and each of them CAN
  // bind below the threshold, so dropping either clause is a different rule:
  //
  // - `capacity` is the HAULER's — `haulerCapacity`, not the flat
  //   `BALANCE.haulCarryCapacity` — so a hauler with no bed (`homelessFactor`)
  //   or a long enough commute (`commute.floor`) carries `round(6 x 0.5)` = 3,
  //   below a threshold of 4. BINDING ON IT IS NEVER WHAT CAUSES THE EXEMPTION,
  //   which is the accurate form of the claim: "when capacity binds the
  //   exemption does not fire" is false on TIES. Where capacity is the ONLY
  //   binding term the site can still offer a full-sized load, so it is not a
  //   stuck site — the next hauler with a bed takes it, and the small one makes
  //   no sub-threshold transfer of either class, exactly as it makes no
  //   sub-threshold staging one. Where capacity binds JOINTLY WITH THE SURPLUS
  //   — `min(3, 3, 12)` at the split-surplus depot — the exemption DOES fire,
  //   on the surplus's account and not on capacity's, and the fixture asserts
  //   both halves with the same capacity-3 hauler.
  //
  // - `need` binding means the trip FINISHES the job, so a sub-threshold
  //   `movable` means the site is within three units of its floor: at least
  //   `storehouseFreeFloor - minTransferUnits + 1` = 9 units of HEADROOM, more
  //   than a hauler carries. Headroom, not necessarily free space — `drainNeed`
  //   is netted against `plannedOutAt`, so those nine can be zero free units
  //   with nine already booked out, which is exactly the fourth hauler at the
  //   split-surplus depot. Either way nothing is silting up: the room is there,
  //   or it is on its way out in trips already dispatched. Walking the last one
  //   to three units to the camp is the trivial trip the threshold exists to
  //   refuse, and that refusal cannot become permanent — deposit into the site
  //   and `need` rises past the surplus, at which point the exemption fires.
  const siteDoingItsBest = surplus < BALANCE.minTransferUnits && surplus < need;
  const minUnits = siteDoingItsBest ? ANY_UNITS : BALANCE.minTransferUnits;
  const candidate = candidateOf(source, dest, resource, movable, false, minUnits);
  if (candidate !== null) out.push(candidate);
}

/** Per-site, per-resource demand, computed once per tick and handed to both
 * builders below — the one input either of them needs that is not a claim. */
export type SiteDemand = ReadonlyMap<number, ReadonlyMap<ResourceId, number>>;

/**
 * Every push a site below its free-space floor would make right now (§2.4's
 * second class).
 *
 * Split from the pull half because `chooseJob` asks the two questions at
 * DIFFERENT PRIORITIES and therefore at different frequencies. A drain is
 * offered on every dispatch tick, ahead of collect, so it has to be cheap: it
 * is one `drainNeed` per site — which is zero for the camp and for every
 * bounded site above its floor — and it reaches `drainResource` only for a
 * site that is genuinely saturated. Staging is the expensive half, quadratic
 * in the site list, and it is still asked for only when nothing else is left
 * to do.
 *
 * A site can never be both source and sink for one resource: deficit and
 * surplus come from ONE comparison of its claimed-net holding against its
 * demand, so at most one of them is positive. That is the whole termination
 * argument for the pull half, and the claimed-net part is what makes it true
 * rather than approximately true — compare physical stock against demand and a
 * site's surplus can be over-committed within a single tick until it lands
 * below its own demand, a source that has just made itself a sink.
 */
export function drainCandidates(
  sites: readonly StoreSite[], claims: Claims, demand: SiteDemand, capacity: number,
): TransferCandidate[] {
  const ledger = ledgerOf(claims, demand);
  const candidates: TransferCandidate[] = [];
  for (const source of sites) drainFrom(source, sites, ledger, capacity, candidates);
  return candidates;
}

/** Every pull a site with an unmet demand would make right now (§2.4's first
 * class). The quadratic half, and the one nobody is waiting for. */
export function stagingCandidates(
  sites: readonly StoreSite[], claims: Claims, demand: SiteDemand, capacity: number,
): TransferCandidate[] {
  const ledger = ledgerOf(claims, demand);
  const candidates: TransferCandidate[] = [];
  for (const dest of sites) {
    for (const resource of RESOURCE_IDS) stageInto(dest, resource, sites, ledger, capacity, candidates);
  }
  return candidates;
}

/** Hauler → source → destination: the full trip a transfer costs, measured
 * from wherever the hauler currently is, exactly as `supplyRouteDistance` is. */
function transferRouteDistance(candidate: TransferCandidate, from: TileRef): number {
  const toSource = Math.hypot(candidate.sourceCol - from.col, candidate.sourceRow - from.row);
  const onward = Math.hypot(candidate.destCol - candidate.sourceCol, candidate.destRow - candidate.sourceRow);
  return toSource + onward;
}

/**
 * THE transfer job-selection order: a real consumer's demand before freeing
 * room, then the most movable stock, then the cheapest whole route, then
 * source id, then destination id, then resource by catalog order.
 *
 * The last term is not padding, and this is the only comparator in the
 * codebase that needs it. `needOf` picks ONE resource per building, so a
 * (building, site) pair yields exactly one supply candidate and
 * `compareSupplyCandidates` can safely end at a site id. `transferCandidates`
 * iterates resources: one source and one destination can produce several
 * candidates differing only in WHAT is being moved, and with equal `movable`
 * they tie on class, route, source id and destination id alike. A chain ending
 * at the destination id returns 0 for a real pair of distinct candidates, the
 * winner becomes whichever the builder emitted first, and §2.6's guarantee
 * that selection is independent of candidate order is silently false.
 */
export function compareTransferCandidates(a: TransferCandidate, b: TransferCandidate, from: TileRef): number {
  const byClass = Number(b.staging) - Number(a.staging);
  if (byClass !== 0) return byClass;
  const byMovable = b.movable - a.movable;
  if (byMovable !== 0) return byMovable;
  const byRoute = transferRouteDistance(a, from) - transferRouteDistance(b, from);
  if (byRoute !== 0) return byRoute;
  const bySource = a.sourceSiteId - b.sourceSiteId;
  if (bySource !== 0) return bySource;
  const byDest = a.destSiteId - b.destSiteId;
  if (byDest !== 0) return byDest;
  return RESOURCE_IDS.indexOf(a.resource) - RESOURCE_IDS.indexOf(b.resource);
}

/** The site-to-site move a hauler should make next, or null when nothing is
 * worth moving. */
export function nextTransferTarget(
  candidates: readonly TransferCandidate[], from: TileRef,
): TransferCandidate | null {
  let best: TransferCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.movable <= 0) continue;
    if (best === null || compareTransferCandidates(candidate, best, from) < 0) best = candidate;
  }
  return best;
}
