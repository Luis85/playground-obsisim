import type { IEntity } from 'sim-ecs';
import { birthBlocker, lifespanFor, stageOf } from '../../shared/population';
import { BALANCE } from '../content/balance';
import { MEAL_WEIGHTS } from '../content/resources';
import { colonistComponents } from '../spawn';
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
  /** Colonists who died earlier in THIS tick. Removal is deferred to the
   * post-step drain, so queries still see them — every later phase must not. */
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
 * because entity removal is DEFERRED to the post-step drain: a colonist killed
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

/**
 * The three things a death is, in the one place both causes share them: the
 * colonist stops working, the entity is queued for the post-step drain, and
 * every later phase this tick stops counting them as alive. The cause supplies
 * only its own notice.
 *
 * Together, not one call each at two sites: an earlier version left
 * `removals.dirty = true` as a fourth thing to remember beside the removal,
 * and a remover that forgot it published a stale snapshot. Nothing here can be
 * half-done now, and a third cause of death gets all of it for free.
 */
function die(ctx: PopulationContext, row: ColonistRow): void {
  standDown(ctx, row);
  ctx.removals.remove(row.entity);
  ctx.deadIds.add(row.colonist.id);
}

export function resolveOldAge(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.age.ticks < lifespanFor(row.colonist.id, BALANCE.lifeBands)) continue;
    die(ctx, row);
    ctx.notices.succeed(`Colonist #${row.colonist.id} died of old age.`);
  }
}

export function resolveStarvation(ctx: PopulationContext): void {
  for (const row of livingRows(ctx)) {
    if (row.hunger.starvingTicks < BALANCE.starvationDeathTicks) continue;
    die(ctx, row);
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
    // Only the CHILD branch speaks here, and it is not the mirror of a
    // retirement notice — it is a REPAIR notice. It is reachable solely
    // through a save loaded after `matureTicks` was raised, telling the
    // player why a building they staffed is suddenly empty. An elder is
    // silent because `announceBandChanges` below already announced the
    // retirement on the very tick this stand-down happens; saying it twice
    // is the defect the transition trigger was moved to avoid.
    if (stage === 'child') ctx.notices.succeed(`Colonist #${row.colonist.id} is too young to work.`);
  }
}

/**
 * The two band crossings, announced (spec 2.13) — the labour pool grew, or it
 * shrank.
 *
 * Triggered on the TRANSITION, not on the stand-down that accompanies one
 * (OBS-6-03). Tying the retirement notice to `standDownNonAdults`'s "is there
 * anything to unassign?" test answered a second question with it — "is there
 * anything to announce?" — and got it wrong: in §4.1's own curve the colony
 * holds 34-40 against roughly six job slots, so the large majority of
 * retirements were of idle colonists and went unannounced. Two colonists
 * crossing on the same tick were treated differently purely on whether they
 * happened to be employed.
 *
 * Coming of age is announced for the same reason and by the same rule. A child
 * reaching `matureTicks` grows the assignable pool exactly as an elder leaving
 * it shrinks the pool, and announcing one without the other would replace the
 * old asymmetry with a new one.
 *
 * EQUALITY, not `>=`: `ageEveryone` increments by exactly 1, so each colonist
 * meets each boundary on exactly one tick of one run. A colonist RESTORED past
 * a boundary never meets it and is deliberately never announced — only a
 * balance retune can write such a save, and `restoredColonists` treats it as a
 * repair (clearing a now-non-adult's job at load) rather than as an event in
 * the colony's life. That holds at both ends: an elder restored past
 * `retireTicks` arrives already stood down with nothing left to announce, and
 * an adult restored past `matureTicks` came of age in an earlier session, so
 * announcing it on load would report an event that never happened.
 *
 * Which notice a boundary gets is asked of `stageOf` rather than hard-coded to
 * the field name, so a degenerate retune with `matureTicks >= retireTicks`
 * says the same thing here as every other reader of the bands does.
 *
 * Runs after the deaths so a colonist who starves on the very tick they cross
 * is not announced as retiring: `livingRows` has already dropped them.
 */
