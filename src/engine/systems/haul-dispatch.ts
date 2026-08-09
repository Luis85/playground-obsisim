import type { ResourceId } from '../../shared/content-types';
import type { HaulCandidate, StoreSite, SupplyCandidate } from '../../shared/haul';
import { CAMP_SITE_ID, haulTicksBetween, nextHaulTarget, nextSupplyTarget, sitesHolding } from '../../shared/haul';
import type { TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import type { HaulKind, HaulPhase } from '../components';
import { Building, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Relocation } from '../components';
import type { Stockpile } from '../resources';

/** The building fields haulage cares about, materialized once per tick by
 * HaulSystem's own query. Declared here rather than there because every
 * function in this file consumes them and the system consumes this file. */
export interface BuildingRow {
  building: Building;
  position: Position;
  buffer: OutputBuffer;
  input: InputBuffer;
  relocation: Relocation;
}

export interface WorkerRow { job: JobAssignment; trip: HaulTrip; home: Home; }

/**
 * Which buildings have at least one colonist assigned — the workplace ids of
 * the whole roster, `null` included and harmlessly ignored.
 *
 * Derived ONCE per tick and passed to both readers, because they must agree:
 * the dispatch filter below decides that an unstaffed building is not a supply
 * target, and `HaulSystem`'s arrival recheck decides that an unstaffed target
 * is not unloaded into. Two verbatim copies of the same expression is exactly
 * how a recheck silently stops matching the filter it is rechecking.
 */
export type StaffedSet = ReadonlySet<number | null>;

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
  /** A site's stock of one resource, less what fetching haulers have already
   * planned to take out of it. */
  unclaimedAt(siteId: number, resource: ResourceId): number;
}

/** One pass over the haulers, adding whatever the caller says each one claims.
 * Shared by all four lookups so there is exactly one traversal to get wrong. */
function sumOverTrips(workers: readonly WorkerRow[], claimOf: (trip: HaulTrip) => number): number {
  let total = 0;
  for (const { trip } of workers) total += claimOf(trip);
  return total;
}

export function claimsOf(
  workers: readonly WorkerRow[], stockpile: Stockpile, capacityOf: (row: WorkerRow) => number,
): Claims {
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
    heldAt: (siteId) => stockpile.totalAt(siteId) + sumOverTrips(workers, (trip) => (
      trip.phase === 'returning' && trip.destSiteId === siteId ? trip.amount : 0
    )),
    unclaimedAt: (siteId, resource) => stockpile.getAt(siteId, resource) - sumOverTrips(workers, (trip) => (
      trip.phase === 'fetching' && trip.sourceSiteId === siteId && trip.resource === resource ? trip.plannedAmount : 0
    )),
  };
}

/** One collect candidate per building: buffered and claimed amounts read from
 * live components, the shape `nextHaulTarget` picks over. Unchanged from
 * increment 4 apart from who counts as a claimant. */
function collectCandidates(buildings: readonly BuildingRow[], claims: Claims): HaulCandidate[] {
  return buildings.map(({ building, position, buffer }) => ({
    buildingId: building.id,
    col: position.col,
    row: position.row,
    buffered: buffer.total(),
    claimed: claims.output(building.id),
  }));
}

/**
 * What one building would take delivery of right now: the input it is
 * proportionally shortest of, and how much of it will still fit once the
 * deliveries already walking toward it have landed. Null when this building
 * is not a supply target at all — no recipe inputs, mid-relocation, or its
 * in-tray is already spoken for.
 */
function needOf(row: BuildingRow, claims: Claims, capacity: number): { resource: ResourceId; room: number } | null {
  const { recipe } = BUILDINGS[row.building.defId];
  if (recipe === null || Object.keys(recipe.inputs).length === 0) return null;
  if (row.relocation.ticksLeft > 0) return null;
  const resource = row.input.shortestOf(recipe, RESOURCE_IDS);
  if (resource === null) return null;
  const room = row.input.room(BALANCE.inputBufferCap) - claims.input(row.building.id);
  return room <= 0 ? null : { resource, room: Math.min(room, capacity) };
}

/**
 * §2.6's delivery threshold: don't walk thirteen tiles to top a building up by
 * one unit — UNLESS that unit is everything the site has of it, because
 * otherwise the threshold strands the tail. Every recipe today consumes one
 * unit per batch, so a depot holding a single flour can feed a bakery but
 * could never produce a candidate, and that unit would sit there for the rest
 * of the game while the ledger and the UI kept counting it.
 */
function worthMoving(movable: number, held: number): boolean {
  return movable > 0 && (movable >= BALANCE.minSupplyUnits || movable >= held);
}

