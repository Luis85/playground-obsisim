import type { IEntity } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import type { ResourceId } from '../../shared/content-types';
import { haulTicks } from '../../shared/haul';
// NOMAD_REJECTIONS is imported, not declared here: the Population view shows
// the same sentence beside its disabled button before the click, and one list
// beside the union it explains is what keeps the two from drifting apart.
import { nomadBlocker, NOMAD_REJECTIONS, SALT, spreadFor, type LifeStage, type NomadGate } from '../../shared/population';
import { autoPlacePosition, isTileBuildable, relocationTicks, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots } from '../components';
import { shelterWithRoom, spawnArrival, type ShelterRow } from './population-handlers';
import { buildingComponents } from '../spawn';
import type { IdCounter, NoticeBoard, PendingChanges, RemovalLedger, SimClock, Stockpile, WorldMap } from '../resources';

// One small handler per command type (the complexity gate is why they live
// here and not inline in the system's run function). Notice doctrine:
// exactly one notice per command, emitted after the state change it
// describes — a notice never claims something that didn't happen.

/** Live query rows, materialized once per drain. Component references stay
 * live, so writes (job.buildingId, position.col) hit the real world. */
export interface BuildingRow {
  entity: Readonly<IEntity>;
  building: Building;
  slots: WorkerSlots;
  position: Position;
  buffer: OutputBuffer;
  relocation: Relocation;
}

export interface WorkerRow {
  job: JobAssignment;
  trip: HaulTrip;
  home: Home;
  stage: LifeStage;
}

/**
 * Everything one drained command may read or write. `spawn` wraps sim-ecs's
 * deferred entity commands; `claimedTiles` bridges that deferral inside a
 * single drain — an entity built this tick is invisible to queries until the
 * post-step sync, but its tile must already count as occupied.
 */
export interface CommandContext {
  clock: SimClock;
  stockpile: Stockpile;
  ids: IdCounter;
  notices: NoticeBoard;
  map: WorldMap;
  buildings: BuildingRow[];
  workers: WorkerRow[];
  spawn: (...components: object[]) => void;
  claimedTiles: TileRef[];
  removals: RemovalLedger;
  pending: PendingChanges;
  /** Buildings demolished earlier in this same drain: removal is deferred to
   * the post-step drain, so queries still see them — every lookup must not. */
  demolishedIds: Set<number>;
  /** Shelters as the homing phase sees them, so the bed a nomad is given and
   * the bed the gate counted come from one description. A function, not a
   * value — same reasoning as `occupancy` below: a relocation (or
   * construction) started earlier in this same drain changes it, and a
   * frozen array would bake in whatever was true at context construction. */
  shelters: () => ShelterRow[];
  /** Colonists per home building id. A function, not a value: a demolition
   * earlier in the drain changes it. */
  occupancy: () => Map<number, number>;
  /** The nomad gate's inputs, built from the same rows — so the gate and the
   * bed it then picks cannot disagree. */
  nomadGate: () => NomadGate;
}

/** Occupancy truth for this drain: live rows plus this drain's own claims. */
function occupiedTiles(ctx: CommandContext): TileRef[] {
  return [
    ...ctx.buildings.map((row) => ({ col: row.position.col, row: row.position.row })),
    ...ctx.claimedTiles,
  ];
}

function findBuilding(ctx: CommandContext, buildingId: number): BuildingRow | null {
  if (ctx.demolishedIds.has(buildingId)) return null;
  return ctx.buildings.find((row) => row.building.id === buildingId) ?? null;
}

// Only unassign needs to go from a bare id to a name without already holding
// a findBuilding() result. The 'building' fallback fires when a
// JobAssignment points at a building that no longer exists — fixture-only in
// practice: demolition nulls every assignment to the building it removes and
// the same-tick guard rejects later commands against the id, so no in-game
// path leaves an assignment dangling. The fallback stays as defense in depth.
function buildingName(ctx: CommandContext, buildingId: number): string {
  const found = findBuilding(ctx, buildingId);
  return found ? BUILDINGS[found.building.defId].name : 'building';
}