export function announceBandChanges(ctx: PopulationContext): void {
  const bands = BALANCE.lifeBands;
  for (const row of livingRows(ctx)) {
    if (row.age.ticks !== bands.matureTicks && row.age.ticks !== bands.retireTicks) continue;
    const entered = stageOf(row.age.ticks, bands);
    ctx.notices.succeed(`Colonist #${row.colonist.id} ${entered === 'elder' ? 'retired' : 'came of age'}.`);
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
  // Arrivals hold reserved beds too, and since Task 8 they genuinely occur: a
  // nomad welcomed by CommandSystem earlier this same tick has already claimed
  // a bed that no query can see yet. Counting them here is what stops `rehome`
  // — running later in that same tick — from handing the same bed to somebody
  // else. It belongs beside the exclusion above; both halves clear together.
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

/**
 * Beds nobody living has a claim on.
 *
 * Deliberately does NOT ask which house has room. That question depends on
 * how far the homing phase has got, and the two systems that create colonists
 * sit on opposite sides of it — `CommandSystem` runs before homing, `tryBirth`
 * after — so an occupancy-based answer is right for one caller and wrong for
 * the other. Three separate defects were found in this one interaction while
 * the plan was under review, each in the fix for the last, and all three were
 * routes to the same broken state.
 *
 * Every living colonist needs exactly one bed and beds are interchangeable, so
 * `total − population − pendingArrivals` is homing-independent and therefore
 * correct from either side. The scenario that broke the occupancy version: a
 * house becomes visible with 4 beds and 4 already-homeless colonists; an
 * occupancy view sees 4 empty beds and admits a nomad, then rehome houses all
 * 4 and five colonists reference a four-bed house. Here, 4 − 4 − 0 = 0.
 *
 * Named `spareBeds`, not `freeBeds`: the private `freeBeds` above answers the
 * per-shelter question that rehome — and only rehome — legitimately needs.
 */
export function spareBeds(shelters: readonly ShelterRow[], population: number, pending: PendingChanges): number {
  const total = shelters
    .filter((s) => !s.relocating && !pending.demolished.has(s.id))
    .reduce((sum, s) => sum + s.beds, 0);
  return total - population - pending.arrivals.length;
}

/**
 * Which house an arrival moves into, given what is already spoken for.
 * Ascending id, like every other assignment order here, so it is
 * reproducible. Only ever called once `spareBeds` has confirmed one exists.
 */
export function shelterWithRoom(
  shelters: readonly ShelterRow[],
  claimed: ReadonlyMap<number, number>,
  pending: PendingChanges,
): number | null {
  // Pending arrivals are folded in HERE rather than at each call site. Two
  // recruitWorker commands can drain in one tick and CommandContext.occupancy()
  // cannot see the first nomad, so a caller passing only visible occupancy
  // would hand both the same lowest-id house and overfill it while another
  // still had room. Counting them in the one function that answers "which
  // house has room" means no caller can forget.
  const spokenFor = new Map(claimed);
  for (const { home } of pending.arrivals) {
    if (home.buildingId !== null) spokenFor.set(home.buildingId, (spokenFor.get(home.buildingId) ?? 0) + 1);
  }
  for (const shelter of [...shelters].sort((a, b) => a.id - b.id)) {
    // Both exclusions, or a nomad drained on the same tick as a demolition
    // gets a bed in a house that vanishes at the sync.
    if (shelter.relocating || pending.demolished.has(shelter.id)) continue;
    if ((spokenFor.get(shelter.id) ?? 0) < shelter.beds) return shelter.id;
  }
  return null;
}

/**
 * Spawn a colonist who arrives THIS tick, and record them on the pending
 * ledger — one function because doing half of it is the bug the ledger exists
 * to prevent. An arrival is invisible to every query until the post-step sync,
 * so a spawn without the ledger push leaves later phases counting a bed as
 * free that is already taken, and a demolition later in the drain unable to
 * evict a colonist it cannot see.
 *
 * The LIVE `Home` goes on the ledger, not a copied id, so that demolition can
 * null it in place.
 */
export function spawnArrival(
  ctx: Pick<PopulationContext, 'spawn' | 'pending'>,
  spec: Parameters<typeof colonistComponents>[0],
): void {
  const components = colonistComponents(spec);
  ctx.spawn(...components);
  // The age comes off the SPAWNED component, not off `spec`: colonistComponents
  // clamps a balance-coupled age on the way in, so the spec's number and the
  // colonist's real age can differ, and the ledger must report the latter.
  const age = components.find((c): c is Age => c instanceof Age)!;
  ctx.pending.arrivals.push({ home: components.find((c): c is Home => c instanceof Home)!, ageTicks: age.ticks });
}

/** Adults among the colonists already visible to the queries. */
function countAdults(rows: readonly ColonistRow[]): number {
  return rows.filter((row) => stageOf(row.age.ticks, BALANCE.lifeBands) === 'adult').length;
}

/** Whether a colonist spawned earlier this tick counts toward the two-adult
 * rule. Every current caller of `spawnArrival` produces either a nomad (adult)
 * or a newborn (child), so this is the whole of the distinction — but it is
 * asked of the record rather than assumed from which handler queued it. */
function isAdultArrival(arrival: { ageTicks: number }): boolean {
  return stageOf(arrival.ageTicks, BALANCE.lifeBands) === 'adult';
}

/**
 * A child, when the colony can shelter and feed one. Runs LAST, after homing,
 * so "a free bed exists" and "nobody is homeless" are the same condition.
 */
export function tryBirth(ctx: PopulationContext): void {
  if (ctx.ids.exhausted()) return; // silent: this is not a player action to refuse
  const rows = livingRows(ctx);
  // A nomad welcomed earlier this tick holds a bed and eats, but is not in
  // `rows` yet — count them, or both arrivals take the same last bed.
  const blocker = birthBlocker({
    stock: ctx.stockpile.toJSON(),
    weights: MEAL_WEIGHTS,
    population: rows.length + ctx.pending.arrivals.length,
    // Arrivals count on BOTH sides, or the gate charges for a mouth it will
    // not credit as a parent. A nomad welcomed this tick is a grown adult who
    // eats: counting them in `population` (the food cost) but not in `adults`
    // (the parent benefit) made a one-adult colony that just welcomed a second
    // fail on `noParents` and lose a whole birthCooldownTicks to a colonist
    // who was standing right there.
    adults: countAdults(rows) + ctx.pending.arrivals.filter(isAdultArrival).length,
    // The OBJECT, not a count: spareBeds reads `.demolished` as well as
    // `.arrivals`, and passing a number back would silently drop the
    // demolition exclusion — the "changed at one site of N" failure this
    // signature exists to prevent.
    freeBeds: spareBeds(ctx.shelters, rows.length, ctx.pending),
    tick: ctx.clock.tick,
    lastBirthTick: ctx.clock.lastBirthTick,
    cooldown: BALANCE.birthCooldownTicks,
    perHead: BALANCE.birthFoodPerHead,
  });
  if (blocker !== null) return;
  ctx.clock.lastBirthTick = ctx.clock.tick;
  const id = ctx.ids.take();
  // Born INTO a bed. Homing already ran this tick, so a child spawned without
  // a homeId would spend its first tick homeless while the bed the gate just
  // counted against still read free.
  const claimed = new Map<number, number>();
  for (const row of rows) {
    if (row.home.buildingId !== null) claimed.set(row.home.buildingId, (claimed.get(row.home.buildingId) ?? 0) + 1);
  }
  // No pending merge here: shelterWithRoom folds ctx.pending.arrivals in
  // itself, and doing it twice would double-count this tick's nomad.
  const homeId = shelterWithRoom(ctx.shelters, claimed, ctx.pending);
  spawnArrival(ctx, { id, ageTicks: 0, homeId });
  ctx.notices.succeed(`Colonist #${id} was born.`);
}
