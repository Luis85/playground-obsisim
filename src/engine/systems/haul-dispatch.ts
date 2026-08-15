import type { RecipeDef, ResourceId } from '../../shared/content-types';
import type { HaulCandidate, StoreSite, SupplyCandidate } from '../../shared/haul';
import { CAMP_SITE_ID, nextHaulTarget, nextSupplyTarget, sitesHolding } from '../../shared/haul';
import { isRelocating, isUnderConstruction, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { batchOutputUnits, BUILDINGS } from '../content/buildings';
import { RESOURCE_IDS } from '../content/resources';
import type { HaulKind } from '../components';
import { Building, Construction, HaulTrip, InputBuffer, OutputBuffer, Position, Production, Relocation } from '../components';
import type { PendingChanges } from '../resources';
import type { Claims } from './haul-claims';
import { acceptsSupply, inputRoomOf, siteNeedOf } from './haul-construction';
import { storeSitesOf, type StoreSiteRow } from './haul-sites';
import {
  drainCandidates, nextTransferTarget, stagingCandidates,
  type SiteDemand, type TransferCandidate,
} from './haul-transfer';

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
  /** Whether this row is a construction SITE rather than a finished building
   * (§2.5). Read by `acceptsSupply` and `inputRoomOf` (haul-construction.ts),
   * which is to say by both ends of a supply leg — the same component
   * `StoreRow` already carries for the site list, off the same query, rather
   * than a second way of asking the same question. */
  construction: Construction;
}

/** The building fields a store site is derived from — a subset of
 * `HaulBuildingRow`, so a command handler can build the site list without
 * materialising the two buffers it has no use for. */
export interface StoreRow { building: Building; position: Position; relocation: Relocation; construction: Construction; }

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
      underConstruction: isUnderConstruction(row.construction.ticksLeft),
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
  row: HaulBuildingRow, claims: Claims, claimedIn: number, capacity: number,
): { resource: ResourceId; room: number; couldStartBatch: boolean } | null {
  if (isRelocating(row.relocation.ticksLeft)) return null;
  const { recipe } = BUILDINGS[row.building.defId];
  const found = isUnderConstruction(row.construction.ticksLeft)
    ? siteNeedOf(row, claims)
    : recipeNeedOf(row, recipe, claimedIn);
  if (found === null) return null;
  const couldStartBatch = row.buffer.room(BALANCE.outputBufferCap) >= batchOutputUnits(recipe);
  return { resource: found.resource, room: Math.min(found.room, capacity), couldStartBatch };
}

/** A FINISHED building's want: its recipe's proportionally shortest input, and
 * whatever is left of the one shared in-tray cap once every claim of every
 * material against it has been counted. Unchanged from increment 7 apart from
 * asking `inputRoomOf` for the room instead of `input.room` directly. */
function recipeNeedOf(
  row: HaulBuildingRow, recipe: RecipeDef | null, claimedIn: number,
): { resource: ResourceId; room: number } | null {
  if (recipe === null || Object.keys(recipe.inputs).length === 0) return null;
  const resource = row.input.shortestOf(recipe, RESOURCE_IDS);
  if (resource === null) return null;
  const room = inputRoomOf(row, resource) - claimedIn;
  return room <= 0 ? null : { resource, room };
}

/**
 * One of `SupplyCandidate.starving`'s FOUR clauses: this building holds NONE
 * of the resource a candidate would deliver. The other three — no batch
 * running, output room for another batch (`needOf`'s `couldStartBatch`), and no
 * delivery already claimed — stay at the call site in `supplyCandidates`,
 * because they read a different component, the recipe, and the claim ledger
 * respectively.
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
 * use it. `acceptsSupply` holds that condition and the one thing it exempts —
 * a construction site, which is never staffed and must still be fed.
 */
