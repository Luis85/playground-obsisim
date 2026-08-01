import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { HaulCandidate } from '../../shared/haul';
import { haulTicks, nextHaulTarget } from '../../shared/haul';
import { BALANCE } from '../content/balance';
import { RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, JobAssignment, OutputBuffer, Position } from '../components';
import { Stockpile } from '../resources';

interface BuildingRow { building: Building; position: Position; buffer: OutputBuffer; }
interface WorkerRow { job: JobAssignment; trip: HaulTrip; }

/**
 * What haulers already on their way will take, keyed by target building id.
 * Without this a second hauler would be dispatched at the same single unit
 * the first is already fetching, and both would arrive to an empty buffer.
 */
function buildClaimMap(workerRows: readonly WorkerRow[]): Map<number, number> {
  const claimed = new Map<number, number>();
  for (const { job, trip } of workerRows) {
    if (!job.hauling || trip.phase !== 'outbound' || trip.targetId === null) continue;
    claimed.set(trip.targetId, (claimed.get(trip.targetId) ?? 0) + BALANCE.haulCarryCapacity);
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
  workers: queryComponents({ job: Read(JobAssignment), trip: Write(HaulTrip) }),
})
  .withName('HaulSystem')
  .withRunFunction(({ stockpile, buildings, workers }) => {
    const buildingRows = [...buildings.iter()];
    const byId = new Map(buildingRows.map((row) => [row.building.id, row]));
    const workerRows = [...workers.iter()];

    const claimed = buildClaimMap(workerRows);
    const candidates = buildCandidates(buildingRows, claimed);

    const dispatch = (trip: HaulTrip): void => {
      const target = nextHaulTarget(candidates);
      if (target === null) return;
      trip.phase = 'outbound';
      trip.targetId = target.buildingId;
      trip.ticksLeft = haulTicks(target.col, target.row, BALANCE.haulTilesPerTick);
      trip.resource = null;
      trip.amount = 0;
      // Mutating the candidate makes the claim visible to the next idle hauler
      // dispatched in this same tick, not only to the next tick's recompute.
      target.claimed += BALANCE.haulCarryCapacity;
    };

    const load = (trip: HaulTrip): void => {
      const row = trip.targetId === null ? undefined : byId.get(trip.targetId);
      // The building can be gone (demolished while this hauler walked): the trip
      // simply ends, which is cheaper than a special cancellation path.
      if (row === undefined) {
        trip.reset();
        return;
      }
      const resource = row.buffer.fullestResource(RESOURCE_IDS);
      const amount = resource === null ? 0 : row.buffer.take(resource, BALANCE.haulCarryCapacity);
      trip.resource = amount > 0 ? resource : null;
      trip.amount = amount;
      trip.phase = 'returning';
      // Recomputed from the building's CURRENT tile, so a building moved while
      // the hauler was outbound charges the walk home it actually walks.
      trip.ticksLeft = haulTicks(row.position.col, row.position.row, BALANCE.haulTilesPerTick);
    };

    const deposit = (trip: HaulTrip): void => {
      if (trip.resource !== null && trip.amount > 0) stockpile.add(trip.resource, trip.amount);
      trip.reset();
    };

    for (const { job, trip } of workerRows) {
      if (!job.hauling) continue;
      if (trip.phase === 'idle') {
        dispatch(trip);
        continue; // a trip dispatched this tick starts walking next tick
      }
      trip.ticksLeft -= 1;
      if (trip.ticksLeft > 0) continue;
      if (trip.phase === 'outbound') load(trip);
      else deposit(trip);
    }
  })
  .build();
