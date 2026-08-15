import { describe, expect, it } from 'vitest';
import { SystemError, type IRuntimeWorld } from 'sim-ecs';
import {
  CommandQueue, IdCounter, MAX_PENDING_COMMANDS, NoticeBoard, PendingChanges, RemovalLedger, SimClock, SnapshotStore, Stockpile,
  WorldMap,
} from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import {
  Building, Colonist, Construction, HaulTrip, Home, Hunger, InputBuffer, JobAssignment, OutputBuffer, Position, Relocation, WorkerSlots,
} from '../../../src/engine/components';
import { CommandSystem } from '../../../src/engine/systems/command-system';
import type { BuildingRow, CommandContext, WorkerRow } from '../../../src/engine/systems/command-handlers';
import { handleMoveBuilding } from '../../../src/engine/systems/placement-handlers';
import { ConstructionSystem } from '../../../src/engine/systems/construction-system';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { HaulSystem, haulerCapacity } from '../../../src/engine/systems/haul-system';
import { HungerSystem } from '../../../src/engine/systems/hunger-system';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { colonyTotal, enqueue } from '../fixtures';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';
import {
  applyRemovals, buildColonyPrepWorld, COMPONENT_TYPES, getPrepResource, initialSave, spawnBuilding, spawnColonist,
  type TColonySystemFactory,
} from '../../../src/engine/world';
import { PopulationSystem } from '../../../src/engine/systems/population-system';
import { RESOURCES } from '../../../src/engine/content/resources';
import { CAMP_SITE_ID, type StoreSite } from '../../../src/shared/haul';
import type { Command } from '../../../src/shared/commands';
import type { SaveGameV6 } from '../../../src/shared/save';
import { DEFAULT_MAP, isUnderConstruction, type TileRef } from '../../../src/shared/placement';

/**
 * What a hauler in this file's fixtures carries per trip.
 *
 * NOT BALANCE.haulCarryCapacity, which is what a hauler with a neutral commute
 * carries. `setup()` defaults to `houselessSave()` below — no shelter anywhere
 * and no planks to build one — so its haulers are homeless and Task 7's carry
 * scaling gives them `haulerCapacity(null)` instead. Named once and used by
 * every case below that seeds "exactly one load" AND every case that asserts a
 * full delivery: if the seed and the assertion ever read different numbers, the
 * fixture silently becomes a two-trip run and the case stops testing what its
 * name says.
 *
 * Housing them is not the fix here the way it is in haul-system.test.ts: this
 * file asserts on `snapshot().buildings[0]` and on building COUNTS throughout,
 * so an extra house entity would break a dozen unrelated cases — which is
 * exactly why the default is `houselessSave()` and not the `initialSave()` it
 * used to be, now that save v5 ships a starter house in every fresh colony.
 */
const ONE_LOAD = haulerCapacity(null);

/**
 * `initialSave()` with the starter house taken away and the founders back on
 * the street — the colony this whole file was written against.
 *
 * Almost every case here counts `snapshot().buildings` or reads
 * `buildings[0]`, and ONE_LOAD above is the capacity of an UNHOUSED hauler.
 * Save v5 gives a fresh colony a house and puts all three founders in it, so
 * inheriting that here would shift a dozen assertions that have nothing to do
 * with housing. Stating the houseless colony explicitly keeps them honest —
 * the same move `houseHaulers: false` makes in haul-system.test.ts.
 */
function houselessSave(): SaveGameV6 {
  const base = initialSave();
  return { ...base, buildings: [], colonists: base.colonists.map((c) => ({ ...c, homeId: null })) };
}

/**
 * A tick as this file needs it: the clock nudged (the recruit cooldown reads
 * `SimClock.tick`, so without it the cooldown can never elapse), the world
 * stepped, and the tick's removals APPLIED.
 *
 * `applyRemovals` is not optional decoration. Since OBS-6-02 a demolition no
 * longer goes through sim-ecs's deferred command queue — `handleDemolishBuilding`
 * puts the entity on `RemovalLedger` and the post-step drain is the only thing
 * that takes it off — so a step without this leaves every demolished building
 * standing for the rest of the run.
 *
 * Deliberately NOT `stepTick`, which is the full production sequence: it also
 * refreshes the snapshot's entity-derived sections, and a dozen cases in this
 * file assert on the DEFERRAL that gate exists to close ("entity appears next
 * tick", the notices a freed tile does or does not produce). This harness runs
 * a partial system set and publishes what SnapshotSystem itself wrote; the
 * removal drain is the one post-step step it cannot do without.
 */
function ticker(world: IRuntimeWorld) {
  return async () => {
    world.getResource(SimClock).tick++;
    await world.step();
    applyRemovals(world);
  };
}

/**
 * `constructBuilding` now spawns a SITE (spec §2.5), and most of this file's
 * cases predate that — they care about worker assignment, moving, hauling,
 * anything BUT construction, and only need a FINISHED building to test it
 * against. `ConstructionSystem`, the thing that would count a site down to 0,
 * is a later task's and does not exist yet, so this reaches straight into the
 * component the same way 'does not charge a site demolished earlier in the
 * same drain against its replacement' above already does — finishing the site
 * instantly rather than leaving every one of these cases blocked on a system
 * this repo does not have.
 */
function finishSite(world: IRuntimeWorld, buildingId: number): void {
  [...world.getEntities()].find((e) => e.getComponent(Building)?.id === buildingId)!
    .getComponent(Construction)!.ticksLeft = 0;
}

