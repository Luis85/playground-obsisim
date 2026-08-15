import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { Building, Colonist, HaulTrip, JobAssignment } from '../../../src/engine/components';
import { IdCounter, SimClock, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, isLoadableSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import { buildSaveFromWorld } from '../../../src/engine/game-engine';
import { BALANCE } from '../../../src/engine/content/balance';
import { autoPlacePosition, autoPlaceSequence, DEFAULT_MAP } from '../../../src/shared/placement';
import { lifespanFor } from '../../../src/shared/population';
import type { Command } from '../../../src/shared/commands';
import type { ResourceId } from '../../../src/shared/content-types';
import type { Snapshot } from '../../../src/shared/snapshot';
import { enqueue, stepTick } from '../fixtures';

async function colonyWith(ages: { id: number; ageTicks: number; buildingId?: number | null }[]) {
  const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
  const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
  const ids = getPrepResource(prep, IdCounter);
  const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
  const buildingId = building.getComponent(Building)!.id;
  for (const spec of ages) {
    spawnColonist(prep, ids, { id: spec.id, ageTicks: spec.ageTicks, buildingId: spec.buildingId ?? null });
  }
  const world = await prep.prepareRun();
  return { world, buildingId };
}

/**
 * The tick's notices, as plain sentences. Read off the SNAPSHOT rather than
 * off NoticeBoard: `takeAll` empties the board during the snapshot phase, so
 * the published snapshot is the only place a notice still exists after a tick
 * — and it is what the player actually reads.
 */
const messages = (snapshot: Snapshot): string[] => snapshot.notices.map((n) => n.message);
const retirements = (snapshot: Snapshot): string[] => messages(snapshot).filter((m) => m.includes('retired'));
const comingsOfAge = (snapshot: Snapshot): string[] => messages(snapshot).filter((m) => m.includes('came of age'));

describe('PopulationSystem — aging', () => {
  it('ages every colonist one tick per tick', async () => {
    const { world } = await colonyWith([{ id: 1, ageTicks: 0 }]);
    await stepTick(world);
    await stepTick(world);
    const me = world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;
    expect(me.ageTicks).toBe(2);
    expect(me.stage).toBe('child');
  });

  it('retires an adult who crosses the elder band, freeing its job slot', async () => {
    // One tick short of retirement, holding a job. Distinct from the death
    // case below: this colonist survives, it just stops working.
    const { world, buildingId } = await colonyWith([
      { id: 1, ageTicks: BALANCE.lifeBands.retireTicks - 1, buildingId: 1 },
    ]);
    // re-point the assignment at the real building id
    for (const entity of world.getEntities()) {
      const job = entity.getComponent(JobAssignment);
      if (job) job.buildingId = buildingId;
    }
    await stepTick(world);
    const me = world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;
    expect(me.stage).toBe('elder');
    expect(me.buildingId).toBeNull();       // unassigned by retirement
    const building = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === buildingId)!;
    expect(building.workers).toBe(0);        // and the slot is free
  });

  it('announces BOTH adults who cross the elder band, the idle one as well as the employed one', async () => {
    // OBS-6-03. The notice used to hang off the unassignment, so an idle
    // colonist retired in silence — and in §4.1's own curve the colony holds
    // 34-40 against roughly six job slots, so the silent kind was the large
    // majority. The test above cannot see it: one colonist, holding a job.
    const { world, buildingId } = await colonyWith([
      { id: 1, ageTicks: BALANCE.lifeBands.retireTicks - 1, buildingId: 1 },
      { id: 2, ageTicks: BALANCE.lifeBands.retireTicks - 1 },
    ]);
    // Re-point ONLY the seeded assignment at the real building id — a blanket
    // re-point would employ colonist 2 as well and erase the whole comparison.
    const jobs = [...world.getEntities()].map((e) => e.getComponent(JobAssignment)).filter((j) => j !== undefined);
    const staffed = jobs.filter((job) => job.buildingId !== null);
    expect(staffed).toHaveLength(1); // fixture precondition: exactly one is employed, one idle
    staffed[0].buildingId = buildingId;

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.map((c) => c.stage)).toEqual(['elder', 'elder']); // both crossed
    expect(retirements(snapshot)).toEqual(['Colonist #1 retired.', 'Colonist #2 retired.']);

    // And exactly once each: `>=` in place of the equality would re-announce
    // every elder on every tick for the rest of their life.
    await stepTick(world);
    expect(retirements(world.getResource(SnapshotStore).latest!)).toEqual([]);
  });

  it('announces BOTH children who come of age, the mirror of retirement', async () => {
    // The other end of the same rule (OBS-6-03): a child reaching matureTicks
    // grows the assignable pool exactly as an elder leaving it shrinks the
    // pool. Neither child holds a job — a child never can — so this notice is
    // reachable ONLY from the band transition, never from a stand-down.
    const { world } = await colonyWith([
      { id: 1, ageTicks: BALANCE.lifeBands.matureTicks - 1 },
      { id: 2, ageTicks: BALANCE.lifeBands.matureTicks - 1 },
    ]);
    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.map((c) => c.stage)).toEqual(['adult', 'adult']); // both crossed
    expect(comingsOfAge(snapshot)).toEqual(['Colonist #1 came of age.', 'Colonist #2 came of age.']);

    await stepTick(world);
    expect(comingsOfAge(world.getResource(SnapshotStore).latest!)).toEqual([]); // once each, not every tick
  });

  it('does not announce a retirement for a colonist who starves on the very tick they cross', async () => {
    // Why the notices phase runs AFTER the two death phases. Both are
    // reachable together — starvation is age-independent — and a colonist
    // announced as retiring in the same breath as their own death notice is
    // the kind of nonsense a phase order silently produces.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    // Id 1 crosses the band on the tick the starvation clock runs out; id 2 is
    // the CONTROL — same age, well fed — without which this test would pass
    // just as happily against a build that announced nobody at all.
    spawnColonist(prep, ids, {
      id: 1, ageTicks: BALANCE.lifeBands.retireTicks - 1,
      hunger: BALANCE.hungerMax, starvingTicks: BALANCE.starvationDeathTicks - 1,
    });
    spawnColonist(prep, ids, { id: 2, ageTicks: BALANCE.lifeBands.retireTicks - 1 });
    const world = await prep.prepareRun();

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.map((c) => c.id)).toEqual([2]); // 1 died this tick
    expect(messages(snapshot)).toContain('Colonist #1 starved.');
    expect(retirements(snapshot)).toEqual(['Colonist #2 retired.']);
  });

  it('still calls a staffed child a repair, not a coming-of-age event', async () => {
    // The "is too young to work" branch deliberately did NOT move to a band
    // trigger. It fires only for a save loaded after matureTicks was raised —
    // a repair explaining why a staffed building emptied — so it must stay
    // keyed to the stand-down, and must not be reworded into the mirror
    // notice above. Seeded well short of the band so no transition is in play.
    const { world, buildingId } = await colonyWith([
      { id: 1, ageTicks: BALANCE.lifeBands.matureTicks - 50, buildingId: 1 },
    ]);
    const staffed = [...world.getEntities()]
      .map((e) => e.getComponent(JobAssignment)).filter((j) => j !== undefined)
      .filter((job) => job.buildingId !== null);
    expect(staffed).toHaveLength(1); // fixture precondition: the child really is staffed
    staffed[0].buildingId = buildingId;

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists[0].buildingId).toBeNull(); // stood down
    expect(messages(snapshot)).toContain('Colonist #1 is too young to work.');
    expect(comingsOfAge(snapshot)).toEqual([]);
    expect(retirements(snapshot)).toEqual([]);
  });

  it('kills a colonist who reaches its own lifespan, not a shared one', async () => {
    // Two colonists of IDENTICAL age and different ids. They cannot be born
    // on the same tick (births are cooldown-gated colony-wide), so the test
    // seeds equal ages directly. If both die together the id-derived spread
    // is not reaching the comparison.
    const span1 = lifespanFor(1, BALANCE.lifeBands);
    const span2 = lifespanFor(2, BALANCE.lifeBands);
    expect(span1).not.toBe(span2); // fixture precondition, not the assertion
    const younger = Math.min(span1, span2);
    const { world } = await colonyWith([
      { id: 1, ageTicks: younger - 1 },
      { id: 2, ageTicks: younger - 1 },
    ]);
    await stepTick(world);
    const alive = world.getResource(SnapshotStore).latest!.colonists.map((c) => c.id);
    expect(alive).toHaveLength(1);
    expect(alive[0]).toBe(span1 < span2 ? 2 : 1); // the longer-lived one survives
  });
});

