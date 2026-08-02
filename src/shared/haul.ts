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

/**
 * Where a hauler is in its round trip. Lives here, in shared law, rather than
 * on the engine's `HaulTrip` component, because the snapshot publishes it and
 * `src/shared/**` may not import the engine.
 */
export type HaulPhase = 'idle' | 'outbound' | 'returning';

/**
 * How far along a leg a hauler is, as 0 (just left) to 1 (arrived).
 *
 * The renderer needs this because the simulated trip has a duration and a
 * fixed-speed walk animation does not: at 1x the sim moves a hauler 4 tiles/s
 * while the dot managed 1.875, so the dot was still crossing open ground when
 * the trip flipped legs and it turned round without ever reaching the building
 * (OBS-4-09). Deriving the dot's position from the trip's own remaining ticks
 * keeps the two clocks identical at every game speed by construction.
 *
 * `totalTicks` is the leg's full length — recomputed from the building's tile
 * rather than stored, since `haulTicks` is deterministic. A leg that somehow
 * reports more ticks left than its length clamps to 0 rather than running
 * backwards past the camp.
 */
export function legProgress(ticksLeft: number, totalTicks: number): number {
  if (totalTicks <= 0) return 1;
  return Math.min(1, Math.max(0, (totalTicks - ticksLeft) / totalTicks));
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