async function setup(save: SaveGameV6 = houselessSave(), systems: readonly TColonySystemFactory[] = [CommandSystem, HaulSystem, SnapshotSystem]) {
  const prep = buildColonyPrepWorld({ save, systems });
  const world = await prep.prepareRun();
  const tick = ticker(world);
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = (w: IRuntimeWorld = world) => w.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

/**
 * A colony that can actually take a nomad in: two houses (8 beds against 3
 * founders) and food well past `nomadFoodPerHead`. Recruiting is gated on beds
 * and food since Task 8, so a fixture that supplies neither can only ever test
 * the rejection. Two houses, not one: a one-house colony has 4 - 3 = 1 spare
 * bed, so the SECOND recruit below would be refused for want of a bed and the
 * cooldown assertion would pass for the wrong reason.
 */
function saveThatCanHouseArrivals(): SaveGameV6 {
  const base = houselessSave();
  return {
    ...base,
    buildings: [
      { inputBuffer: {}, stored: {}, id: 90, defId: 'house', col: 5, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      { inputBuffer: {}, stored: {}, id: 91, defId: 'house', col: 7, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
    ],
    stockpile: { ...base.stockpile, bread: 5000 },
    nextEntityId: 100,
  };
}

/**
 * The id of the FINISHED forester `saveWithFinishedForester` restores.
 */
const FINISHED_FORESTER_ID = 90;

/**
 * A colony whose forester was built in an earlier life, so it is a finished
 * building rather than a construction site.
 *
 * Since §2.3 an ORDERED building is a site: its cost was never charged, and
 * cancelling it therefore refunds nothing. Every case below that asserts the
 * FULL REFUND — a deliberate balance decision, not an accident — needs a
 * building somebody actually paid for, and until Task 8 gives sites a save
 * field the restore path is the only way to get one.
 */
function saveWithFinishedForester(col = 5, row = 5): SaveGameV6 {
  const base = houselessSave();
  return {
    ...base,
    buildings: [
      { inputBuffer: {}, stored: {}, id: FINISHED_FORESTER_ID, defId: 'forester', col, row, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
    ],
    nextEntityId: 100,
  };
}

// Relocation downtime is enforced by ProductionSystem, which the shared setup()
// deliberately omits. Order matches ALL_SYSTEMS (buildColonyPrepWorld throws
// otherwise).
async function setupWithProduction(save: SaveGameV6 = houselessSave()) {
  const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, ProductionSystem, HaulSystem, SnapshotSystem] });
  const world = await prep.prepareRun();
  const tick = ticker(world);
  const dispatch = async (...commands: Command[]) => {
    enqueue(world, ...commands);
    await tick();
  };
  const snapshot = () => world.getResource(SnapshotStore).latest!;
  return { world, tick, dispatch, snapshot };
}

describe('CommandSystem', () => {
  it('constructs a building without charging for it; entity appears next tick', async () => {
    // The cost is charged as materials are HAULED (§2.3), so the ledger does
    // not move here — see 'ordering a building does not move the ledger' below
    // for the whole-ledger version of that claim.
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // untouched
    expect(snapshot().buildings).toHaveLength(0); // command applied at end of step
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Started building a Forester.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0].defId).toBe('forester');
  });

  it('ordering a building does not move the ledger', async () => {
    // §2.3: the cost leaves the ledger as materials are HAULED, not at the
    // order. The whole colonyStock is compared, not the two cost resources —
    // a partial assertion passes an implementation that debits some third
    // resource, and `pay` is a loop over a cost map that is easy to mis-key.
    const { world, dispatch } = await setup();
    const before = { ...world.getResource(Stockpile).colonyStock() };
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(world.getResource(Stockpile).colonyStock()).toEqual(before);
  });

  it('an order spawns a construction site, not a finished building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Started building a Forester.' }]);
    await tick();
    const site = [...world.getEntities()].find((e) => e.getComponent(Building) !== undefined)!;
    expect(site.getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks);
    expect(isUnderConstruction(site.getComponent(Construction)!.ticksLeft)).toBe(true);
  });

  it('a colony that cannot afford a building is still refused', async () => {
    // Removing `pay` deletes the DEBIT and the REFUSAL together — `pay` did
    // both — so without this the check comes out inside a refactor and
    // increment 10's product change ships unmeasured.
    const save = houselessSave();
    save.stockpile = {};
    const { world, tick, dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'mill' }); // 20 wood, 10 planks
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot afford Mill.' }]);
    expect(world.getResource(Stockpile).colonyStock()).toEqual({});
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('cancelling a site with nothing delivered refunds nothing', async () => {
    // The minting test. The refund loop paid back `def.cost` unconditionally,
    // which was right only while the order charged it — with the payment gone
    // it hands back goods that never left, and the colony total is where that
    // shows up. Two resources, so a loop that refunds the first key alone is
    // caught too. (The in-tray half is the two cases below.)
    const save = houselessSave();
    save.stockpile = { ...save.stockpile, planks: 10 };
    const { world, tick, dispatch, snapshot } = await setup(save);
    const held = () => [colonyTotal(world, 'wood'), colonyTotal(world, 'planks')];
    const before = held();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'mill' }); // 20 wood, 10 planks
    await tick();
    expect(held()).toEqual(before); // nothing paid at the order either
    await dispatch({ type: 'demolishBuilding', buildingId: snapshot().buildings[0].id });
    expect(held()).toEqual(before);
  });

  /**
   * A mill site with six of its twenty wood already standing in its in-tray —
   * the state Task 3 makes reachable for the first time, reached here by
   * writing the tray directly rather than by running a hauler across the map,
   * so the quantity under test is stated rather than accumulated.
   */
  async function partlySuppliedSite(delivered = 6) {
    const save = houselessSave();
    save.stockpile = { ...save.stockpile, planks: 10 };
    const fixture = await setup(save);
    await fixture.dispatch({ type: 'constructBuilding', buildingDefId: 'mill' }); // 20 wood, 10 planks
    await fixture.tick();
    const id = fixture.snapshot().buildings[0].id;
    [...fixture.world.getEntities()].find((e) => e.getComponent(Building)?.id === id)!
      .getComponent(InputBuffer)!.add('wood', delivered);
    return { ...fixture, id, delivered };
  }

  it('cancelling a partly supplied site refunds only what arrived', async () => {
    // THE IN-TRAY HALF, and it belongs with the task that first puts anything
    // in a tray: the shipped rule empties both trays into nothing on
    // demolition, so without this a cancelled site permanently destroys every
    // material hauled to it — the conservation break this increment exists to
    // close, arriving inside the task that opens the delivery path.
    //
    // SIX, not twenty-six and not twenty: the site was never charged its cost
    // (§2.3), so only what physically arrived may come back.
    const { world, dispatch, id, delivered } = await partlySuppliedSite();
    const stockpile = world.getResource(Stockpile);
    const wood = () => colonyTotal(world, 'wood');
    const banked = stockpile.get('wood');
    const conserved = wood();
    // `refundAt`, not `addAt`: nobody hauled these to the camp, so Delivered/t
    // must not move. The colony TOTAL alone passes against `add`, which is why
    // this is asserted separately.
    const deliveredBefore = stockpile.producedThisTick.get('wood') ?? 0;

    await dispatch({ type: 'demolishBuilding', buildingId: id });
    expect(wood()).toBe(conserved);                              // nothing lost
    expect(stockpile.get('wood')).toBe(banked + delivered);      // and nothing minted
    expect(stockpile.producedThisTick.get('wood') ?? 0).toBe(deliveredBefore);
    expect(colonyTotal(world, 'planks')).toBe(10);               // the unpaid cost stays unpaid
  });

  it('cancelling a partly supplied site says what actually happened', async () => {
    // THE NOTICE, on its text, shipping with the refund above rather than four
    // tasks later. Every ledger assertion in the case above passes while this
    // sentence tells the player the exact opposite of what happened: OBS-4-07
    // exists because a notice said "cost refunded" while goods were deleted,
    // and describing a site's returned materials as `lost` is that defect with
    // the sign flipped. The cost half of this wording landed in Task 2 — this
    // extends it, and leaves the finished-building sentence alone.
    const { dispatch, snapshot, id } = await partlySuppliedSite();
    await dispatch({ type: 'demolishBuilding', buildingId: id });
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Cancelled the Mill — nothing was charged, 6 Wood moved to the camp.' },
    ]);
  });

  it('demolishing a FINISHED building still refunds its cost', async () => {
    // The other side of the branch: without this it can be written as "never
    // refund", which silently repeals `Demolition Keeps Its Full Refund`.
    const { world, dispatch, snapshot } = await setup(saveWithFinishedForester(5, 3));
    await dispatch({ type: 'demolishBuilding', buildingId: FINISHED_FORESTER_ID });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(40); // 30 + the forester's 10
  });

  it('cancelling a site returns its materials to the ledger for another site to use', async () => {
    // THE RECOVERY PROPERTY — the general form the two refund tests above
    // cannot state, because neither puts the refund anywhere a second build
    // could reach it. Two gatherersHut sites (cost wood:10, a single resource
    // so there is nothing else to confuse the total with), the colony's whole
    // 10-wood budget split five and five between their in-trays: EACH is
    // short exactly the five the OTHER one is holding, so neither can
    // complete. Cancelling site A must not merely conserve the total — a
    // teleport straight into site B's tray would do that too, which is why
    // this is not folded into the refund tests above — it must re-enter the
    // ORDINARY supply path and let a hauler carry it the rest of the way,
    // which is the property increment 10 leans on to argue its starvation
    // stall is recoverable.
    const { world, dispatch, snapshot } = await setup(
      houselessSave(), [CommandSystem, HaulSystem, ConstructionSystem, SnapshotSystem],
    );
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 7, row: 5 } },
    );
    await dispatch(); // spawn is deferred to sim-ecs's post-step sync: one more tick to see it
    const siteAId = snapshot().buildings.find((b) => b.col === 5)!.id;
    const siteBId = snapshot().buildings.find((b) => b.col === 7)!.id;
    const entityOf = (id: number) => [...world.getEntities()].find((e) => e.getComponent(Building)?.id === id)!;
    const stockpile = world.getResource(Stockpile);

    // Zeroed AFTER the orders (which charge nothing — §2.3 — but do check
    // affordability against the starting 30), so the colony's only wood, from
    // here on, is the ten split between the two trays below.
    stockpile.take('wood', stockpile.get('wood'));
    entityOf(siteAId).getComponent(InputBuffer)!.add('wood', 5);
    entityOf(siteBId).getComponent(InputBuffer)!.add('wood', 5);

    // Neither completes on what it holds: several ConstructionSystem passes
    // with no hauler in the colony change nothing.
    for (let i = 0; i < 5; i++) await world.step();
    expect(entityOf(siteAId).getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks);
    expect(entityOf(siteBId).getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks);

    const consumedBefore = stockpile.consumedThisTick.get('wood') ?? 0;
    const producedBefore = stockpile.producedThisTick.get('wood') ?? 0;
    await dispatch({ type: 'demolishBuilding', buildingId: siteAId });
    // THE REFUND HALF, pinned the way the two tests above pin it: banked at
    // the camp, site B's own tray untouched, and no delivery recorded.
    expect(stockpile.get('wood')).toBe(5);
    expect(entityOf(siteBId).getComponent(InputBuffer)!.total()).toBe(5);
    expect(stockpile.consumedThisTick.get('wood') ?? 0).toBe(consumedBefore);
    expect(stockpile.producedThisTick.get('wood') ?? 0).toBe(producedBefore);

    // THE RECOVERY HALF: nothing but the ordinary dispatch loop carries the
    // refunded five wood the rest of the way to site B.
    await dispatch({ type: 'assignHauler' });
    for (let i = 0; i < 150 && entityOf(siteBId).getComponent(Construction)!.ticksLeft > 0; i++) await world.step();
    expect(entityOf(siteBId).getComponent(Construction)!.ticksLeft).toBe(0); // completed
    expect(entityOf(siteBId).getComponent(InputBuffer)!.total()).toBe(0); // cleared at completion
    expect(stockpile.get('wood')).toBe(0); // the refunded five, and nothing more, went in
    // The delivery that finished it went through `unload`'s real pickup, not
    // a second refund: `recordConsumed` moved, which only a genuine haul does.
    expect(stockpile.consumedThisTick.get('wood') ?? 0).toBe(consumedBefore + 5);
  });

  it('a finished building is unchanged by this', async () => {
    // The asymmetry (§2.6) is deliberate: a SITE cannot be relocated (the
    // test right below), but a FINISHED building's move is untouched by that
    // refusal. Pinned here so a future reader sees a decision rather than an
    // inconsistency — without this, `handleMoveBuilding`'s new check could be
    // widened to refuse every building and every test above that moves a
    // finished one would need to be rewritten to notice.
    const { world, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch(); // spawn is deferred to sim-ecs's post-step sync: one more tick to see it
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 9, row: 6 });
  });

  it('a site cannot be relocated', async () => {
    // §2.6, §2.12: moving a hole in the ground is meaningless, the relocation
    // price is derived from a WORKING building's downtime, and a move
    // countdown and a build countdown on one entity at once is a state
    // Task 8's save guard is specified to reject as impossible for the
    // engine to have produced. This refusal is what keeps that true.
    const { world, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch(); // spawn is deferred to sim-ecs's post-step sync: one more tick to see it
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move a building under construction.' }]);
    // Nothing moved, and no downtime was written — a refused relocation
    // changes nothing about the site it named.
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 5, row: 5 });
    const entity = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === buildingId)!;
    expect(entity.getComponent(Relocation)!.ticksLeft).toBe(0);
    expect(entity.getComponent(Construction)!.ticksLeft).toBe(BALANCE.buildTicks); // untouched too
  });

  it('a hauler walking to a cancelled site loses nothing', async () => {
    // The existing cancellation paths (`turnBackOrCancel`), pointed at a new
    // kind of target: every case that exercises them today demolishes a
    // FINISHED building. Expected to pass unchanged — and tested anyway,
    // because increment 8 found three paths that "obviously" already worked
    // and did not.
    const { world, dispatch, snapshot } = await setup();
    // Far enough that a supply trip is genuinely mid-leg for several ticks —
    // the same far-corner distance the move-retargeting cases above use.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await dispatch(); // spawn is deferred to sim-ecs's post-step sync: one more tick to see it
    const buildingId = snapshot().buildings[0].id;
    // STILL A SITE: forester costs 10 wood and nothing has been delivered, so
    // the colony's one idle worker is dispatched on a SUPPLY job, not a
    // collect. `beginSupply` fetches from the camp first ('fetching', the
    // dispatch tick itself never walks — "a trip dispatched this tick starts
    // walking next tick") — and since the hauler is already standing at the
    // camp, the very next tick's arrival hands it the load and starts the
    // 'outbound' leg to the site.
    await dispatch({ type: 'assignHauler' });
    await dispatch();
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    expect(trip()).toMatchObject({ kind: 'supply', resource: 'wood', targetId: buildingId, ticksLeft: 13 });
    const carried = trip().amount;
    expect(carried).toBeGreaterThan(0);

    // Two more ticks, walking — well into the 13-tick leg, nowhere near
    // arrival, and (load-bearing for the assertion just below) far enough
    // out that the turn for home is not itself a one-tick trip: a return
    // leg that short would complete in the very same tick as the demolish
    // and never be observable as 'returning' at all.
    await dispatch(); await dispatch();
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 11 });
    const before = colonyTotal(world, 'wood');

    await dispatch({ type: 'demolishBuilding', buildingId });
    // Turned for home ON THE DEMOLISH TICK, carrying what it already held —
    // not cancelled (which would delete the load) and not left walking to a
    // tile with nothing on it any more.
    expect(trip()).toMatchObject({ phase: 'returning', amount: carried, resource: 'wood' });
    expect(colonyTotal(world, 'wood')).toBe(before); // nothing lost, nothing minted

    for (let i = 0; i < 20 && trip().phase !== 'idle'; i++) await dispatch();
    expect(trip().phase).toBe('idle'); // walked home and banked
    expect(colonyTotal(world, 'wood')).toBe(before);
  });

  describe('the affordability check counts the sites already queued', () => {
    /**
     * Exactly one house's worth of wood, and plenty of planks.
     *
     * A house costs 15 wood AND 5 planks, so a ledger holding one house's
     * planks would refuse the second order for want of planks whichever way
     * the check is written — passing the test for the wrong reason. 20 planks
     * leaves wood as the only binding resource, which is the resource the
     * cumulative rule is being tested on.
     */
    function oneHouseOfWood(): SaveGameV6 {
      return { ...houselessSave(), stockpile: { wood: 15, planks: 20 } };
    }

    it('refuses the second of two orders sharing one house\'s materials, both in one drain', async () => {
      const { tick, dispatch, snapshot } = await setup(oneHouseOfWood());
      await dispatch(
        { type: 'constructBuilding', buildingDefId: 'house' },
        { type: 'constructBuilding', buildingDefId: 'house' },
      );
      expect(snapshot().notices).toEqual([
        { kind: 'success', message: 'Started building a House.' },
        { kind: 'rejection', message: 'Cannot afford House.' },
      ]);
      await tick();
      expect(snapshot().buildings).toHaveLength(1);
    });

    it('refuses the second of two orders sharing one house\'s materials, one order per tick', async () => {
      // No hauler is assigned and no site is a source, so nothing collects
      // between the two ticks: the ledger the second order reads is the same
      // one the first read. A plain `canAfford(def.cost)` therefore accepts
      // both — which is exactly the queue §2.4 says increment 9 does not ship.
      const { tick, dispatch, snapshot } = await setup(oneHouseOfWood());
      await dispatch({ type: 'constructBuilding', buildingDefId: 'house' });
      await tick();
      await dispatch({ type: 'constructBuilding', buildingDefId: 'house' });
      expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot afford House.' }]);
      await tick();
      expect(snapshot().buildings).toHaveLength(1);
    });

    it('charges a standing site once, not once more for every tick since it was ordered', async () => {
      // The pin on `PendingChanges.clear()` emptying `constructed`
      // (resources.ts). That list is THIS drain's own record of sites ordered a
      // moment ago, and `outstandingMaterials` charges each entry its WHOLE
      // cost — on top of the shortfall it charges the live site row the
      // post-step sync has since published. A list that survived its tick would
      // therefore charge every standing site twice from the tick after its
      // order onwards, and the colony would progressively refuse orders it can
      // plainly afford.
      //
      // Until task 2b this was pinned incidentally, through the same-tick
      // shelter fold a stale `constructed` also corrupted; §2.5 removed that
      // fold, and with it the only test that reddened when `clear()` stopped
      // clearing.
      //
      // Exactly two houses' materials, so the second order has no slack for a
      // double charge to hide in: 30 >= 15 (the standing site) + 15 (this
      // order) passes, and 30 >= 15 + 15 + 15 does not. No hauler is assigned
      // and no site is a source, so nothing is delivered across the ticks
      // below — the first site still owes its whole cost when the second order
      // is judged, exactly once.
      const { tick, dispatch, snapshot } = await setup({ ...houselessSave(), stockpile: { wood: 30, planks: 10 } });
      await dispatch({ type: 'constructBuilding', buildingDefId: 'house' });
      for (let i = 0; i < 3; i++) await tick();
      await dispatch({ type: 'constructBuilding', buildingDefId: 'house' });
      expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Started building a House.' }]);
      await tick();
      expect(snapshot().buildings).toHaveLength(2);
    });

    it('counts sites only — a FINISHED building is not charged against a new order', async () => {
      // The distinction the row's `Construction` exists for. A finished
      // building's cost was paid off long ago; counting it as outstanding would
      // reserve every building the colony has ever built against every future
      // order, and a colony holding exactly one forester's wood could never
      // build a second one.
      const save = saveWithFinishedForester();
      save.stockpile = { wood: 10 }; // exactly one forester, and no slack at all
      const { tick, dispatch, snapshot } = await setup(save);
      await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
      expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Started building a Forester.' }]);
      await tick();
      expect(snapshot().buildings).toHaveLength(2);
    });

    it('does not charge a site demolished earlier in the same drain against its replacement', async () => {
      // Removal is deferred to the post-step drain, so the cancelled site is
      // still in the query with its Construction intact. Summed naively its
      // shortfall is charged against the very order meant to replace it, and
      // the pair is refused for materials the refund has already returned.
      const save = houselessSave();
      save.buildings = [
        { inputBuffer: {}, stored: {}, id: 90, defId: 'house', col: 5, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      ];
      // Exactly one house, and no refund to help: cancelling a site returns
      // nothing, so the replacement is funded by the ledger alone. Counted
      // naively the ghost's own 15 wood is charged on top and the pair is
      // refused for materials the colony plainly holds.
      save.stockpile = { wood: 15, planks: 5 };
      save.nextEntityId = 100;
      const { world, tick, dispatch, snapshot } = await setup(save);
      // Building 90 is a SITE, not a finished house: nothing delivered to it
      // yet, so its shortfall is its whole cost. (Sites do not round-trip
      // through a save until Task 8, hence the direct write.)
      [...world.getEntities()].find((e) => e.getComponent(Building)?.id === 90)!
        .getComponent(Construction)!.ticksLeft = BALANCE.buildTicks;
      await dispatch(
        { type: 'demolishBuilding', buildingId: 90 },
        { type: 'constructBuilding', buildingDefId: 'house', at: { col: 5, row: 3 } },
      );
      expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'success']);
      await tick();
      expect(snapshot().buildings).toHaveLength(1);
    });
  });

  it('a site occupies its tile from the order tick', async () => {
    // An obstruction, not a reservation: the tile is taken the moment the
    // order lands, and stays taken on every later tick.
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(1); // the refused hut never spawned
  });

  it('rejects unaffordable construction with a notice', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'workshop' }); // needs 20 planks
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot afford Workshop.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
  });

  it('welcomes a nomad and enforces the 30-tick cooldown', async () => {
    // Beds and food are both held far from their thresholds by the fixture, so
    // the cooldown is the only gate in play — the same reason the balance
    // harness seeds a berry stock to hold hunger neutral.
    const { tick, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Colonist #100 joined the colony.' }]);
    await tick();
    expect(snapshot().population).toBe(4);
    await dispatch({ type: 'recruitWorker' }); // still on cooldown
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No one is passing through just yet.' }]);
    for (let i = 0; i < 30; i++) await tick();
    await dispatch({ type: 'recruitWorker' });
    await tick();
    expect(snapshot().population).toBe(5);
  });

  it('refuses a nomad when there is nowhere to sleep, and says so', async () => {
    // The discriminating half of the pair above: same command, same cooldown
    // state, only the beds removed. That is what `setup()`'s default
    // `houselessSave()` is for — a fresh v5 colony ships a starter house with
    // a bed to spare, so `initialSave()` would ACCEPT the nomad and this test
    // would assert the opposite of its own name.
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free bed: build a house first.' }]);
    expect(snapshot().population).toBe(3);
  });

  it('refuses a nomad when the store cannot feed one', async () => {
    // Beds available, food gone: the OTHER gate, named distinctly so a single
    // catch-all rejection cannot satisfy both tests.
    const { dispatch, snapshot } = await setup({ ...saveThatCanHouseArrivals(), stockpile: {} });
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Not enough food stored to feed another colonist.' }]);
    expect(snapshot().population).toBe(3);
  });

  /**
   * The nomad fixture with its food SPLIT between the camp and a storehouse —
   * the only shape that can tell a colony-wide food gate from a camp-only one.
   * A fixture holding all its bread at the camp passes either way, and one
   * holding it all in a depot fails on a total rather than on where it sits.
   */
  async function nomadWithSplitFood(campBread: number, depotBread: number) {
    const base = saveThatCanHouseArrivals();
    const depot = { id: 92, col: 9, row: 3 };
    const save: SaveGameV6 = {
      ...base,
      buildings: [...base.buildings, { inputBuffer: {}, stored: {},
        ...depot, defId: 'storehouse', progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0,
      }],
      stockpile: { bread: campBread },
    };
    const fixture = await setup(save);
    fixture.world.getResource(Stockpile)
      .refundAt({ ...depot, capacity: BALANCE.storehouseCapacity }, 'bread', depotBread);
    return fixture;
  }

  it('welcomes a nomad on food the camp alone could not feed them with', async () => {
    // 3 founders, so the gate needs 20 meals x 4 heads = 80. The camp holds 40
    // and the storehouse 44: neither figure clears the bar, their sum does, and
    // the meals really are spendable — `pay` draws across every site.
    const { tick, dispatch, snapshot } = await nomadWithSplitFood(40, 44);
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Colonist #100 joined the colony.' }]);
    await tick(); // the arrival is synced into the queries a tick later
    expect(snapshot().population).toBe(4);
  });

  it('refuses that same nomad when the depot half of the food is not there', async () => {
    // The discriminating half: identical colony, identical camp stock, only the
    // storehouse emptied. Without it the case above passes for a colony that is
    // simply well fed.
    const { dispatch, snapshot } = await nomadWithSplitFood(40, 0);
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Not enough food stored to feed another colonist.' }]);
    expect(snapshot().population).toBe(3);
  });

  it('re-seats a nomad in the other house when the one it landed in moves in the same drain', async () => {
    // The relocation twin of the demolition case. recruitWorker seats the
    // nomad in house 90 (lowest id with room), then moveBuilding starts 90
    // relocating LATER IN THE SAME DRAIN. Nulling the homeId is necessary —
    // a homeId naming a relocating house is the dangling reference the v5 load
    // guard refuses — but it is not sufficient: rehome cannot repair it,
    // because a colonist spawned earlier in this drain is invisible to every
    // query until the post-step sync, so PopulationSystem has no row for them
    // this tick. Without the re-seat the nomad ends the tick homeless while
    // house 91 stands with four empty beds, and a paused player sees that
    // contradiction until they step again.
    const { world, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch(
      { type: 'recruitWorker' },
      { type: 'moveBuilding', buildingId: 90, to: { col: 12, row: 9 } },
    );
    // Both commands genuinely applied: a drain that rejected the recruit would
    // otherwise leave nothing to find below and fail for the wrong reason.
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Colonist #100 joined the colony.' },
      { kind: 'success', message: 'Moved the House.' },
    ]);
    const nomad = [...world.getEntities()].find((e) => e.getComponent(Colonist)?.id === 100);
    expect(nomad, 'the recruited nomad never reached the world').toBeDefined();
    // 91 specifically, not merely "not null": the whole point is that the free
    // bed it takes belongs to a house that is standing still.
    expect(nomad!.getComponent(Home)!.buildingId).toBe(91);
  });

  it('re-seats a nomad in the other house when the one it landed in is demolished in the same drain', async () => {
    // The demolition half of the pair above, and the site `reseatArrivalsOf`
    // was written for but never wired to: `handleDemolishBuilding` used to only
    // NULL the arrival's home. Nulling stops the dangling reference the v5 load
    // guard refuses, but it leaves the nomad homeless for the rest of the tick
    // with house 91 standing on four empty beds — and rehome cannot repair it,
    // because a colonist spawned earlier in this drain has no query row until
    // the post-step sync. Paused, that contradiction persists indefinitely.
    const { world, dispatch, snapshot } = await setup(saveThatCanHouseArrivals());
    await dispatch(
      { type: 'recruitWorker' },
      { type: 'demolishBuilding', buildingId: 90 },
    );
    // Both commands genuinely applied — same guard as the relocation twin.
    // The displaced count is 3, not 4: the load repair houses the three
    // founders in house 90, and the nomad the re-seat exists for is invisible
    // to `ctx.workers` — which is the whole reason `displaced` cannot see them
    // and `reseatArrivalsOf` has to.
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Colonist #100 joined the colony.' },
      { kind: 'success', message: 'Demolished the House — cost refunded. — 3 colonist(s) displaced.' },
    ]);
    const nomad = [...world.getEntities()].find((e) => e.getComponent(Colonist)?.id === 100);
    expect(nomad, 'the recruited nomad never reached the world').toBeDefined();
    // 91, never 90: the re-seat runs after the demolition is on the pending
    // ledger, so `shelterWithRoom` cannot hand back the house being removed.
    expect(nomad!.getComponent(Home)!.buildingId).toBe(91);
  });

  /**
   * OBS-6-07 path 1. `reseatArrivalsOf` loops, and its doc comment claims the
   * loop is safe for SEVERAL displaced arrivals at once because
   * `shelterWithRoom` reads `ctx.pending.arrivals` live — so each arrival it
   * re-seats is already counted against its new house by the time the next one
   * asks. The two scenario tests above only ever put ONE arrival through it.
   *
   * The branch cannot be reached through the command path at all:
   * `recruitCooldownTicks` refuses a second nomad in the same drain (the
   * handler writes `lastRecruitTick` before the next command is read), and
   * `tryBirth` — the only other pusher — runs in `PopulationSystem`, after
   * `CommandSystem` has finished draining. So the handler is driven directly,
   * with a context built from real components. That is the honest shape of the
   * claim: this is live code with no live caller, kept because a bulk-arrival
   * command or a retuned cooldown would make it one overnight.
   */
  describe('handleMoveBuilding with more than one arrival to re-seat', () => {
    /** Real entities, so the rows carry the components production reads. */
    async function houseRows(tiles: readonly TileRef[]) {
      const prep = buildColonyPrepWorld({ save: houselessSave(), systems: [] });
      const ids = getPrepResource(prep, IdCounter);
      return tiles.map((at, index) => {
        const entity = spawnBuilding(prep, ids, {
          id: 90 + index, defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0,
        });
        return {
          entity,
          building: entity.getComponent(Building)!,
          slots: entity.getComponent(WorkerSlots)!,
          position: entity.getComponent(Position)!,
          buffer: entity.getComponent(OutputBuffer)!,
          input: entity.getComponent(InputBuffer)!,
          relocation: entity.getComponent(Relocation)!,
          construction: entity.getComponent(Construction)!,
        };
      });
    }

    /** One resident of `homeId`, as `ctx.workers` sees them. */
    function resident(homeId: number): WorkerRow {
      return { job: new JobAssignment(), trip: new HaulTrip(), home: new Home(homeId), stage: 'adult' };
    }

    /**
     * What `CommandSystem` builds, minus what this handler cannot reach.
     * `shelters` and `occupancy` are derived from the same rows and in the same
     * shape it uses; `pending.constructed` is left out of `shelters` because
     * nothing is constructed in this drain, so the fold would be a no-op.
     * `spawn` and `nomadGate` THROW rather than returning a stub, so a handler
     * that started using either would fail here rather than read a fiction.
     */
    function contextOf(buildings: BuildingRow[], workers: WorkerRow[], pending: PendingChanges): CommandContext {
      return {
        clock: new SimClock(),
        stockpile: new Stockpile({}),
        ids: new IdCounter(1000),
        notices: new NoticeBoard(),
        map: new WorldMap(DEFAULT_MAP.cols, DEFAULT_MAP.rows),
        buildings,
        workers,
        spawn: () => { throw new Error('handleMoveBuilding must not spawn'); },
        claimedTiles: [],
        removals: new RemovalLedger(),
        pending,
        demolishedIds: new Set<number>(),
        shelters: () => buildings
          .filter(({ building }) => BUILDINGS[building.defId].beds > 0)
          .map(({ building, position, relocation }) => ({
            id: building.id,
            beds: BUILDINGS[building.defId].beds,
            col: position.col,
            row: position.row,
            relocating: relocation.ticksLeft > 0,
          })),
        occupancy: () => {
          const byHouse = new Map<number, number>();
          for (const { home } of workers) {
            if (home.buildingId !== null) byHouse.set(home.buildingId, (byHouse.get(home.buildingId) ?? 0) + 1);
          }
          return byHouse;
        },
        nomadGate: () => { throw new Error('handleMoveBuilding must not ask the nomad gate'); },
        sites: () => { throw new Error('handleMoveBuilding must not resolve store sites'); },
      };
    }

    it('spreads them across the houses that have room, one bed each', async () => {
      // Houses 91 and 92 hold three residents each, so each has exactly ONE bed
      // free. That is the whole fixture: with the ledger read live, the first
      // arrival takes 91's last bed and the second is offered 92; with the
      // destination resolved once for the whole loop, both are handed 91 and it
      // ends the drain holding five colonists in four beds.
      const buildings = await houseRows([{ col: 5, row: 3 }, { col: 7, row: 3 }, { col: 9, row: 3 }]);
      const workers = [91, 91, 91, 92, 92, 92].map(resident);
      const pending = new PendingChanges();
      const first = new Home(90);
      const second = new Home(90);
      for (const home of [first, second]) pending.arrivals.push({ home, ageTicks: BALANCE.nomadArrivalTicks });

      handleMoveBuilding(contextOf(buildings, workers, pending), {
        type: 'moveBuilding', buildingId: 90, to: { col: 15, row: 11 },
      });

      // Precondition, not the point: house 90 really did lift off, so both
      // arrivals genuinely had to move.
      expect(buildings[0].relocation.ticksLeft).toBeGreaterThan(0);
      expect([first.buildingId, second.buildingId]).toEqual([91, 92]);
    });
  });

  // §2.7's table, exclusion 4 of 5 (task 2b), and the one addition rather
  // than an exclusion: a mill site carries its def's `workerSlots` (2) like
  // any finished building, so `handleAssignWorker` would accept it today —
  // the refusal below is new, not preserved. Forester, not mill: it has the
  // same two worker slots and costs only wood, which `houselessSave`'s
  // default stockpile (no planks) can actually afford.
  it('a site cannot be assigned a worker', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' }); // workerSlots: 2
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Forester is still under construction.' }]);
    expect(snapshot().buildings[0].workers).toBe(0);
    expect(snapshot().idleAdults).toBe(3); // nobody was actually moved
  });

  it('assigns and unassigns workers within slot limits', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a worker to Forester.' }]);
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().buildings[0].workers).toBe(2);
    await dispatch({ type: 'assignWorker', buildingId }); // forester has 2 slots
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free worker slots at this building.' }]);
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from Forester.' }]);
    expect(snapshot().buildings[0].workers).toBe(1);
    expect(snapshot().idleAdults).toBe(2);
  });

  it('falls back to a generic name when the building an assignment points at is gone', async () => {
    // buildingName's 'building' fallback. Unreachable through the save path --
    // isLoadableSave rejects a worker whose buildingId names no building -- and
    // demolition kept it fixture-only: it nulls every assignment it evicts and
    // the same-tick demolishedIds guard rejects later commands against the id.
    // Pinned as defense in depth for any future remover that misses eviction.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, SnapshotSystem] });
    spawnColonist(prep, getPrepResource(prep, IdCounter), { buildingId: 404 }); // no building 404
    const world = await prep.prepareRun();
    enqueue(world, { type: 'unassignWorker', buildingId: 404 });
    world.getResource(SimClock).tick++;
    await world.step();

    const notices = world.getResource(SnapshotStore).latest!.notices;
    expect(notices).toEqual([{ kind: 'success', message: 'Unassigned a worker from building.' }]);
  });

  it('refuses entity creation once the id space is exhausted, without side effects', async () => {
    const save = houselessSave();
    save.nextEntityId = Number.MAX_SAFE_INTEGER - 2 ** 32; // == MAX_SAVED_COUNTER: nothing left to hand out
    const { world, tick, dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30); // untouched: an order never charges the ledger, rejected or not
    await dispatch({ type: 'recruitWorker' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot create more entities: id space exhausted.' }]);
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().population).toBe(3);
  });

  it('notices when assigning to a missing building or with no idle workers, or unassigning from an unstaffed one', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignWorker', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);

    // a real building nobody has been assigned to yet
    await dispatch({ type: 'unassignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No worker assigned to this building.' }]);

    // a second forester so a slot stays open even once every worker is busy
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const secondBuildingId = snapshot().buildings.find((b) => b.id !== buildingId)!.id;
    finishSite(world, secondBuildingId);

    // 3 starting workers, 2 slots per forester: fill building 1 (2 workers),
    // send the last idle worker to building 2 (1/2 slots) -- one open slot
    // remains there, but every worker is now busy.
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    await dispatch({ type: 'assignWorker', buildingId: secondBuildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('emits exactly one notice naming the drop count after a queue overflow', async () => {
    const { world, tick, snapshot } = await setup();
    const queue = world.getResource(CommandQueue);
    for (let i = 0; i < MAX_PENDING_COMMANDS + 5; i++) queue.push({ type: 'recruitWorker' });
    await tick();
    const dropNotices = snapshot().notices.filter((n) => n.message.includes('dropped'));
    expect(dropNotices).toEqual([{ kind: 'rejection', message: '5 command(s) were dropped: the queue was full.' }]);
  });

  it('constructs at a chosen buildable tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 7, row: 4 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Started building a Forester.' }]);
    await tick();
    expect(snapshot().buildings[0]).toMatchObject({ defId: 'forester', col: 7, row: 4 });
  });

  it('auto-places table constructions on the legacy plot pattern', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut' });
    await tick();
    expect(snapshot().buildings.map((b) => [b.col, b.row])).toEqual([[4, 1], [6, 1]]);
  });

  it('rejects out-of-bounds, camp-band, and occupied tiles', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 0, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 24, row: 1 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot build there.' }]);
    // Nothing is charged at the order any more (§2.3), so the ledger says
    // nothing about which of these four orders was accepted — the building
    // count below is what does.
    expect(world.getResource(Stockpile).get('wood')).toBe(30);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick constructions cannot claim one tile', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester', at: { col: 6, row: 2 } },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 2 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
  });

  it('two same-tick auto-placed constructions land on distinct plots', async () => {
    // the claimedTiles bridge must feed autoPlacePosition too, not only the
    // explicit-at validator — otherwise both table builds pick one plot
    const { tick, dispatch, snapshot } = await setup();
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'forester' },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut' },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'success']);
    await tick();
    const tiles = snapshot().buildings.map((b) => `${b.col},${b.row}`);
    expect(new Set(tiles).size).toBe(2);
  });

  it('rejects construction once no buildable tile remains', async () => {
    const save = houselessSave(); // its own fill covers (4,1), where the starter house would stand
    let id = 10;
    for (let row = 0; row < 16; row++) {
      for (let col = 3; col < 24; col++) {
        save.buildings.push({ inputBuffer: {}, stored: {}, id: id++, defId: 'forester', progress: 0, batchActive: false, col, row, buffer: {}, relocatingTicks: 0 });
      }
    }
    save.nextEntityId = id;
    save.stockpile = { wood: 100 };
    const { dispatch, snapshot } = await setup(save);
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No free tile left to build on.' }]);
  });

  it('demolishes: refunds the cost, idles the workers, removes the entity', async () => {
    const { world, tick, dispatch, snapshot } = await setup(saveWithFinishedForester());
    const buildingId = FINISHED_FORESTER_ID;
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
    expect(world.getResource(Stockpile).get('wood')).toBe(40); // 30 + the forester's full 10
    await tick();
    expect(snapshot().buildings).toHaveLength(0);
    expect(snapshot().idleAdults).toBe(3);
  });

  it('demolishing a building with buffered goods names the loss; the refund stays exactly the construction cost', async () => {
    // OBS-4-07, resolved: the buffer is destroyed either way (unchanged from
    // the test above) — only the notice's wording is new. The stockpile
    // assertion is the guard that this stayed a messaging fix: it must land on
    // the exact same 40 as the empty-building case above, proving the 9
    // buffered wood never reached the stockpile despite being named in the notice.
    const { world, dispatch, snapshot } = await setup(saveWithFinishedForester());
    const buildingId = FINISHED_FORESTER_ID;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'demolishBuilding', buildingId });
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Forester — cost refunded, 9 Wood lost.' },
    ]);
    expect(world.getResource(Stockpile).get('wood')).toBe(40); // construction refund only, same as the empty case
  });

  it('demolishing an empty building leaves the notice byte-identical to today\'s wording', async () => {
    // OBS-4-07: a zero-units clause would be noise on the common case, so an
    // empty buffer must not grow a trailing ", lost." clause of any kind.
    // The same finished building the case above uses, so the two notices differ
    // in exactly the one clause under test.
    const { dispatch, snapshot } = await setup(saveWithFinishedForester());
    await dispatch({ type: 'demolishBuilding', buildingId: FINISHED_FORESTER_ID });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Demolished the Forester — cost refunded.' }]);
  });

  it('names exactly one displaced resident, singular wording', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, homeId: houseId });
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded. — 1 colonist(s) displaced.' },
    ]);
  });

  it('names the exact count of several displaced residents', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    for (const id of [1, 2, 3]) spawnColonist(prep, ids, { id, homeId: houseId });
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded. — 3 colonist(s) displaced.' },
    ]);
  });

  it('demolishing a house with no residents gains no displaced clause', async () => {
    // The empty case is how a clause like this grows noise: pinned directly
    // against a house (the one building type residents ever point home at),
    // not just the Forester the byte-identical test above already covers.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    const prep = buildColonyPrepWorld({ save, systems: [CommandSystem, HaulSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    const world = await prep.prepareRun();
    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await ticker(world)();
    expect(world.getResource(SnapshotStore).latest!.notices).toEqual([
      { kind: 'success', message: 'Demolished the House — cost refunded.' },
    ]);
  });

  it('rejects demolishing a building that does not exist', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'demolishBuilding', buildingId: 999 });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
  });

  it('a demolished id is dead within its own tick: later commands against it reject', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'assignWorker', buildingId },
      { type: 'unassignWorker', buildingId },
      { type: 'demolishBuilding', buildingId },
    );
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Cancelled the Forester — nothing was charged.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
      { kind: 'rejection', message: 'Building not found.' },
    ]);
  });

  // OBS-6-01. `occupiedTiles` used to build the drain's occupancy from every
  // LIVE building row with no `ctx.demolishedIds` filter, unlike `findBuilding`
  // immediately below it. sim-ecs defers entity removal to the post-step sync,
  // so a building demolished earlier in this drain was still in `ctx.buildings`
  // and its tile still read as occupied — the construction below used to be
  // refused with 'Cannot build there.' in the SAME drain as the demolition,
  // only succeeding a tick later. Per-command tests cannot catch this: the
  // defect only exists in the interaction between the two handlers in one
  // drain, which is why both commands are queued together here.
  it('a tile freed by demolition is buildable again in the SAME drain', async () => {
    const { tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    await dispatch(
      { type: 'demolishBuilding', buildingId },
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 5, row: 5 } },
    );
    // Both succeed: no rejection anywhere on the board, not merely "the second
    // notice happens to be a success" — a stray rejection elsewhere would slip
    // past an index-1-only assertion.
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Cancelled the Forester — nothing was charged.' },
      { kind: 'success', message: "Started building a Gatherer's Hut." },
    ]);
    await tick();
    expect(snapshot().buildings).toHaveLength(1);
    expect(snapshot().buildings[0]).toMatchObject({ defId: 'gatherersHut', col: 5, row: 5 });
  });

  // The `moveBuilding` twin of the same bug: `handleMoveBuilding` calls the
  // same unfiltered `occupiedTiles`, so a tile freed by a same-drain demolition
  // was equally unreachable by a relocation, not just a fresh construction.
  it('a tile freed by demolition is a valid MOVE target in the same drain', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 9, row: 5 } });
    await tick();
    const demolishedId = snapshot().buildings.find((b) => b.defId === 'forester')!.id;
    const moverId = snapshot().buildings.find((b) => b.defId === 'gatherersHut')!.id;
    // FINISHED: this case is about same-drain tile visibility, not about
    // Task 7's site-move refusal — a still-under-construction mover would be
    // refused before the tile logic under test ever runs.
    finishSite(world, moverId);
    await dispatch(
      { type: 'demolishBuilding', buildingId: demolishedId },
      { type: 'moveBuilding', buildingId: moverId, to: { col: 5, row: 5 } },
    );
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Cancelled the Forester — nothing was charged.' },
      { kind: 'success', message: "Moved the Gatherer's Hut." },
    ]);
    // Position is a component mutation, not a deferred entity command — the
    // same tick's snapshot already shows it landed on the freed tile.
    expect(snapshot().buildings.find((b) => b.id === moverId)).toMatchObject({ col: 5, row: 5 });
  });

  it('moves a building in place — same id, workers and batch intact, visible same tick', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Position is a component mutation, not a deferred entity command — the
    // same tick's snapshot already shows it.
    expect(snapshot().buildings[0]).toMatchObject({ id: buildingId, col: 9, row: 6, workers: 1 });
  });

  it('rejects moving to an occupied tile, its own tile, off-map, or a missing building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await dispatch({ type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 6, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED: this case is about tile validation, not Task 7's site-move
    // refusal, which would otherwise reject every call below for the wrong
    // reason and with the wrong message.
    finishSite(world, buildingId);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 6, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 1, row: 5 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Cannot move there.' }]);
    await dispatch({ type: 'moveBuilding', buildingId: 999, to: { col: 9, row: 9 } });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'Building not found.' }]);
    expect(snapshot().buildings[0]).toMatchObject({ col: 5, row: 5 }); // never moved
  });

  it('same-tick: a construction claims its tile before a later move can take it', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 5 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED: this case is about occupiedTiles' same-drain visibility, not
    // Task 7's site-move refusal — an unfinished mover would be rejected
    // before the tile claim under test is ever consulted, and the assertion
    // below (rejection kind alone) would pass for the wrong reason.
    finishSite(world, buildingId);
    await dispatch(
      { type: 'constructBuilding', buildingDefId: 'gatherersHut', at: { col: 7, row: 7 } },
      { type: 'moveBuilding', buildingId, to: { col: 7, row: 7 } },
    );
    expect(snapshot().notices.map((n) => n.kind)).toEqual(['success', 'rejection']);
  });

  it('assigns and unassigns haulers, with one notice each', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Assigned a hauler.' }]);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(1);
    expect(snapshot().idleAdults).toBe(2); // 3 starting workers, one now hauling

    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(0);
    expect(snapshot().idleAdults).toBe(3);
  });

  it('rejects hauler assignment with no idle worker, and unassignment with no hauler', async () => {
    const { dispatch, snapshot } = await setup();
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No hauler to unassign.' }]);

    await dispatch({ type: 'assignHauler' }, { type: 'assignHauler' }, { type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
  });

  it('haulers are workers in every other respect — they still eat', async () => {
    // Built directly against HungerSystem: the shared `setup` runs only the
    // command and snapshot systems, so it could never show a hauler eating.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // this fixture spawns exactly the world it needs
    save.stockpile = { berries: 5 };
    const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
    spawnColonist(prep, getPrepResource(prep, IdCounter), { hauling: true });
    const world = await prep.prepareRun();
    for (let i = 0; i <= BALANCE.mealThreshold; i++) await world.step();
    expect(world.getResource(Stockpile).get('berries')).toBeLessThan(5);
  });

  it('never takes a building worker for hauling', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    await dispatch({ type: 'assignWorker', buildingId }, { type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignHauler' }); // one idle worker left
    await dispatch({ type: 'assignHauler' }); // none left
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    expect(snapshot().buildings[0].workers).toBe(2); // the staffed pair was never poached
  });

  it('assigning a building worker never poaches a hauler', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    // Turn every starting worker into a hauler (3 workers total)
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });
    // Verify all are hauling and none are idle
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(3);
    expect(snapshot().idleAdults).toBe(0);
    // Try to assign a worker to the building — should reject, not poach a hauler
    await dispatch({ type: 'assignWorker', buildingId });
    expect(snapshot().notices).toEqual([{ kind: 'rejection', message: 'No idle workers available.' }]);
    // Verify every hauler is still hauling with no buildingId
    expect(snapshot().colonists.every((w) => w.hauling && w.buildingId === null)).toBe(true);
    expect(snapshot().buildings[0].workers).toBe(0);
  });

  it('a hauler unassigned mid-trip drops its load in the store, never into nothing', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    await dispatch({ type: 'assignHauler' });
    await tick(); await tick(); await tick(); await tick(); // out and loaded
    const carrier = [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0)!;
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD);
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The trip must be reset, not merely handed off: buildSaveFromWorld banks a
    // carried load into the save filtered on `carrying`, NOT on `hauling`, so a
    // load left in hand here would be banked a second time on the next save —
    // the same units twice. legTicks and the leg's endpoints were genuinely
    // non-zero the moment before this (the carrier was mid-return-leg from
    // (5,4) to the camp) — cancel() must clear them along with everything
    // else, the same way it clears phase/targetId/resource/amount.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({
      phase: 'idle', targetId: null, resource: null, amount: 0, legTicks: 0,
      legFromCol: 0, legFromRow: 0, legToCol: 0, legToRow: 0,
    });
    expect(buildSaveFromWorld(world).stockpile.wood).toBe(before + ONE_LOAD);
  });

  // OBS-4-08: the old rule took the first hauler in entity-iteration order, so
  // pressing `−` could interrupt a loaded worker most of the way home while an
  // idle one stood at the camp. No goods were lost — the load is banked — but
  // the walk already done was thrown away for nothing.
  it('unassigning releases an idle hauler rather than one carrying a load home', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner: 13 ticks each way, so the return leg is long enough that
    // the two dispatches below cannot finish it out from under the assertion.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED, so the only work in this colony is the collect below. Since
    // Task 3 a construction site is a supply candidate for its own cost, and
    // supply outranks collect — an unfinished forester would take both haulers
    // out to it with wood and this case would never see a loaded return leg.
    finishSite(world, buildingId);
    for (const entity of world.getEntities()) {
      // Exactly one load: the first hauler empties the buffer, so the second has
      // nothing to fetch and stays idle at the camp instead of going outbound.
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
      }
    }
    await dispatch({ type: 'assignHauler' });
    const loaded = () => [...world.getEntities()].find((e) => (e.getComponent(HaulTrip)?.amount ?? 0) > 0);
    for (let i = 0; i < 20 && loaded() === undefined; i++) await tick();
    const carrier = loaded()!;
    expect(carrier.getComponent(HaulTrip)!.phase).toBe('returning'); // precondition, not the assertion
    await dispatch({ type: 'assignHauler' });

    const carriedBefore = carrier.getComponent(HaulTrip)!.amount;
    const stockBefore = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'unassignHauler' });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Unassigned a hauler.' }]);
    // The idle one went. The loaded trip is untouched: still returning, still
    // holding its load, and nothing banked early.
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({ phase: 'returning', amount: carriedBefore });
    expect(world.getResource(Stockpile).get('wood')).toBe(stockBefore);
    expect(snapshot().colonists.filter((w) => w.hauling)).toHaveLength(1);
  });

  it('a move retargets the haulers already walking to that building', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    // The far corner of the default map: BALANCE.haulTilesPerTick's own comment
    // pins it at 13 ticks each way -- genuinely distant, not a token trip.
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 23, row: 15 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED, for the reason above: an unfinished forester wants 10 wood of
    // its own, and a supply job would beat the collect this case is about.
    finishSite(world, buildingId);
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', 9);
    }
    // CommandSystem runs before HaulSystem (the real ALL_SYSTEMS order), so the
    // very tick that flags the worker as hauling also dispatches it -- no extra
    // tick is needed to see it start walking.
    await dispatch({ type: 'assignHauler' });
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    expect(trip()).toMatchObject({ targetId: buildingId, ticksLeft: 13, legTicks: 13 }); // the far-corner distance

    await tick(); await tick(); // well into the walk, nowhere near arrival
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 11, legTicks: 13 }); // legTicks never decrements

    // (5,5), not the (5,1) this case used to name. The leg is re-priced from
    // where the hauler HAS GOT TO — 2/13 of the way from the camp to (23,15),
    // i.e. (5.23, 2.31) — and not from the camp, so the two tiles disagree:
    // (5,5) is 2 ticks from there and 3 from the camp, while doing nothing at
    // all leaves 11. Three different numbers, so this assertion now tells the
    // three apart instead of only catching the third.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 5, row: 5 } });
    // Re-priced against the new tile (2), then HaulSystem's same-tick decrement
    // (CommandSystem runs first) takes it to 1. Exact value, still true under
    // the real order because 2 ticks leaves room for CommandSystem's write to
    // be decremented once without hitting zero in this same tick. legTicks is
    // refreshed to the SAME new total (2) but, unlike ticksLeft, is never
    // touched by that same-tick decrement — it is OBS-5-01's frozen figure.
    expect(trip()).toMatchObject({ phase: 'outbound', ticksLeft: 1, legTicks: 2 });

    // Behavioral proof, not another frame of the counter: within a handful of
    // ticks (not the dozen the original far-corner distance demanded) the
    // hauler must actually arrive, load, walk home and deposit. Four, not the
    // three (5,1) needed: the walk home from (5,5) is a tick longer.
    await tick(); await tick(); await tick(); await tick();
    expect(trip().phase).toBe('idle'); // arrived, loaded, walked home, delivered
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD); // the goods actually reached the stockpile
  });

  it('a move does not disturb a hauler already on its return leg', async () => {
    const { world, tick, dispatch, snapshot } = await setup();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } }); // 5 tiles out -> 3 ticks each way
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED, for the reason above: an unfinished forester wants 10 wood of
    // its own, and a supply job would beat the collect this case is about.
    finishSite(world, buildingId);
    const before = world.getResource(Stockpile).get('wood'); // 30 starting - 10 forester cost
    for (const entity of world.getEntities()) {
      const building = entity.getComponent(Building);
      if (building?.id === buildingId) entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
    }
    await dispatch({ type: 'assignHauler' }); // dispatched this same tick: outbound, ticksLeft 3
    const hauler = [...world.getEntities()].find((e) => e.getComponent(HaulTrip)?.phase === 'outbound')!;
    const trip = () => hauler.getComponent(HaulTrip)!;
    await tick(); await tick(); await tick(); // walks the 3 ticks out and loads
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 3, legTicks: 3, legFromCol: 5, legFromRow: 4,
      resource: 'wood', amount: ONE_LOAD,
    });

    // The building it loaded from moves elsewhere. A returning hauler walks to
    // the camp, which never moves, so this must leave the trip alone.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 9, row: 6 } });
    expect(snapshot().notices).toEqual([{ kind: 'success', message: 'Moved the Forester.' }]);
    // Only HaulSystem's ordinary per-tick decrement (3 -> 2), nothing extra
    // from the move: ticksLeft and the load it is carrying are untouched — and
    // neither are legTicks or the leg's frozen origin. OBS-5-01: a returning
    // trip's origin does not follow the building; legFromCol/legFromRow must
    // still read the OLD (5,4), never the new (9,6) the building moved to.
    expect(trip()).toMatchObject({
      phase: 'returning', ticksLeft: 2, legTicks: 3, legFromCol: 5, legFromRow: 4,
      resource: 'wood', amount: ONE_LOAD,
    });

    await tick(); await tick(); // the same 2 ticks it would have taken without the move
    expect(trip().phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD); // still delivers in full
  });

  // The buildings-side companion to the worker parity test below. OBS-4-02
  // recorded its absence as an open gap: OutputBuffer was added to the restore
  // path only, so buildings constructed during play had no buffer at all, and
  // nothing in the suite would have noticed.
  it('a constructed building carries the same components as a restored one', async () => {
    const save: SaveGameV6 = {
      ...initialSave(),
      // Beside the starter house, not instead of it: the founders' homeId
      // points at it, and the load guard refuses a home that names nothing.
      buildings: [
        ...initialSave().buildings,
        { inputBuffer: {}, stored: {}, id: 10, defId: 'forester', col: 6, row: 3, progress: 0, batchActive: false, buffer: {}, relocatingTicks: 0 },
      ],
      nextEntityId: 11, // strictly past every id above, or the load guard refuses the save
    };
    const { world, tick, dispatch } = await setup(save);
    const restored = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === 10)!;
    const expected = COMPONENT_TYPES.filter((type) => restored.getComponent(type) !== undefined);
    expect(expected.length).toBeGreaterThan(0); // guards against an empty comparison passing vacuously

    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester' });
    await tick();
    // id > 10 identifies the live-constructed one: the restored building holds
    // exactly 10, and ids only ever increase.
    const constructed = [...world.getEntities()]
      .filter((e) => e.getComponent(Building) !== undefined)
      .find((e) => e.getComponent(Building)!.id > 10)!;
    expect(constructed, 'no building was constructed').toBeDefined();
    for (const type of expected) {
      expect(constructed.getComponent(type), `constructed building is missing ${type.name}`).toBeDefined();
    }
  });

  it('a recruited worker carries the same components as a restored one', async () => {
    const { world, tick, dispatch } = await setup(saveThatCanHouseArrivals());
    // The highest existing id, not just "the first worker found": entity
    // iteration order is not id-ordered, and comparing against an arbitrary
    // starting worker would let the id > before.id check below match another
    // pre-existing (and therefore trivially complete) worker instead of the
    // actual recruit, silently defeating the whole test.
    const workers = [...world.getEntities()].filter((e) => e.getComponent(Colonist) !== undefined);
    const before = workers.reduce((max, e) => (e.getComponent(Colonist)!.id > max.getComponent(Colonist)!.id ? e : max));
    const expected = COMPONENT_TYPES.filter((type) => before.getComponent(type) !== undefined);
    await dispatch({ type: 'recruitWorker' });
    await tick();
    const recruited = [...world.getEntities()]
      .filter((e) => e.getComponent(Colonist) !== undefined)
      .find((e) => e.getComponent(Colonist)!.id > before.getComponent(Colonist)!.id)!;
    for (const type of expected) {
      expect(recruited.getComponent(type), `recruited worker is missing ${type.name}`).toBeDefined();
    }
  });

  it('a moved building stops producing for a distance-scaled downtime', async () => {
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    finishSite(world, buildingId);
    await dispatch({ type: 'assignWorker', buildingId });
    await dispatch({ type: 'assignWorker', buildingId });
    for (let i = 0; i < 10; i++) await tick(); // it is genuinely producing
    const madeBefore = snapshot().buildings[0].buffered;
    expect(madeBefore).toBeGreaterThan(0);

    // (5,4) -> (15,4) is exactly 10 tiles; at 1 tile/tick that is 10 ticks.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 15, row: 4 } });
    const paused = snapshot().buildings[0].buffered;
    for (let i = 0; i < 9; i++) await tick();
    expect(snapshot().buildings[0].buffered).toBe(paused); // nothing made while relocating

    for (let i = 0; i < 6; i++) await tick(); // downtime over, work resumes
    expect(snapshot().buildings[0].buffered).toBeGreaterThan(paused);
  });

  it('moving again replaces the remaining downtime rather than adding to it', async () => {
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED: relocation downtime is what this case measures, and Task 7's
    // site-move refusal would reject both moves below before any downtime
    // is ever written.
    finishSite(world, buildingId);
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } }); // long move
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 21, row: 14 } }); // 1 tile: 1 tick
    const relocation = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocation.ticksLeft).toBeLessThanOrEqual(1);
  });

  it('haulers still collect from a relocating building', async () => {
    // Acceptance criterion 3. Goods already in the buffer exist whether or not
    // the crew is working, so only production pauses — a relocating building
    // with a full buffer must still drain.
    const { world, tick, dispatch, snapshot } = await setupWithProduction();
    await dispatch({ type: 'constructBuilding', buildingDefId: 'forester', at: { col: 5, row: 4 } });
    await tick();
    const buildingId = snapshot().buildings[0].id;
    // FINISHED: a site is never a collect candidate (it produces nothing) and
    // Task 7's site-move refusal would reject the move below outright, so
    // this case needs a real building for either half of its own name.
    finishSite(world, buildingId);
    for (const entity of world.getEntities()) {
      if (entity.getComponent(Building)?.id === buildingId) {
        entity.getComponent(OutputBuffer)!.add('wood', ONE_LOAD);
      }
    }
    await dispatch({ type: 'assignHauler' });
    // Move it far enough that the downtime outlasts the whole haul round trip.
    await dispatch({ type: 'moveBuilding', buildingId, to: { col: 20, row: 14 } });
    const relocating = [...world.getEntities()]
      .find((e) => e.getComponent(Building)?.id === buildingId)!
      .getComponent(Relocation)!;
    expect(relocating.ticksLeft).toBeGreaterThan(10); // genuinely out of action for the whole trip

    const before = world.getResource(Stockpile).get('wood');
    for (let i = 0; i < 40; i++) await tick();
    expect(world.getResource(Stockpile).get('wood')).toBe(before + ONE_LOAD);
    expect(snapshot().buildings[0].buffered).toBe(0); // the buffer genuinely drained
  });

  // ---------------------------------------------------------------------
  // §2.7: goods, and the buildings that hold them. Four places goods can now
  // stand (camp, storehouse, in-tray, out-tray) plus a pair of hands, and every
  // path that ends a trip or removes a building has to account for all five.
  // ---------------------------------------------------------------------

  /** The depot, a whole map away from the camp: 11 ticks. */
  const DEPOT_TILE = { col: 20, row: 12 };
  /** The mill, 8 ticks from the camp and 4 from the depot — three leg lengths
   * (11, 8, 4) no two of which coincide, and none of which is ONE_LOAD. */
  const MILL_TILE = { col: 14, row: 9 };
  const MILL_ID = 80;
  const DEPOT_ID = 81;
  const DEPOT_SITE: StoreSite = { id: DEPOT_ID, ...DEPOT_TILE, capacity: BALANCE.storehouseCapacity };
  /** Every unit of wheat this colony owns, and it all starts in the depot: the
   * camp holds none, so a supply job can only be the walk out and back. 17 is
   * distinct from every leg length, from ONE_LOAD, and from the depot's own
   * capacity, so no assertion below can read one for another. */
  const DEPOT_WHEAT = 17;

  function withBuildings(...buildings: SaveGameV6['buildings']): SaveGameV6 {
    return { ...houselessSave(), buildings, stockpile: {}, nextEntityId: 100 };
  }

  const storeSpec = (id: number, at: TileRef, defId: 'mill' | 'storehouse'): SaveGameV6['buildings'][number] =>
    ({ id, defId, col: at.col, row: at.row, progress: 0, batchActive: false, buffer: {}, inputBuffer: {}, stored: {}, relocatingTicks: 0 });

  /**
   * A staffed mill wanting wheat, and a storehouse holding all of it. The one
   * fixture every cancellation case below runs in: `dispatch` returns with the
   * mill staffed, one hauler on duty and its supply trip already dispatched,
   * because CommandSystem runs before HaulSystem in the real order.
   */
  async function millAndDepot(systems?: readonly TColonySystemFactory[], extras: SaveGameV6['buildings'] = []) {
    const fixture = await setup(
      withBuildings(storeSpec(MILL_ID, MILL_TILE, 'mill'), storeSpec(DEPOT_ID, DEPOT_TILE, 'storehouse'), ...extras),
      systems,
    );
    fixture.world.getResource(Stockpile).refundAt(DEPOT_SITE, 'wheat', DEPOT_WHEAT);
    await fixture.dispatch({ type: 'assignWorker', buildingId: MILL_ID });
    await fixture.dispatch({ type: 'assignHauler' });
    return fixture;
  }

  /** The one hauler `millAndDepot` puts on duty, as a live trip. */
  function haulerTrip(world: IRuntimeWorld): HaulTrip {
    return [...world.getEntities()]
      .filter((e) => e.getComponent(JobAssignment)?.hauling === true)
      .map((e) => e.getComponent(HaulTrip)!)[0];
  }

  /** Walk the hauler's current leg down to its last tick, so the NEXT tick is
   * the one it arrives on. Returns the trip for chaining. */
  async function walkToLastTick(world: IRuntimeWorld, tick: () => Promise<void>): Promise<HaulTrip> {
    while (haulerTrip(world).ticksLeft > 1) await tick();
    return haulerTrip(world);
  }

  it('demolishing a storehouse leaves colony wealth unchanged', async () => {
    // THE assertion for §2.7, and it is wealth across the tick rather than "the
    // camp gained 37 bread": wealth is the figure the player watches, the one a
    // notice reading "cost refunded" would be lying about, and the one a future
    // refactor of WHERE goods live cannot accidentally satisfy.
    //
    // Unchanged does not mean "identical", because demolition also refunds the
    // construction cost — 20 Wood and 10 Planks, worth 50. That refund is the
    // ONLY thing wealth may move by. Destroying the contents instead would move
    // it by 50 - 296 = -246, a number nothing here could be confused for.
    const refundValue = Object.entries(BUILDINGS.storehouse.cost)
      .reduce((sum, [id, amount]) => sum + amount * RESOURCES[id as keyof typeof RESOURCES].value, 0);
    const { world, tick, dispatch, snapshot } = await setup(withBuildings(storeSpec(DEPOT_ID, DEPOT_TILE, 'storehouse')));
    const stockpile = world.getResource(Stockpile);
    stockpile.refundAt(DEPOT_SITE, 'bread', 37);
    await tick();
    const wealthBefore = snapshot().colonyWealth;
    expect(wealthBefore).toBe(37 * RESOURCES.bread.value); // the goods really are in the ledger already

    await dispatch({ type: 'demolishBuilding', buildingId: DEPOT_ID });
    expect(snapshot().colonyWealth - wealthBefore).toBe(refundValue);
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Storehouse — cost refunded, 37 Bread moved to the camp.' },
    ]);
    // And the ledger holds no site behind a building that is gone: §2.4's second
    // invariant, which the save would otherwise silently drop at the next write.
    expect(stockpile.getAt(CAMP_SITE_ID, 'bread')).toBe(37);
    expect(stockpile.siteIds()).toEqual([CAMP_SITE_ID]);
  });

  it('demolishing a producer loses both its buffers, and says so', async () => {
    // OBS-4-07's decision, extended to the in-tray for the same reason: neither
    // tray is in the ledger, and a building left full of goods should be
    // expensive to bulldoze.
    //
    // "AND SAYS SO" IS HALF THE TEST. The notice used to be worded from the
    // OUT-tray alone, so a mill holding only delivered wheat reported that its
    // cost was refunded while silently deleting the wheat. The two trays hold
    // different resources in different amounts, at different catalog positions,
    // so a notice built from either one alone fails on its text.
    const { world, tick, dispatch, snapshot } = await setup(withBuildings(storeSpec(MILL_ID, MILL_TILE, 'mill')));
    const mill = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === MILL_ID)!;
    mill.getComponent(InputBuffer)!.add('wheat', 4);
    mill.getComponent(OutputBuffer)!.add('flour', 9);
    await tick();
    expect(colonyTotal(world, 'wheat')).toBe(4);
    expect(colonyTotal(world, 'flour')).toBe(9);

    await dispatch({ type: 'demolishBuilding', buildingId: MILL_ID });
    expect(snapshot().notices).toEqual([
      { kind: 'success', message: 'Demolished the Mill — cost refunded, 4 Wheat, 9 Flour lost.' },
    ]);
    // Colony-wide, not "the buffer is empty": both really left the colony, and
    // neither quietly reappeared in the ledger as a refund.
    expect(colonyTotal(world, 'wheat')).toBe(0);
    expect(colonyTotal(world, 'flour')).toBe(0);
  });

  it('a hauler fetching for a building demolished this tick does not set off', async () => {
    // The rule Task 5 established for store sites, unapplied to a second lookup.
    // CommandSystem runs before HaulSystem and entity removal is deferred to the
    // post-step drain, so on the demolish tick — and only on that tick — the
    // target's row is still in `byId`. The fetch arrival is lined up to land on
    // exactly that tick, which is the only tick the bug exists on.
    const { world, tick, dispatch } = await millAndDepot();
    const stockpile = world.getResource(Stockpile);
    expect(haulerTrip(world)).toMatchObject({ phase: 'fetching', targetId: MILL_ID, sourceSiteId: DEPOT_ID, ticksLeft: 11 });
    await walkToLastTick(world, tick);

    await dispatch({ type: 'demolishBuilding', buildingId: MILL_ID });
    // Idle, not outbound: the recheck's own doc comment promises "either recheck
    // failing is a clean cancel: no load, no disposal, no remainder".
    expect(haulerTrip(world)).toMatchObject({ phase: 'idle', targetId: null, amount: 0 });
    // UNTOUCHED, which colonyTotal alone could never show: the round trip
    // conserves either way, so 14 in the depot and 3 in a pair of hands would
    // pass a conservation assertion while the goods walked to a demolished mill.
    expect(stockpile.getAt(DEPOT_ID, 'wheat')).toBe(DEPOT_WHEAT);
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
  });

  it('cancels a fetching hauler when its source storehouse is moved out from under it', async () => {
    // §2.7's "stops being one" rule, unapplied to the move loop: it matched an
    // outbound trip by `targetId`, so a hauler still WALKING TO FETCH from a
    // storehouse that moves was left alone. Nothing is ever LOST either way —
    // `fetchArrival`'s own by-tile recheck cancels it clean on arrival — so the
    // only thing this test can show is the WASTED TICKS: cancelled on the
    // move's own tick, not the 9 more it would otherwise walk toward a tile the
    // depot no longer stands on. 11 ticks is deliberately not the 2 ticks
    // walked before the move, not ONE_LOAD, and not any leg length in this
    // file's other cases, so "cancelled now" and "cancelled on arrival" cannot
    // be confused for one another.
    const { world, tick, dispatch } = await millAndDepot();
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    expect(haulerTrip(world)).toMatchObject({ phase: 'fetching', sourceSiteId: DEPOT_ID, ticksLeft: 11 });

    await tick(); await tick(); // partway into the 11-tick leg, nowhere near arrival
    expect(haulerTrip(world).ticksLeft).toBe(9);

    await dispatch({ type: 'moveBuilding', buildingId: DEPOT_ID, to: { col: 21, row: 12 } });
    // ON THIS TICK: idle, not still fetching with 9 ticks left to walk off a
    // tile nothing stands on any more.
    expect(haulerTrip(world)).toMatchObject({ phase: 'idle', targetId: null, sourceSiteId: CAMP_SITE_ID, amount: 0 });
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
    expect(systemErrors).toBe(0);
  });

  it('cancels a fetching hauler when its source storehouse is demolished under it', async () => {
    const { world, tick, dispatch } = await millAndDepot();
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    expect(haulerTrip(world)).toMatchObject({ phase: 'fetching', sourceSiteId: DEPOT_ID, ticksLeft: 11 });

    // The mill is unstaffed before the demolition — not because staffing
    // matters to a fetch already under way (only the outbound arrival
    // rechecks it, per §2.5 step 3), but because `spillTo` lands the depot's
    // whole stock at the camp in the very same command that demolishes it,
    // and a still-staffed mill would then legitimately claim a FRESH supply
    // job from the camp on this same tick — a correct redispatch that would
    // make "idle" the wrong thing to assert for what this test checks.
    await dispatch({ type: 'unassignWorker', buildingId: MILL_ID });
    expect(haulerTrip(world).ticksLeft).toBe(10); // this dispatch also costs a tick

    await tick(); await tick(); // partway into the 11-tick leg, nowhere near arrival
    expect(haulerTrip(world).ticksLeft).toBe(8);

    await dispatch({ type: 'demolishBuilding', buildingId: DEPOT_ID });
    // ON THIS TICK, and the depot's own stock (spilled to the camp by the
    // demolition itself) shows nothing was taken by the cancelled fetch.
    expect(haulerTrip(world)).toMatchObject({ phase: 'idle', targetId: null, sourceSiteId: CAMP_SITE_ID, amount: 0 });
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
    expect(systemErrors).toBe(0);
  });

  it('a fetching hauler whose TARGET processor is demolished releases its source claim', async () => {
    // The third face of §2.7's rule, missed by the other two: neither the
    // outbound `targetId` clause nor the fetching `sourceSiteId` clause
    // matches a hauler still WALKING TO FETCH whose destination processor is
    // demolished while its source is a different, still-live site. Unlike the
    // other two, this trip's own recheck (`fetchArrival`) resolves it cleanly
    // eventually — NOTHING IS LOST. What is lost, for up to a whole leg, is
    // the CLAIM: the trip stays 'fetching' with `sourceSiteId`/`plannedAmount`
    // pointed at a live depot, so `unclaimedAt` keeps subtracting a
    // reservation for a delivery that can never land — blocking every OTHER
    // hauler, not just this one. The proof has to be that release, not merely
    // "the hauler goes idle": a hand-rolled reset that moves `phase` without
    // clearing `sourceSiteId`/`plannedAmount` would still pass a phase-only
    // assertion, so this test ends by showing a SECOND hauler served from the
    // freed stock, not just the first one's own fields.
    const OTHER_MILL_TILE = { col: 4, row: 14 };
    const OTHER_MILL_ID = 180;
    // Equal to a homeless hauler's carry capacity ON PURPOSE — this case only
    // exists when the source is FULLY claimed, so the depot's whole stock and
    // the dispatched hauler's plannedAmount must coincide. Every other number
    // here (both mill tiles, the depot tile) is the pairwise-distinct set the
    // rest of this file already established.
    const FULL_CLAIM_WHEAT = ONE_LOAD;

    const { world, dispatch } = await setup(
      withBuildings(
        storeSpec(MILL_ID, MILL_TILE, 'mill'),
        storeSpec(DEPOT_ID, DEPOT_TILE, 'storehouse'),
        storeSpec(OTHER_MILL_ID, OTHER_MILL_TILE, 'mill'),
      ),
    );
    const stockpile = world.getResource(Stockpile);
    stockpile.refundAt(DEPOT_SITE, 'wheat', FULL_CLAIM_WHEAT);
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });

    // One worker at the mill under test, two haulers — the second stays idle
    // once the first has claimed the depot's whole stock for the first mill.
    await dispatch({ type: 'assignWorker', buildingId: MILL_ID });
    await dispatch({ type: 'assignHauler' });
    await dispatch({ type: 'assignHauler' });

    const haulerEntities = [...world.getEntities()].filter((e) => e.getComponent(JobAssignment)?.hauling === true);
    expect(haulerEntities).toHaveLength(2);
    const [first, second] = haulerEntities;
    const [claimant, bystander] = first.getComponent(HaulTrip)!.phase === 'fetching' ? [first, second] : [second, first];
    expect(claimant.getComponent(HaulTrip)).toMatchObject({
      phase: 'fetching', sourceSiteId: DEPOT_ID, targetId: MILL_ID, plannedAmount: FULL_CLAIM_WHEAT,
    });
    // Fully claimed, per the case's own name: nothing left for the bystander.
    expect(bystander.getComponent(HaulTrip)!.phase).toBe('idle');
    expect(colonyTotal(world, 'wheat')).toBe(FULL_CLAIM_WHEAT);

    await dispatch({ type: 'demolishBuilding', buildingId: MILL_ID });
    // THE fix: cancelled and fully cleared on the demolish tick, not merely
    // moved to 'idle' with the claim fields left standing.
    expect(claimant.getComponent(HaulTrip)).toMatchObject({
      phase: 'idle', targetId: null, sourceSiteId: CAMP_SITE_ID, amount: 0, plannedAmount: 0,
    });
    // Untouched: a fetching hauler had taken nothing, so nothing left the
    // ledger and nothing was destroyed along with the mill.
    expect(colonyTotal(world, 'wheat')).toBe(FULL_CLAIM_WHEAT);
    expect(systemErrors).toBe(0);

    // Take the claimant off duty so the next dispatch cannot be answered by
    // the SAME hauler recovering on its own — the point is that a DIFFERENT
    // hauler was unblocked, not that this one could simply retry itself.
    await dispatch({ type: 'unassignHauler' });
    expect(claimant.getComponent(JobAssignment)!.hauling).toBe(false);
    expect(bystander.getComponent(JobAssignment)!.hauling).toBe(true);

    // The freed worker restaffs the second mill — the only building left that
    // wants wheat, and the only dispatch this claim's release can answer.
    await dispatch({ type: 'assignWorker', buildingId: OTHER_MILL_ID });
    // THE assertion: the bystander — a hauler that was never anywhere near the
    // demolished building — is now dispatched against the depot's full stock.
    // Without the fix, the claimant's phantom claim would still be subtracting
    // FULL_CLAIM_WHEAT from `unclaimedAt`, leaving nothing for anyone to take.
    expect(bystander.getComponent(HaulTrip)).toMatchObject({
      phase: 'fetching', sourceSiteId: DEPOT_ID, targetId: OTHER_MILL_ID, plannedAmount: FULL_CLAIM_WHEAT,
    });
    expect(colonyTotal(world, 'wheat')).toBe(FULL_CLAIM_WHEAT);
  });

  it('a cancelled trip disposes of its load by whether a hauler is left to walk', async () => {
    // §2.7's split, both sides from one fixture. A FETCHING hauler has taken
    // nothing yet, so every path cancels it clean; a loaded one splits on
    // whether anybody is left to do the walking.
    const { world, tick, dispatch } = await millAndDepot();
    const stockpile = world.getResource(Stockpile);

    // (1) Nothing taken yet: unassigning mid-fetch disposes of nothing.
    await dispatch({ type: 'unassignHauler' });
    expect(stockpile.getAt(DEPOT_ID, 'wheat')).toBe(DEPOT_WHEAT);
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);

    // Back on duty, and this time walked all the way out and loaded.
    await dispatch({ type: 'assignHauler' });
    await walkToLastTick(world, tick);
    await tick();
    expect(haulerTrip(world)).toMatchObject({ phase: 'outbound', resource: 'wheat', amount: ONE_LOAD, pickedUp: false });
    expect(stockpile.getAt(DEPOT_ID, 'wheat')).toBe(DEPOT_WHEAT - ONE_LOAD);
    await tick(); await tick(); // halfway along the four-tick walk out, standing on neither end

    // (2) The hauler survives and can carry it: the target is demolished under
    // it, so it turns for home ON THIS TICK from where it stands. The TICKS are
    // the assertion, not the destination — "the goods arrived" would pass for a
    // teleport. 2 is the walk back from the tile it actually reached; pricing it
    // from the leg's frozen origin instead gives 1 (the depot is underfoot
    // there), from the camp 11, and to the camp rather than to its own source
    // 10. Four different numbers, so this tells all four apart.
    expect(haulerTrip(world)).toMatchObject({ legTicks: 4, ticksLeft: 2 });
    await dispatch({ type: 'demolishBuilding', buildingId: MILL_ID });
    expect(haulerTrip(world)).toMatchObject({
      phase: 'returning', amount: ONE_LOAD, destSiteId: DEPOT_ID, legTicks: 2, ticksLeft: 1,
    });
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);

    // (3) Nobody left to walk it: the same load, in the same hands, banked
    // immediately because this colonist stops being a hauler. Held by entity
    // rather than found by `hauling`, which is the very flag being cleared.
    const carrier = [...world.getEntities()].find((e) => e.getComponent(JobAssignment)?.hauling === true)!;
    await dispatch({ type: 'unassignHauler' });
    expect(carrier.getComponent(HaulTrip)!).toMatchObject({ phase: 'idle', amount: 0, resource: null });
    expect(stockpile.getAt(DEPOT_ID, 'wheat')).toBe(DEPOT_WHEAT); // back where it came from
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
  });

  /**
   * A hauler killed mid-trip, and what the ledger recorded for the load in its
   * hands. Both worlds end with the SAME colonist holding the SAME three wheat
   * — only `pickedUp` differs, which is the whole discriminator §2.4 asks for.
   */
  async function deathMidTrip(carrying: 'supply' | 'collect') {
    const systems = [CommandSystem, PopulationSystem, HaulSystem, SnapshotSystem];
    const fixture = carrying === 'supply'
      ? await millAndDepot(systems)
      : await setup({ ...withBuildings(storeSpec(MILL_ID, MILL_TILE, 'mill')), stockpile: {} }, systems);
    const { world, tick, dispatch } = fixture;
    if (carrying === 'collect') {
      // A full out-tray and no in-tray: the only job on offer is a collect run,
      // so the hauler comes back holding goods it PICKED UP.
      const mill = [...world.getEntities()].find((e) => e.getComponent(Building)?.id === MILL_ID)!;
      mill.getComponent(OutputBuffer)!.add('wheat', DEPOT_WHEAT);
      await dispatch({ type: 'assignHauler' });
    }
    await walkToLastTick(world, tick);
    await tick();
    return fixture;
  }

  it('a hauler who dies mid-supply-trip refunds rather than delivers', async () => {
    // standDown's own path, reached through death rather than any command — it
    // banked with `stockpile.add` until Task 8, which records a delivery, so a
    // colonist dying with an undelivered SUPPLY load inflated Delivered/t for
    // wheat that was merely going back where it came from.
    //
    // producedThisTick is exactly what StatsSystem publishes as deliveredRate,
    // read directly so the assertion is not filtered through a rolling window.
    const supply = await deathMidTrip('supply');
    expect(haulerTrip(supply.world)).toMatchObject({ amount: ONE_LOAD, pickedUp: false });
    const hauler = [...supply.world.getEntities()].find((e) => e.getComponent(JobAssignment)?.hauling === true)!;
    hauler.getComponent(Hunger)!.starvingTicks = BALANCE.starvationDeathTicks;
    await supply.tick();
    expect(supply.snapshot().notices.some((n) => n.message.includes('starved'))).toBe(true);
    expect(supply.world.getResource(Stockpile).producedThisTick.get('wheat') ?? 0).toBe(0);
    expect(colonyTotal(supply.world, 'wheat')).toBe(DEPOT_WHEAT);

    // The discriminating half: same death, same three wheat, but PICKED UP out
    // of an out-tray — goods the ledger has never counted, so this one IS a
    // delivery. Without it the case above passes with the banking deleted.
    const collect = await deathMidTrip('collect');
    expect(haulerTrip(collect.world)).toMatchObject({ amount: ONE_LOAD, pickedUp: true });
    const doomed = [...collect.world.getEntities()].find((e) => e.getComponent(JobAssignment)?.hauling === true)!;
    doomed.getComponent(Hunger)!.starvingTicks = BALANCE.starvationDeathTicks;
    await collect.tick();
    expect(collect.world.getResource(Stockpile).producedThisTick.get('wheat') ?? 0).toBe(ONE_LOAD);
    expect(colonyTotal(collect.world, 'wheat')).toBe(DEPOT_WHEAT);
  });

  it('cancelling a supply trip whose source filled meanwhile loses nothing', async () => {
    // The source depot is BOUNDED and back at exactly its capacity by the time
    // the trip is cancelled, so the load cannot go home to where it came from.
    //
    // A SECOND depot stands one tick from the hauler, and it is what gives this
    // case teeth: conservation alone cannot fail here, because every wrong
    // answer still ends at the camp — banking blind with `stockpile.add` (the
    // pre-Task-8 code) lands there, and so does resolving the full source and
    // letting §2.4's forward-to-camp catch the overflow. Naming the site the
    // load actually reaches tells all three apart: 1 tick to NEAR_DEPOT, 2 back
    // to the full source, 10 on to the camp.
    const NEAR_DEPOT_ID = 82;
    const NEAR_DEPOT_TILE = { col: 16, row: 10 };
    const { world, tick, dispatch } = await millAndDepot(undefined, [storeSpec(NEAR_DEPOT_ID, NEAR_DEPOT_TILE, 'storehouse')]);
    const stockpile = world.getResource(Stockpile);
    await walkToLastTick(world, tick);
    await tick();
    expect(haulerTrip(world)).toMatchObject({ phase: 'outbound', amount: ONE_LOAD, sourceSiteId: DEPOT_ID });
    await tick(); await tick(); // halfway out, so all three sites are different distances away

    // Packed to exactly capacity with something else while the hauler walked.
    // The equality IS the subject here, so it is stated rather than avoided.
    const filler = BALANCE.storehouseCapacity - (DEPOT_WHEAT - ONE_LOAD);
    stockpile.refundAt(DEPOT_SITE, 'planks', filler);
    expect(stockpile.totalAt(DEPOT_ID)).toBe(BALANCE.storehouseCapacity);

    await dispatch({ type: 'unassignHauler' });
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
    // The camp's share is ZERO, and that is the assertion: a load with nobody
    // left to walk it is still banked at a site chosen by distance, not dumped
    // at the camp by reflex — the camp is the last resort, not the route.
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(0);
    expect(stockpile.getAt(NEAR_DEPOT_ID, 'wheat')).toBe(ONE_LOAD);
    // And the full source is neither drawn from again nor overfilled.
    expect(stockpile.getAt(DEPOT_ID, 'wheat')).toBe(DEPOT_WHEAT - ONE_LOAD);
    expect(stockpile.totalAt(DEPOT_ID)).toBe(BALANCE.storehouseCapacity);
  });

  it('cancelling a supply trip whose source was demolished in the same drain loses nothing', async () => {
    // Sharper than the case above, and the reason addAt/refundAt take a resolved
    // StoreSite: banking into a dead storehouse would create a ledger site no
    // building owns. Those goods would count in colonyWealth, be unreachable by
    // any hauler, and disappear at the next save, because a storehouse's
    // contents are serialized off the BUILDING record.
    const { world, tick, dispatch } = await millAndDepot();
    const stockpile = world.getResource(Stockpile);
    await walkToLastTick(world, tick);
    await tick();
    expect(haulerTrip(world)).toMatchObject({ phase: 'outbound', amount: ONE_LOAD, sourceSiteId: DEPOT_ID });

    // ONE drain: the source is gone by the time the release resolves a site.
    await dispatch(
      { type: 'demolishBuilding', buildingId: DEPOT_ID },
      { type: 'unassignHauler' },
    );
    expect(colonyTotal(world, 'wheat')).toBe(DEPOT_WHEAT);
    // The one that catches an orphan: every ledger site must name a live
    // building, and the camp is the only site left standing.
    expect(stockpile.siteIds()).toEqual([CAMP_SITE_ID]);
    expect(stockpile.getAt(CAMP_SITE_ID, 'wheat')).toBe(DEPOT_WHEAT);
  });

  it('demolition still refunds 100% of construction cost', async () => {
    // A decision, not an accident: increment 5 considered cutting the refund as
    // a balance knob and rejected it, because free relocation dominated it —
    // a player could dodge any refund penalty by moving instead of rebuilding.
    // Now that moving costs downtime the two acts are cleanly separated: moving
    // costs time, removing is fully refunded.
    //
    // The NUMBER is already guarded by the two demolition tests above — both
    // fail if the refund is halved. What this test adds is the REASON it is
    // 100%, recorded at an assertion rather than only in a spec, so a future
    // balance pass reaching for this knob finds the argument against it here.
    //
    // A FINISHED forester, because since §2.3 an ordered one is a site whose
    // cost was never charged — refunding that would mint wood from nothing,
    // which is a different rule and has its own case above.
    const { world, dispatch } = await setup(saveWithFinishedForester());
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'demolishBuilding', buildingId: FINISHED_FORESTER_ID });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + 10); // forester costs 10 wood
  });

  it('demolition refund does not count as a hauler delivery', async () => {
    // Stockpile.add unconditionally records into producedThisTick, which
    // StatsSystem publishes as deliveredRate. Routing the refund through
    // add() would inflate Delivered/t for a resource no hauler touched, and
    // could push it above Made/t — undermining the gap-is-haul-backlog
    // reading the Made/t + Delivered/t pairing (OBS-4-06) depends on.
    // refund() must bank the same amount without ever touching
    // producedThisTick. Both halves matter: the refund amount is existing
    // behaviour that must not regress, and the zeroed producedThisTick is
    // the fix.
    const { world, dispatch } = await setup(saveWithFinishedForester());
    const before = world.getResource(Stockpile).get('wood');
    await dispatch({ type: 'demolishBuilding', buildingId: FINISHED_FORESTER_ID });
    expect(world.getResource(Stockpile).get('wood')).toBe(before + 10); // full refund
    expect(world.getResource(Stockpile).producedThisTick.get('wood') ?? 0).toBe(0); // not a delivery
  });
});