describe('PopulationSystem — starvation', () => {
  it('kills a colonist pinned at max hunger, but not before the counter runs out', async () => {
    // Empty store: nothing to eat, ever. Fixture values discriminate — the
    // colonist starts BELOW hungerMax so the first ticks raise hunger without
    // touching the starvation clock, which is what separates "hungry" from
    // "starving".
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax - 2 });
    const world = await prep.prepareRun();

    const step = () => stepTick(world);
    const me = () => world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1);

    await step();
    expect(me()!.starvingTicks).toBe(0);          // hunger 99: hungry, not starving
    await step();
    expect(me()!.starvingTicks).toBe(1);          // pinned at the cap: the clock starts
    for (let i = 0; i < BALANCE.starvationDeathTicks - 2; i++) await step();
    expect(me()).toBeDefined();                    // still alive one tick short
    await step();
    expect(me()).toBeUndefined();                  // and now dead
  });

  it('resets the starvation clock the moment a colonist eats', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const me = () => world.getResource(SnapshotStore).latest!.colonists.find((c) => c.id === 1)!;

    await step();
    await step();
    expect(me().starvingTicks).toBe(2);
    world.getResource(Stockpile).add('bread', 1);
    await step();
    expect(me().starvingTicks).toBe(0);
    expect(me().hunger).toBe(0);
  });
});

describe('PopulationSystem — a die-off of more than one colonist', () => {
  /**
   * OBS-6-02. Every other death test in this file kills exactly ONE colonist
   * — including the lifespan test, which deliberately gives two colonists
   * different lifespans so that only one dies — so none of them can see what
   * happens when a tick removes more than one entity.
   *
   * What happened before the RemovalLedger carried the entities: removals went
   * through sim-ecs's deferred command queue, and sim-ecs 0.6.4 throws inside
   * `removeEntity` for any entity that entered the world at prep time (its
   * event-handler record is never registered, and `removeEntity` unhooks the
   * listeners AFTER deleting the entity). The throw was swallowed at the sync
   * point, aborting the rest of that batch, and each leftover removal then
   * drained on a subsequent `step()` that ran NO systems at all. A die-off of
   * `n` cost `n - 1` steps in which nothing aged, nothing was produced and no
   * snapshot was published — while `SimClock.tick` advanced across them.
   *
   * The fed survivor is the instrument: its age is the one thing that must
   * change on every tick regardless of who died, so an age that stands still
   * is a tick that did not happen.
   */
  it('kills three colonists on one tick without costing the colony a single tick', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    // Three colonists one tick from starving, so the next tick's HungerSystem
    // (empty store) pushes all three over the threshold together.
    for (const id of [1, 2, 3]) {
      spawnColonist(prep, ids, {
        id, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax,
        starvingTicks: BALANCE.starvationDeathTicks - 1,
      });
    }
    // Fed (hunger 0 with an empty store still leaves ~200 ticks of slide) and
    // nowhere near its own lifespan, so nothing about this colonist may change
    // over the six steps below except its age.
    spawnColonist(prep, ids, { id: 4, ageTicks: 1000, hunger: 0 });
    const world = await prep.prepareRun();

    const snapshotTicks: number[] = [];
    const survivorAges: number[] = [];
    const rosters: number[][] = [];
    let starvedNotices = 0;
    for (let i = 0; i < 6; i++) {
      await stepTick(world);
      const snapshot = world.getResource(SnapshotStore).latest!;
      snapshotTicks.push(snapshot.tick);
      survivorAges.push(snapshot.colonists.find((c) => c.id === 4)!.ageTicks);
      rosters.push(snapshot.colonists.map((c) => c.id));
      starvedNotices += snapshot.notices.filter((n) => n.message.includes('starved')).length;
    }

    // All three gone in the ONE step that killed them, not one per step.
    expect(rosters[0]).toEqual([4]);
    // Every step advanced the simulation: the snapshot's own tick moves each
    // time, which it cannot do unless SnapshotSystem ran.
    expect(snapshotTicks).toEqual([1, 2, 3, 4, 5, 6]);
    // ...and PopulationSystem ran, which SnapshotSystem alone would not prove.
    expect(survivorAges).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
    // Three deaths, three notices. A frozen step republishes the same
    // Snapshot object, so a per-tick tally re-reads its notices — which is
    // how this defect was found (nine starvation deaths for three colonists).
    expect(starvedNotices).toBe(3);
  });
});

/**
 * Point colonist `id`'s HaulTrip mid-return, `amount` of `resource` in hand —
 * the shape `standDown` must bank when this colonist dies. `ticksLeft` is set
 * above 1 so HaulSystem's own deposit (`ticksLeft -= 1; if (> 0) continue`)
 * would not fire on the death tick either: the only route the load has to the
 * stockpile, on that tick, is `standDown` itself.
 */
function sendHauling(world: IRuntimeWorld, id: number, resource: ResourceId, amount: number): void {
  for (const entity of world.getEntities()) {
    if (entity.getComponent(Colonist)?.id !== id) continue;
    entity.getComponent(JobAssignment)!.hauling = true;
    const trip = entity.getComponent(HaulTrip)!;
    trip.phase = 'returning';
    trip.resource = resource;
    trip.amount = amount;
    trip.ticksLeft = 5;
    trip.legTicks = 5;
  }
}

