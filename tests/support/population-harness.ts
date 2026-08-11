import { createSystem, queryComponents, Read, Write, WriteResource } from 'sim-ecs';
import type { IPreptimeWorld } from 'sim-ecs';
import type { ResourceId } from '../../src/shared/content-types';
import type { SaveGameV6 } from '../../src/shared/save';
import { autoPlaceSequence, type TileRef, type WorldMapSize } from '../../src/shared/placement';
import { stageOf } from '../../src/shared/population';
import { BALANCE } from '../../src/engine/content/balance';
import { Age, Building, Colonist, JobAssignment, WorkerSlots } from '../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist, type TColonySystemFactory,
} from '../../src/engine/world';
import { StatsSystem } from '../../src/engine/systems/stats-system';
import { stepTick } from '../engine/fixtures';
import { GoodsAudit, type GoodsAuditResult } from './goods-audit';

/**
 * A DEMOGRAPHIC experiment, reproducible from this descriptor alone — the
 * population equivalent of `Scenario` in balance-harness.ts, which measures
 * logistics. It lives in its own file because the two share no code beyond the
 * engine's own entry points: this one seeds no stockpile, measures no single
 * building, and samples a curve rather than reducing a run to one total.
 *
 * Increment 6 §4 records three questions this instrument exists to answer, and
 * none of them can be asked of a single tick: whether a colony with a working
 * food chain stabilises or oscillates, how many ticks of warning a starving
 * colony gets, and whether the commute penalty is large enough to change a
 * placement decision without making clustering always right.
 */
export interface PopulationScenario {
  houses: number;
  startingAdults: number;
  /**
   * `number` drips that much bread into the store each tick — an exogenous
   * supply, useful for isolating one variable (0 starves the colony
   * deliberately). `'chain'` instead builds gatherers' huts and haulers and
   * lets the colony **feed itself**.
   *
   * The distinction is not cosmetic. Spec §4's first question is whether a
   * colony with a working food chain stabilises or oscillates, and a drip
   * cannot answer it: food arrives regardless of how many adults are alive, so
   * the dependency ratio never feeds back on supply and the loop being tuned is
   * precisely the one held constant. Use `'chain'` for the stability
   * measurement and a number only where the point is to hold food fixed.
   */
  foodPerTick: number | 'chain';
  /** Gatherers' huts to build when `foodPerTick` is `'chain'`. */
  huts?: number;
  /** Haulers to staff when `foodPerTick` is `'chain'`. Taken OUT of
   * `startingAdults`, never added on top. */
  haulers?: number;
  /**
   * Storehouses to place, laid down the same auto-placement sequence as the
   * rest of the colony.
   *
   * This harness staffs but cannot BUILD, which increment 6 flagged as a
   * conservative control and increment 7 turns into a distortion: a colony
   * that cannot build a depot cannot play this increment at all, so the
   * 12,000-tick chain run has to be repeatable with and without one (spec
   * §4.1's fourth reading).
   *
   * Placed LAST, after the huts and the houses, and that order is the point:
   * the placement sequence is shared, so anything laid down before the depots
   * keeps its tiles whatever this number is — which is what makes a
   * with-and-without pair differ in the depot alone rather than in the depot
   * plus every haul leg in the colony.
   *
   * THE TRAP: a depot only becomes a live store site once it is the nearest
   * site to something. `autoPlaceSequence` gives the first huts the plots
   * nearest the camp, so in a SMALL colony (§4.1's 2-hut/12-house chain fixture
   * among them) the camp stays nearest to everything and the depot goes
   * unused — `PopulationResult.storedAtEnd` is 0 whether or not one is placed,
   * and a with/without comparison at that size is measuring a run against
   * itself. Before quoting any difference a with-depot comparison makes,
   * assert `storedAtEnd > 0` in the WITH-depot run; see the stress-size fixture
   * in balance.test.ts for a colony where that holds.
   *
   * THE SIBLING TRAP (OBS-7-05): **below the first old-age death a with/without
   * pair is comparable digit for digit; above it, only aggregate outcomes are.**
   * Adding a depot spawns an entity, which shifts every colonist's id, and
   * `lifespanFor` derives its jitter from the id — so past the first death the
   * two runs draw different lifespans and diverge for a reason that has nothing
   * to do with a depot. The two runs behind §4.1's fourth reading are 12,000
   * ticks and differ in exactly that way while `storedAtEnd` is 0 in both, so
   * the divergence cannot be the depot; every figure that reading quotes (peak,
   * final, trough, births, deaths, starvation, minimum meals per head) is an
   * aggregate that agreed across all four runs. Anything tighter — sample-for-
   * sample equality, or a small difference read as an effect — would be
   * measuring the jitter.
   *
   * The horizon is a property of the FIXTURE, not a constant: `spawnFounders`
   * starts its adults at `matureTicks`, so retirement falls at elapsed 4,500
   * and the earliest old-age death at 4,700 here, where the balance harness's
   * founders (`BALANCE.startingAgeTicks`) put the same two at 3,000 and 3,200.
   * Do not do that arithmetic to decide a run is safe — `deathsByOldAge` says
   * so, and balance.test.ts asserts it beside the equality it licenses. The
   * structural fix, a colonist-scoped salt that does not move when unrelated
   * entities spawn, would redefine every existing population figure and belongs
   * to an increment that needs it.
   */
  storehouses?: number;
  ticks: number;
  sampleEvery: number;
}

