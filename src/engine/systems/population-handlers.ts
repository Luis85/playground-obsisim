import type { IEntity } from 'sim-ecs';
import { lifespanFor, stageOf } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { Age, Colonist, HaulTrip, Home, Hunger, JobAssignment } from '../components';
import type { IdCounter, NoticeBoard, PendingChanges, RemovalLedger, SimClock, Stockpile } from '../resources';

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
  home: Home;
}

/** A building that can shelter, as the homing phase needs it. */
export interface ShelterRow {
  id: number;
  beds: number;
  col: number;
  row: number;
  /** A house in transit shelters nobody until it lands. */
  relocating: boolean;
}

export interface PopulationContext {
  clock: SimClock;
  stockpile: Stockpile;
  ids: IdCounter;
  notices: NoticeBoard;
  removals: RemovalLedger;
  pending: PendingChanges;
  colonists: ColonistRow[];
  shelters: ShelterRow[];
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

export function resolveStarvation(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.hunger.starvingTicks < BALANCE.starvationDeathTicks) continue;
    standDown(ctx, row);
    ctx.remove(row.entity);
    ctx.deadIds.add(row.colonist.id);
    ctx.removals.dirty = true;
    ctx.notices.succeed(`Colonist #${row.colonist.id} starved.`);
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

/**
 * Beds still open per shelter this tick: every non-relocating, non-demolished
 * shelter's full capacity, minus whatever this tick's pending arrivals have
 * already claimed. `rehome`'s later phases both read this map rather than
 * `ctx.shelters` directly, which is what lets a demolished or relocating
 * shelter's beds disappear from the count without a second exclusion check
 * at every call site.
 *
 * Split out of `rehome` (alongside `settleExistingHome` and `claimOpening`
 * below) purely to keep each function's own cognitive complexity under the
 * gate — same principle as `isOutputBlocked`/`buildingState` splitting out
 * of `buildEntitySections`. `rehome` itself is still the one place that
 * reads as spec 2.3's eviction-then-fill in order.
 */
function freeBeds(ctx: PopulationContext): Map<number, number> {
  const free = new Map<number, number>();
  for (const shelter of ctx.shelters) {
    // A house demolished earlier this tick is still in the query until the
    // post-step sync — see PendingChanges above. Counting its beds would let
    // homing put the residents handleDemolishBuilding just evicted straight
    // back into a building that no longer exists.
    if (shelter.relocating || ctx.pending.demolished.has(shelter.id)) continue;
    free.set(shelter.id, shelter.beds);
  }
  // Arrivals hold reserved beds too, but nothing creates one until Task 8, so
  // this loop is a no-op until then — written now because it belongs beside
  // the exclusion above, and both halves clear together.
  for (const { home } of ctx.pending.arrivals) {
    if (home.buildingId !== null) free.set(home.buildingId, (free.get(home.buildingId) ?? 0) - 1);
  }
  return free;
}

/**
 * Eviction half of spec 2.3, for one colonist: null its home if that home
 * stopped sheltering this tick (gone from `free` entirely — demolished or
 * relocating — or already full), otherwise claim one of its remaining beds.
 * A no-op for a colonist already homeless (`homeId === null`).
 */
function settleExistingHome(row: ColonistRow, byId: ReadonlyMap<number, ShelterRow>, free: Map<number, number>): void {
  const homeId = row.home.buildingId;
  if (homeId === null) return;
  const shelter = byId.get(homeId);
  if (shelter === undefined || shelter.relocating) {
    row.home.buildingId = null;
    return;
  }
  // Over capacity evicts rather than overflowing. A save can legitimately
  // arrive this way — lowering houseBeds in a retune leaves every existing
  // house one resident over — and the load principle says clamp a
  // balance-coupled value, never reject the save for it. Ascending id means
  // the highest ids are the ones displaced, deterministically.
  const remaining = free.get(homeId) ?? 0;
  if (remaining <= 0) {
    row.home.buildingId = null;
    return;
  }
  free.set(homeId, remaining - 1);
}

/**
 * Fill half of spec 2.3, for one colonist: place it into the lowest-id
 * opening with room, if it is homeless and one exists. `openings` entries are
 * mutated in place (`opening[1]--`) so a shelter fills before the next
 * colonist is offered it. Returns false only when this colonist is homeless
 * AND no opening remains — the signal `rehome` uses to stop early, since
 * every later row in ascending-id order is in exactly the same position.
 */
function claimOpening(row: ColonistRow, openings: [number, number][]): boolean {
  if (row.home.buildingId !== null) return true; // already homed: not this phase's business
  const opening = openings.find(([, beds]) => beds > 0);
  if (opening === undefined) return false;
  row.home.buildingId = opening[0];
  opening[1]--;
  return true;
}

/**
 * Evict, then fill — the two halves spec 2.3 describes.
 *
 * Eviction covers a home that stopped sheltering: demolished (gone from
 * `shelters` entirely) or relocating. Filling is greedy in ascending colonist
 * id against shelters in ascending building id, which is what makes the
 * assignment reproducible rather than entity-iteration-ordered.
 *
 * Runs before births so that "a free bed exists" and "nobody is homeless" are
 * the same condition and the birth rule can test either.
 */
export function rehome(ctx: PopulationContext): void {
  const byId = new Map(ctx.shelters.map((shelter) => [shelter.id, shelter]));
  const rows = livingRows(ctx);
  const free = freeBeds(ctx);
  for (const row of rows) settleExistingHome(row, byId, free);

  const openings = [...free.entries()].filter(([, beds]) => beds > 0).sort((a, b) => a[0] - b[0]);
  for (const row of rows) {
    if (!claimOpening(row, openings)) return; // no beds left: the rest stay homeless
  }
}
