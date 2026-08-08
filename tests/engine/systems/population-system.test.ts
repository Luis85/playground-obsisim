import { describe, expect, it } from 'vitest';
import { Building, JobAssignment } from '../../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import { BALANCE } from '../../../src/engine/content/balance';
import { lifespanFor } from '../../../src/shared/population';
import { stepTick } from '../fixtures';

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