/**
 * Every building-source PAIR that could be supplied right now. The pair is the
 * candidate, not the building: a mill suppliable from both the camp and a
 * depot is two candidates, and the ordering ranks on the whole
 * hauler-to-source-to-building route — neither of which is expressible if a
 * candidate names only its building.
 *
 * Staffing is a condition rather than an optimisation: goods in an InputBuffer
 * are out of the spendable ledger and die with the building, so without it a
 * colony short of adults would watch its stock drain into a mill that cannot
 * use it.
 */
function supplyCandidates(
  buildings: readonly BuildingRow[], sites: readonly StoreSite[], staffed: StaffedSet,
  claims: Claims, capacity: number,
): SupplyCandidate[] {
  const candidates: SupplyCandidate[] = [];
  for (const row of buildings) {
    if (!staffed.has(row.building.id)) continue;
    const need = needOf(row, claims, capacity);
    if (need === null) continue;
    const unclaimedAt = (siteId: number) => claims.unclaimedAt(siteId, need.resource);
    for (const site of sitesHolding(sites, unclaimedAt)) {
      const movable = Math.min(need.room, unclaimedAt(site.id));
      if (!worthMoving(movable, unclaimedAt(site.id))) continue;
      candidates.push({
        buildingId: row.building.id, buildingCol: row.position.col, buildingRow: row.position.row,
        siteId: site.id, siteCol: site.col, siteRow: site.row, resource: need.resource, movable,
      });
    }
  }
  return candidates;
}

/**
 * Begin a leg, freezing everything about it that must survive the walk: its
 * length, and BOTH endpoints. Setting one and leaving the rest at their
 * defaults is the failure the four-field model exists to prevent, so every leg
 * in the engine starts here rather than by assigning the fields by hand.
 */
export function startLeg(trip: HaulTrip, phase: HaulPhase, from: TileRef, to: TileRef): void {
  const ticks = haulTicksBetween(from, to, BALANCE.haulTilesPerTick);
  trip.phase = phase;
  trip.ticksLeft = ticks;
  trip.legTicks = ticks;
  trip.legFromCol = from.col;
  trip.legFromRow = from.row;
  trip.legToCol = to.col;
  trip.legToRow = to.row;
}

/** What every dispatch agrees on, whichever kind of job it is. */
function beginTrip(trip: HaulTrip, kind: HaulKind, buildingId: number): void {
  trip.kind = kind;
  trip.targetId = buildingId;
  trip.amount = 0;
  trip.pickedUp = false;
  trip.destSiteId = CAMP_SITE_ID;
}

function beginSupply(trip: HaulTrip, at: TileRef, target: SupplyCandidate): void {
  beginTrip(trip, 'supply', target.buildingId);
  trip.resource = target.resource;
  trip.sourceSiteId = target.siteId;
  trip.plannedAmount = target.movable;
  startLeg(trip, 'fetching', at, { col: target.siteCol, row: target.siteRow });
}

function beginCollect(trip: HaulTrip, at: TileRef, target: HaulCandidate): void {
  beginTrip(trip, 'collect', target.buildingId);
  trip.resource = null;
  trip.plannedAmount = 0;
  startLeg(trip, 'outbound', at, { col: target.col, row: target.row });
}

/** Everything a dispatch decision reads, gathered once per tick. */
export interface DispatchInputs {
  buildings: readonly BuildingRow[];
  sites: readonly StoreSite[];
  staffed: StaffedSet;
  claims: Claims;
}

/**
 * Give one idle hauler a job, or leave it standing.
 *
 * Supply is offered first: a building waiting on inputs produces NOTHING,
 * while one with a full output buffer has already produced and its goods are
 * safe where they stand. The obvious objection is a deadlock — every hauler
 * supplying, nobody collecting, the ledger drained — and it cannot happen
 * structurally: a supply job requires stock to exist SOMEWHERE in the ledger,
 * and only collection puts it there. As the ledger empties, supply candidates
 * vanish and collection resumes on its own.
 *
 * NOT "stock at the hauler's own site" — haulers have no site. That phrasing
 * is the discarded base model, and this is the one function where it could
 * creep back in: a source is chosen across EVERY site and the trip begins by
 * walking to it.
 */
export function chooseJob(trip: HaulTrip, at: TileRef, inputs: DispatchInputs, capacity: number): void {
  const { buildings, sites, staffed, claims } = inputs;
  const supply = nextSupplyTarget(supplyCandidates(buildings, sites, staffed, claims, capacity), at);
  if (supply !== null) {
    beginSupply(trip, at, supply);
    return;
  }
  const collect = nextHaulTarget(collectCandidates(buildings, claims));
  if (collect !== null) beginCollect(trip, at, collect);
}
