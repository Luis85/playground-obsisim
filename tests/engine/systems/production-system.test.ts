import { describe, expect, it } from 'vitest';
import { SystemError, type IEntity } from 'sim-ecs';
import { Building, InputBuffer, OutputBuffer, Production } from '../../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import {
  ALL_SYSTEMS, buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnColonist,
} from '../../../src/engine/world';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import type { TileRef } from '../../../src/shared/placement';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';
import { stepTick } from '../fixtures';

async function setup(
  defId: BuildingDefId,
  stock: Partial<Record<ResourceId, number>>,
  workerCount = 1,
  workerToolTicks = 0,
  // The building's OWN input buffer (Task 3): a recipe's inputs are paid
  // from here, never from `stock` any more. `stock` stays a separate
  // parameter rather than being folded into this one — tests that seed the
  // colony stockpile for a reason unrelated to this building's own recipe
  // (e.g. asserting it is never touched) still need to say so explicitly.
  inputBuffer: Partial<Record<ResourceId, number>> = {},
) {
  const save = initialSave();
  save.colonists = [];
  save.buildings = [];   // no starter house: this fixture builds its own world
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const building: IEntity = spawnBuilding(prep, ids, {
    defId, progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0, inputBuffer,
  });
  const buildingId = building.getComponent(Building)!.id;
  // Housed at the same building it works: this file is exercising batch
  // arithmetic in isolation (systems: [ProductionSystem], no PopulationSystem
  // to ever rehome anyone), the same way it already holds hunger and age off
  // to the side — homelessness is Task 6's third orthogonal axis, and an
  // unhoused worker here would halve every power figure these tests pin.
  for (let i = 0; i < workerCount; i++) spawnColonist(prep, ids, { buildingId, toolTicks: workerToolTicks, homeId: buildingId });
  const world = await prep.prepareRun();
  return { world, building, stockpile: world.getResource(Stockpile) };
}

