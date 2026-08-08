import type { IEntity } from 'sim-ecs';
import { lifespanFor, stageOf } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { Age, Colonist, HaulTrip, Hunger, JobAssignment } from '../components';
import type { IdCounter, NoticeBoard, RemovalLedger, SimClock, Stockpile } from '../resources';

// One small phase per rule, for the same reason command-handlers.ts exists:
// the complexity gate is why these are not inline in the system's run
// function. The system materialises query rows into a context and calls the
// phases in the order spec 2.9 fixes.

/** Live query rows, materialised once per tick. Component references stay
 * live, so writes (age.ticks, job.buildingId) hit the real world. */
export interface ColonistRow {
  entity: Readonly<IEntity>;
  colonist: Colonist;
  age: Age;
  hunger: Hunger;
  job: JobAssignment;
  trip: HaulTrip;
}

export interface PopulationContext {
  clock: SimClock;
  stockpile: Stockpile;
  ids: IdCounter;
  notices: NoticeBoard;
  removals: RemovalLedger;
  colonists: ColonistRow[];
  spawn: (...components: object[]) => void;
  remove: (entity: Readonly<IEntity>) => void;
  /** Colonists who died earlier in THIS tick. Removal is deferred to the
   * post-step sync, so queries still see them — every later phase must not. */
  deadIds: Set<number>;
}

/** Everyone still alive this tick, in ascending id: the deterministic order
 * every phase iterates, independent of entity iteration order. Module-private:
 * every phase that needs it lives in this same file. */
function livingRows(ctx: PopulationContext): ColonistRow[] {
  return ctx.colonists
    .filter((row) => !ctx.deadIds.has(row.colonist.id))
    .sort((a, b) => a.colonist.id - b.colonist.id);
}

export function ageEveryone(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) row.age.ticks++;
}

/**
 * Strip a colonist of every job. Called on death as well as retirement,
 * because entity removal is DEFERRED to the post-step sync: a colonist killed
 * this tick is still visible to ProductionSystem and HaulSystem later in the
 * same tick, and would contribute one last tick of work from beyond the grave.
 * Anything in a hauler's hands goes to the store — those goods left a building
 * and must land somewhere, exactly as handleUnassignHauler banks them.
 */
function standDown(ctx: PopulationContext, row: ColonistRow): void {
  row.job.buildingId = null;
  row.job.hauling = false;
  if (row.trip.resource !== null && row.trip.amount > 0) ctx.stockpile.add(row.trip.resource, row.trip.amount);
  row.trip.reset();
}

export function resolveOldAge(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.age.ticks < lifespanFor(row.colonist.id, BALANCE.lifeBands)) continue;
    standDown(ctx, row);
    ctx.remove(row.entity);
    ctx.deadIds.add(row.colonist.id);
    ctx.removals.dirty = true;
    ctx.notices.succeed(`Colonist #${row.colonist.id} died of old age.`);
  }
}

export function standDownNonAdults(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    const stage = stageOf(row.age.ticks, BALANCE.lifeBands);
    // Every non-adult, not just elders. A save written before `matureTicks`
    // was raised can load with a staffed colonist whose age now falls in the
    // CHILD band — balance-retuned saves are accepted by policy, and the
    // assign command only gates future commands — so an elder-only check
    // would leave that child working until it matured all over again.
    if (stage === 'adult') continue;
    if (row.job.buildingId === null && !row.job.hauling) continue; // already stood down
    standDown(ctx, row);
    ctx.notices.succeed(`Colonist #${row.colonist.id} ${stage === 'elder' ? 'retired' : 'is too young to work'}.`);
  }
}