export function handleConstructBuilding(ctx: CommandContext, command: Extract<Command, { type: 'constructBuilding' }>): void {
  // Checked BEFORE pay(): refusing after payment would swallow the cost.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const def = BUILDINGS[command.buildingDefId];
  // Position resolves (and can refuse) BEFORE pay(), same principle as ids.
  const occupied = occupiedTiles(ctx);
  let at = command.at ?? null;
  if (at === null) {
    at = autoPlacePosition(ctx.map, occupied);
    if (at === null) {
      ctx.notices.reject('No free tile left to build on.');
      return;
    }
  } else if (!isTileBuildable(ctx.map, occupied, at.col, at.row)) {
    ctx.notices.reject('Cannot build there.');
    return;
  }
  if (!ctx.stockpile.pay(def.cost)) {
    ctx.notices.reject(`Cannot afford ${def.name}.`);
    return;
  }
  ctx.claimedTiles.push({ col: at.col, row: at.row });
  const id = ctx.ids.take();
  // Component list shared with the save-restore path (src/engine/spawn.ts) so a
  // building constructed in play cannot end up missing one — it already did,
  // with OutputBuffer (OBS-4-02).
  ctx.spawn(...buildingComponents({ id, defId: def.id, col: at.col, row: at.row }));
  // Recorded AFTER every rejection path above: a construction refused for
  // cost, tiles, or id exhaustion must not appear in this list, or homing
  // would shelter someone in a house that was never actually built.
  ctx.pending.constructed.push({ id, defId: def.id, col: at.col, row: at.row });
  ctx.notices.succeed(`Built a ${def.name}.`);
}

/**
 * Recruiting is now a nomad ARRIVING, gated on food and a bed (spec 2.7). It
 * is the colony's recovery valve and deliberately also a trap: the food bar is
 * higher than a birth's, so a colony that has starved itself cannot simply
 * hire its way out.
 */
export function handleRecruitWorker(ctx: CommandContext): void {
  // Checked BEFORE the cooldown write: a refused recruit must not start it.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  const blocker = nomadBlocker(ctx.nomadGate());
  if (blocker !== null) {
    ctx.notices.reject(NOMAD_REJECTIONS[blocker]);
    return;
  }
  ctx.clock.lastRecruitTick = ctx.clock.tick;
  const id = ctx.ids.take();
  // Take the bed AND record the arrival. Both matter, for the same reason:
  // this entity does not exist to any query until the post-step sync, so
  // PopulationSystem — which runs later this very tick — would otherwise see
  // the bed as free and let tryBirth hand it to a child as well. The tick
  // would end with five colonists in four beds and the nomad homeless.
  const homeId = shelterWithRoom(ctx.shelters(), ctx.occupancy(), ctx.pending);
  // spawnArrival, not a bare spawn: the same shared component list as the
  // restore path (a worker recruited in play once shipped without HaulTrip and
  // vanished from snapshots entirely — OBS-4-02), plus the pending-ledger push
  // that lets a demolition later in this drain still evict them.
  spawnArrival(ctx, {
    id,
    homeId,
    ageTicks: BALANCE.nomadArrivalTicks + spreadFor(id, BALANCE.lifeBands.spreadTicks, SALT.arrivalAge),
  });
  ctx.notices.succeed(`Colonist #${id} joined the colony.`);
}