describe('ProductionSystem', () => {
  it('a staffed mill with an empty input buffer produces nothing, however full the colony store', async () => {
    // DISCRIMINATING FIXTURE: 10,000 wheat in the stockpile. Before Task 3
    // that mill produced flour every 3 ticks. A pass here cannot come from
    // "there was no wheat" — there is more wheat than the mill could eat in a
    // session, and it is simply in the wrong place: the colony store, not the
    // mill's own input buffer.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wheat: 10_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const mill = spawnBuilding(prep, ids, { defId: 'mill', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const millId = mill.getComponent(Building)!.id;
    // No homeId (see the 'a house never produces' fixture below on the same
    // pattern): a mill has no beds, so this colonist stays homeless for the
    // whole run regardless — full ALL_SYSTEMS is what exercises the real
    // per-tick sequence, not an isolated ProductionSystem-only world.
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, buildingId: millId });
    const world = await prep.prepareRun();
    const stockpile = world.getResource(Stockpile);
    for (let i = 0; i < 20; i++) await stepTick(world);

    const snap = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === millId)!;
    expect(snap.state).toBe('waitingForInput');
    expect(snap.buffered).toBe(0);
    expect(stockpile.get('wheat')).toBe(10_000); // and nothing was quietly eaten
  });

  it('the same mill produces once wheat is in its own input buffer', async () => {
    // The other half of the pair above: without this, "produces nothing"
    // would also pass with ProductionSystem deleted entirely.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { wheat: 10_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    // SIX wheat would not survive the 20-tick horizon: a mill is one wheat per
    // three-tick batch, so six run out around tick 18 and the mill correctly
    // returns to `waitingForInput` — the assertions below would then reject
    // the implementation they are meant to accept. Seed the cap instead.
    const mill = spawnBuilding(prep, ids, {
      defId: 'mill', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0,
      inputBuffer: { wheat: BALANCE.inputBufferCap },
    });
    const millId = mill.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, buildingId: millId });
    const world = await prep.prepareRun();
    const stockpile = world.getResource(Stockpile);
    for (let i = 0; i < 20; i++) await stepTick(world);

    const snap = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === millId)!;
    const inputBuffer = mill.getComponent(InputBuffer)!;
    // Assert what the feature DOES, not the state it happens to be in at a
    // chosen tick: a momentary `producing` is hostage to `ticksPerBatch` and
    // the crew's work power, both tunable. Output banked and local input
    // drawn down is the claim.
    expect(snap.buffered).toBeGreaterThan(0);
    expect(inputBuffer.total()).toBeLessThan(BALANCE.inputBufferCap);
    expect(stockpile.get('wheat')).toBe(10_000); // still not touched
  });

  it('produces raw output after ticksPerBatch worker-ticks (forester: 3)', async () => {
    const { world, building } = await setup('forester', {});
    await world.step();
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('consumes inputs at batch start, all-or-nothing (mill)', async () => {
    // Task 3: the wheat comes from the mill's OWN input buffer, not the
    // colony stockpile (left empty here on purpose).
    const { world, building } = await setup('mill', {}, 1, 0, { wheat: 1 });
    await world.step();
    expect(building.getComponent(InputBuffer)!.total()).toBe(0); // consumed at start
    expect(building.getComponent(Production)!.batchActive).toBe(true);
    await world.step();
    await world.step(); // 3 worker-ticks done
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
    expect(building.getComponent(Production)!.batchActive).toBe(false); // no wheat for next batch
  });

  it('stalls without inputs', async () => {
    const { world, building } = await setup('mill', {});
    await world.step();
    expect(building.getComponent(Production)!.batchActive).toBe(false);
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
  });

  it('does nothing when unstaffed', async () => {
    const { world, building } = await setup('forester', {}, 0);
    for (let i = 0; i < 5; i++) await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
  });

  it('tooled workers contribute 1.5x work power', async () => {
    // forester needs 3 worker-ticks; 2 covered workers x 1.5 = 3 power/tick -> 1 wood per tick
    const { world, building } = await setup('forester', {}, 2, 1000);
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('a homeless worker contributes at BALANCE.homelessFactor work power', async () => {
    // Unlike setup() (see its own comment), this worker is spawned with no
    // homeId at all — genuinely homeless, not the housed default every other
    // test in this file uses. forester needs 3 worker-ticks; a homeless
    // worker contributes only BALANCE.homelessFactor (0.5) power/tick, so the
    // batch needs 6 ticks rather than the 3 "produces raw output" pins for an
    // otherwise-identical housed worker — the discriminating half of the
    // pair.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    const buildingId = building.getComponent(Building)!.id;
    spawnColonist(prep, ids, { buildingId }); // no homeId: homeless by default
    const world = await prep.prepareRun();
    for (let i = 0; i < 5; i++) await world.step(); // 5 x 0.5 = 2.5 < 3
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
    await world.step(); // 6 x 0.5 = 3
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('a crew housed far from work banks less than one next door, and still more than one with no home', async () => {
    // Task 7's whole point: WHERE the house goes is a decision, not a
    // checkbox. Three otherwise-identical worlds differing in one thing —
    // the tile the crew sleeps on — and BOTH gaps are asserted, because
    // either half alone passes against a broken reading. A factor that
    // ignored distance (1 for anyone housed) still beats homeless; a factor
    // that ignored `homeId` still falls off with distance.
    const bankedIn30Ticks = async (houseAt: TileRef | null) => {
      const save = initialSave();
      save.colonists = [];
      save.buildings = [];   // no starter house: this fixture builds its own world
      save.stockpile = {};
      const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
      const ids = getPrepResource(prep, IdCounter);
      const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
      // A REAL house, so this measures the mechanic and not a stray id: the
      // tile is all ProductionSystem reads, but a sentinel would be evicted
      // the moment PopulationSystem is in the pipeline.
      const home = houseAt === null
        ? null
        : spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: houseAt.col, row: houseAt.row, relocatingTicks: 0 });
      spawnColonist(prep, ids, {
        buildingId: building.getComponent(Building)!.id,
        homeId: home === null ? null : home.getComponent(Building)!.id,
      });
      const world = await prep.prepareRun();
      for (let i = 0; i < 30; i++) await world.step();
      return building.getComponent(OutputBuffer)!.total();
    };

    // (5,1) is 1 tile from work — inside BALANCE.commute.freeTiles, so a full
    // 1.0. (14,1) is 10 tiles: 8 charged tiles, 0.76, deliberately chosen to
    // land strictly BETWEEN 1.0 and the 0.5 floor. Anything past ~19 tiles
    // clamps to the floor and would read identically to homeless, which would
    // make the second assertion below unfalsifiable.
    const near = await bankedIn30Ticks({ col: 5, row: 1 });
    const far = await bankedIn30Ticks({ col: 14, row: 1 });
    const homeless = await bankedIn30Ticks(null);

    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(homeless);
    // Exact, not merely ordered: 30 ticks x 1.0 / 0.76 / 0.5 power over a
    // 3-tick batch. Ordering alone would hold for a factor an order of
    // magnitude off, and 30 ticks stays under the 12-unit output cap in the
    // fastest of the three, so none of them is silently stalled instead.
    expect([near, far, homeless]).toEqual([10, 7, 5]);
  });

  it('only covered workers get the multiplier (mixed staffing)', async () => {
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    save.stockpile = {}; // starting wood would mask the 'no output yet' assertion
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // one covered worker (1.5) + one bare worker (1.0) = 2.5 power/tick, forester batch is 3
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    const buildingId = building.getComponent(Building)!.id;
    // Housed (see setup()'s comment above): this test isolates the tool
    // multiplier, not homelessness.
    spawnColonist(prep, ids, { buildingId, toolTicks: 1000, homeId: buildingId });
    spawnColonist(prep, ids, { buildingId, homeId: buildingId });
    const world = await prep.prepareRun();
    await world.step(); // 2.5 < 3: batch not done
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
    await world.step(); // 5.0 >= 3
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('completes whole batches at exactly matching power', async () => {
    // 4 workers on the farm (4 power/tick, needs 4): exactly 1 wheat per tick
    const { world, building } = await setup('farm', {}, 4);
    await world.step();
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(2);
  });

  it('carries overflow progress across batches (no throughput loss)', async () => {
    // 4 tooled farm workers: 6 power/tick against a 4-tick recipe -> 1.5 wheat/tick average
    const { world, building } = await setup('farm', {}, 4, 1000);
    for (let i = 0; i < 4; i++) await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(6);
  });

  it('the work power the snapshot reports is the one production actually applied', async () => {
    // Two INDEPENDENT derivations of the same number: this system sums live
    // components, buildEntitySections sums ColonistFacts. They agreed only by
    // both spelling out the tool bonus, so a change to one could make the UI
    // report a work power the simulation never used. Both assertions are
    // needed: the cross-check catches a change to one derivation, the absolute
    // value catches a change to the shared formula they now both call.
    const save = initialSave();
    save.colonists = [];
    save.buildings = [];   // no starter house: this fixture builds its own world
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1, relocatingTicks: 0 });
    const buildingId = building.getComponent(Building)!.id;
    // Housed (see setup()'s comment above): both derivations must agree on
    // the SAME placementFactor too, but that agreement is not what this test
    // is pinning — an unhoused worker here would just halve both sides at
    // once and hide a real mismatch as easily as it would hide none.
    spawnColonist(prep, ids, { buildingId, toolTicks: 1000, homeId: buildingId }); // exercises the tooled branch
    spawnColonist(prep, ids, { buildingId, homeId: buildingId }); // and the untooled one
    const world = await prep.prepareRun();
    await world.step();

    const reported = world.getResource(SnapshotStore).latest!.buildings[0].workPower;
    expect(reported).toBeCloseTo(building.getComponent(Production)!.progress);
    expect(reported).toBeCloseTo(2.5); // tooled 1 x 1.5 + untooled 1 x 1.0
  });

  it('banks output in the building instead of the stockpile', async () => {
    const { world, building, stockpile } = await setup('forester', {});
    await world.step();
    await world.step();
    await world.step();
    expect(stockpile.get('wood')).toBe(0); // nothing has been hauled in
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('stalls at a full buffer, holding one finished batch', async () => {
    // forester: 1 wood per 3 worker-ticks, cap 12 -> 36 ticks to fill
    const { world, building } = await setup('forester', {});
    for (let i = 0; i < 40; i++) await world.step();
    const buffer = building.getComponent(OutputBuffer)!;
    const production = building.getComponent(Production)!;
    expect(buffer.total()).toBe(BALANCE.outputBufferCap);
    expect(production.batchActive).toBe(true);
    expect(production.progress).toBe(BUILDINGS.forester.recipe!.ticksPerBatch); // forester always has a recipe; work done, waiting on a cart
  });

  it('resumes the tick after the buffer gains room', async () => {
    const { world, building } = await setup('forester', {});
    for (let i = 0; i < 40; i++) await world.step();
    const buffer = building.getComponent(OutputBuffer)!;
    expect(buffer.take('wood', 5)).toBe(5);
    await world.step();
    expect(buffer.total()).toBe(BALANCE.outputBufferCap - 5 + 1);
  });

  it('does not consume inputs it cannot bank the output of', async () => {
    // A mill with a full OUTPUT buffer must not eat wheat it can do nothing
    // with: the room check runs BEFORE payFrom(), so not a single grain is
    // taken from its own input buffer (Task 3: never from the stockpile at
    // all any more).
    const { world, building } = await setup('mill', {}, 1, 0, { wheat: 5 });
    const buffer = building.getComponent(OutputBuffer)!;
    buffer.add('flour', BALANCE.outputBufferCap);
    for (let i = 0; i < 6; i++) await world.step();
    expect(building.getComponent(InputBuffer)!.total()).toBe(5);
    expect(buffer.total()).toBe(BALANCE.outputBufferCap);
  });

  it('consumes at most one batch of inputs beyond a full buffer', async () => {
    // Mill: inputs 1 wheat per batch, outputs 1 flour per batch (1 unit).
    // Buffer cap: 12 units. Arithmetic for the bound:
    // - Start buffer at 11 flour: room = 12 - 11 = 1 unit (exactly room for 1 batch)
    // - 1 worker contributes 1.0 work power per tick
    // - Mill recipe needs 3 ticks per batch (ticksPerBatch)
    // - Tick 1-3: consume 1 wheat (startBatch's payFrom), produce 1 flour per tick, bank at tick 3
    // - At tick 3: bank 1 flour (buffer = 12) and consume 1 more wheat for the next batch (completeBatches' chained payFrom)
    // - Total: 2 wheat consumed FROM THE MILL'S OWN INPUT BUFFER, 1 batch banked, 1 batch in flight
    // - Tick 4+: room check (buffer.room(...) < perBatch) prevents new batches
    // Expected: exactly one batch's worth of inputs held in flight, no more consumed
    const { world, building } = await setup('mill', {}, 1, 0, { wheat: 2 });
    const buffer = building.getComponent(OutputBuffer)!;
    const input = building.getComponent(InputBuffer)!;
    const production = building.getComponent(Production)!;

    // Fill buffer to 11 flour (leaving room for exactly 1 more batch)
    buffer.add('flour', 11);

    // Run ticks for 1 batch to complete: 3 ticks
    for (let i = 0; i < 3; i++) await world.step();

    // Exactly 2 wheat consumed: 1 for the batch that completed, 1 for the batch in flight
    expect(input.total()).toBe(0); // 2 - 2 = 0
    expect(buffer.total()).toBe(12); // 11 + 1 = 12 (full)
    expect(production.batchActive).toBe(true); // One batch in flight (inputs paid, waiting to bank)
    expect(production.progress).toBe(0); // Progress reset after banking

    // Run many more ticks: no further wheat consumed (can't start new batch due to full buffer)
    for (let i = 0; i < 50; i++) await world.step();
    expect(input.total()).toBe(0);
    expect(buffer.total()).toBe(12);
  });

  it('a house never produces, even fully staffed', async () => {
    // Discriminating fixture: the same crew on a forester at the same tile DOES
    // produce, so a pass here cannot come from the crew being idle for some
    // unrelated reason.
    const save = { ...initialSave(), colonists: [], buildings: [], stockpile: { berries: 100_000 }, nextEntityId: 100 };
    const prep = buildColonyPrepWorld({ save, systems: ALL_SYSTEMS });
    const ids = getPrepResource(prep, IdCounter);
    const house = spawnBuilding(prep, ids, { defId: 'house', progress: 0, batchActive: false, col: 5, row: 3, relocatingTicks: 0 });
    const houseId = house.getComponent(Building)!.id;
    spawnColonist(prep, ids, { id: 1, ageTicks: BALANCE.lifeBands.matureTicks, buildingId: houseId });
    const world = await prep.prepareRun();
    // Also discriminating, and load-bearing: ProductionSystem's recipe-null
    // skip must run BEFORE advanceBatches reads BUILDINGS[...].recipe!, not
    // merely produce a snapshot that happens to look right. Without the skip,
    // advanceBatches throws on this exact fixture — but sim-ecs's scheduler
    // catches a system's thrown Error and republishes it as a SystemError
    // event instead of failing the tick (see node_modules/sim-ecs's stage
    // executor), and the crash happens before any state mutation, so
    // state/buffered/progress below would still read as correct. Subscribing
    // here is what turns that swallowed crash into a real test failure.
    let systemErrors = 0;
    world.eventBus.subscribe(SystemError, () => { systemErrors++; });
    for (let i = 0; i < 20; i++) await stepTick(world);

    const snap = world.getResource(SnapshotStore).latest!.buildings.find((b) => b.id === houseId)!;
    expect(systemErrors).toBe(0);
    expect(snap.state).toBe('housing');
    expect(snap.buffered).toBe(0);
    expect(snap.progress).toBe(0);
  });
});