describe('PopulationSystem — standDown on death', () => {
  // Both removers call standDown(ctx, row) before removing the entity,
  // because sim-ecs defers the removal to the post-step sync: a colonist
  // killed this tick is still visible to ProductionSystem and HaulSystem
  // later in the SAME tick. standDown nulls the job, clears hauling, banks
  // any carried load into the stockpile, and resets the trip. Nothing else
  // in either remover performs those four things, so deleting the standDown
  // call is otherwise invisible to the rest of the suite.

  it("banks a starving hauler's carried load into the stockpile the tick they die", async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    // One tick short of the death threshold, already pinned at max hunger:
    // the next tick's HungerSystem run (empty store, nothing to eat) pushes
    // starvingTicks to the cap and resolveStarvation fires that same tick.
    spawnColonist(prep, ids, {
      id: 1, ageTicks: BALANCE.lifeBands.matureTicks, hunger: BALANCE.hungerMax, starvingTicks: BALANCE.starvationDeathTicks - 1,
    });
    const world = await prep.prepareRun();
    sendHauling(world, 1, 'wood', 6);

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.find((c) => c.id === 1)).toBeUndefined(); // dead
    expect(snapshot.stockpile.wood.stock).toBe(6);                     // the load survived them
  });

  it("banks an aged-out hauler's carried load into the stockpile the tick they die", async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const span = lifespanFor(1, BALANCE.lifeBands);
    spawnColonist(prep, ids, { id: 1, ageTicks: span - 1, hunger: 0 }); // one tick short of its own lifespan
    const world = await prep.prepareRun();
    sendHauling(world, 1, 'planks', 4);

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.find((c) => c.id === 1)).toBeUndefined(); // dead
    expect(snapshot.stockpile.planks.stock).toBe(4);                   // the load survived them
  });

  it('gives a building no phantom tick of work from a colonist who dies of old age this tick', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: {}, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnBuilding(prep, ids, { id: 50, defId: 'forester', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const span = lifespanFor(1, BALANCE.lifeBands);
    // Full efficiency (hunger 0) and no tool coverage: work power is exactly
    // 1, so a banked phantom tick is unambiguous — 0 with standDown, 1 without.
    spawnColonist(prep, ids, { id: 1, ageTicks: span - 1, hunger: 0, buildingId: 50 });
    const world = await prep.prepareRun();

    await stepTick(world);
    const snapshot = world.getResource(SnapshotStore).latest!;
    expect(snapshot.colonists.find((c) => c.id === 1)).toBeUndefined(); // dead
    const forester = snapshot.buildings.find((b) => b.id === 50)!;
    expect(forester.progress).toBe(0);        // no contribution banked from beyond the grave
    expect(forester.batchActive).toBe(false); // never even started
  });
});

