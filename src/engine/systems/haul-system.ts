import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { HaulCandidate } from '../../shared/haul';
import { haulDistance, haulTicks, nextHaulTarget } from '../../shared/haul';
import type { TileRef } from '../../shared/placement';
import { commuteFactor } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position } from '../components';
import { Stockpile } from '../resources';

interface BuildingRow { building: Building; position: Position; buffer: OutputBuffer; }
interface WorkerRow { job: JobAssignment; trip: HaulTrip; home: Home; }

/**
 * What THIS hauler carries per trip. A hauler's output is goods moved, so
 * their commute costs them the same fraction of it that a worker's costs them
 * of production — ProductionSystem never sees a hauler (no buildingId), so
 * without this their commute would be decorative. Rounded, floored at 1: a
 * hauler who shows up carries something.
 *
 * The distance is `haulDistance`, the camp-store measure the rest of logistics
 * already uses, because a hauler's round trip both starts and ends there — the
 * same tile buildEntitySections measures a hauler's published commute to.
 *
 * Every site that reserves or takes capacity must call this — buildClaimMap,
 * the same-tick dispatch claim, and the load. A reservation computed from the
 * flat BALANCE.haulCarryCapacity while the load uses this would claim 6 for a
 * hauler taking 3, leaving goods unclaimed and other haulers sent away: a
 * scheduling penalty stacked on top of the commute, which is not what this
 * models.
 */
export function haulerCapacity(homeTile: TileRef | null): number {
  const tiles = homeTile === null ? null : haulDistance(homeTile.col, homeTile.row);
  const factor = commuteFactor(tiles, BALANCE.commute, BALANCE.homelessFactor);
  return Math.max(1, Math.round(BALANCE.haulCarryCapacity * factor));
}

/** Where a hauler sleeps, or null when nowhere — the input haulerCapacity
 * charges. Resolved against the same building rows the haul targets come from,
 * so a house is just another row here. */
function homeTileOf(homeId: number | null, byId: ReadonlyMap<number, BuildingRow>): TileRef | null {
  const row = homeId === null ? undefined : byId.get(homeId);
  return row === undefined ? null : row.position;
}

/**
 * What haulers already on their way will take, keyed by target building id.
 * Without this a second hauler would be dispatched at the same single unit
 * the first is already fetching, and both would arrive to an empty buffer.
 */
function buildClaimMap(workerRows: readonly WorkerRow[], byId: ReadonlyMap<number, BuildingRow>): Map<number, number> {
  const claimed = new Map<number, number>();
  for (const { job, trip, home } of workerRows) {
    if (!job.hauling || trip.phase !== 'outbound' || trip.targetId === null) continue;
    claimed.set(trip.targetId, (claimed.get(trip.targetId) ?? 0) + haulerCapacity(homeTileOf(home.buildingId, byId)));
  }
  return claimed;
}

/** One haul candidate per building this tick: buffered and claimed amounts
 * snapshotted from live components, the shape nextHaulTarget picks over. */
function buildCandidates(buildingRows: readonly BuildingRow[], claimed: ReadonlyMap<number, number>): HaulCandidate[] {
  return buildingRows.map(({ building, position, buffer }) => ({
    buildingId: building.id,
    col: position.col,
    row: position.row,
    buffered: buffer.total(),
    claimed: claimed.get(building.id) ?? 0,
  }));
}

/**
 * Haulers carry finished goods from the building that made them to the camp
 * store. Runs after ProductionSystem (goods produced this tick are claimable
 * immediately) and before StatsSystem (a deposit counts in this tick's flows).
 *
 * Every decision here is a pure function of world state: claims are recomputed
 * from live components each tick rather than remembered, and the tie-break
 * chain in nextHaulTarget ends at the building id, so entity iteration order
 * cannot change which building a hauler serves.
 */
export const HaulSystem = () => createSystem({
  stockpile: WriteResource(Stockpile),
  buildings: queryComponents({
    building: Read(Building), position: Read(Position), buffer: Write(OutputBuffer),
  }),
  workers: queryComponents({ job: Read(JobAssignment), trip: Write(HaulTrip), home: Read(Home) }),
})
  .withName('HaulSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const buildingRows = [...buildings.iter()];
    const byId = new Map(buildingRows.map((row) => [row.building.id, row]));
    const workerRows = [...workers.iter()];

    const claimed = buildClaimMap(workerRows, byId);
    const candidates = buildCandidates(buildingRows, claimed);

    const dispatch = (trip: HaulTrip, capacity: number): void => {
      const target = nextHaulTarget(candidates);
      if (target === null) return;
      trip.phase = 'outbound';
      trip.targetId = target.buildingId;
      const ticks = haulTicks(target.col, target.row, BALANCE.haulTilesPerTick);
      trip.ticksLeft = ticks;
      trip.legTicks = ticks;
      trip.resource = null;
      trip.amount = 0;
      // Mutating the candidate makes the claim visible to the next idle hauler
      // dispatched in this same tick, not only to the next tick's recompute.
      target.claimed += capacity;
    };

    const load = (trip: HaulTrip, capacity: number): void => {
      const row = trip.targetId === null ? undefined : byId.get(trip.targetId);
      // The building can be gone (demolished while this hauler walked): the trip
      // simply ends, which is cheaper than a special cancellation path.
      if (row === undefined) {
        trip.reset();
        return;
      }
      const resource = row.buffer.fullestResource(RESOURCE_IDS);
      const amount = resource === null ? 0 : row.buffer.take(resource, capacity);
      trip.resource = amount > 0 ? resource : null;
      trip.amount = amount;
      trip.phase = 'returning';
      // Recomputed from the building's CURRENT tile, so a building moved while
      // the hauler was outbound charges the walk home it actually walks. Frozen
      // into legTicks/pickupCol/pickupRow here because this is the one moment
      // the return leg's origin is unambiguous: handleMoveBuilding deliberately
      // never retargets a returning trip, so nothing after this point may treat
      // the building's tile as this leg's start again (OBS-5-01).
      const ticks = haulTicks(row.position.col, row.position.row, BALANCE.haulTilesPerTick);
      trip.ticksLeft = ticks;
      trip.legTicks = ticks;
      trip.pickupCol = row.position.col;
      trip.pickupRow = row.position.row;
    };

    const deposit = (trip: HaulTrip): void => {
      if (trip.resource !== null && trip.amount > 0) stockpile.add(trip.resource, trip.amount);
      trip.reset();
    };

    for (const { job, trip, home } of workerRows) {
      if (!job.hauling) continue;
      // Read once per hauler per tick and handed to both the claim and the
      // load, so the two can never be computed from different numbers.
      const capacity = haulerCapacity(homeTileOf(home.buildingId, byId));
      if (trip.phase === 'idle') {
        dispatch(trip, capacity);
        continue; // a trip dispatched this tick starts walking next tick
      }
      trip.ticksLeft -= 1;
      if (trip.ticksLeft > 0) continue;
      if (trip.phase === 'outbound') load(trip, capacity);
      else deposit(trip);
    }
  })
  .build();
