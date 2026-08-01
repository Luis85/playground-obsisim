import type { IEntity } from 'sim-ecs';
import type { Command } from '../../shared/commands';
import type { ResourceId } from '../../shared/content-types';
import { haulTicks } from '../../shared/haul';
import { autoPlacePosition, isTileBuildable, type TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import {
  Building, Efficiency, HaulTrip, Hunger, JobAssignment, OutputBuffer, Position, Production, ToolCoverage, Worker, WorkerSlots,
} from '../components';
import type { IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile, WorldMap } from '../resources';

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
}

export interface WorkerRow {
  job: JobAssignment;
  trip: HaulTrip;
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
  ctx.spawn(
    new Building(ctx.ids.take(), def.id),
    new WorkerSlots(def.workerSlots),
    new Production(),
    new Position(at.col, at.row),
    new OutputBuffer(),
  );
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
  ctx.spawn(new Worker(id), new Hunger(), new JobAssignment(), new Efficiency(), new ToolCoverage(), new HaulTrip());
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
  for (const { job } of ctx.workers) {
    if (job.buildingId === command.buildingId) assigned++;
    // A hauler is staffed work, not spare capacity — never poach it.
    else if (job.buildingId === null && !job.hauling && idle === null) idle = job;
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
  // Full refund — flagged balance knob (increment 5 owns tuning). add() is
  // the one write path, so the refund shows in production stats; that is
  // deliberate visibility, not an accounting bug. Active batch progress is
  // simply lost with the entity.
  for (const [resource, amount] of Object.entries(def.cost)) {
    ctx.stockpile.add(resource as ResourceId, amount);
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
  for (const { job, trip } of ctx.workers) {
    if (job.buildingId === command.buildingId) job.buildingId = null;
    // Spec §2.8: the trip cancels now, riding the same-tick demolishedIds
    // machinery, rather than lazily when the hauler reaches a tile with nothing
    // on it — up to 13 ticks later, all of them spent booked to a building the
    // snapshot no longer contains. Outbound only: a returning hauler is carrying
    // those goods to the camp, which did not move, and resetting it would
    // destroy the load (mirrors handleMoveBuilding's guard below).
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) trip.reset();
  }
  ctx.remove(found.entity);
  ctx.demolishedIds.add(command.buildingId);
  ctx.removals.dirty = true;
  // A zero-units clause would be noise on the common case, so the empty
  // buffer keeps the plain wording rather than gaining an empty ", lost."
  const notice = lost === ''
    ? `Demolished the ${def.name} — cost refunded.`
    : `Demolished the ${def.name} — cost refunded, ${lost} lost.`;
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
  found.position.col = to.col;
  found.position.row = to.row;
  // Haulers already walking to this building now have a different journey:
  // recompute from the new tile so the ticks charged match the line the dot
  // visibly travels. A returning hauler is unaffected — it walks to the camp,
  // which did not move.
  for (const { trip } of ctx.workers) {
    if (trip.phase === 'outbound' && trip.targetId === command.buildingId) {
      trip.ticksLeft = haulTicks(to.col, to.row, BALANCE.haulTilesPerTick);
    }
  }
  ctx.notices.succeed(`Moved the ${BUILDINGS[found.building.defId].name}.`);
}

export function handleAssignHauler(ctx: CommandContext): void {
  // The first idle worker, matching handleAssignWorker's selection rule. A
  // worker already on a building is never poached: the player staffed it.
  const idle = ctx.workers.find(({ job }) => job.buildingId === null && !job.hauling);
  if (idle === undefined) {
    ctx.notices.reject('No idle workers available.');
    return;
  }
  idle.job.hauling = true;
  ctx.notices.succeed('Assigned a hauler.');
}

export function handleUnassignHauler(ctx: CommandContext): void {
  const hauler = ctx.workers.find(({ job }) => job.hauling);
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