export interface PopulationSample {
  tick: number;
  children: number;
  adults: number;
  elders: number;
  mealsPerHead: number;
  /**
   * Colonists whose starvation countdown is running. This, not an empty store,
   * is when the player's warning actually begins: spec §4 asks for the interval
   * from `starvingTicks` climbing to the first death, and with `foodPerTick: 0`
   * the store is empty from tick 1 — a hundred ticks before anyone is even at
   * max hunger.
   */
  starving: number;
}

export interface PopulationResult {
  samples: PopulationSample[];
  births: number;
  deathsByOldAge: number;
  deathsByStarvation: number;
  /** (children + elders) / adults at the end: the share being carried. */
  dependencyRatio: number;
  /**
   * Steps that advanced no simulation at all — see `runPopulationScenario`'s
   * loop.
   *
   * **A REGRESSION SENTINEL, and since OBS-6-02 was fixed it must be 0.** It
   * was a live signal while the engine batched entity removals through
   * sim-ecs's command queue: a die-off of `n` cost `n - 1` steps in which no
   * system ran, so a "12,000-tick" colony could have lived 11,900, and this
   * number was the only way to know. Removals now drain after `step()`, one
   * per call, and nothing else in the engine can stall a tick — so the field
   * stays because the detector behind it is four lines and the failure it
   * catches is silent, not because it is expected to move again. The
   * starvation-warning scenario, the one that used to lose 2 steps, asserts it
   * is zero (tests/engine/balance.test.ts). If it is ever non-zero again,
   * every tick-indexed figure in a report is short by that much.
   */
  frozenSteps: number;
  /** Units this colony's storehouses hold at the end. Always 0 with no depot
   * placed — but NOT necessarily positive with one, since a small colony's
   * depot can sit unused (see `PopulationScenario.storehouses`); a positive
   * reading is evidence of a live store site, a zero reading is not evidence
   * of the opposite. */
  storedAtEnd: number;
  /** The conservation sentinel. `conservationError` must be 0. */
  goods: GoodsAuditResult;
}

/**
 * A food drip, spliced in before StatsSystem exactly as
 * `captureDeliveredSystem` is in balance-harness.ts. `refund`, not `add`: this
 * is not a hauler delivery and must not inflate `deliveredRate` for bread.
 */
function foodDripSystem(perTick: number): TColonySystemFactory {
  return () => createSystem({ stockpile: WriteResource(Stockpile) })
    .withName('FoodDrip')
    .withRunFunction(({ stockpile }) => {
      if (perTick > 0) stockpile.refund('bread', perTick);
    })
    .build();
}

/** One colonist as the staffing stand-in sees them. */
interface StaffRow { id: number; age: Age; job: JobAssignment }