function supplyCandidates(
  buildings: readonly HaulBuildingRow[], sites: readonly StoreSite[], staffed: StaffedSet,
  claims: Claims, capacity: number,
): SupplyCandidate[] {
  const candidates: SupplyCandidate[] = [];
  for (const row of buildings) {
    if (!acceptsSupply(row, staffed)) continue;
    // Computed once per building rather than once inside `needOf` and again at
    // `starving` below: `chooseJob` rebuilds this whole candidate list per
    // idle hauler, so a second traversal here would be O(haulers² x
    // buildings) instead of O(haulers x buildings).
    const claimedIn = claims.input(row.building.id);
    const need = needOf(row, claims, claimedIn, capacity);
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
  /**
   * Per-site, per-resource demand. Gathered once per tick like everything else
   * here, and unlike everything else here that is a STATEMENT rather than a
   * convenience: `claims` is a set of closures over live components, so it
   * answers freshly for every hauler dispatched this tick, while this map is a
   * snapshot. It may be, because it is derived from building positions,
   * staffing and the site list — none of which a dispatch changes. A quantity
   * a dispatch DOES change (stock, room, headroom) belongs in `claims` and
   * would be wrong here.
   */
  demand: SiteDemand;
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
 *
 * THE TWO TRANSFER CLASSES SIT ON OPPOSITE SIDES OF COLLECT, and that is this
 * increment's one measured reversal rather than a preference. §2.6 originally
 * offered both last, on the argument that a transfer can only spend ticks that
 * would otherwise be idle and therefore cannot starve the other two kinds. The
 * argument is sound and the budget it leaves is ZERO exactly where a depot
 * saturates: a chain busy enough to fill a depot is busy enough that a collect
 * candidate exists on every dispatch tick, so this function returned above and
 * `drainCandidates` was never asked. Measured on the corner chain — depot full
 * at 60 of 60, zero transfers, zero transfer hauler-ticks, and an advantage
 * over no depot of 26 / 24 / 28 planks at 600 / 1,200 / 2,400 ticks, which is
 * increment 7's flat one-off buffer digit for digit. §4.2 has the readings.
 */
export function chooseJob(trip: HaulTrip, at: TileRef, inputs: DispatchInputs, capacity: number): void {
  const { buildings, sites, staffed, claims, demand } = inputs;
  const supply = nextSupplyTarget(supplyCandidates(buildings, sites, staffed, claims, capacity), at);
  if (supply !== null) {
    beginSupply(trip, at, supply);
    return;
  }
  // A DRAIN OUTRANKS COLLECT, because on this one candidate class the premise
  // below is false: something IS waiting for it. A drain candidate exists only
  // for a site whose free space has fallen below `storehouseFreeFloor`, and a
  // depot without room is a depot that can no longer take the short-hop
  // deposits that are its entire outbound value — every collect near it
  // silently reverts to the long walk to the camp, which is the leg the depot
  // was placed to remove. The goods are safe; the PIPELINE STAGE is blocked,
  // and a drain is the only rule that unblocks it.
  //
  // It cannot starve collect, and the bound is structural rather than a
  // tuning: `drainNeed` is netted against `plannedOutAt`, so the removals
  // already scheduled count against the floor being restored. At a floor of 12
  // and a capacity of 6 the first two haulers take the drain and the third
  // reads a `drainNeed` of zero and no candidate at all. The promotion is
  // extinguished by acting on it — the same shape as §2.1's starving band, and
  // it is why this is a floor rather than a rival priority.
  const drain = nextTransferTarget(drainCandidates(sites, claims, demand, capacity), at);
  if (drain !== null) {
    beginTransfer(trip, at, drain);
    return;
  }
  const collect = nextHaulTarget(collectCandidates(buildings, claims));
  if (collect !== null) {
    beginCollect(trip, at, collect);
    return;
  }
  // Staging stays LAST, and its half of §2.6's argument is untouched: it moves
  // goods toward a consumer that MIGHT want them later, against a collect trip
  // that frees an output tray about to stall its producer right now. Nobody is
  // waiting for a staging load, so the only ticks it may spend are ticks that
  // would otherwise be spent standing still.
  //
  // It is not free, and the cost is worth naming rather than hiding: a hauler
  // mid-transfer is UNAVAILABLE for a supply job that arises next tick, and a
  // transfer's round trip can be long. The order above bounds that cost to one
  // trip per hauler — a staging transfer is never STARTED while real work
  // exists — but it does not eliminate it, and no ordering could, because
  // dispatch cannot see a tick ahead.
  const staging = nextTransferTarget(stagingCandidates(sites, claims, demand, capacity), at);
  if (staging !== null) beginTransfer(trip, at, staging);
}