export function handleAssignWorker(ctx: CommandContext, command: Extract<Command, { type: 'assignWorker' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  let assigned = 0;
  let idle: JobAssignment | null = null;
  for (const { job, stage } of ctx.workers) {
    if (job.buildingId === command.buildingId) assigned++;
    // A hauler is staffed work, not spare capacity — never poach it. A child
    // or elder is not spare capacity either: they are ineligible.
    else if (stage === 'adult' && job.buildingId === null && !job.hauling && idle === null) idle = job;
  }
  if (assigned >= found.slots.max) {
    ctx.notices.reject('No free worker slots at this building.');
    return;
  }
  if (idle === null) {
    ctx.notices.reject('No idle workers available.');
    return;
  }
  idle.buildingId = command.buildingId;
  ctx.notices.succeed(`Assigned a worker to ${BUILDINGS[found.building.defId].name}.`);
}

export function handleUnassignWorker(ctx: CommandContext, command: Extract<Command, { type: 'unassignWorker' }>): void {
  if (ctx.demolishedIds.has(command.buildingId)) {
    ctx.notices.reject('Building not found.');
    return;
  }
  let found = false;
  for (const { job } of ctx.workers) {
    if (job.buildingId === command.buildingId) {
      job.buildingId = null;
      found = true;
      break;
    }
  }
  if (!found) {
    ctx.notices.reject('No worker assigned to this building.');
    return;
  }
  ctx.notices.succeed(`Unassigned a worker from ${buildingName(ctx, command.buildingId)}.`);
}

/** What a demolished building's buffer held, worded for the success notice:
 * resource names from the same catalog `BUILDINGS` comes from, in catalog
 * order — the determinism rule `OutputBuffer.fullestResource` also uses — and
 * comma-separated. Empty when the buffer held nothing; the caller decides
 * whether that is worth a clause of its own. */
function bufferLossText(amounts: ReadonlyMap<ResourceId, number>): string {
  const parts: string[] = [];
  for (const id of RESOURCE_IDS) {
    const amount = amounts.get(id) ?? 0;
    if (amount > 0) parts.push(`${amount} ${RESOURCES[id].name}`);
  }
  return parts.join(', ');
}

export function handleDemolishBuilding(ctx: CommandContext, command: Extract<Command, { type: 'demolishBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const def = BUILDINGS[found.building.defId];
  // Full refund — flagged balance knob (increment 5 owns tuning). refund(),
  // not add(): the building was never hauled to, so this must not inflate
  // the Economy view's Delivered/t (Stockpile.refund's doc comment says why).
  // Active batch progress is simply lost with the entity.
  for (const [resource, amount] of Object.entries(def.cost)) {
    ctx.stockpile.refund(resource as ResourceId, amount);
  }
  // Whatever was waiting in the buffer dies with the building — decided in
  // OBS-4-07, against refunding it: a building left full of uncollected goods
  // should be expensive to bulldoze, since that is exactly the pressure
  // haulers exist to relieve, and a player who wants the goods kept already
  // has the non-destructive moveBuilding. The notice below names the loss
  // instead of hiding it. Read here, before the clear, purely to word that
  // notice — the stockpile loop above is untouched either way. Emptying the
  // buffer HERE rather than letting the entity carry it off at the post-step
  // sync is load-bearing for an unrelated reason: HaulSystem runs later in
  // this same tick and still sees the not-yet-removed entity, so a buffer
  // left full would have it dispatch a hauler at a building that is already
  // gone.
  const lost = bufferLossText(found.buffer.amounts);
  found.buffer.amounts.clear();
  // Read BEFORE the loop below nulls every matching home: this counts exactly
  // who the demolition displaces, for the notice.
  const displaced = ctx.workers.filter(({ home }) => home.buildingId === command.buildingId).length;
  for (const { job, trip, home } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
    // Defensive, not load-bearing: rehome (PopulationSystem, later this same
    // tick) already zeroes a demolished shelter's residents on its own —
    // freeBeds excludes ctx.pending.demolished, so settleExistingHome's
    // free.get(homeId) ?? 0 falls through to eviction. Kept because it is
    // cheap and harmless. The colonist this can't protect is one ctx.workers
    // has no row for yet — spawned earlier this same tick — which the
    // pending.arrivals loop below exists to catch.
    if (home.buildingId === command.buildingId) home.buildingId = null;
    // Spec §2.8: the trip cancels now, riding the same-tick demolishedIds
    // machinery, rather than lazily when the hauler reaches a tile with nothing
    // on it — up to 13 ticks later, all of them spent booked to a building the
    // snapshot no longer contains. Outbound only: a returning hauler is carrying
    // those goods to the camp, which did not move, and resetting it would
    // destroy the load (mirrors handleMoveBuilding's guard below).
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) trip.reset();
  }
  ctx.removals.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.pending.demolished.add(command.buildingId);
  // Colonists spawned EARLIER THIS TICK are not in ctx.workers — the query
  // cannot see them until the post-step sync — so a nomad welcomed before this
  // demolition keeps a homeId pointing at the building being removed unless
  // something reaches them through the pending ledger. Since Task 8 wires nomad
  // welcoming, ctx.pending.arrivals genuinely fills: recruitWorker and
  // demolishBuilding in one drain is a reachable pair, not a hypothetical.
  //
  // AFTER the two demolished-ledger writes above, deliberately:
  // reseatArrivalsOf re-seats through shelterWithRoom, which skips
  // pending.demolished — re-seating any earlier would hand the arrival a bed in
  // the very house being removed.
  reseatArrivalsOf(ctx, command.buildingId);
  // A zero-units clause would be noise on the common case, so the empty
  // buffer keeps the plain wording rather than gaining an empty ", lost."
  let notice = lost === ''
    ? `Demolished the ${def.name} — cost refunded.`
    : `Demolished the ${def.name} — cost refunded, ${lost} lost.`;
  if (displaced > 0) notice += ` — ${displaced} colonist(s) displaced.`;
  ctx.notices.succeed(notice);
}

/**
 * Move this drain's own arrivals out of a house that just stopped sheltering,
 * into whichever house still has room. Both ways a house stops sheltering call
 * it: `handleMoveBuilding` (in transit) and `handleDemolishBuilding` (gone).
 *
 * A nomad welcomed EARLIER THIS SAME DRAIN is invisible to `ctx.workers` — the
 * query cannot see an entity until the post-step sync — so `rehome`
 * (PopulationSystem, later this tick) has no row for them and can neither
 * evict nor re-house them: it walks `ctx.colonists`, which this arrival is not
 * yet part of. Only the pending ledger can still reach them.
 *
 * Both halves are load-bearing. Nulling alone stops the dangling homeId the v5
 * load guard refuses (and the phantom occupant it would add to a house nobody
 * lives in) but leaves the arrival homeless for the rest of the tick even when
 * another house stands empty — a paused player watches that contradiction
 * until they step again. Re-seating alone would leave the old id in place when
 * no bed is left anywhere.
 *
 * Null first, then re-seat, in that order: `shelterWithRoom` folds
 * `ctx.pending.arrivals` in itself and reads them LIVE, so an arrival still
 * pointing at its old house would be counted against a bed it no longer holds.
 * The same liveness is what makes this safe for several displaced arrivals at
 * once — each one re-seated counts against its new house on the next call.
 */
function reseatArrivalsOf(ctx: CommandContext, buildingId: number): void {
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId !== buildingId) continue;
    home.buildingId = null;
    home.buildingId = shelterWithRoom(ctx.shelters(), ctx.occupancy(), ctx.pending);
  }
}

