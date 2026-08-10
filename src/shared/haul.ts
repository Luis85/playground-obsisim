import { ticksForDistance, type TileRef } from './placement';
import type { ResourceId } from './content-types';

/**
 * The colony's store: where every hauled good ends up, and the point every
 * haul distance is measured from. The app layer draws the camp tent at
 * tile-space (2, 0.75), so this is that tent's tile — the cost the simulation
 * charges and the walk the player watches describe the same journey.
 */
export const CAMP_TILE: TileRef = { col: 2, row: 0 };

/**
 * The camp's id in the `StoreSite` list. It is always present and always
 * unbounded (see `StoreSite.capacity`), so it is the guaranteed fallback
 * destination `nearestSiteWithRoom` can never fail to find.
 */
export const CAMP_SITE_ID = 0;

/**
 * A place goods can be stored: the camp, or a `storehouse`. `capacity` is
 * null for the camp (unbounded) and a finite unit count for everything else
 * — the distinction `nearestSiteWithRoom` uses to decide whether a site can
 * even be asked whether it has room.
 */
export interface StoreSite {
  id: number;
  col: number;
  row: number;
  capacity: number | null;
}

/**
 * Straight-line tiles from the camp store to a tile. Euclidean, not Manhattan:
 * the renderer walks its dots in a straight line, and a cost model that
 * disagreed with the drawn motion would be unexplainable to the player.
 */
export function haulDistance(col: number, row: number): number {
  return Math.hypot(col - CAMP_TILE.col, row - CAMP_TILE.row);
}

/**
 * One-way trip length in ticks between two arbitrary tiles — the
 * generalisation `haulTicks` is now defined through. `tilesPerTick` arrives
 * as an argument rather than an import: this module lives in src/shared/,
 * which may import nothing outside itself, while the tunable rate belongs to
 * engine content (BALANCE).
 *
 * Never zero — two adjacent tiles still cost a tick, so no leg of a trip is
 * ever free and no hauler can complete a round trip inside one tick.
 */
export function haulTicksBetween(from: TileRef, to: TileRef, tilesPerTick: number): number {
  return ticksForDistance(Math.hypot(to.col - from.col, to.row - from.row), tilesPerTick);
}

/**
 * One-way trip length in ticks between the camp and a tile. Kept
 * camp-relative on purpose: `haulerCapacity` and the commute charge were
 * measured against this exact function in increment 6, and a test pins
 * `haulTicksBetween(CAMP_TILE, ...)` to this so a future edit to one cannot
 * silently re-price every existing trip.
 */
export function haulTicks(col: number, row: number, tilesPerTick: number): number {
  return haulTicksBetween(CAMP_TILE, { col, row }, tilesPerTick);
}

/**
 * Where a hauler is in its round trip. Lives here, in shared law, rather than
 * on the engine's `HaulTrip` component, because the snapshot publishes it and
 * `src/shared/**` may not import the engine.
 *
 * `'fetching'` is a hauler walking empty to the site it will load a supply
 * trip from — the leg a `collect` trip never has, because collect always
 * starts at a building's own output buffer.
 */
export type HaulPhase = 'idle' | 'outbound' | 'returning' | 'fetching';

/** The two jobs a hauler can be doing: bringing raw goods in, or moving
 * stored goods out to a building that needs them. */
export type HaulKind = 'collect' | 'supply';

/**
 * How far along a leg a hauler is, as 0 (just left) to 1 (arrived).
 *
 * Module-private: the only way to ask this question is `legPositionOf` below,
 * because every caller that asks it wants a position and the ratio on its own
 * is what let a second copy of the two multiplications appear. It was exported
 * while `haulSpot` kept a third copy in pixel space; that copy is gone.
 *
 * The ratio exists at all because the simulated trip has a duration and a
 * fixed-speed walk animation does not: at 1x the sim moves a hauler 4 tiles/s
 * while the dot managed 1.875, so the dot was still crossing open ground when
 * the trip flipped legs and it turned round without ever reaching the building
 * (OBS-4-09). Deriving the dot's position from the trip's own remaining ticks
 * keeps the two clocks identical at every game speed by construction.
 *
 * `totalTicks` is the leg's full length. Callers must pass what `haulTicks`
 * actually charged when the leg began (`HaulTrip.legTicks`, published on the
 * snapshot as `haulLegTicks`), never a fresh `haulTicks` recomputed from the
 * building's CURRENT tile: a returning trip is deliberately left alone when
 * its building moves, so a recomputed total can disagree with the leg the sim
 * is actually running (OBS-5-01 — the "somehow" below, now named). A leg that
 * reports more ticks left than its length clamps to 0 rather than running
 * backwards past the camp.
 */
function legProgress(ticksLeft: number, totalTicks: number): number {
  if (totalTicks <= 0) return 1;
  return Math.min(1, Math.max(0, (totalTicks - ticksLeft) / totalTicks));
}