const isAdult = (age: Age): boolean => stageOf(age.ticks, BALANCE.lifeBands) === 'adult';

/** How many colonists each building currently has assigned. */
function staffedCounts(rows: readonly StaffRow[]): Map<number, number> {
  const staffed = new Map<number, number>();
  for (const { job } of rows) {
    if (job.buildingId !== null) staffed.set(job.buildingId, (staffed.get(job.buildingId) ?? 0) + 1);
  }
  return staffed;
}

/**
 * Top the hauling pool back up to `target`.
 *
 * HAULERS FIRST, and topped back up as they retire: the founding haulers all
 * start at `matureTicks`, so they are stood down together about 4,500 ticks in.
 * If nobody replaced them, delivery would stop for the remaining two-thirds of
 * a long run and the colony would starve because of the harness rather than
 * because of the balance under measurement.
 */
function topUpHaulers(rows: readonly StaffRow[], target: number): void {
  let haulers = rows.filter(({ age, job }) => job.hauling && isAdult(age)).length;
  for (const { age, job } of rows) {
    if (haulers >= target) return;
    if (job.hauling || job.buildingId !== null || !isAdult(age)) continue;
    job.hauling = true;
    haulers++;
  }
}

/** Free work slots per building, lowest building id first. A house has
 * `workerSlots: 0`, so it never yields an opening. */
function openSlots(
  buildings: Iterable<{ building: Building; slots: WorkerSlots }>, staffed: ReadonlyMap<number, number>,
): [number, number][] {
  return [...buildings]
    .map(({ building, slots }): [number, number] => [building.id, slots.max - (staffed.get(building.id) ?? 0)])
    .filter(([, free]) => free > 0)
    .sort((a, b) => a[0] - b[0]);
}

/** Put every remaining idle adult into the lowest-id building with room.
 * `openings` entries are decremented in place, so a building fills before the
 * next colonist is offered it. */
function fillOpenings(rows: readonly StaffRow[], openings: [number, number][]): void {
  for (const { age, job } of rows) {
    if (job.buildingId !== null || job.hauling || !isAdult(age)) continue;
    const opening = openings.find(([, free]) => free > 0);
    if (opening === undefined) return;
    job.buildingId = opening[0];
    opening[1]--;
  }
}

/**
 * Stands in for the player under `'chain'`: every tick, put any idle adult to
 * work in a hut with a free slot.
 *
 * The instrument needs this because nothing in the engine assigns anyone —
 * colonists are born unassigned and the player staffs them. Without a stand-in
 * the chain would be worked only by the founders, every child would grow up
 * idle, and the run would measure a colony that starves as it grows, which is
 * an artefact of the harness rather than a property of the balance. Stated here
 * as a limitation, in the same spirit as balance-harness.ts's FED berry stock:
 * this models an *attentive* player, so it measures the best case the balance
 * allows.
 *
 * Rows are sorted by colonist id, not taken in entity-iteration order: the
 * whole instrument's value rests on two runs differing only in the variable
 * under test, and sim-ecs recycles storage as colonists die and are born.
 */
function autoStaffSystem(targetHaulers: number): TColonySystemFactory {
  return () => createSystem({
    colonists: queryComponents({ colonist: Read(Colonist), age: Read(Age), job: Write(JobAssignment) }),
    buildings: queryComponents({ building: Read(Building), slots: Read(WorkerSlots) }),
  })
    .withName('AutoStaff')
    .withRunFunction(({ colonists, buildings }) => {
      const rows: StaffRow[] = [...colonists.iter()]
        .map(({ colonist, age, job }) => ({ id: colonist.id, age, job }))
        .sort((a, b) => a.id - b.id);
      topUpHaulers(rows, targetHaulers);
      fillOpenings(rows, openSlots(buildings.iter(), staffedCounts(rows)));
    })
    .build();
}

/**
 * An empty colony: no starter house, no founders, no stock. `initialSave()`
 * ships a house at id 1 on the first plot and three founders at ids 2-4, all of
 * which would collide with what this harness places — and `nextEntityId: 1`
 * would mint those ids a second time.
 */