export function handleMoveBuilding(ctx: CommandContext, command: Extract<Command, { type: 'moveBuilding' }>): void {
  const found = findBuilding(ctx, command.buildingId);
  if (found === null) {
    ctx.notices.reject('Building not found.');
    return;
  }
  const { to } = command;
  // Own tile first: it IS occupied (by the mover), so isTileBuildable would
  // reject it anyway — the explicit check just makes the no-op reject
  // independent of that coincidence. occupiedTiles includes the mover's old
  // tile, which a move to any DIFFERENT tile never matches.
  const own = found.position.col === to.col && found.position.row === to.row;
  if (own || !isTileBuildable(ctx.map, occupiedTiles(ctx), to.col, to.row)) {
    ctx.notices.reject('Cannot move there.');
    return;
  }
  // Read BEFORE overwriting found.position: doing this after would measure a
  // zero-distance move against the tile the building already occupies.
  const moved = Math.hypot(to.col - found.position.col, to.row - found.position.row);
  found.position.col = to.col;
  found.position.row = to.row;
  // Distance-scaled downtime: relocation used to be free and instant, which let
  // a player cluster at the camp and never feel haul pressure. Replaces any
  // remaining downtime rather than adding to it — accumulating would let a
  // player trap a building by accident.
  found.relocation.ticksLeft = relocationTicks(moved, BALANCE.relocationTilesPerTick);
  reseatArrivalsOf(ctx, command.buildingId);
  // Haulers already walking to this building now have a different journey:
  // recompute from the new tile so the ticks charged match the line the dot
  // visibly travels. legTicks is refreshed the same way, from the same call —
  // this outbound trip is effectively restarting its leg, so the snapshot's
  // published total must match the new ticksLeft it is now counting down from.
  // A returning hauler is unaffected — it walks to the camp, which did not
  // move, and its legTicks/pickup tile stay exactly as frozen at pickup.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) {
      const ticks = haulTicks(to.col, to.row, BALANCE.haulTilesPerTick);
      trip.ticksLeft = ticks;
      trip.legTicks = ticks;
    }
  }
  ctx.notices.succeed(`Moved the ${BUILDINGS[found.building.defId].name}.`);
}