describe('PopulationSystem — homing', () => {
  it('homes a homeless colonist into a free bed, and evicts when the house relocates', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const snap = () => world.getResource(SnapshotStore).latest!;

    await step();
    expect(snap().colonists[0].homeId).toBe(houseId);
    expect(snap().homeless).toBe(0);
    expect(snap().beds).toEqual({ total: BALANCE.houseBeds, occupied: 1 });
    expect(snap().buildings.find((b) => b.id === houseId)!.occupants).toBe(1);

    // A house being carried shelters nobody — otherwise moving a house would
    // be the one free relocation in the game.
    enqueue(world, { type: 'moveBuilding', buildingId: houseId, to: { col: 15, row: 11 } });
    await step();
    expect(snap().colonists[0].homeId).toBeNull();
    expect(snap().homeless).toBe(1);
    // The relocating house's beds drop out of the total too — a "0/4 free"
    // reading would contradict rehome's own refusal to fill it.
    expect(snap().beds).toEqual({ total: 0, occupied: 0 });
  });

  it('re-homes an evicted colonist once its relocating house lands', async () => {
    // Same move as the test above, ridden all the way out: eviction is only
    // half the relocation story — a house that stops sheltering must start
    // again once it lands, or a homeless colonist evicted by a move would
    // never recover without a SECOND, unrelated free bed opening elsewhere.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const snap = () => world.getResource(SnapshotStore).latest!;
    await step();
    expect(snap().colonists[0].homeId).toBe(houseId); // precondition: housed first

    // hypot(10,8) = 12.8 tiles -> relocationTicks floors/ceils to 13.
    enqueue(world, { type: 'moveBuilding', buildingId: houseId, to: { col: 15, row: 11 } });
    await step(); // tick 1 of 13: evicted (see the test above)
    expect(snap().colonists[0].homeId).toBeNull();

    for (let i = 0; i < 12; i++) await step(); // ride out the remaining 12 charged ticks
    expect(snap().buildings.find((b) => b.id === houseId)!.relocatingTicks).toBe(0); // landed
    // Not yet rehomed: homing this tick read ticksLeft BEFORE ProductionSystem's
    // own decrement brought it to 0, so it still saw the house as relocating.
    expect(snap().colonists[0].homeId).toBeNull();

    await step(); // the tick after landing: homing now reads the already-0 countdown
    expect(snap().colonists[0].homeId).toBe(houseId);
    expect(snap().homeless).toBe(0);
    expect(snap().buildings.find((b) => b.id === houseId)!.occupants).toBe(1);
  });

  it('evicts the highest-id resident first when a house holds more than its current beds allow', async () => {
    // Spec 4.5: a save can legitimately carry more residents than a
    // retuned houseBeds currently permits, and the load principle clamps
    // rather than rejects. Ascending id is the deterministic tie-break —
    // spawned in a SHUFFLED order so entity-creation order and colonist id
    // order disagree: a rehome that walked entity order (or Map/Set
    // iteration order) instead of sorting by id would evict a different
    // colonist than id 5, the numerically highest.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    expect(BALANCE.houseBeds).toBe(4); // fixture precondition: exactly one resident over capacity below
    for (const id of [3, 1, 5, 2, 4]) {
      spawnColonist(prep, ids, { id, ageTicks: BALANCE.lifeBands.matureTicks, homeId: houseId });
    }
    const world = await prep.prepareRun();
    await stepTick(world);

    const snap = world.getResource(SnapshotStore).latest!;
    for (const id of [1, 2, 3, 4]) expect(snap.colonists.find((c) => c.id === id)!.homeId).toBe(houseId);
    expect(snap.colonists.find((c) => c.id === 5)!.homeId).toBeNull(); // the highest id is displaced
    expect(snap.homeless).toBe(1);
    expect(snap.buildings.find((b) => b.id === houseId)!.occupants).toBe(BALANCE.houseBeds);
  });

  it('makes a demolished house homeless immediately, not next tick', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    await step();
    expect(world.getResource(SnapshotStore).latest!.colonists[0].homeId).toBe(houseId);

    enqueue(world, { type: 'demolishBuilding', buildingId: houseId });
    await step();
    expect(world.getResource(SnapshotStore).latest!.colonists[0].homeId).toBeNull();
  });

  // PopulationSystem runs before ProductionSystem (ALL_SYSTEMS order), and
  // ProductionSystem is what decrements Relocation.ticksLeft — homing sees
  // ticksLeft BEFORE that decrement. So on the tick ticksLeft counts down from
  // 1 to 0 — the tick the house both starts and finishes its one charged
  // relocation tick on — homing still reads 1 and must NOT treat it as already
  // landed: sumWorkPower reads the same Home component this same tick, and an
  // early readmit would hand the resident its full placementFactor for a tick
  // still genuinely charged as relocation downtime.
  it('does not readmit a colonist until the tick after its relocating house lands', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const step = () => stepTick(world);
    const snap = () => world.getResource(SnapshotStore).latest!;
    await step();
    expect(snap().colonists[0].homeId).toBe(houseId); // precondition: actually housed first

    // One tile away: relocationTicks floors distance-scaled cost at 1, so this
    // relocation both starts and finishes its one charged tick right here.
    enqueue(world, { type: 'moveBuilding', buildingId: houseId, to: { col: 6, row: 3 } });
    await step();
    expect(snap().buildings.find((b) => b.id === houseId)!.relocatingTicks).toBe(0); // already landed...
    expect(snap().colonists[0].homeId).toBeNull(); // ...but still evicted THIS tick
    expect(snap().homeless).toBe(1);

    await step(); // the tick after landing
    expect(snap().colonists[0].homeId).toBe(houseId);
    expect(snap().homeless).toBe(0);
    expect(snap().buildings.find((b) => b.id === houseId)!.occupants).toBe(1);
  });

  // sim-ecs defers entity creation to the post-step sync, so on the tick a
  // house is built, PopulationSystem's `buildings` query cannot see it yet.
  // Without telling homing about it separately, a homeless colonist would
  // stay homeless for this one tick even though the house they'll move into
  // already exists — resolving itself the tick after, but persisting forever
  // if the game is paused right after building.
  it('houses a homeless colonist on the tick its house is built, not the tick after', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wood: 100, planks: 100 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const snap = () => world.getResource(SnapshotStore).latest!;

    enqueue(world, { type: 'constructBuilding', buildingDefId: 'house' });
    await stepTick(world);

    const house = snap().buildings.find((b) => b.defId === 'house')!;
    expect(snap().colonists[0].homeId).toBe(house.id);
  });

  // Same tick as above, but the player-visible half: test 1 could pass while
  // the published snapshot still shows the old, stale aggregates (free beds
  // beside a homeless colonist), because homeless/beds are derived from the
  // same Home components rehome just wrote. Distinct assertion, same defect.
  it('does not publish free beds beside a homeless colonist on the tick its house is built', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wood: 100, planks: 100 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const snap = () => world.getResource(SnapshotStore).latest!;

    enqueue(world, { type: 'constructBuilding', buildingDefId: 'house' });
    await stepTick(world);

    expect(snap().homeless).toBe(0);
    expect(snap().beds.occupied).toBeGreaterThan(0);
  });

  // PendingChanges.clear() must wipe `constructed` every tick, the same as
  // `arrivals` and `demolished`: by the tick after construction, the building
  // is live in the `buildings` query, so a lingering pending entry is a STALE
  // duplicate of it — frozen with `relocating: false` from the tick it was
  // built, forever after. That stale copy sits AFTER the live one in
  // ctx.shelters, so anything keyed by shelter id (rehome's `byId` map) reads
  // the stale, wrong value once the live building's actual state diverges
  // from it — e.g. once the house starts relocating. Without the clear, this
  // relocation would go completely unnoticed: freeBeds would still hand out
  // the relocating house's beds as free, and rehome would not evict its
  // resident, both because the stale entry's hard-coded `relocating: false`
  // outvotes the live, now-`true` value.
  it('does not let a pending-constructed house shelter its resident through a later relocation', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wood: 100, planks: 100 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks });
    const world = await prep.prepareRun();
    const snap = () => world.getResource(SnapshotStore).latest!;

    enqueue(world, { type: 'constructBuilding', buildingDefId: 'house' });
    await stepTick(world);
    const house = snap().buildings.find((b) => b.defId === 'house')!;
    expect(snap().colonists[0].homeId).toBe(house.id); // precondition: housed the tick it was built

    // A tile far enough away that the move is not instantaneous — irrelevant
    // to this test beyond needing ticksLeft > 0 the instant it is issued.
    enqueue(world, { type: 'moveBuilding', buildingId: house.id, to: { col: 23, row: 15 } });
    await stepTick(world);

    expect(snap().colonists[0].homeId).toBeNull();
    expect(snap().homeless).toBe(1);
    expect(snap().beds).toEqual({ total: 0, occupied: 0 });
  });

  // No test for "a house constructed and demolished in the same tick shelters
  // nobody": that scenario is unreachable. handleDemolishBuilding looks its
  // target up through findBuilding -> ctx.buildings, a snapshot materialized
  // BEFORE the drain loop starts — the same reason ctx.pending.constructed is
  // needed at all. A demolishBuilding command naming a building constructed
  // earlier in the same drain always rejects with "Building not found.": the
  // construction stands, and its colonist ends up HOUSED, not homeless.
  // Verified experimentally (constructBuilding then demolishBuilding for the
  // predicted id, one drain): the notice board shows the rejection and the
  // colonist's homeId is the new house's id. freeBeds' ctx.pending.demolished
  // check is exercised by the existing "makes a demolished house homeless
  // immediately" test above instead, against a building that already existed
  // before the tick — the only way a demolish can ever reach one.

  // Housing a colonist and CHARGING them as housed are two different things,
  // and for a while only the first was true. rehome seats the colonist in the
  // pending house, but ProductionSystem resolves a homeId to a TILE, and its
  // own query cannot see that house until the post-step sync — so it fell
  // through to homelessFactor and charged the colonist half power on the very
  // tick they were housed, while refreshEntitySections published them housed
  // moments later. Same defect as the two tests above, one layer down.
  it('charges a colonist housed by a same-tick construction as housed, not homeless', async () => {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wood: 100, planks: 100 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const forester = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 5, row: 2, relocatingTicks: 0 });
    const buildingId = forester.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, buildingId });
    const world = await prep.prepareRun();
    const snap = () => world.getResource(SnapshotStore).latest!;

    // Adjacent to the workplace, so the commute is inside commute.freeTiles
    // and a correctly-resolved home scores exactly 1.0 against
    // homelessFactor's 0.5 — the separation the assertion below rests on.
    enqueue(world, { type: 'constructBuilding', buildingDefId: 'house', at: { col: 6, row: 2 } });
    await stepTick(world);
    expect(snap().colonists[0].homeId).not.toBeNull();   // precondition, not the point

    // Asserts on PRODUCTION, not on the published workPower. The snapshot's
    // workPower comes from buildEntitySections, which runs after the
    // post-step sync and could always see the new house — it was never the
    // broken reader, so asserting on it passes with the fix reverted. Only
    // ProductionSystem's own pre-sync lookup was wrong, and the sole place
    // that surfaces is the batch it advances.
    //
    // forester is 3 worker-ticks per batch. Charged as housed, this colonist
    // contributes 1.0/tick and banks a unit on the third tick. Charged as
    // homeless for the construction tick only, they contribute
    // 0.5 + 1.0 + 1.0 = 2.5 and bank nothing.
    await stepTick(world);
    await stepTick(world);
    expect(snap().buildings.find((b) => b.id === buildingId)!.buffered).toBe(1);
  });
});

