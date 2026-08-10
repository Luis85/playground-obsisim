import type { IEntity } from 'sim-ecs';
import type { Command } from '../../shared/commands';
// NOMAD_REJECTIONS is imported, not declared here: the Population view shows
// the same sentence beside its disabled button before the click, and one list
// beside the union it explains is what keeps the two from drifting apart.
import { nomadBlocker, NOMAD_REJECTIONS, SALT, spreadFor, type LifeStage, type NomadGate } from '../../shared/population';
import type { TileRef } from '../../shared/placement';
import { BALANCE } from '../content/balance';
import { BUILDINGS } from '../content/buildings';
import { Building, HaulTrip, Home, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots } from '../components';
import { shelterWithRoom, spawnArrival, type ShelterRow } from './population-handlers';
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

/** The live row for one building id, or null when it is gone — the ONE lookup
 * every handler resolves an id through, here rather than in
 * placement-handlers.ts because the staffing commands need it too. */
export function findBuilding(ctx: CommandContext, buildingId: number): BuildingRow | null {
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
 * Cheapest trip to throw away first, ranked by PHASE: idle, then outbound, then
 * returning — take the one closest to home among those, whose remaining walk is
 * smallest. Ties break by the same entity-iteration order as before, which keeps
 * the choice deterministic.
 *
 * The reasoning that ordering was built on ("an outbound hauler carries nothing
 * yet") stopped being true with the supply leg: an outbound SUPPLY hauler is
 * carrying inputs, and a `fetching` one is empty but is not in the ordering at
 * all. Ranking on `trip.amount` — which is what carrying actually means — is
 * spec §2.7 / Task 8 Step 3b, deliberately not changed here: release order is
 * balance-visible, and a task that only had comments to fix should not move it.
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
  // Anything already in hand goes to the store: those goods left their site and
  // must land somewhere. NOT the mid-return case alone since the supply leg —
  // an outbound hauler can be carrying inputs it fetched from a store — which is
  // why this is guarded on `amount` rather than on the phase.
  if (hauler.trip.resource !== null && hauler.trip.amount > 0) {
    ctx.stockpile.add(hauler.trip.resource, hauler.trip.amount);
  }
  hauler.trip.cancel();
  ctx.notices.succeed('Unassigned a hauler.');
}
