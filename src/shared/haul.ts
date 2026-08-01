import type { TileRef } from './placement';

/**
 * The colony's store: where every hauled good ends up, and the point every
 * haul distance is measured from. The app layer draws the camp tent at
 * tile-space (2, 0.75), so this is that tent's tile — the cost the simulation
 * charges and the walk the player watches describe the same journey.
 */
export const CAMP_TILE: TileRef = { col: 2, row: 0 };

/**
 * Straight-line tiles from the camp store to a tile. Euclidean, not Manhattan:
 * the renderer walks its dots in a straight line, and a cost model that
 * disagreed with the drawn motion would be unexplainable to the player.
 */
export function haulDistance(col: number, row: number): number {
  return Math.hypot(col - CAMP_TILE.col, row - CAMP_TILE.row);
}

/**
 * One-way trip length in ticks. `tilesPerTick` arrives as an argument rather
 * than an import: this module lives in src/shared/, which may import nothing
 * outside itself, while the tunable rate belongs to engine content (BALANCE).
 *
 * Never zero — a building beside the camp still costs a tick, so no placement
 * is ever free and no hauler can complete a round trip inside one tick.
 */
export function haulTicks(col: number, row: number, tilesPerTick: number): number {
  return Math.max(1, Math.ceil(haulDistance(col, row) / tilesPerTick));
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