/** Shelters in ascending id — the order every seating rule here walks. */
function housesOf(snap: Snapshot) {
  return snap.buildings.filter((b) => b.beds > 0).sort((a, b) => a.id - b.id);
}

// Three coprime churn periods, so beds appear and disappear out of phase with
// each other and with the two arrival cooldowns (30 and 50), instead of
// settling into one repeating alignment. Named because `offersANomad` below is
// derived from MOVE_PERIOD rather than tuned beside it.
const CONSTRUCT_PERIOD = 61;
const MOVE_PERIOD = 23;
const DEMOLISH_PERIOD = 101;

/**
 * The construction, relocation or demolition a churn tick issues, or nothing.
 *
 * The three rates are deliberately BELOW what the cooldowns could admit — a
 * house every 61 ticks is +4 beds and a demolition every 101 is -4, against a
 * colony that could take one arrival every 19 — so it spends most of the run
 * with no spare bed at all. That is the only regime in which the admission
 * gates decide anything: a colony with beds going spare admits everyone and
 * proves nothing, which is how the predecessor of this test came to pass under
 * a broken `spareBeds`.
 *
 * The relocation target is the house the NEXT arrival would be offered (lowest
 * id with a bed free): a move and an arrival contending for one house in one
 * drain is the interaction that produced `4012dd2`'s dangling `homeId`, and
 * moving some other house would leave the two commands independent.
 */
function churnFor(t: number, snap: Snapshot): Command[] {
  const houses = housesOf(snap);
  if (t % CONSTRUCT_PERIOD === 0) return [{ type: 'constructBuilding', buildingDefId: 'house' }];
  if (t % MOVE_PERIOD === 0) {
    const target = houses.find((h) => h.relocatingTicks === 0 && h.occupants < h.beds) ?? houses[0];
    const to = autoPlacePosition(DEFAULT_MAP, snap.buildings);
    return target === undefined || to === null ? [] : [{ type: 'moveBuilding', buildingId: target.id, to }];
  }
  // Never below two shelters: a colony demolished down to none admits nobody,
  // and the rest of the run would prove nothing.
  if (t % DEMOLISH_PERIOD === 0 && houses.length >= 3) return [{ type: 'demolishBuilding', buildingId: houses[houses.length - 1].id }];
  return [];
}

/**
 * The two arrival regimes the property below is ridden through. Each is a rule
 * for whether tick `t` offers the colony a nomad at all, and they are run as a
 * PAIR because the defects they reach pull in opposite directions — a single
 * regime that catches both was searched for and does not exist (OBS-6-07).
 *
 * `EVERY_TICK` is the fixture this test shipped with: an offer on every tick,
 * which keeps the colony at its tightest and is what a broken `spareBeds` needs
 * to show itself. Its cost is that the 30-tick arrival cooldown is spent the
 * instant a bed opens — and in this colony a bed only ever opens just after a
 * construction, never on a relocation tick. MEASURED over its 600 ticks: 12
 * joins, 26 moves, and an arrival and a relocation drained together on exactly
 * ZERO of them (the recruit was refused for `cooldown` on every recruit-first
 * move tick that had a bed, and for `noBed` on the rest). So the interaction
 * `4012dd2` fixed — a nomad seated in the very house the same drain then starts
 * moving — was never reached under it, which is why deleting
 * `handleMoveBuilding`'s arrivals half left this test green.
 *
 * `SAVING_THE_COOLDOWN` withholds the offer for the `recruitCooldownTicks`
 * ticks before every second relocation — every second, because the drain order
 * below puts the recruit first only on even ticks and only a recruit drained
 * BEFORE the move can seat a nomad for the move to displace. That stages the
 * contended drain 8 times in 600 ticks. It does NOT simply make the colony
 * comfortable (still saturated on 322 ticks of 600, with 11 arrivals getting
 * in), but the arrivals it skips do relieve enough pressure that the
 * `spareBeds` defect stops reaching its own coincidence — hence both regimes,
 * not the second alone.
 */
const EVERY_TICK = () => true;
const CONTESTED_PERIOD = 2 * MOVE_PERIOD;
const SAVING_THE_COOLDOWN = (t: number) => t % CONTESTED_PERIOD <= CONTESTED_PERIOD - BALANCE.recruitCooldownTicks;

/** How often the run reached each state the assertions below depend on. */
interface Exercised {
  joined: number; moved: number; demolished: number; saturated: number;
  /** Ticks on which a nomad was admitted and a house started moving in the
   * SAME drain, recruit first — the state `reseatArrivalsOf` exists for. */
  contested: number;
  /** Ticks on which a bed `rehome` could have filled actually stood free —
   * without which the fifth clause below is true of an empty question. */
  spare: number;
  /**
   * Ticks that were BOTH — a contested drain AND one with a bed standing free
   * for the displaced arrival to be re-seated INTO. That conjunction, not
   * either half, is the only state in which the fifth clause can fail at all:
   * with no contest nothing displaces an arrival, and with no slack the
   * arrival is legitimately homeless whether or not the re-seat happens.
   * Measured: 2 of the 8 contested drains, and the fifth clause fails on
   * exactly those two ticks under a move that evicts without re-seating.
   * Guarding `contested` and `spare` separately leaves it unpinned — see the
   * demonstration in the vacuity guard below (OBS-6-07 I1).
   *
   * Read BEFORE the drain, deliberately. The obvious form — `contested` with
   * this tick's `spare` — is unassertable: measured, `spare` is 0 on all 8
   * contested ticks, because when there IS a bed the re-seat takes it, and
   * when there is not the arrival ends homeless with nothing free. The state
   * has to be read on the way in, not on the way out.
   */
  contestedWithSlack: number;
}

/**
 * Tally one tick against those states, from what the engine said it did.
 *
 * One `Record<keyof Exercised, boolean>` rather than a run of `if`s, so a
 * counter added to `Exercised` fails to compile until its condition is written
 * here — an unincremented counter would read as a state the run never reached,
 * which is the exact lie the vacuity guard exists to prevent.
 */