function blankSave(): SaveGameV6 {
  return { ...initialSave(), buildings: [], colonists: [], stockpile: {} as Partial<Record<ResourceId, number>>, nextEntityId: 1 };
}

/**
 * The colony's fabric: (under `'chain'`) the gatherers' huts that feed it, then
 * `houses` houses, laid down the map's own auto-placement sequence so the
 * layout is a function of the scenario alone. Berries need no input, so a hut
 * is the shortest real production loop the engine has.
 *
 * **Huts FIRST, houses after.** The order is the whole point: the sequence is
 * shared, so placing houses first would slide every hut along it by the number
 * of houses — and a bed-capped control would then also get shorter haul legs
 * and a cheaper commute than the roomy run it is compared against. The one
 * variable the comparison means to change would arrive bundled with two it
 * never asked for, both favouring the control. Placing the shared fixture first
 * pins the huts to the same tiles in every run of a comparison, whatever the
 * house count.
 *
 * Returns the house ids, in placement order — the founders move into the first
 * one so the run does not open on a homelessness penalty it never meant to
 * measure.
 */
function placeColony(prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, scenario: PopulationScenario): number[] {
  const spots = autoPlaceSequence(map);
  const place = (defId: 'house' | 'gatherersHut' | 'storehouse') => {
    const at: TileRef | void = spots.next().value;
    if (at === undefined) throw new Error('population harness: the map ran out of tiles');
    // `relocatingTicks: 0` is not optional on the way in — `SavedBuilding`
    // requires it and `spawnBuilding` only makes `id` and `buffer` optional.
    return spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
  };
  const huts = scenario.foodPerTick === 'chain' ? scenario.huts ?? 2 : 0;
  for (let i = 0; i < huts; i++) place('gatherersHut');
  const houseIds: number[] = [];
  for (let i = 0; i < scenario.houses; i++) houseIds.push(place('house').getComponent(Building)!.id);
  // Depots LAST — see PopulationScenario.storehouses for why the shared
  // fixture has to be pinned before the variable under test is added.
  for (let i = 0; i < (scenario.storehouses ?? 0); i++) place('storehouse');
  return houseIds;
}

/**
 * The founding adults, all at `matureTicks` and all homed into the first house.
 *
 * Haulers come OUT OF `startingAdults`; they are not extra. Spawning them on
 * top would mean `startingAdults: 2` really began with four adults, four mouths
 * and four beds taken — so "no births in the one-house control" would be a
 * fixture artefact rather than a measurement, and every reported population and
 * dependency figure would describe a different colony than the one requested.
 */
function spawnFounders(prep: IPreptimeWorld, ids: IdCounter, scenario: PopulationScenario, houseIds: readonly number[]): void {
  const haulers = scenario.foodPerTick === 'chain' ? scenario.haulers ?? 2 : 0;
  if (haulers > scenario.startingAdults) {
    throw new Error(`Scenario asks for ${haulers} haulers out of only ${scenario.startingAdults} adults`);
  }
  for (let i = 0; i < scenario.startingAdults; i++) {
    spawnColonist(prep, ids, { ageTicks: BALANCE.lifeBands.matureTicks, hauling: i < haulers, homeId: houseIds[0] ?? null });
  }
}

/** ALL_SYSTEMS with the scenario's food source spliced in immediately before
 * StatsSystem — the same seam balance-harness.ts uses for its observer, and the
 * one point at which a tick's flows are still intact. */
function systemsFor(scenario: PopulationScenario): TColonySystemFactory[] {
  const statsIndex = ALL_SYSTEMS.indexOf(StatsSystem);
  const injected = scenario.foodPerTick === 'chain'
    ? autoStaffSystem(scenario.haulers ?? 2)
    : foodDripSystem(scenario.foodPerTick);
  return [...ALL_SYSTEMS.slice(0, statsIndex), injected, ...ALL_SYSTEMS.slice(statsIndex)];
}

/** The engine's own account of what happened this tick. Notices are cleared
 * each snapshot, so they are counted per tick rather than summed at the end. */