/**
 * The frozen facts about the leg a hauler is currently walking, plus the ticks
 * it has left of it. Named for the fields `HaulTrip` already carries so a live
 * component satisfies it structurally — this module may not import the engine,
 * and a parallel shape the engine had to convert into would be a second place
 * for the endpoint pairing to go wrong.
 */
export interface RunningLeg {
  ticksLeft: number;
  legTicks: number;
  legFromCol: number;
  legFromRow: number;
  legToCol: number;
  legToRow: number;
}

/**
 * Where a hauler physically stands right now, in tiles: `legProgress` of the
 * way along the leg it is walking.
 *
 * Here rather than on `HaulTrip` because it is the same law `legProgress`
 * is, and separating the ratio from the two multiplications that consume it is
 * what let a SECOND copy of those multiplications appear beside the first —
 * and then a THIRD, in pixel space, inside `haulSpot` (src/app/world/layout.ts),
 * which is where the duplication was actually closed. Every caller that has to
 * answer "where is this hauler" — a cancellation choosing its resting tile, a
 * move re-pricing an outbound leg from where the walk actually got to, the
 * canvas drawing the dot — must answer it identically, or the ticks charged and
 * the line the player watches describe different journeys.
 *
 * A fractional tile is the correct answer and not a rounding bug: the result is
 * only ever a distance origin or a drawing anchor, never a tile lookup.
 */
export function legPositionOf(leg: RunningLeg): TileRef {
  const travelled = legProgress(leg.ticksLeft, leg.legTicks);
  return {
    col: leg.legFromCol + (leg.legToCol - leg.legFromCol) * travelled,
    row: leg.legFromRow + (leg.legToRow - leg.legFromRow) * travelled,
  };
}

/** What one building offers a hauler right now. */
export interface HaulCandidate {
  buildingId: number;
  col: number;
  row: number;
  /** Units sitting in the building's output buffer. */
  buffered: number;
  /** Units already spoken for by haulers currently outbound to it. */
  claimed: number;
}

/**
 * Units a newly dispatched hauler could still pick up. Claims are what let
 * several haulers serve one badly-backed-up building without all converging
 * on the same single unit.
 */
export function claimableAt(candidate: HaulCandidate): number {
  return candidate.buffered - candidate.claimed;
}

/**
 * THE job-selection order, so the engine's authoritative pick and any UI that
 * previews haul pressure can never disagree: clear the worst backlog first,
 * then prefer the cheapest round trip, then take the lowest id. The final
 * tie-break is what makes selection independent of entity iteration order —
 * without it, the same world could dispatch differently across runs.
 */
export function compareHaulCandidates(a: HaulCandidate, b: HaulCandidate): number {
  const byBacklog = claimableAt(b) - claimableAt(a);
  if (byBacklog !== 0) return byBacklog;
  const byDistance = haulDistance(a.col, a.row) - haulDistance(b.col, b.row);
  if (byDistance !== 0) return byDistance;
  return a.buildingId - b.buildingId;
}

/** The building a hauler should serve next, or null when nothing is waiting. */
export function nextHaulTarget(candidates: readonly HaulCandidate[]): HaulCandidate | null {
  let best: HaulCandidate | null = null;
  for (const candidate of candidates) {
    if (claimableAt(candidate) <= 0) continue;
    if (best === null || compareHaulCandidates(candidate, best) < 0) best = candidate;
  }
  return best;
}

/**
 * Distance from an arbitrary tile to a site, then site id — the same
 * "distance, then id" order `compareHaulCandidates` ends on, and for the
 * same reason: the answer must never depend on array order.
 */
function closer(a: StoreSite, b: StoreSite, col: number, row: number): boolean {
  const da = Math.hypot(a.col - col, a.row - row);
  const db = Math.hypot(b.col - col, b.row - row);
  if (da !== db) return da < db;
  return a.id < b.id;
}

/** The site actually closest to a tile, ignoring capacity entirely. Null only
 * when `sites` is empty — every real call site always includes the camp. */
export function nearestSite(col: number, row: number, sites: readonly StoreSite[]): StoreSite | null {
  let best: StoreSite | null = null;
  for (const site of sites) {
    if (best === null || closer(site, best, col, row)) best = site;
  }
  return best;
}

/**
 * The closest site that can actually take a load of `amount` units, or null
 * only if `sites` omits the camp (which never happens: the camp's capacity
 * is unbounded, so it is always a legal destination).
 *
 * `heldAt` rather than a `Stockpile`: `src/shared/**` imports nothing outside
 * itself, and a site's current occupancy lives in engine state.
 */
export function nearestSiteWithRoom(
  col: number, row: number, sites: readonly StoreSite[], heldAt: (siteId: number) => number, amount: number,
): StoreSite | null {
  let best: StoreSite | null = null;
  for (const site of sites) {
    // The WHOLE load must fit: `>= capacity` skips only sites already full and
    // lets a 12-unit load pick a depot holding 55 of 60.
    if (site.capacity !== null && heldAt(site.id) + amount > site.capacity) continue;
    if (best === null || closer(site, best, col, row)) best = site;
  }
  return best;
}