function tally(seen: Exercised, snap: Snapshot, recruitFirst: boolean, spare: number, slackBefore: number): void {
  const said = (pattern: RegExp) => snap.notices.some((n) => pattern.test(n.message));
  const joined = said(/joined the colony/);
  const moved = said(/Moved the/);
  const contested = joined && moved && recruitFirst;
  const reached: Record<keyof Exercised, boolean> = {
    joined,
    moved,
    // Matches either wording a demolishBuilding success can land on: a
    // FINISHED house ("Demolished the...— cost refunded") or a SITE one still
    // under construction ("Cancelled the...— nothing was charged", added
    // alongside Task 2's cost-refund branch). This tally is about the command
    // being accepted, not about which of the two it hit.
    demolished: said(/(Demolished|Cancelled) the/),
    saturated: snap.beds.total <= snap.population,
    contested,
    spare: spare > 0,
    contestedWithSlack: contested && slackBefore > 0,
  };
  for (const key of Object.keys(reached) as (keyof Exercised)[]) {
    if (reached[key]) seen[key]++;
  }
}

/**
 * Beds standing free in a shelter `rehome` would have been willing to fill,
 * this tick — the right-hand side of "no colonist is homeless while a usable
 * bed stands free".
 *
 * "Usable" is `rehome`'s own word for it: a bed in a shelter that is neither
 * demolished nor in transit. Demolition needs no check — a house demolished
 * this tick is already gone from `snap.buildings` by the time `stepTick`
 * refreshes the snapshot. Relocation cannot be read off `snap` at all, and this
 * is the whole subtlety: `PopulationSystem` reads `Relocation.ticksLeft` BEFORE
 * `ProductionSystem` decrements it, so the published countdown is one lower
 * than the figure `rehome` acted on, and a house LANDING this tick publishes 0
 * while `rehome` still (deliberately) treated it as in transit and kept its
 * residents homeless — the transient 'does not readmit a colonist until the
 * tick after its relocating house lands' pins. Trusting the published figure
 * would report that house's beds free on exactly the tick they are not.
 *
 * The figure `rehome` saw is instead the PREVIOUS tick's published countdown,
 * because the only thing that can change it in between is this tick's own drain
 * — hence `movedThisTick`. A house built this tick is in neither map and scores
 * 0 from `?? 0`, which is right: `rehome` folds `pending.constructed` in with
 * `relocating: false`.
 */
function usableBedsStandingFree(
  snap: Snapshot,
  movedThisTick: ReadonlySet<number>,
  relocatingBefore: ReadonlyMap<number, number>,
): number {
  const perHouse = residentsByHouse(snap);
  return housesOf(snap)
    .filter((h) => !movedThisTick.has(h.id) && (relocatingBefore.get(h.id) ?? 0) === 0)
    .reduce((free, h) => free + Math.max(0, h.beds - (perHouse.get(h.id) ?? 0)), 0);
}

/** Which houses this tick's churn puts in transit, for the reader above. */
function movingThisTick(churn: readonly Command[]): Set<number> {
  return new Set(churn.flatMap((c) => (c.type === 'moveBuilding' ? [c.buildingId] : [])));
}

/**
 * Clauses one and two of the property: the published aggregate never claims
 * more sleepers than beds, and no single house does either. The per-house count
 * comes from `residentsByHouse` rather than `BuildingSnapshot.occupants` so the
 * builder cannot supply its own expectation.
 */
function expectNobodyOverHoused(snap: Snapshot): void {
  expect(snap.beds.occupied).toBeLessThanOrEqual(snap.beds.total);
  const perHouse = residentsByHouse(snap);
  for (const house of housesOf(snap)) {
    expect(perHouse.get(house.id) ?? 0).toBeLessThanOrEqual(house.beds);
  }
}

/**
 * Clause four: nobody is admitted into a bed that does not exist. Both gates
 * promise it — `spareBeds` counts what is genuinely spare and `shelterWithRoom`
 * then finds it — so a colonist created this tick ends the tick housed.
 *
 * Exempt only when this tick's own churn took beds away: a move or a demolition
 * drained AFTER an arrival legitimately unseats it, and the engine cannot see a
 * command it has not read yet. `known` is the running roster and is extended in
 * place, so each colonist is judged on the one tick they first appear.
 */
function expectArrivalsHoused(snap: Snapshot, known: Set<number>, tookBedsAway: boolean): void {
  for (const c of snap.colonists) {
    if (known.has(c.id)) continue;
    known.add(c.id);
    if (!tookBedsAway) expect(c.homeId).not.toBeNull();
  }
}

/**
 * Residents per house id, counted from who points at each house. Asked
 * independently of `BuildingSnapshot.occupants`, which the snapshot builder
 * derives the same way — so a builder that miscounts cannot also supply the
 * expectation.
 */
function residentsByHouse(snap: Snapshot): Map<number, number> {
  const perHouse = new Map<number, number>();
  for (const c of snap.colonists) {
    if (c.homeId !== null) perHouse.set(c.homeId, (perHouse.get(c.homeId) ?? 0) + 1);
  }
  return perHouse;
}