function tallyNotices(messages: readonly string[], counts: { births: number; oldAge: number; starved: number }): void {
  for (const message of messages) {
    if (message.includes('was born')) counts.births++;
    else if (message.includes('died of old age')) counts.oldAge++;
    else if (message.includes('starved')) counts.starved++;
  }
}

/**
 * Run the colony and sample its shape.
 *
 * The loop is deliberately driven by the SNAPSHOT's own tick rather than by
 * `step`, and it stays that way now that OBS-6-02 is fixed — as a detector
 * rather than as a workaround.
 *
 * What it was written for: while the engine batched entity removals through
 * sim-ecs's command queue, a die-off of `n` colonists cost `n - 1` steps in
 * which no system ran at all and `SnapshotStore.latest` was the same object as
 * the step before. Read naively, the instrument reported that as extra deaths
 * — the first draft of this runner counted `deathsByStarvation: 9` for a
 * three-colonist colony, because it re-read one frozen snapshot's three
 * notices on each of the two frozen steps.
 *
 * Removals drain after `step()` now, so `snapshot.tick` moves on every step
 * and `frozenSteps` is 0 in every scenario. Keeping the check costs four
 * lines and is the only thing that would notice a stalled tick coming back:
 * the symptom is a *quietly* wrong measurement, never an error.
 */
export async function runPopulationScenario(scenario: PopulationScenario): Promise<PopulationResult> {
  const save = blankSave();
  // The sentinel's probes are spliced into the pipeline beside the scenario's
  // own food source, displacing nothing — see GoodsAudit.
  const audit = new GoodsAudit();
  const prep = buildColonyPrepWorld({ save, systems: audit.instrument(systemsFor(scenario)) });
  const ids = getPrepResource(prep, IdCounter);
  spawnFounders(prep, ids, scenario, placeColony(prep, ids, save.map, scenario));
  const world = await prep.prepareRun();
  const stockpile = world.getResource(Stockpile);
  audit.open(world.getResource(SnapshotStore).latest!, stockpile);

  const samples: PopulationSample[] = [];
  const counts = { births: 0, oldAge: 0, starved: 0 };
  let simulated = 0;
  let frozenSteps = 0;
  let nextSample = scenario.sampleEvery;
  for (let step = 0; step < scenario.ticks; step++) {
    await stepTick(world);
    // Unconditional, and before the frozen-step guard: a frozen step ran no
    // system at all, so its probes never fired and the sentinel's windows
    // would be read twice. That cannot happen while `frozenSteps` is 0, which
    // is exactly what the guard below is there to keep true.
    audit.closeTick();
    const snapshot = world.getResource(SnapshotStore).latest!;
    if (snapshot.tick === simulated) {
      frozenSteps++;
      continue;
    }
    simulated = snapshot.tick;
    tallyNotices(snapshot.notices.map((n) => n.message), counts);
    if (simulated < nextSample) continue;
    // A `while`, not `+=`, for the same reason `frozenSteps` is still counted:
    // a stalled tick would carry the clock past a whole sample point, and a
    // fixed stride would then emit that sample late and every later one at the
    // wrong offset. Equivalent to `+=` while nothing stalls, which is now.
    while (nextSample <= simulated) nextSample += scenario.sampleEvery;
    samples.push({
      tick: simulated,
      children: snapshot.demographics.children,
      adults: snapshot.demographics.adults,
      elders: snapshot.demographics.elders,
      mealsPerHead: snapshot.mealsPerHead,
      starving: snapshot.colonists.filter((c) => c.starvingTicks > 0).length,
    });
  }

  const last = samples.at(-1) ?? { children: 0, adults: 0, elders: 0 };
  const snapshot = world.getResource(SnapshotStore).latest!;
  return {
    samples,
    births: counts.births,
    deathsByOldAge: counts.oldAge,
    deathsByStarvation: counts.starved,
    dependencyRatio: last.adults === 0 ? Infinity : (last.children + last.elders) / last.adults,
    frozenSteps,
    storedAtEnd: snapshot.buildings.reduce((sum, b) => sum + b.stored, 0),
    goods: audit.close(snapshot, stockpile),
  };
}