export function handleAssignHauler(ctx: CommandContext): void {
  // The first idle worker, matching handleAssignWorker's selection rule. A
  // worker already on a building is never poached: the player staffed it. A
  // child or elder is not spare capacity either: they are ineligible.
  const idle = ctx.workers.find(({ job, stage }) => stage === 'adult' && job.buildingId === null && !job.hauling);
  if (idle === undefined) {
    ctx.notices.reject('No idle workers available.');
    return;
  }
  idle.job.hauling = true;
  ctx.notices.succeed('Assigned a hauler.');
}

/**
 * Which hauler the `−` button takes off duty. Spec §2.3 fixes the *dispatch*
 * order but said nothing about removal, so this used to take the first hauler in
 * entity-iteration order — which could interrupt a loaded worker most of the way
 * home while an idle one stood at the camp (OBS-4-08).
 *
 * Cheapest trip to throw away first: an idle hauler wastes nothing, an outbound
 * one wastes only the walk out (it carries nothing yet), and a returning one
 * wastes the walk it has already done — so among those, take the one closest to
 * home, whose remaining walk is smallest. Ties break by the same
 * entity-iteration order as before, which keeps the choice deterministic.
 */
export function cheapestHaulerToRelease(workers: WorkerRow[]): WorkerRow | undefined {
  const haulers = workers.filter(({ job }) => job.hauling);
  const cost = ({ trip }: WorkerRow) => (trip.phase === 'idle' ? 0 : trip.phase === 'outbound' ? 1 : 2);
  return haulers.reduce<WorkerRow | undefined>((best, hauler) => {
    if (best === undefined) return hauler;
    if (cost(hauler) !== cost(best)) return cost(hauler) < cost(best) ? hauler : best;
    // Same phase: prefer the one with the least walking left to lose. Strict <
    // keeps the earlier worker on a tie, preserving iteration order.
    return hauler.trip.ticksLeft < best.trip.ticksLeft ? hauler : best;
  }, undefined);
}

export function handleUnassignHauler(ctx: CommandContext): void {
  const hauler = cheapestHaulerToRelease(ctx.workers);
  if (hauler === undefined) {
    ctx.notices.reject('No hauler to unassign.');
    return;
  }
  hauler.job.hauling = false;
  // Anything already in hand goes to the store: those goods left the building
  // and must land somewhere. Only a returning hauler carries — an outbound one
  // is empty — so this is exactly the mid-return case.
  if (hauler.trip.resource !== null && hauler.trip.amount > 0) {
    ctx.stockpile.add(hauler.trip.resource, hauler.trip.amount);
  }
  hauler.trip.reset();
  ctx.notices.succeed('Unassigned a hauler.');
}