describe('PopulationSystem — births and the nomad gate', () => {
  /** A colony that can feed and shelter arrivals; `houses` four-bed shelters. */
  async function fedColony(houses: number, colonists: number, bread = 5000, extraStock: Partial<Record<ResourceId, number>> = {}) {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { bread, ...extraStock }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const spots = autoPlaceSequence(save.map);
    const houseIds: number[] = [];
    for (let i = 0; i < houses; i++) {
      const at = spots.next().value!;
      const h = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: at.col, row: at.row, relocatingTicks: 0 });
      houseIds.push(h.getComponent(Building)!.id);
    }
    for (let i = 0; i < colonists; i++) {
      spawnColonist(prep, ids, { id: i + 1, ageTicks: BALANCE.lifeBands.matureTicks, homeId: houseIds[0] ?? null });
    }
    const world = await prep.prepareRun();
    world.getResource(SimClock).tick = 1000;  // both cooldowns long expired
    return { world, houseIds, snap: () => world.getResource(SnapshotStore).latest! };
  }

  it('births a child when fed and housed, then holds off for the cooldown', async () => {
    const { world, snap } = await fedColony(1, 2);
    const count = () => snap().colonists.length;

    await stepTick(world);
    expect(count()).toBe(3);                    // tick 1: homing, then a birth
    for (let i = 0; i < BALANCE.birthCooldownTicks - 1; i++) await stepTick(world);
    expect(count()).toBe(3);                    // still on cooldown, 4th bed free
    await stepTick(world);
    expect(count()).toBe(4);                    // cooldown expired, bed still free
    await stepTick(world);
    expect(count()).toBe(4);                    // beds full now: noBed, not cooldown
  });

  /**
   * `fedColony` with its food SPLIT: `bread` at the camp and `depotBread` in a
   * storehouse. The gate must count both, because the meals it is deciding
   * about are paid through `pay`, which draws across every site — so this is
   * the only fixture shape that can tell a colony-wide read from a camp-only
   * one on the VALUE rather than on a total that merely differs.
   */
  async function splitFoodColony(bread: number, depotBread: number) {
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { bread }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const spots = autoPlaceSequence(save.map);
    const houseAt = spots.next().value!;
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, ...houseAt, relocatingTicks: 0 });
    const depotAt = spots.next().value!;
    const depot = spawnBuilding(prep, ids, { defId: 'storehouse', progress: 0, batchActive: false, ...depotAt, relocatingTicks: 0 });
    for (let i = 0; i < 2; i++) {
      spawnColonist(prep, ids, { id: i + 1, ageTicks: BALANCE.lifeBands.matureTicks, homeId: house.getComponent(Building)!.id });
    }
    const world = await prep.prepareRun();
    world.getResource(SimClock).tick = 1000; // both cooldowns long expired
    world.getResource(Stockpile).refundAt(
      { id: depot.getComponent(Building)!.id, ...depotAt, capacity: BALANCE.storehouseCapacity }, 'bread', depotBread,
    );
    return { world, snap: () => world.getResource(SnapshotStore).latest! };
  }

  it('births on food the camp alone could not feed the child with', async () => {
    // Two adults, so the gate needs 12 meals x 3 heads = 36. The camp holds 15
    // and the storehouse 27: neither clears it, their sum does.
    const { world, snap } = await splitFoodColony(15, 27);
    await stepTick(world);
    expect(snap().colonists).toHaveLength(3);
  });

  it('holds off when the depot half of that same food is not there', async () => {
    // The discriminating half: identical colony, identical camp stock, empty
    // storehouse. Without it the case above passes for a colony simply well fed.
    const { world, snap } = await splitFoodColony(15, 0);
    await stepTick(world);
    expect(snap().colonists).toHaveLength(2);
  });

  it('will not birth into a colony that cannot feed the child', async () => {
    // Beds and parents both fine; only the store is short. Discriminating
    // against the test above, which differs in this one input.
    const { world, snap } = await fedColony(1, 2, 0);
    await stepTick(world);
    expect(snap().colonists).toHaveLength(2);
  });

  it('will not birth from a single adult', async () => {
    const { world, snap } = await fedColony(1, 1);
    await stepTick(world);
    expect(snap().colonists).toHaveLength(1);
  });

  it('counts a nomad welcomed this tick as the second parent, not only as a second mouth', async () => {
    // The pair for the test above: the SAME one-adult colony, differing only
    // in that a nomad lands on the same tick. tryBirth folds pending arrivals
    // into `population` (the food the gate must cover) and must fold them into
    // `adults` too, or the same colonist is charged as a mouth and refused as
    // a parent — and an eligible birth is lost for a whole birthCooldownTicks.
    //
    // One house is 4 beds against 1 founder, so the nomad and the child are
    // not competing for the last one; 'a nomad and a birth cannot take the
    // same last bed' below is the case where they are.
    const { world, snap } = await fedColony(1, 1);
    enqueue(world, { type: 'recruitWorker' });
    await stepTick(world);

    const stages = snap().colonists.map((c) => c.stage).sort();
    expect(stages).toEqual(['adult', 'adult', 'child']); // founder, nomad, and the birth they enabled
    expect(snap().homeless).toBe(0);
  });

  it('a nomad and a birth cannot take the same last bed', async () => {
    // One house, 4 beds, 3 colonists: exactly one bed free, with food and both
    // cooldowns clear so ONLY the bed is in contention. CommandSystem runs
    // before PopulationSystem and its nomad is invisible to every query until
    // the post-step sync, so without the pending ledger tryBirth would hand a
    // child the very bed the nomad just took.
    const { world, snap } = await fedColony(1, 3);
    enqueue(world, { type: 'recruitWorker' });
    await stepTick(world);

    expect(snap().colonists).toHaveLength(4);   // the nomad, and NOT also a child
    expect(snap().homeless).toBe(0);
    expect(snap().beds.occupied).toBeLessThanOrEqual(snap().beds.total);
  });

  it('a nomad welcomed before a demolition does not keep a home in the demolished house', async () => {
    // Command ORDER is the point: recruitWorker spawns a colonist CommandSystem's
    // own worker query cannot see, so the demolition drained moments later walks
    // right past it. Left unevicted, the tick's autosave writes a homeId naming a
    // building that no longer exists.
    const { world, houseIds, snap } = await fedColony(1, 1);
    enqueue(world, { type: 'recruitWorker' }, { type: 'demolishBuilding', buildingId: houseIds[0] });
    await stepTick(world);

    expect(snap().buildings.find((b) => b.id === houseIds[0])).toBeUndefined();  // the house really went
    expect(snap().colonists).toHaveLength(2);                                    // the nomad really arrived
    for (const c of snap().colonists) expect(c.homeId).toBeNull();               // and NOBODY points at it
    // The actual harm, not merely the mechanism: a `homeId` naming a building
    // the save does not contain is one of the four reference states the v5
    // guard refuses outright, so leaving the nomad unevicted does not just
    // misreport occupancy — it makes this tick's autosave unloadable, and
    // decideLoad answers `{kind:'backup'}` for a colony that was never corrupt.
    expect(isLoadableSave(buildSaveFromWorld(world))).toBe(true);
  });

  /**
   * 600 ticks of the churn above, offering a nomad on the ticks `offersANomad`
   * allows, asserting all five clauses of the property every tick and returning
   * how often the run reached the states those clauses depend on.
   *
   * Property, not scenario: the bed-contention defects found in review were
   * several routes to one broken state, and a case-by-case test would only have
   * caught whichever one it was written for.
   *
   * The predecessor of this run used three STATIC houses and was therefore
   * unfalsifiable in both of its assertions: with no relocation, demolition or
   * construction, `rehome`'s per-house cap and `shelterWithRoom`'s
   * `spokenFor < beds` mean an over-admission can only ever produce a homeless
   * colonist — never an over-occupied house, and never more occupants than
   * beds. It passed with `spareBeds` mutated to drop `pending.arrivals.length`.
   * The churn is what put beds in motion under the arrivals; the fourth clause
   * is what an over-admission actually violates; the third is the only one
   * that sees a `homeId` naming a house that is mid-relocation.
   *
   * The colony is the contended one the scenario tests above use — one house,
   * one bed spare — with materials and food to spare, so beds are the only
   * thing that is ever scarce.
   */
  async function rideOutTheChurn(offersANomad: (t: number) => boolean): Promise<Exercised> {
    const { world } = await fedColony(1, 3, 1_000_000, { wood: 1_000_000, planks: 1_000_000 });
    const snap = () => world.getResource(SnapshotStore).latest!;
    const known = new Set(snap().colonists.map((c) => c.id));
    const seen: Exercised = { joined: 0, moved: 0, demolished: 0, saturated: 0, contested: 0, spare: 0, contestedWithSlack: 0 };
    // What `rehome` will read as each house's relocation countdown NEXT tick,
    // carried across the loop — see `usableBedsStandingFree` for why the
    // published figure cannot be read on the tick it is wanted.
    let relocatingBefore = new Map(housesOf(snap()).map((h) => [h.id, h.relocatingTicks]));

    for (let t = 0; t < 600; t++) {
      const before = snap();
      const churn = churnFor(t, before);
      const moving = movingThisTick(churn);
      const recruitFirst = t % 2 === 0;
      const recruit: Command[] = offersANomad(t) ? [{ type: 'recruitWorker' }] : [];
      // Room a displaced arrival could be re-seated into, read the way
      // `reseatArrivalsOf` will see it — the SAME reader as the fifth clause
      // below, aimed at the pre-drain snapshot instead of the post-tick one.
      // `relocatingBefore` is the right map on both sides: last tick's
      // published countdown IS the live `ticksLeft` CommandSystem reads this
      // tick, because ProductionSystem decrements after it.
      const slackBefore = usableBedsStandingFree(before, moving, relocatingBefore);
      // Both drain orders across the run: `4012dd2` fixed one defect per order
      // — a stale `shelters` snapshot seating a nomad in a house the SAME
      // drain had already started moving (move first), and a move that could
      // not evict a nomad welcomed moments earlier (recruit first).
      enqueue(world, ...(recruitFirst ? [...recruit, ...churn] : [...churn, ...recruit]));
      await stepTick(world);

      const s = snap();
      expectNobodyOverHoused(s);
      // The tick's own end state must be one the engine can restore. This is
      // the clause that catches a `homeId` naming a relocating house: the
      // v5 guard rejects that pairing outright, so an autosave written here
      // would send a live colony down decideLoad's corrupt-backup path.
      expect(isLoadableSave(buildSaveFromWorld(world))).toBe(true);
      expectArrivalsHoused(s, known, churn.some((c) => c.type === 'moveBuilding' || c.type === 'demolishBuilding'));
      // Nobody is homeless while a bed they could have been given stands free
      // (OBS-6-07). This is `rehome`'s own postcondition — it evicts, then
      // fills every homeless colonist in ascending id until the openings run
      // out — and it is the one thing a colonist stranded by a same-tick
      // command violates while breaking none of the four above: a stranded
      // colonist leaves the colony too EMPTY, not too full. Asserted
      // unconditionally, no `if`, so the run cannot pass this line by never
      // reaching the question; `seen.spare` records how often it was a real one
      // and `seen.contestedWithSlack` how often it was the DECISIVE one.
      //
      // Numbering: the OBS-6-07 issue note calls this "the fourth clause".
      // It is the FIFTH here — this file counts the aggregate cap and the
      // per-house cap as two, where the note counts them as one.
      const spare = usableBedsStandingFree(s, moving, relocatingBefore);
      expect({ tick: s.tick, strandedBeds: s.homeless > 0 ? spare : 0 }).toEqual({ tick: s.tick, strandedBeds: 0 });
      tally(seen, s, recruitFirst, spare, slackBefore);
      relocatingBefore = new Map(housesOf(s).map((h) => [h.id, h.relocatingTicks]));
    }
    return seen;
  }

  it('never over-houses, admits an arrival it has no bed for, strands a bed, or ends a tick it cannot reload', async () => {
    // TWO runs of one property, over the two arrival regimes described above,
    // because no single regime reaches both families of defect. Measured, all
    // four mutations run against both regimes (OBS-6-07):
    //
    //   `spareBeds` drops pending arrivals   EVERY_TICK only
    //   `ctx.shelters` frozen at construction both
    //   move's arrivals half deleted          SAVING_THE_COOLDOWN only
    //   move evicts but does not re-seat      SAVING_THE_COOLDOWN only
    //
    // The last two are the ones this test was blind to for the whole of
    // increment 6, and the reason is worth stating exactly, because the issue
    // note diagnosed it as a missing assertion: deleting the arrivals half
    // leaves the displaced nomad pointing at the moving house, which the FIRST
    // and THIRD clauses were always able to see — the state was simply never
    // reached. Only the fourth mutation, which evicts that nomad without
    // re-seating it, needs the fifth clause; nothing here caught it before, and
    // the whole 607-test suite once missed its demolition twin.
    const always = await rideOutTheChurn(EVERY_TICK);
    const saved = await rideOutTheChurn(SAVING_THE_COOLDOWN);

    // Vacuity guard, and the reason this test discriminates at all: every
    // assertion above passes trivially against a colony that never admits
    // anyone, never moves or demolishes a house, or always has a bed going
    // spare. Bounds are well under what the runs actually reach —
    // 12 / 26 / 5 / 412 / 0 / 180 / 0 offering every tick,
    // 11 / 26 / 5 / 322 / 8 / 267 / 2 saving the cooldown (joined, moved,
    // demolished, saturated, contested, spare, contestedWithSlack) — so
    // ordinary drift does not trip them, but a balance change that made this
    // colony comfortable would fail HERE, loudly, instead of quietly turning
    // the invariants above back into decoration.
    for (const seen of [always, saved]) {
      expect(seen.joined).toBeGreaterThan(5);
      expect(seen.moved).toBeGreaterThan(5);
      expect(seen.demolished).toBeGreaterThan(2);
      expect(seen.saturated).toBeGreaterThan(100);
      expect(seen.spare).toBeGreaterThan(100);
    }
    // `contested` is asked of the second regime alone, and it is the number
    // that stopped this test being decoration: it counts the ticks on which an
    // arrival and a relocation actually drained together, recruit first. It
    // reads ZERO for the first regime — with every other number there healthy.
    // A fixture can exercise all the churn in the world and still never stage
    // the one interaction it was built for.
    expect(always.contested).toBe(0);
    expect(saved.contested).toBeGreaterThan(3);
    // And the conjunction, which is the one the fifth clause actually needs: a
    // contested drain WITH a bed free elsewhere. Guarding `contested > 3` and
    // `spare > 100` separately does not pin it, and the gap is not theoretical
    // — measured, `CONTESTED_PERIOD = 4 * MOVE_PERIOD` (a plausible retune)
    // leaves every bound above green, `contested` at 4, and this at ZERO, with
    // the evict-without-re-seat mutation no longer caught by anything.
    //
    // Bounded at > 0, not at the measured 2, and the reason is worth stating
    // rather than hiding: 2 IS the whole discriminating margin. One tick is
    // enough for the clause to have power, so `> 0` is exactly the condition
    // "the question was asked"; a tighter bound would go red on a retune that
    // left the clause perfectly able to fail. The cost is that losing ONE of
    // the two ticks halves that margin silently. If this ever needs to be
    // sturdier it wants a regime that stages the contested-with-slack drain
    // more often, not a bigger number here.
    expect(saved.contestedWithSlack).toBeGreaterThan(0);
  }, 60000);
});
