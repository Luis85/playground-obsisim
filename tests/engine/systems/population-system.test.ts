import { describe, expect, it } from 'vitest';
import type { IRuntimeWorld } from 'sim-ecs';
import { Building, Colonist, HaulTrip, JobAssignment } from '../../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import { BALANCE } from '../../../src/engine/content/balance';
import { lifespanFor } from '../../../src/shared/population';
import type { ResourceId } from '../../../src/shared/content-types';
import { enqueue, stepTick } from '../fixtures';

async function colonyWith(ages: { id: number; ageTicks: number; buildingId?: number | null }[]) {
  const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: {}, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
    const save = { ...initialSave(), workers: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
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
});
