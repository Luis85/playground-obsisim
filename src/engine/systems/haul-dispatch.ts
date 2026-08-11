import type { ResourceId } from '../../shared/content-types';
import type { HaulCandidate, StoreSite, SupplyCandidate } from '../../shared/haul';
import { CAMP_SITE_ID, nextHaulTarget, nextSupplyTarget, sitesHolding } from '../../shared/haul';
import { isRelocating, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import type { HaulKind } from '../components';
import { Building, HaulTrip, Home, InputBuffer, JobAssignment, OutputBuffer, Position, Production, Relocation } from '../components';
import type { PendingChanges, Stockpile } from '../resources';
import { storeSitesOf, type StoreSiteRow } from './haul-sites';
import { nextTransferTarget, transferCandidates, type TransferCandidate } from './haul-transfer';

/**
 * The building fields haulage cares about, materialized once per tick by
 * HaulSystem's own query. Declared here rather than there because every
 * function in this file consumes them and the system consumes this file.
 *
 * `Haul`-prefixed because `command-handlers.ts` exports its own `BuildingRow`
 * and `WorkerRow` — a different shape for a different query — and since Task 8
 * the command handlers import from this module. Two exports of one name across
 * a single API surface is what Fallow reports as `duplicate_exports`; the
 * prefix resolves the collision rather than routing around it.
 */
export interface HaulBuildingRow {
  building: Building;
  position: Position;
  buffer: OutputBuffer;
  input: InputBuffer;
  relocation: Relocation;
  /** Read only for the starvation floor, and unavoidable there: an empty
   * in-tray means nothing on its own, because `payFrom` empties it at batch
   * start. See `supplyCandidates`. */
  production: Production;
}

/** Just the trip. The narrowest row any claim reads, and the one the
 * cancellation paths outside `HaulSystem` can supply: `CommandContext.workers`
 * and `PopulationContext.colonists` both carry a live `HaulTrip` and neither
 * carries a hauler's home. */
export interface TripRow { trip: HaulTrip; }

export interface HaulWorkerRow extends TripRow { job: JobAssignment; home: Home; }

/** The building fields a store site is derived from — a subset of
 * `HaulBuildingRow`, so a command handler can build the site list without
 * materialising the two buffers it has no use for. */
export interface StoreRow { building: Building; position: Position; relocation: Relocation; }

/**
 * The site list, straight from live building rows: the catalog lookup that
 * turns a `storehouse` into a capacity, then `storeSitesOf`'s exclusions.
 *
 * One function rather than the two calls written out at each of the three
 * systems that now need sites — `HaulSystem` to haul against, `CommandSystem`
 * and `PopulationSystem` to bank a cancelled hauler's load into. Capacity is
 * resolved HERE rather than inside `storeSitesOf`, which keeps the site law
 * free of a content dependency.
 */
export function storeSitesFrom(rows: readonly StoreRow[], pending: PendingChanges): StoreSite[] {
  const stores = rows
    .filter((row) => BUILDINGS[row.building.defId].storage > 0)
    .map((row): StoreSiteRow => ({
      id: row.building.id,
      col: row.position.col,
      row: row.position.row,
      capacity: BUILDINGS[row.building.defId].storage,
      relocating: isRelocating(row.relocation.ticksLeft),
    }));
  return storeSitesOf(stores, pending);
}

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

/** One collect candidate per building: buffered and claimed amounts read from
 * live components, the shape `nextHaulTarget` picks over. Unchanged from
 * increment 4 apart from who counts as a claimant. */
function collectCandidates(buildings: readonly HaulBuildingRow[], claims: Claims): HaulCandidate[] {
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
 * proportionally shortest of, how much of it will still fit once the
 * deliveries already walking toward it have landed, and whether a finished
 * batch would actually have somewhere to go. Null when this building is not
 * a supply target at all — no recipe inputs, mid-relocation, or its in-tray
 * is already spoken for.
 *
 * `couldStartBatch` is computed here, alongside `resource` and `room`,
 * because `recipe` is already in hand at this point and the caller (
 * `supplyCandidates`) has no other reason to re-derive it — see the
 * `starving` derivation there for what the field means.
 */
function needOf(
  row: HaulBuildingRow, claimedIn: number, capacity: number,
): { resource: ResourceId; room: number; couldStartBatch: boolean } | null {
  const { recipe } = BUILDINGS[row.building.defId];
  if (recipe === null || Object.keys(recipe.inputs).length === 0) return null;
  if (isRelocating(row.relocation.ticksLeft)) return null;
  const resource = row.input.shortestOf(recipe, RESOURCE_IDS);
  if (resource === null) return null;
  const room = row.input.room(BALANCE.inputBufferCap) - claimedIn;
  if (room <= 0) return null;
  const couldStartBatch = row.buffer.room(BALANCE.outputBufferCap) >= batchOutputUnits(recipe);
  return { resource, room: Math.min(room, capacity), couldStartBatch };
}

/**
 * One of `SupplyCandidate.starving`'s three clauses: this building holds NONE
 * of the resource a candidate would deliver. The other two — no batch running,
 * no delivery already claimed — stay at the call site in `supplyCandidates`,
 * because they read a different component and the claim ledger respectively.
 *
 * Per RESOURCE, not per buffer. Exported for that clause alone, because it
 * cannot be reached through dispatch even in principle: no shipped recipe has
 * two inputs, and `needOf` calls `shortestOf` ONCE, so with resource A at zero
 * the candidate for a well-stocked resource B is never emitted to compare
 * against. Unit-testing an exported rule is the repo's documented escape for
 * exactly this — `cheapestHaulerToRelease` is exported for the same reason —
 * and it matters here because a rule that only becomes wrong the first time a
 * recipe gains a second input is the kind that ships silently.
 */
export function holdsNoneOf(input: InputBuffer, resource: ResourceId): boolean {
  return (input.amounts.get(resource) ?? 0) === 0;
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
  buildings: readonly HaulBuildingRow[], sites: readonly StoreSite[], staffed: StaffedSet,
  claims: Claims, capacity: number,
): SupplyCandidate[] {
  const candidates: SupplyCandidate[] = [];
  for (const row of buildings) {
    if (!staffed.has(row.building.id)) continue;
    // Computed once per building rather than once inside `needOf` and again at
    // `starving` below: `chooseJob` rebuilds this whole candidate list per
    // idle hauler, so a second traversal here would be O(haulers² x
    // buildings) instead of O(haulers x buildings).
    const claimedIn = claims.input(row.building.id);
    const need = needOf(row, claimedIn, capacity);
    if (need === null) continue;
    const unclaimedAt = (siteId: number) => claims.unclaimedAt(siteId, need.resource);
    // Nothing in hand, nothing in progress, nothing on the way, and a batch
    // that would actually have somewhere to go. Derived once per BUILDING
    // rather than per site: it is a fact about the building, so every
    // candidate for it must carry the same answer.
    //
    // This is ONE question, not four independent ones: would a load land here
    // and IMMEDIATELY make `startBatch` (production-system.ts) start a batch?
    // Three of these four clauses are exactly `startBatch`'s own early
    // returns, in the order it checks them — batch already active, no room
    // for the batch's output, inputs absent — and the fourth (`claims.input`)
    // is the reservation, because `startBatch` cannot see a hauler that has
    // not arrived yet. Anything `startBatch` checks belongs here BY
    // CONSTRUCTION; anything it does not check does not. This floor has now
    // been corrected three times because each draft asked its own
    // approximation of `startBatch`'s question instead of asking
    // `startBatch`'s question directly — so before adding a fifth clause,
    // check `startBatch` first.
    //
    // - `batchActive`, because `payFrom` (production-system.ts) draws a batch's
    //   inputs out of the in-tray at batch START. An empty tray is therefore
    //   the ORDINARY state of a building producing perfectly well — a mill on a
    //   three-tick batch holds no wheat for three ticks out of three — and
    //   without this clause that healthy producer outranks a consumer blocked
    //   for six hundred ticks, on the tick after every delivery it receives.
    // - `need.couldStartBatch`, because `startBatch` returns BEFORE `payFrom`
    //   when `buffer.room(...) < batchOutputUnits(recipe)`. A processor that
    //   finishes a batch into a FULL output tray leaves `batchActive` false
    //   with an empty in-tray too — the other three clauses all read true —
    //   but no delivery can start a batch there until a hauler CLEARS the
    //   output. That building is blocked on COLLECTION, not on input, and
    //   promoting it spends a supply trip it cannot use. This is the far-
    //   processor `outputFull` stall `StageResult.stalledTicks` counts: the
    //   common case, not a corner one.
    // - `holdsNoneOf` (below) supplies only THIS clause — the per-resource
    //   "nothing in hand" test — and nothing more. It is exported and named
    //   for exactly what it computes, on purpose: a caller that finds it by
    //   name and treats it as the whole starvation rule reintroduces the
    //   one-clause defect this floor was corrected twice to remove.
    // - `claims.input`, because the other clauses above read PHYSICAL state
    //   and none of them moves when a hauler is DISPATCHED, only when one
    //   ARRIVES several legs later. Dispatch runs every idle hauler inside one
    //   tick, so without this clause the promotion is not extinguished until a
    //   load LANDS and every hauler idle on that tick is sent to the same
    //   building. `needOf` bounds the pile-up at the tray's room, which is not
    //   the same as intending it.
    //
    //   `claims.input` also sums a building's claims across EVERY resource,
    //   not just `need.resource` — unlike `holdsNoneOf`, which is deliberately
    //   per-resource. On a recipe with two inputs, a claimed delivery of
    //   resource B would wrongly suppress `starving` for resource A. This is
    //   unreachable today for the same reason `holdsNoneOf`'s per-resource
    //   case is (see its test): no shipped recipe has two inputs. A future
    //   one would need a per-resource `claims.input` — `HaulTrip.resource` is
    //   already there for it — but that change is out of scope here, since it
    //   would alter dispatch behaviour rather than just naming it correctly.
    const starving = !row.production.batchActive
      && need.couldStartBatch
      && holdsNoneOf(row.input, need.resource)
      && claimedIn === 0;
    for (const site of sitesHolding(sites, unclaimedAt)) {
      const movable = Math.min(need.room, unclaimedAt(site.id));
      if (!worthMoving(movable, unclaimedAt(site.id))) continue;
      candidates.push({
        buildingId: row.building.id, buildingCol: row.position.col, buildingRow: row.position.row,
        siteId: site.id, siteCol: site.col, siteRow: site.row, resource: need.resource, movable, starving,
      });
    }
  }
  return candidates;
}

/**
 * What every dispatch agrees on, whichever kind of job it is. `buildingId` is
 * nullable because a transfer has no target: it moves goods between two SITES,
 * and `targetId` stays null for its whole life.
 *
 * `staging` is written here rather than left alone, and the difference is one
 * a fresh reader will not see: `cancel()` already clears it, so today every
 * idle trip arrives here with it false. That is a property of the OTHER end of
 * the trip, though, and this is the end that decides what the trip IS — a
 * hauler that ran a staging transfer and then took a collect job still
 * reporting `staging` would silently inflate §4.2's measurement, which is the
 * only consumer the field has.
 */
function beginTrip(trip: HaulTrip, kind: HaulKind, buildingId: number | null): void {
  trip.kind = kind;
  trip.targetId = buildingId;
  trip.amount = 0;
  trip.pickedUp = false;
  trip.destSiteId = CAMP_SITE_ID;
  trip.staging = false;
}

function beginSupply(trip: HaulTrip, at: TileRef, target: SupplyCandidate): void {
  beginTrip(trip, 'supply', target.buildingId);
  trip.resource = target.resource;
  trip.sourceSiteId = target.siteId;
  trip.plannedAmount = target.movable;
  trip.startLeg('fetching', at, { col: target.siteCol, row: target.siteRow }, BALANCE.haulTilesPerTick);
}

function beginCollect(trip: HaulTrip, at: TileRef, target: HaulCandidate): void {
  beginTrip(trip, 'collect', target.buildingId);
  trip.resource = null;
  trip.plannedAmount = 0;
  trip.startLeg('outbound', at, { col: target.col, row: target.row }, BALANCE.haulTilesPerTick);
}

/**
 * `beginSupply` minus its middle leg. A transfer walks to a source site and
 * then to a destination site, so `targetId` is null throughout and the trip
 * never enters `outbound`.
 *
 * `destSiteId` is written HERE, at dispatch, rather than resolved on the
 * return the way a supply trip's is — and that is the whole reservation. A
 * transfer's candidate was sized against room at that specific site
 * (`SiteLedger.room`), so the room has to be held from this moment: `heldAt`
 * counts a fetching transfer's `plannedAmount` against its destination
 * precisely because this field is already set while the hauler is still
 * walking the other way.
 *
 * `staging` is the candidate's class, recorded because it cannot be recovered
 * afterwards — a depot to camp move is legitimately either class, and the
 * snapshot carries no site ids to reconstruct it from.
 */
function beginTransfer(trip: HaulTrip, at: TileRef, target: TransferCandidate): void {
  beginTrip(trip, 'transfer', null);
  trip.resource = target.resource;
  trip.sourceSiteId = target.sourceSiteId;
  trip.destSiteId = target.destSiteId;
  trip.plannedAmount = target.movable;
  trip.staging = target.staging;
  trip.startLeg('fetching', at, { col: target.sourceCol, row: target.sourceRow }, BALANCE.haulTilesPerTick);
}

/** Everything a dispatch decision reads, gathered once per tick. */
export interface DispatchInputs {
  buildings: readonly HaulBuildingRow[];
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
  if (collect !== null) {
    beginCollect(trip, at, collect);
    return;
  }
  // Transfer is offered LAST, and only here, because it is the one kind of job
  // NOBODY IS WAITING FOR. A supply trip unblocks a building that is producing
  // nothing; a collect trip frees an output tray that is about to stall its
  // producer. A transfer moves goods that are already banked, already counted,
  // and already safe, from one store to another — so the only ticks it may
  // spend are ticks that would otherwise be spent standing still.
  //
  // It is not free, and the cost is worth naming rather than hiding: a hauler
  // mid-transfer is UNAVAILABLE for a supply job that arises next tick, and a
  // transfer's round trip can be long. The order above bounds that cost to one
  // trip per hauler — a transfer is never STARTED while real work exists — but
  // it does not eliminate it, and no ordering could, because dispatch cannot
  // see a tick ahead.
  const transfer = nextTransferTarget(transferCandidates(buildings, sites, staffed, claims, capacity), at);
  if (transfer !== null) beginTransfer(trip, at, transfer);
}