/** Every site holding unclaimed stock of some resource — the pool §2.6's
 * supply dispatch draws candidates from. `unclaimedAt` closes over the
 * resource, the same way `heldAt` closes over nothing but the site. */
export function sitesHolding(
  sites: readonly StoreSite[], unclaimedAt: (siteId: number) => number,
): StoreSite[] {
  return sites.filter((site) => unclaimedAt(site.id) > 0);
}

/**
 * What one building could be supplied with, from one site, right now. A
 * candidate is a building-SOURCE pair rather than just a building: a
 * building suppliable from both the camp and a depot is two candidates. The
 * tile fields are named for the two ends of a route rather than a bare
 * `col`/`row`, because on a two-ended thing that would read as the
 * building's to everyone including the tests.
 */
export interface SupplyCandidate {
  buildingId: number;
  buildingCol: number;
  buildingRow: number;
  siteId: number;
  siteCol: number;
  siteRow: number;
  resource: ResourceId;
  movable: number;
  /**
   * The building is STOPPED: nothing in hand, nothing in progress, nothing on
   * the way. It holds none of `resource`, has no batch running, and has no
   * supply delivery already claimed toward it — not merely running low, not
   * merely mid-batch with a tray its own crew has just emptied, and not one
   * already being served by a hauler dispatched moments ago.
   *
   * About the resource THIS candidate would deliver rather than the in-tray as
   * a whole, so two candidates for the same building can never rank differently
   * for a reason no player could see.
   */
  starving: boolean;
}

/** Hauler-to-site-to-building: the full trip a supply candidate costs,
 * measured from wherever the hauler currently is rather than the camp. */
function supplyRouteDistance(candidate: SupplyCandidate, from: TileRef): number {
  const toSite = Math.hypot(candidate.siteCol - from.col, candidate.siteRow - from.row);
  const toBuilding = Math.hypot(candidate.buildingCol - candidate.siteCol, candidate.buildingRow - candidate.siteRow);
  return toSite + toBuilding;
}

/**
 * THE supply job-selection order: serve a STOPPED building before a running
 * one, then clear the most movable stock, then prefer the cheapest whole route
 * (hauler to source to building — not the building's distance alone, or two
 * candidates for the same building from different sites could not be told
 * apart), then lowest building id, then lowest site id. The final tie-break is
 * what makes selection independent of candidate order, the same guarantee
 * `compareHaulCandidates` gives collect.
 *
 * `starving` is a FLOOR, not a rival priority, and the distinction is the whole
 * reason it is safe to put at the front (OBS-7-01). The condition it ranks on
 * is extinguished the moment the building is served — on the DISPATCH tick,
 * not on the arrival several legs later — and stays extinguished for as long as
 * the building has a load coming or work to do. So a distant stopped building
 * gets one trip ahead of the queue and cannot pin a hauler to itself
 * indefinitely, which a standing "rank on need" or "rank on distance from full"
 * term could, because those stay true while the building is being served.
 *
 * That guarantee is the engine's, not this comparator's: all three clauses of
 * `starving` are load-bearing for it, and each fails it differently if dropped.
 * Two are physical (nothing in hand, nothing in progress) and would not be
 * extinguished until a load LANDED; the third is the claim already standing
 * against the building, which is what makes "the moment it is served" true on
 * the tick the promotion is spent. See `supplyCandidates` in
 * src/engine/systems/haul-dispatch.ts, where the three are derived.
 *
 * What it fixes is a strict priority with no floor: while the nearer hungry
 * building could still take a load it won every comparison and took every trip,
 * so a bakery behind a mill made zero bread in 600 ticks. Nothing below this
 * term moved — among equally starving (or equally fed) candidates the previous
 * order decides in full, which is what stops the floor becoming the opposite
 * failure, a hauler crossing the map past a building it could have served on
 * the way.
 */
export function compareSupplyCandidates(a: SupplyCandidate, b: SupplyCandidate, from: TileRef): number {
  const byStarving = Number(b.starving) - Number(a.starving);
  if (byStarving !== 0) return byStarving;
  const byMovable = b.movable - a.movable;
  if (byMovable !== 0) return byMovable;
  const byRoute = supplyRouteDistance(a, from) - supplyRouteDistance(b, from);
  if (byRoute !== 0) return byRoute;
  const byBuilding = a.buildingId - b.buildingId;
  if (byBuilding !== 0) return byBuilding;
  return a.siteId - b.siteId;
}

/** The building-source pair a hauler should supply next, or null when
 * nothing is movable. */
export function nextSupplyTarget(
  candidates: readonly SupplyCandidate[], from: TileRef,
): SupplyCandidate | null {
  let best: SupplyCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.movable <= 0) continue;
    if (best === null || compareSupplyCandidates(candidate, best, from) < 0) best = candidate;
  }
  return best;
}
