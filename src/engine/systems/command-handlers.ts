import type { IEntity } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import type { ResourceId } from '../../shared/content-types';
import { haulTicks } from '../../shared/haul';
import type { LifeStage } from '../../shared/population';
import { autoPlacePosition, isTileBuildable, relocationTicks, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots } from '../components';
import { buildingComponents, colonistComponents } from '../spawn';
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
  remove: (entity: Readonly<IEntity>) => void;
  /** Buildings demolished earlier in this same drain: removal is deferred to
   * the post-step sync, so queries still see them — every lookup must not. */
  demolishedIds: Set<number>;
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
  // Component list shared with the save-restore path (src/engine/spawn.ts) so a
  // building constructed in play cannot end up missing one — it already did,
  // with OutputBuffer (OBS-4-02).
  ctx.spawn(...buildingComponents({ id: ctx.ids.take(), defId: def.id, col: at.col, row: at.row }));
  ctx.notices.succeed(`Built a ${def.name}.`);
}

export function handleRecruitWorker(ctx: CommandContext): void {
  // Checked BEFORE the cooldown write: a refused recruit must not start it.
  if (ctx.ids.exhausted()) {
    ctx.notices.reject('Cannot create more entities: id space exhausted.');
    return;
  }
  if (ctx.clock.tick < ctx.clock.lastRecruitTick + BALANCE.recruitCooldownTicks) {
    ctx.notices.reject('Recruiting is still on cooldown.');
    return;
  }
  ctx.clock.lastRecruitTick = ctx.clock.tick;
  const id = ctx.ids.take();
  // Same shared list as the restore path — a worker recruited in play once
  // shipped without HaulTrip and vanished from snapshots entirely (OBS-4-02).
  ctx.spawn(...colonistComponents({ id }));
  ctx.notices.succeed(`Recruited worker #${id}.`);
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
    // The house is gone now, not at the post-step sync — rehome would
    // otherwise leave its residents nominally housed for one more tick.
    if (home.buildingId === command.buildingId) home.buildingId = null;
    // Spec §2.8: the trip cancels now, riding the same-tick demolishedIds
    // machinery, rather than lazily when the hauler reaches a tile with nothing
    // on it — up to 13 ticks later, all of them spent booked to a building the
    // snapshot no longer contains. Outbound only: a returning hauler is carrying
    // those goods to the camp, which did not move, and resetting it would
    // destroy the load (mirrors handleMoveBuilding's guard below).
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) trip.reset();
  }
  // Colonists spawned EARLIER THIS TICK are not in ctx.workers — the query
  // cannot see them until the post-step sync — so a nomad welcomed before
  // this demolition would keep a homeId pointing at the building being
  // removed. The autosave at the end of the tick would then serialize a
  // dangling reference, and the v5 load guard would refuse the save.
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId === command.buildingId) home.buildingId = null;
  }
  ctx.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.pending.demolished.add(command.buildingId);
  ctx.removals.dirty = true;
  // A zero-units clause would be noise on the common case, so the empty
  // buffer keeps the plain wording rather than gaining an empty ", lost."
  let notice = lost === ''
    ? `Demolished the ${def.name} — cost refunded.`
    : `Demolished the ${def.name} — cost refunded, ${lost} lost.`;
  if (displaced > 0) notice += ` — ${displaced} colonist(s) now homeless.`;
  ctx.notices.succeed(notice);
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
