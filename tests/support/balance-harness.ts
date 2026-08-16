import type { IPreptimeWorld, IRuntimeWorld } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../src/shared/content-types';
import type { HaulPhase } from '../../src/shared/haul';
import type { SaveGameV7 } from '../../src/shared/save';
import type { ColonistSnapshot, Snapshot } from '../../src/shared/snapshot';
import { haulTicks } from '../../src/shared/haul';
import { autoPlacePosition, isTileBuildable, type TileRef, type WorldMapSize } from '../../src/shared/placement';
import { BALANCE } from '../../src/engine/content/balance';
import { BUILDINGS } from '../../src/engine/content/buildings';
import { Building, Colonist, HaulTrip } from '../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../src/engine/resources';
import {
  ALL_SYSTEMS, applyRemovals, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../src/engine/world';
import { campAdjacentFreeTile, enqueue } from '../engine/fixtures';
import { GoodsAudit, type GoodsAuditResult } from './goods-audit';

/**
 * One building being measured: what it is, where it stands, and who works it.
 *
 * A `Scenario` is one of these plus the run's own settings, so the
 * single-building form every increment-5 measurement is written in stays
 * exactly what it was — the sweep is the control for spec §4's first question,
 * and a control that had to be rewritten is not one.
 */
export interface ScenarioStage {
  defId: BuildingDefId;
  col: number;
  row: number;
  crew: number;
  /** The output resource to measure for this stage. */
  resource: ResourceId;
  /**
   * Put this stage's crew house at THIS tile instead of beside their building —
   * the only way to vary commute while holding everything else fixed, which is
   * what a "a distant house costs delivered goods" measurement needs. Task 12
   * depends on `runScenario` actually reading it; a `Scenario` field the
   * runner ignores makes the near and far worlds identical, so the test can
   * never fail and proves nothing.
   */
  crewHouseAt?: TileRef;
}

/**
 * A balance experiment, reproducible from this descriptor alone: one or two
 * buildings at fixed tiles, a fixed crew and hauler count, run for a fixed
 * number of ticks.
 *
 * The instrument exists because increment 4 documented three constants as
 * "starting points, tuned in increment 5" and nothing could check the claim —
 * the engine is headless and deterministic, but nothing ran it as an
 * experiment. See docs/superpowers/specs/2026-08-01-increment-5-validated-balance.md.
 */
export interface Scenario extends ScenarioStage {
  haulers: number;
  ticks: number;
  /**
   * A SECOND building, fed by the first — a forester feeding a sawmill at a
   * distance, which is the shape spec §4's first two questions are asked in.
   * Increment 5's gradient describes raw producers only, because a raw
   * producer was the only kind whose real cost the simulation charged.
   *
   * When present, the chain has to feed ITSELF: any resource a stage of this
   * scenario produces is left out of the seeded stock (see
   * `seededResourcesFor`), so the sawmill's wood comes from the forester by
   * hauler rather than from an inexhaustible camp pile. Without that, a
   * two-stage descriptor would measure two independent buildings that happen
   * to be listed together.
   */
  second?: ScenarioStage;
  /**
   * Storehouses to place, at tiles the scenario chooses. Spec §4's second
   * question is a crossover distance — the leg beyond which 20 wood and 10
   * planks buys more throughput than another hauler does — and that is
   * measured by running the same chain with and without a depot beside it.
   */
  storehouses?: TileRef[];
  /** Optionally relocate the FIRST building mid-run, to measure what downtime
   * costs. */
  moveTo?: { col: number; row: number; atTick: number };
  /**
   * Construction sites this scenario orders mid-run: one `constructBuilding`
   * command per entry, issued the tick named — the only way a balance
   * scenario can put a site on the map at all, since every OTHER building
   * this harness places (`placeBuilding`) is spawned finished, straight into
   * the prep world, and never passes through `ConstructionSystem`'s
   * countdown.
   *
   * Each site's tile is reserved in `occupied` before any house is placed
   * (same treatment as `moveTo` and `storehouses`), so a crew or hauler house
   * can never be planted on a tile a later tick is about to order a site
   * onto. Cost is charged on DELIVERY, not on this order — `handleConstructBuilding`
   * moves no goods — so a house is the only thing this field must keep
   * clear of.
   */
  sites?: { defId: BuildingDefId; col: number; row: number; atTick: number }[];
  /**
   * House the crew beside their building and the haulers beside the camp, so
   * commute is held at its neutral value (1.0, inside BALANCE.commute
   * .freeTiles) and this instrument keeps measuring logistics rather than
   * housing. Same principle as the FED berry stock holding hunger neutral.
   *
   * Defaults to `true`: housed and commute-neutral, preserving increment 5's
   * numbers exactly. Deliberately NOT keyed off `moveTo` — housing uniformity
   * is a property of the COMPARISON a scenario is measured against, not of
   * any single scenario, and no per-scenario default can supply that. A
   * relocation comparison's stationary controls (`from`/`to`) carry no
   * `moveTo` of their own, so a default keyed on "does THIS scenario have a
   * moveTo" silently houses the controls while leaving only the mover
   * unhoused — manufacturing, by construction, exactly the confound this
   * field exists to rule out: `moved.made < from.made` would then compare a
   * homeless run against two housed ones, and would stay green even if
   * relocation downtime stopped costing production entirely, because most of
   * the gap would be the homelessFactor penalty rather than the downtime.
   *
   * So a relocation comparison must pass `houseCrew: false` explicitly to
   * EVERY call it makes (see `relocating` in balance.test.ts) — uniformity is
   * the caller's job, because only the caller knows which runs belong to the
   * same comparison. Uniform-UNhoused, not uniform-housed: a moveTo scenario
   * houses its crew beside the building's STARTING tile, and increment 5's
   * relocation case moves from (10,0) to (3,7), ~9.9 tiles apart — there is
   * no tile inside BALANCE.commute.freeTiles of both endpoints, so after the
   * move the crew would carry a large commute penalty neither stationary
   * control pays, the same confound in the other direction. Unhoused,
   * `commuteFactor` returns the flat `homelessFactor` regardless of tile (see
   * production-system.ts), so all three runs in the comparison pay the exact
   * same penalty and the only variable left is the downtime — neutrality of
   * the COMPARISON, which is what a control needs, rather than neutrality of
   * the absolute number.
   */
  houseCrew?: boolean;
  /**
   * The age every colonist this scenario spawns starts at, defaulting to
   * `spawnColonist`'s own `BALANCE.startingAgeTicks` (2,500) — a founder a
   * quarter of the way through life.
   *
   * A run's turnover horizon is a function of exactly this number, which is
   * what the field is for: at the default, retirement lands at ELAPSED tick
   * 3,000 (`retireTicks - startingAgeTicks`) and the earliest old-age death at
   * 3,200 (`lifespanTicks - spreadTicks - startingAgeTicks`), so a longer run
   * measures replacement as well as logistics. `BALANCE.lifeBands.matureTicks`
   * buys a young workforce and moves those two to 4,500 and 4,700.
   *
   * BOTH ARMS OF A COMPARISON MUST PASS THE SAME VALUE, for the reason
   * `houseCrew` documents at greater length: uniformity is a property of the
   * comparison, so a pair differing here compares two demographics rather than
   * the variable under test. Whether a run actually stayed inside its window is
   * not left to the arithmetic above — `BalanceResult.retirements` and
   * `.deaths` report it, and §4.2 asserts those rather than trusting a sum.
   */
  ageTicks?: number;
}

/** Everything measured about ONE building of a scenario. */
export interface StageResult {
  defId: BuildingDefId;
  resource: ResourceId;
  /**
   * GROSS production, read off `ProductionLedger` — every unit this stage's
   * recipe banked into an output buffer, whatever became of it afterwards.
   *
   * Derived from the production record rather than reconstructed from where
   * the goods are standing, and that is the whole point. Until increment 7
   * this was `delivered + finalBuffer + everything in every hauler's hands`,
   * on the reasoning that anything made had either reached the store, was
   * still in the buffer, or was in a hauler's hands. That was sound while a
   * hauler could only ever be carrying the measured building's OUTPUT.
   * Two-way haul falsified the premise without touching the line: six wood
   * walking TOWARD a sawmill read as six planks the sawmill had produced, and
   * it inflated precisely in the scenarios this increment adds, since those
   * are the ones with supply trips in flight. Every §4 figure that divides by
   * `made` inherited it.
   */
  made: number;
  /**
   * Cumulative hauler inflow — the running sum of every deposit HaulSystem
   * banked into the stockpile, NOT the stockpile's net change over the run.
   * Net change also nets out whatever any consumer (HungerSystem, chiefly)
   * took from the same resource, which understates delivery for any measured
   * resource that is also eaten, and can go negative with no haulers keeping
   * up. A gatherer's hut measuring berries — its own output — is exactly that
   * case: crew hunger eats the same resource the hut makes.
   */
  delivered: number;
  /** Ticks this building spent in `outputFull`. */
  stalledTicks: number;
  /**
   * Ticks this building spent in `waitingForInput` — the headline diagnostic
   * of the whole increment (spec §2.1), and 0 by construction for a raw
   * producer, which is why §4 expects its gradient to be unchanged.
   */
  waitingForInputTicks: number;
  /** Units still waiting in this building's OUTPUT buffer at the end. */
  finalBuffer: number;
  /** Units still waiting in its IN-tray at the end. */
  finalInputBuffer: number;
  /** One-way trip length in ticks from the CAMP to this stage's starting tile,
   * for reference. A depot may make the walk a hauler actually takes shorter;
   * this stays the camp-relative figure increment 5's gradient is indexed on. */
  legTicks: number;
  /**
   * Units the crew could produce with hauling never a constraint, assuming
   * baseline work power of 1 per fed, untooled crew member. A `workshop`
   * scenario breaks that assumption: recipe inputs are seeded, so it can
   * produce and deliver its own `tools`, which EfficiencySystem then spends
   * to grant its own crew the 1.5x tool multiplier — work power this figure
   * never counted. For that one case, `ceiling` is a lower bound, not a
   * ceiling. For a stage FED BY ANOTHER STAGE it is a ceiling in the strict
   * sense and an unreachable one: the chain, not the crew, is the constraint.
   */
  ceiling: number;
}

/**
 * How a run's hauler-ticks were spent. Spec §4's third question asks for the
 * split between the kinds of job and for the fetch leg's share — a supply trip
 * is three legs where the discarded base model made it two, and the first buys
 * nothing but position.
 *
 * `transfer` is the fourth category, added the moment `chooseJob` gained its
 * third offer (Task 6) — earlier than the plan put it, because the guard that
 * used to stand in its place THREW, and it fired on the tick transfers started
 * running rather than waiting to be scheduled. That is what it was for: a
 * silent 0-guess would have left three depot scenarios quietly reporting a
 * hauler-tick split that omitted a whole kind of trip.
 *
 * A transfer only exists where a bounded site does, so every scenario without a
 * storehouse reports 0 here — which is a fact about the fixture, not a gap.
 */
export interface HaulerTicks {
  idle: number;
  fetching: number;
  outbound: number;
  returning: number;
  collect: number;
  supply: number;
  transfer: number;
}

export interface BalanceResult extends StageResult {
  /** Per-building figures, `stages[0]` first. The fields above alias
   * `stages[0]`, so every single-building measurement written before this
   * increment reads exactly what it always did. */
  stages: StageResult[];
  /** Ticks the FIRST building spent out of action after a move. */
  relocatingTicks: number;
  /** Hauler-ticks spent with no trip at all (over-provisioning). Aliases
   * `haulerTicks.idle`. */
  haulerIdleTicks: number;
  haulerTicks: HaulerTicks;
  /** Supply trips that turned for home, and how many of those turned for home
   * LOADED — the round trip §2.5 is named for. Worth its complexity only if
   * the second number is not near zero. */
  supplyReturns: number;
  supplyReturnsLoaded: number;
  /**
   * Transfers DISPATCHED over the run, and the two classes of §2.2's pull rule
   * counted separately, because §4.2 must be able to say which half did the
   * work.
   *
   * **An EDGE counter, and `haulerTicks.transfer` is not one.** That bucket
   * increments once per active hauler-tick — exactly right for a hauler-tick
   * split and exactly wrong as a count, because it weights a long route more
   * heavily than a short one, so three slow transfers would outscore six quick
   * ones. This counts the tick a hauler's trip crosses from `idle` to
   * `fetching` on a transfer job, which is where `chooseJob` decided. Both
   * instruments are wanted; they answer different questions.
   *
   * The class comes off `HaulTrip.staging`, read from the live trip at that
   * tick and never re-derived from the route: a depot -> camp move is
   * legitimately either class (§2.2 makes the camp an ordinary site in the pull
   * rule), so route-based attribution would be wrong rather than approximate.
   * The snapshot deliberately does not carry the flag and must not gain it —
   * this harness builds the world itself, so it samples the component.
   *
   * Exact for every scenario this harness can express, and `dispatchedTransfer`
   * carries the argument for that claim along with the one condition — a
   * mid-tick cancel-and-redispatch, OBS-8-01 — that would void it.
   */
  transfers: number;
  transfersStaging: number;
  transfersDrain: number;
  /**
   * The SAME trips counted at the opposite turn: the `-> returning` edge on a
   * transfer job, once per trip that reached its source and loaded.
   *
   * A second derivation of `transfers`, published because it is the only thing
   * that pins that field to being an EDGE count rather than a plausible
   * magnitude. Asserting `haulerTicks.transfer > transfers` catches only the
   * degenerate case where the two are equal; the likeliest wrong
   * implementation — counting every tick in `fetching` on a transfer job —
   * still reads well below the bucket and passes. It cannot agree with this,
   * because turning for home happens once per trip however long the walk.
   *
   * The two can legitimately differ, and only in one direction: a trip still
   * walking out when the run ends has been dispatched and has not yet turned
   * (at most one per hauler), and a transfer whose source is spent by the time
   * it arrives cancels where it stands rather than turning (`transferOnward`
   * in haul-system.ts). So `transfers - transferReturns` is a small
   * non-negative number, not necessarily zero.
   *
   * That difference going NEGATIVE is not a legitimate outcome, it is the
   * signature of a missed dispatch: this edge is `before !== 'returning'` where
   * the dispatch edge is `before === 'idle'`, so the loose form survives a
   * cancel-and-redispatch tick that the strict one does not (OBS-8-01). No
   * scenario this harness can express reaches it — see `dispatchedTransfer`.
   */
  transferReturns: number;
  /**
   * `haulerTicks.transfer` split by the same `HaulTrip.staging` flag the
   * dispatch counts are split by — the WALKING each class cost, beside the
   * number of trips each class dispatched.
   *
   * Published because §2.6's ordering makes the two classes cost different
   * things and a single bucket can no longer answer the question §4.2 asks of
   * it. Staging is offered LAST, behind collect, so its ticks come out of what
   * would otherwise be idle time; a drain is offered AHEAD of collect, so its
   * ticks are by construction taken from collect. "Transfers are paid for out
   * of idle time" is now a claim about staging alone, and checking it against a
   * bucket holding both classes would confirm or deny it on the wrong number.
   *
   * A partition of `haulerTicks.transfer`, not a second tally beside it: both
   * count one per hauler per non-idle tick on a transfer job, the first from
   * the snapshot's published leg and this from the live trip. They are asserted
   * equal in `tests/engine/balance.test.ts` rather than assumed, because they
   * are read from different places and nothing else would notice them drifting.
   *
   * A TICK bucket and not a count, exactly as `haulerTicks.transfer` is — see
   * `transfers` for why the two instruments are both wanted and must not be
   * substituted for one another.
   */
  transferTicks: { staging: number; drain: number };
  /** Units in haulers' hands when the run ended. Published because it is
   * exactly the term the old `made` wrongly added to every stage's total. */
  carriedAtEnd: number;
  /** Units held by this scenario's storehouses at the end. 0 with no depot. */
  storedAtEnd: number;
  /**
   * `storedAtEnd` sampled every tick instead of once: one entry per tick of the
   * run, so `storedSeries.at(-1)` is `storedAtEnd` by construction.
   *
   * Acceptance criterion 4 is about TURNOVER, and a single closing level cannot
   * distinguish a depot that never filled from one that filled and drained —
   * both report a small number. The series can: it rises and falls, and a
   * measurement that wants "did this depot cycle" reads its peak against its
   * end rather than its end against a capacity.
   */
  storedSeries: number[];
  /**
   * Old-age and starvation deaths, and retirements, inside this run's own
   * window — the instrument that makes the horizon arithmetic on
   * `Scenario.ageTicks` unnecessary rather than merely written down.
   *
   * §4.2 asserts both are 0 at every horizon it measures a with/without-depot
   * pair at, rather than trusting a prose claim about which horizons are safe:
   * a colonist who retires stops working and one who dies stops existing, and
   * either turns a logistics comparison into a demographic one. Computing the
   * bound by hand is what put an invalid 4,800-tick reading in the spec; a
   * computed bound fails silently the next time a constant moves, an asserted
   * one fails loudly.
   *
   * ONE COUNT, TWO CAUSES, and the name says less than the field does: a
   * STARVED colonist is counted here beside one who died of old age, because
   * either one leaves the run a worker short and that is what this is asked.
   * Today they cannot be confused — every balance scenario seeds `berries` at
   * FED (see SEEDED_RESOURCE_IDS), which is far past what any crew here can eat
   * in any run, so hunger never kills and every death reported is an old-age
   * one. A future scenario that deliberately runs the food down would make the
   * number ambiguous, and should split the two causes rather than quietly
   * reinterpret this one.
   */
  deaths: number;
  retirements: number;
  /** The conservation sentinel. `conservationError` must be 0. */
  goods: GoodsAuditResult;
  /**
   * Every site `Scenario.sites` ordered that finished inside the run,
   * IN THE ORDER THEY COMPLETED — a LOG, not a count. §4.1's convergence
   * question is about ORDER (which site's countdown finishes first when two
   * are contending for the same haulers), and a count cannot express that: a
   * scenario where site B finishes before site A and one where A finishes
   * before B would report the same length-2 array under a count, and only
   * the sequence published here tells them apart.
   *
   * `[]` for a scenario with no `sites` — the zero side, and the one that
   * catches an instrument that over-counts: a completion log that fires on
   * something other than a genuine `ticksLeft: 30 -> 0` transition (a
   * building spawned already finished, say) would report a false entry here
   * with nothing in `sites` to have produced it.
   */
  completions: { buildingId: number; defId: BuildingDefId; tick: number }[];
}

/**
 * Stock level for every seeded resource (see SEEDED_RESOURCE_IDS): large
 * enough that neither hunger nor a recipe's input can ever run it dry over
 * any scenario this harness runs.
 */
const FED = 1_000_000;

/**
 * Resources this instrument seeds at FED: `berries`, so HungerSystem never
 * starves the crew, plus every resource that is a recipe INPUT somewhere in
 * the catalog (today wheat, flour, wood, and planks — mill, bakery, sawmill,
 * and workshop, respectively) so ProductionSystem can always pay a batch's
 * cost. A scenario against any of those four used to silently report zero
 * production against a positive `ceiling`, for want of a raw material this
 * instrument never supplied. Derived from BUILDINGS rather than hand-listed,
 * so a future recipe change cannot drift out of sync with what actually needs
 * seeding.
 *
 * Deliberately NOT every `ResourceId`. `tools` is one but is never a recipe
 * input — EfficiencySystem spends it on an unrelated mechanic, granting
 * `BALANCE.toolMultiplier` (1.5x) work power while a worker stays tooled,
 * gated only on stock being available. Seeding it was tried and measured:
 * the (10,0) forester regression scenario jumped from 128 to 195 delivered,
 * because every worker is permanently tooled instead of never tooled, which
 * is what an unmodified run gets today — a real change to an existing
 * measurement, not just a generalisation of the instrument. `bread` is the
 * other non-input `ResourceId`; seeding it measured harmless (hunger never
 * crosses `colonistEfficiency`'s threshold under either meal choice — see
 * BALANCE.mealThreshold), but it stays out on the same principle: it is not
 * a recipe input, so seeding it is not this fix's job.
 */
const SEEDED_RESOURCE_IDS: readonly ResourceId[] = [
  ...new Set<ResourceId>([
    'berries',
    ...Object.values(BUILDINGS).flatMap((def) => Object.keys(def.recipe?.inputs ?? {}) as ResourceId[]),
  ]),
];

/**
 * What this run seeds, at FED apiece.
 *
 * A ONE-STAGE scenario seeds everything in SEEDED_RESOURCE_IDS, exactly as it
 * always has, so increment 5's sweep measures the world it was calibrated on.
 *
 * A CHAIN seeds neither of its own outputs. Leaving the sawmill's wood at FED
 * would let it draw an inexhaustible pile from the camp and never notice the
 * forester at all — two independent buildings that happen to be listed
 * together, and no chain to measure. `berries` is never a stage output in any
 * scenario §4 asks for, so hunger stays neutral either way; a scenario that
 * measured a gatherer's hut in a chain would have to feed its crew from its
 * own hut, which is a different experiment and would say so.
 */
function seededResourcesFor(stages: readonly ScenarioStage[]): ResourceId[] {
  if (stages.length < 2) return [...SEEDED_RESOURCE_IDS];
  const produced = new Set(stages.map((stage) => stage.resource));
  return SEEDED_RESOURCE_IDS.filter((id) => !produced.has(id));
}

/**
 * A buildable free tile inside BALANCE.commute.freeTiles of `at` — where a
 * crew house goes. Proximity is the point: commuteFactor is exactly 1 there,
 * so every increment-5 measurement is preserved by construction rather than by
 * luck.
 *
 * The candidate order opens on `col + 1`, which is the tile the single-building
 * form always used, so every existing measurement keeps the layout it was taken
 * with. The alternatives exist for the second stage: two buildings a couple of
 * tiles apart can want the same neighbouring plot, and `spawnBuilding` writes
 * tiles directly without consulting `isTileBuildable`, so a collision would
 * silently stack two buildings rather than fail.
 */
function commuteFreeTile(map: WorldMapSize, at: TileRef, occupied: readonly TileRef[]): TileRef {
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  for (const [dc, dr] of offsets) {
    const tile = { col: at.col + dc, row: at.row + dr };
    if (isTileBuildable(map, occupied, tile.col, tile.row)) return tile;
  }
  throw new Error(`balance harness: no free commute-neutral tile beside (${at.col},${at.row}) for a crew house`);
}

/**
 * Enough real shelter for `group` colonists. The FIRST house lands on
 * `preferred` — a tile the caller chose to be inside BALANCE.commute.freeTiles
 * of wherever that group works, so their commuteFactor is exactly 1 and this
 * instrument keeps measuring logistics rather than housing. Any overflow house
 * falls back to autoPlacePosition, which is arbitrary and therefore NOT
 * commute-neutral; runScenario refuses a group that would need one.
 *
 * `occupied` is mutated as each house is placed, so a second house never lands
 * on the first — and so the caller's next call (the haulers' house) can see
 * this one. spawnBuilding writes tiles directly without consulting
 * isTileBuildable, so nothing else would catch a stack.
 *
 * A real house, not a sentinel homeId reusing the measured building's own
 * id: this harness runs ALL_SYSTEMS, so PopulationSystem's rehome executes
 * every tick and evicts any Home pointing at a building that isn't an actual
 * shelter (rehome's `shelter === undefined` branch) — a fake homeId would be
 * evicted on tick 1, leaving the group homeless (and at half work power or
 * half carry capacity) for the rest of the run, and silently invalidating
 * every threshold this instrument is calibrated against.
 *
 * Split out of runScenario purely to keep its own cognitive complexity under
 * the gate — same principle as population-handlers.ts's rehome splitting
 * into freeBeds/settleExistingHome/claimOpening.
 */
function spawnShelters(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, group: number, occupied: TileRef[], preferred: TileRef,
): number[] {
  const homeIds: number[] = [];
  while (homeIds.length * BALANCE.houseBeds < group) {
    const at = homeIds.length === 0 ? preferred : autoPlacePosition(map, occupied);
    if (at === null) throw new Error('balance harness: no free tile left for a shelter house');
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
    homeIds.push(house.getComponent(Building)!.id);
    occupied.push(at);
  }
  return homeIds;
}

/**
 * Where each colonist of a group sleeps: houses fill in order, houseBeds
 * apiece, and an unhoused group (relocation scenarios) reports null for
 * everyone. Named so the two spawn loops below read the same way.
 */
function homeOf(homeIds: readonly number[], index: number): number | null {
  return homeIds[Math.floor(index / BALANCE.houseBeds)] ?? null;
}


/** The buildings this scenario measures, first stage first. */
function stagesOf(scenario: Scenario): ScenarioStage[] {
  return scenario.second === undefined ? [scenario] : [scenario, scenario.second];
}

/** One building on the map, with an empty batch and an empty buffer. Shared by
 * the stages, the storehouses and (through spawnShelters) the houses, so no
 * caller can forget a field `SavedBuilding` requires. */
function placeBuilding(prep: IPreptimeWorld, ids: IdCounter, defId: BuildingDefId, at: TileRef): number {
  const entity = spawnBuilding(prep, ids, {
    defId, progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0,
  });
  return entity.getComponent(Building)!.id;
}

/**
 * Where each group sleeps: a commute-neutral house apiece per stage, plus one
 * for the haulers, or nowhere for a relocation scenario. Empty lists mean an
 * unhoused group, which `homeOf` turns into a null home for everyone in it.
 *
 * Separate from `populateColony` below because these are two questions, not
 * one — where the houses go, and who gets spawned into them — and folding
 * them together put the pair over the CRAP gate at cyclomatic 10. Every
 * branch in this harness lives on this side of the split; the spawning side
 * has none.
 *
 * `occupied` arrives already holding every building tile this scenario has
 * placed — both stages, any move destination, and every storehouse — because
 * `spawnBuilding` writes tiles directly without consulting `isTileBuildable`
 * and nothing else would catch a house stacked on a depot.
 */
function shelterPlan(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, scenario: Scenario, stages: readonly ScenarioStage[],
  occupied: TileRef[],
): { crew: number[][]; haulers: number[] } {
  // Commute-neutral by default — see Scenario.houseCrew for why this cannot
  // be keyed off moveTo: uniformity is a property of the comparison the
  // caller is building, not of this one scenario, so the caller (not this
  // default) must pass houseCrew explicitly to every run in a comparison
  // that needs uniform housing.
  if (!(scenario.houseCrew ?? true)) return { crew: stages.map(() => []), haulers: [] };
  // One house holds BALANCE.houseBeds and the largest group this instrument
  // runs is 4, so a single commute-neutral house per group suffices. Asserted
  // rather than assumed: spawnShelters places any overflow house with
  // autoPlacePosition, i.e. outside the free radius, and that group would then
  // quietly start paying a commute that moves every measurement here.
  if (Math.max(scenario.haulers, ...stages.map((stage) => stage.crew)) > BALANCE.houseBeds) {
    throw new Error('balance harness: a group needs more beds than one house provides — place a second commute-neutral house before measuring');
  }
  // crewHouseAt wins when given; otherwise beside the building, which lands
  // inside BALANCE.commute.freeTiles and scores exactly 1.0. Stage by stage in
  // order, and the haulers' house LAST, so each resolution sees every house
  // already placed in `occupied` and cannot stack on one.
  const crew = stages.map((stage) => spawnShelters(
    prep, ids, map, stage.crew, occupied, stage.crewHouseAt ?? commuteFreeTile(map, stage, occupied),
  ));
  return { crew, haulers: spawnShelters(prep, ids, map, scenario.haulers, occupied, campAdjacentFreeTile(occupied)) };
}

/**
 * The colony this measurement runs on: each stage's crew at their own
 * building, the haulers at the camp, each in the home `shelterPlan` assigned
 * them.
 *
 * Split out of `runScenario` for the reason `spawnShelters` was split out of
 * it in the previous task: housing is the third concern that function had
 * accumulated (world setup, population, then the 600-tick measurement loop).
 * Same remedy as `rehome` splitting into freeBeds/settleExistingHome/
 * claimOpening — extract the named thing, leave the baseline alone.
 */
function populateColony(
  prep: IPreptimeWorld, ids: IdCounter, map: WorldMapSize, scenario: Scenario, stages: readonly ScenarioStage[],
  buildingIds: readonly number[], occupied: TileRef[],
): void {
  const homes = shelterPlan(prep, ids, map, scenario, stages, occupied);
  // `spawnColonist` falls back to BALANCE.startingAgeTicks on undefined, so an
  // unset `ageTicks` spawns exactly the founders every earlier measurement was
  // taken with — see Scenario.ageTicks for what setting it moves.
  const ageTicks = scenario.ageTicks;
  stages.forEach((stage, index) => {
    for (let i = 0; i < stage.crew; i++) {
      spawnColonist(prep, ids, { buildingId: buildingIds[index], homeId: homeOf(homes.crew[index], i), ageTicks });
    }
  });
  for (let i = 0; i < scenario.haulers; i++) {
    spawnColonist(prep, ids, { hauling: true, homeId: homeOf(homes.haulers, i), ageTicks });
  }
}

/** Running per-building state counts. Named rather than inlined so the tick
 * loop below stays a list of one-line readings. */
interface StageTally { stalled: number; waiting: number }

function tallyStates(snapshot: Snapshot, buildingIds: readonly number[], tallies: StageTally[]): void {
  buildingIds.forEach((id, index) => {
    const state = snapshot.buildings.find((b) => b.id === id)?.state;
    if (state === 'outputFull') tallies[index].stalled++;
    if (state === 'waitingForInput') tallies[index].waiting++;
  });
}

/**
 * One tick of hauler bookkeeping: which leg every hauler is walking, on which
 * kind of job, and whether a supply trip that just turned for home turned
 * loaded.
 *
 * `phases` carries each hauler's previous leg between ticks, because a trip is
 * counted at the EDGE where it turns: counting ticks in `returning` would
 * report the length of the walk home rather than the number of round trips
 * that paid off, and those two numbers answer different questions.
 */
function tallyHaulers(
  colonists: readonly ColonistSnapshot[], ticks: HaulerTicks, phases: Map<number, HaulPhase>,
  returns: { total: number; loaded: number },
): void {
  for (const worker of colonists) {
    if (!worker.hauling) continue;
    ticks[worker.haulPhase]++;
    // Every kind, unguarded: `HaulerTicks` now has a bucket for each member of
    // `HaulKind`, which is what retired the throw that used to stand here.
    if (worker.haulKind !== null && worker.haulPhase !== 'idle') ticks[worker.haulKind]++;
    const turned = phases.get(worker.id) !== 'returning' && worker.haulPhase === 'returning';
    if (turned && worker.haulKind === 'supply') {
      returns.total++;
      if (worker.haulPickedUp) returns.loaded++;
    }
    phases.set(worker.id, worker.haulPhase);
  }
}

/** Transfers dispatched over a run, split by `HaulTrip.staging`, plus the same
 * trips counted again at the turn for home, plus the hauler-ticks each class
 * spent walking (`BalanceResult.transferTicks`). */
interface TransferTally {
  total: number; staging: number; drain: number; returned: number;
  stagingTicks: number; drainTicks: number;
}

/**
 * Whether THIS tick is the one a transfer was dispatched on: the `idle` ->
 * `fetching` edge, on a transfer job.
 *
 * `chooseJob` only ever runs on an idle trip and returns immediately after
 * (`continue` — "a trip dispatched this tick starts walking next tick"), and
 * every leg is at least one tick long, so the edge is observable at end of tick
 * exactly once per transfer. Counting ticks in `fetching` instead would report
 * the length of the walk out, which is `haulerTicks.transfer`'s question rather
 * than this one.
 *
 * ONE KNOWN BLIND SPOT, UNREACHABLE FROM THIS HARNESS TODAY (OBS-8-01). The
 * edge is sampled at END of tick, so the intermediate `idle` is invisible when
 * a trip is cancelled and re-dispatched inside a single tick. `CommandSystem`
 * runs before `HaulSystem` and cancels a `fetching` trip whose source is being
 * moved or demolished (and, for a demolition, an `outbound` one whose target
 * is), so `before` can read `fetching` (or `outbound`) with a brand-new
 * transfer already walking — the dispatch is missed, its `staging`/`drain`
 * class with it, and `transferReturns` then counts a turn for home that
 * `transfers` never counted, which is the one way that pair can invert. This
 * is measured, not conjectured: a hand-built world that moves a DEPOT out from
 * under a fetching hauler reproduces it on the first tick.
 *
 * Nothing a `Scenario` can express reaches it, which is why the predicate
 * stands as it is. The argument is the CONJUNCTION of the two facts below —
 * one per half of the path — and NEITHER IS SUFFICIENT ALONE, so a change that
 * falsifies either one voids it:
 *
 * - **Nothing measured demolishes.** `runScenario` issues exactly one command,
 *   `moveBuilding`, and only ever on `buildingIds[0]`. It has no way to
 *   demolish anything at all, and `runPopulationScenario` issues no commands
 *   whatsoever. That closes the `handleDemolishBuilding` half. Checkable in one
 *   step rather than taken on trust: `runScenario` below holds a single call to
 *   `enqueue`, and its command literal is `moveBuilding`.
 * - **The one command it does issue can never cancel.** `handleMoveBuilding`
 *   cancels only a `fetching` trip whose `sourceSiteId` is the moved building,
 *   and a `sourceSiteId` is a STORE SITE. A stage must have a recipe
 *   (`stageResultOf` throws otherwise) and no building in the catalog both
 *   stores and has a recipe, so `buildingIds[0]` is never a store site and the
 *   cancel branch cannot match. That closes the `handleMoveBuilding` half.
 *
 * Both are pinned by tests rather than left here as prose — see
 * balance-harness.test.ts, 'a stage the catalog gives no recipe yields no
 * result at all' (the throw, which is what makes "a stage has a recipe" true)
 * and 'a mid-run move cannot reach the transfer counter' (the catalog fact).
 * ONE HEDGE, STATED RATHER THAN GLOSSED: that throw fires from `stageResultOf`
 * AFTER the tick loop, so a `defId: 'storehouse'` stage — which the
 * `BuildingDefId` type permits — would run the whole simulation, blind spot
 * included, and only then reject. What is guaranteed is that no such run yields
 * a `BalanceResult`, which is what a published figure needs, not that the
 * defect never executes.
 *
 * A scenario that gains a demolition, or a `moveTo` that can name a storehouse,
 * makes this predicate unsound and must fix it before publishing a figure:
 * identify a DISTINCT TRIP (its route, class and planned amount together)
 * rather than a phase edge. Not by counting inside `beginTransfer` — the
 * increment's constraint is that nothing outside the trip remembers anything.
 */
function dispatchedTransfer(before: HaulPhase, trip: HaulTrip): boolean {
  return before === 'idle' && trip.phase === 'fetching' && trip.kind === 'transfer';
}

/**
 * Whether THIS tick is the one a transfer turned for home: the `-> returning`
 * edge, on a transfer job.
 *
 * The same trips as `dispatchedTransfer`, counted at the other end, and that
 * redundancy is the point — see `BalanceResult.transferReturns` for what the
 * cross-check buys and for the two ways the two counts may legitimately
 * disagree.
 */
function returnedTransfer(before: HaulPhase, trip: HaulTrip): boolean {
  return before !== 'returning' && trip.phase === 'returning' && trip.kind === 'transfer';
}

/**
 * This hauler's contribution to the class-split tick bucket
 * (`BalanceResult.transferTicks`): one per non-idle tick on a transfer job,
 * exactly the terms `tallyHaulers` counts `haulerTicks.transfer` on, but split
 * by a flag the snapshot does not carry.
 *
 * A LEVEL rather than an edge, which is why it takes no `before` phase and sits
 * outside `tallyTransfers`'s edge guards — and why it is a function of its own
 * rather than three more lines inside that loop: the quality gate scores
 * cognitive complexity per function, and the loop was already near its bar.
 */
function tallyTransferTick(trip: HaulTrip, tally: TransferTally): void {
  if (trip.kind !== 'transfer' || trip.phase === 'idle') return;
  if (trip.staging) tally.stagingTicks++;
  else tally.drainTicks++;
}

/**
 * One tick of transfer bookkeeping, read from the LIVE trip components rather
 * than from the snapshot.
 *
 * `HaulTrip.staging` is the only place a transfer's class survives — the
 * snapshot carries no site ids to reconstruct it from, and the route is not a
 * discriminator either — and it is deliberately not published: the snapshot is
 * the app's read model, no UI surface consumes the flag, and a published field
 * that only a test reads is what later looks load-bearing to someone deciding
 * what they may change. This harness builds the world itself, so it can ask the
 * component directly.
 *
 * `phases` is this function's own, separate from `tallyHaulers`'s: that one
 * follows the published leg, this one follows the trip, and sharing one map
 * would make each edge depend on which tally ran first.
 */
function tallyTransfers(world: IRuntimeWorld, tally: TransferTally, phases: Map<number, HaulPhase>): void {
  for (const entity of world.getEntities()) {
    const trip = entity.getComponent(HaulTrip);
    const colonist = entity.getComponent(Colonist);
    if (trip === undefined || colonist === undefined) continue;
    // A fresh trip is 'idle' (see HaulTrip's defaults), so an unseen hauler
    // counts as idle rather than as "no edge" — otherwise a transfer dispatched
    // on the very first tick would go unrecorded.
    const before = phases.get(colonist.id) ?? 'idle';
    phases.set(colonist.id, trip.phase);
    tallyTransferTick(trip, tally);
    if (returnedTransfer(before, trip)) tally.returned++;
    if (!dispatchedTransfer(before, trip)) continue;
    tally.total++;
    if (trip.staging) tally.staging++;
    else tally.drain++;
  }
}

/** Units this scenario's storehouses hold right now. One derivation, read by
 * the per-tick series and by the closing figure, so the two cannot disagree. */
function storedUnits(snapshot: Snapshot): number {
  return snapshot.buildings.reduce((sum, b) => sum + b.stored, 0);
}

/** Population turnover this tick, as the engine itself announced it. Notices
 * are cleared each snapshot, so they are counted per tick rather than summed at
 * the end. */
function tallyTurnover(snapshot: Snapshot, turnover: { deaths: number; retirements: number }): void {
  for (const { message } of snapshot.notices) {
    if (message.includes('died of old age') || message.includes('starved')) turnover.deaths++;
    else if (message.includes('retired')) turnover.retirements++;
  }
}

/** One construction site `Scenario.sites` ordered: its own descriptor, plus
 * the two things the tick loop learns about it as the run plays out —
 * `buildingId` (null until the ordering command has actually landed) and
 * `completed` (so a finished site is logged exactly once, however many more
 * ticks the run has left with its countdown sitting at 0). */
interface SiteState {
  defId: BuildingDefId;
  col: number;
  row: number;
  atTick: number;
  buildingId: number | null;
  completed: boolean;
}

/**
 * Issues the `constructBuilding` command for every site whose `atTick` is
 * THIS tick — split out of the loop for the same reason `tallySites` below
 * is, and for the same reason `issuingMove` stays a single inline check
 * while THIS is a function: one command per site, an unbounded number of
 * sites, so the loop it takes cannot be written as one line the way a single
 * `moveTo` check can.
 */
function issueSiteOrders(world: IRuntimeWorld, t: number, sites: readonly SiteState[]): void {
  for (const site of sites) {
    if (t === site.atTick) {
      enqueue(world, { type: 'constructBuilding', buildingDefId: site.defId, at: { col: site.col, row: site.row } });
    }
  }
}

/**
 * One tick of construction bookkeeping, split out of the tick loop for the
 * same reason `tallyHaulers` and `tallyTransfers` are: one concern per
 * function, and the loop stays a list of one-line readings.
 *
 * Resolves a just-ordered site's `buildingId` from the snapshot it first
 * appears in (there is no other way to learn it — `constructBuilding`'s
 * command carries no reply channel), then logs a completion the tick a
 * RESOLVED site's `constructionTicks` reads 0. `t` here is the same loop
 * counter `moveTo.atTick` is compared against, so a completion's `tick` and a
 * site's own `atTick` share one clock.
 */
function tallySites(
  snapshot: Snapshot, sites: readonly SiteState[], t: number,
  completions: { buildingId: number; defId: BuildingDefId; tick: number }[],
): void {
  for (const site of sites) {
    if (site.buildingId === null) {
      const building = snapshot.buildings.find((b) => b.col === site.col && b.row === site.row);
      if (building !== undefined) site.buildingId = building.id;
      else continue;
    }
    if (site.completed) continue;
    const building = snapshot.buildings.find((b) => b.id === site.buildingId);
    if (building !== undefined && building.constructionTicks === 0) {
      site.completed = true;
      completions.push({ buildingId: site.buildingId, defId: site.defId, tick: t });
    }
  }
}

/** Everything measured about one stage, once the run is over. */
function stageResultOf(
  stage: ScenarioStage, buildingId: number, tally: StageTally, snapshot: Snapshot, audit: GoodsAudit, ticks: number,
): StageResult {
  const recipe = BUILDINGS[stage.defId].recipe;
  if (recipe === null) throw new Error(`Scenario building ${stage.defId} has no recipe to measure`);
  const perBatch = Object.values(recipe.outputs).reduce((sum, n) => sum + n, 0);
  const building = snapshot.buildings.find((b) => b.id === buildingId);
  return {
    defId: stage.defId,
    resource: stage.resource,
    made: audit.madeOf(stage.resource),
    delivered: audit.deliveredOf(stage.resource),
    stalledTicks: tally.stalled,
    waitingForInputTicks: tally.waiting,
    finalBuffer: building?.buffered ?? 0,
    finalInputBuffer: building?.inputBuffered ?? 0,
    legTicks: haulTicks(stage.col, stage.row, BALANCE.haulTilesPerTick),
    ceiling: (ticks * stage.crew * perBatch) / recipe.ticksPerBatch,
  };
}

export async function runScenario(scenario: Scenario): Promise<BalanceResult> {
  const { ticks, moveTo } = scenario;
  const stages = stagesOf(scenario);
  const seededStockpile = Object.fromEntries(seededResourcesFor(stages).map((id): [ResourceId, number] => [id, FED]));
  const save: SaveGameV7 = {
    ...initialSave(),
    // Both, and for different reasons. `colonists` because v5 renamed the
    // roster key — clearing `workers` would leave the real array untouched.
    // `buildings` because initialSave() now ships a starter house, whose id
    // (1, which `nextEntityId: 1` would mint again) and tile (the first plot,
    // which campAdjacentFreeTile does not know to avoid) would both collide
    // with what this harness places below. Either collision corrupts the
    // distance and relocation sweeps silently.
    colonists: [],
    buildings: [],
    stockpile: seededStockpile as Partial<Record<ResourceId, number>>,
    nextEntityId: 1,
  };

  // ALL_SYSTEMS with the sentinel's probes spliced in. Every system keeps its
  // place and relative order; the probes only observe — the same technique
  // stats-system.test.ts's DepositWoodSystem uses for test-only wiring.
  const audit = new GoodsAudit();
  const prep = buildColonyPrepWorld({ save, systems: audit.instrument(ALL_SYSTEMS) });
  const ids = getPrepResource(prep, IdCounter);
  // Seeded with every tile this scenario will build on BEFORE any house is
  // placed, so no house can land on a stage, a move destination or a depot.
  const occupied: TileRef[] = stages.map((stage) => ({ col: stage.col, row: stage.row }));
  if (moveTo) occupied.push({ col: moveTo.col, row: moveTo.row });
  for (const at of scenario.storehouses ?? []) occupied.push(at);
  occupied.push(...(scenario.sites ?? []).map((site): TileRef => ({ col: site.col, row: site.row })));
  const buildingIds = stages.map((stage) => placeBuilding(prep, ids, stage.defId, stage));
  for (const at of scenario.storehouses ?? []) placeBuilding(prep, ids, 'storehouse', at);
  populateColony(prep, ids, save.map, scenario, stages, buildingIds, occupied);
  const world = await prep.prepareRun();
  const stockpile = world.getResource(Stockpile);
  audit.open(world.getResource(SnapshotStore).latest!, stockpile);

  const tallies: StageTally[] = stages.map(() => ({ stalled: 0, waiting: 0 }));
  const haulerTicks: HaulerTicks = {
    idle: 0, fetching: 0, outbound: 0, returning: 0, collect: 0, supply: 0, transfer: 0,
  };
  const phases = new Map<number, HaulPhase>();
  const tripPhases = new Map<number, HaulPhase>();
  const transfers: TransferTally = {
    total: 0, staging: 0, drain: 0, returned: 0, stagingTicks: 0, drainTicks: 0,
  };
  const storedSeries: number[] = [];
  const turnover = { deaths: 0, retirements: 0 };
  const returns = { total: 0, loaded: 0 };
  const siteStates: SiteState[] = (scenario.sites ?? []).map((site) => ({ ...site, buildingId: null, completed: false }));
  const completions: { buildingId: number; defId: BuildingDefId; tick: number }[] = [];
  let relocatingTicks = 0;
  // Whether the PREVIOUS tick ended with the countdown still running — see the
  // downtime comment below for why this, not the snapshot's `relocating`
  // state, is what counting downtime requires.
  let wasRelocating = false;

  for (let t = 0; t < ticks; t++) {
    // Mirrors the PRE-step retry both sanctioned drivers now perform
    // (GameEngine.runStep, stepTick): anything a previous tick's detach threw
    // on and re-queued must be gone before this tick's systems read the world,
    // or PopulationSystem can rehome someone into a shelter that is already
    // doomed. A bare `applyRemovals` touches no snapshot — unlike `stepTick`,
    // which also refreshes entity sections and would re-time every reading
    // this loop takes — so this is a measured no-op today (see the drain
    // below: nothing this harness runs ever queues a removal) kept for
    // symmetry with the post-step drain, not a fix for an observed defect.
    applyRemovals(world);
    world.getResource(SimClock).tick++;
    const issuingMove = moveTo !== undefined && t === moveTo.atTick;
    if (issuingMove) {
      enqueue(world, { type: 'moveBuilding', buildingId: buildingIds[0], to: { col: moveTo!.col, row: moveTo!.row } });
    }
    issueSiteOrders(world, t, siteStates);
    await world.step();
    // Deaths and demolitions go onto RemovalLedger and come off it here and
    // nowhere else (OBS-6-02). No scenario this harness runs today queues one —
    // measured, not assumed: a drain-and-count probe over all 15 balance cases
    // and all 4 harness cases reported zero, the longest run being 600 ticks
    // against a ~5,300-tick lifespan with hunger held neutral by the FED stock.
    // The drain is here so that stays a fact about the FIXTURES rather than a
    // silent property of the loop: a scenario that outlives a founder, or one
    // that ever issues `demolishBuilding`, would otherwise measure a colony in
    // which nobody can die and nothing can be torn down.
    //
    // Deliberately the drain ALONE, not `stepTick`. stepTick also calls
    // `refreshEntitySections`, which rebuilds the snapshot's `colonists` and
    // `buildings` from post-step entity state — and this loop reads exactly
    // those sections (`state`, `relocatingTicks`, `haulPhase`) as its
    // measurements. Refreshing would re-time every reading in the increment-5
    // sweep against a mid-tick baseline it was calibrated on. Same reasoning as
    // command-system.test.ts's `ticker`: the drain is the one post-step step an
    // instrumented driver cannot do without.
    applyRemovals(world);
    audit.closeTick();
    const snapshot = world.getResource(SnapshotStore).latest!;
    tallyStates(snapshot, buildingIds, tallies);
    // Downtime is ticks the building could not WORK, which is not the same as
    // snapshots reporting `relocating`: ProductionSystem skips work and then
    // decrements, so the tick that lands the move and the tick the countdown
    // reaches zero are both worked-through-zero — the first is not yet in a
    // snapshot, the last already reads 0. Counting the skip itself makes this
    // match `relocationTicks()` exactly, including a 1-tick nudge.
    if (issuingMove || wasRelocating) relocatingTicks++;
    wasRelocating = (snapshot.buildings.find((b) => b.id === buildingIds[0])?.relocatingTicks ?? 0) > 0;
    tallyHaulers(snapshot.colonists, haulerTicks, phases, returns);
    // From the live trips, not this snapshot: `staging` is deliberately absent
    // from the published read model — see tallyTransfers.
    tallyTransfers(world, transfers, tripPhases);
    storedSeries.push(storedUnits(snapshot));
    tallyTurnover(snapshot, turnover);
    tallySites(snapshot, siteStates, t, completions);
  }

  const snapshot = world.getResource(SnapshotStore).latest!;
  const results = stages.map((stage, index) => stageResultOf(stage, buildingIds[index], tallies[index], snapshot, audit, ticks));
  return {
    // The first stage's figures ARE the result's own, so every measurement
    // written against the single-building form reads exactly what it did
    // before this increment.
    ...results[0],
    stages: results,
    relocatingTicks,
    haulerIdleTicks: haulerTicks.idle,
    haulerTicks,
    supplyReturns: returns.total,
    supplyReturnsLoaded: returns.loaded,
    transfers: transfers.total,
    transfersStaging: transfers.staging,
    transfersDrain: transfers.drain,
    transferReturns: transfers.returned,
    transferTicks: { staging: transfers.stagingTicks, drain: transfers.drainTicks },
    carriedAtEnd: snapshot.colonists.reduce((sum, w) => sum + w.carrying, 0),
    storedAtEnd: storedUnits(snapshot),
    storedSeries,
    deaths: turnover.deaths,
    retirements: turnover.retirements,
    goods: audit.close(snapshot, stockpile),
    completions,
  };
}
