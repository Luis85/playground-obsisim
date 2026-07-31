import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Building, OutputBuffer, Production } from '../../../src/engine/components';
import { IdCounter, SnapshotStore, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { SnapshotSystem } from '../../../src/engine/systems/snapshot-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';
import { BALANCE } from '../../../src/engine/content/balance';
import { BUILDINGS } from '../../../src/engine/content/buildings';

async function setup(defId: BuildingDefId, stock: Partial<Record<ResourceId, number>>, workerCount = 1, workerToolTicks = 0) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const building: IEntity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false, col: 4, row: 1 });
  const buildingId = building.getComponent(Building)!.id;
  for (let i = 0; i < workerCount; i++) spawnWorker(prep, ids, { buildingId, toolTicks: workerToolTicks });
  const world = await prep.prepareRun();
  return { world, building, stockpile: world.getResource(Stockpile) };
}

describe('ProductionSystem', () => {
  it('produces raw output after ticksPerBatch worker-ticks (forester: 3)', async () => {
    const { world, building } = await setup('forester', {});
    await world.step();
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(0);
    await world.step();
    expect(building.getComponent(OutputBuffer)!.total()).toBe(1);
  });

  it('consumes inputs at batch start, all-or-nothing (mill)', async () => {
    const { world, building, stockpile } = await setup('mill', { wheat: 1 });
    await world.step();
    expect(stockpile.get('wheat')).toBe(0); // consumed at start
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

  it('only covered workers get the multiplier (mixed staffing)', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = {}; // starting wood would mask the 'no output yet' assertion
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // one covered worker (1.5) + one bare worker (1.0) = 2.5 power/tick, forester batch is 3
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, toolTicks: 1000 });
    spawnWorker(prep, ids, { buildingId });
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
    // components, buildEntitySections sums WorkerFacts. They agreed only by
    // both spelling out the tool bonus, so a change to one could make the UI
    // report a work power the simulation never used. Both assertions are
    // needed: the cross-check catches a change to one derivation, the absolute
    // value catches a change to the shared formula they now both call.
    const save = initialSave();
    save.workers = [];
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem, SnapshotSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, toolTicks: 1000 }); // exercises the tooled branch
    spawnWorker(prep, ids, { buildingId }); // and the untooled one
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
    expect(production.progress).toBe(BUILDINGS.forester.recipe.ticksPerBatch); // work done, waiting on a cart
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
    // A mill with a full buffer must not eat wheat it can do nothing with:
    // the room check runs BEFORE pay(), so not a single grain is taken.
    const { world, building, stockpile } = await setup('mill', { wheat: 20 });
    const buffer = building.getComponent(OutputBuffer)!;
    buffer.add('flour', BALANCE.outputBufferCap);
    for (let i = 0; i < 6; i++) await world.step();
    expect(stockpile.get('wheat')).toBe(20);
    expect(buffer.total()).toBe(BALANCE.outputBufferCap);
  });

  it('consumes at most one batch of inputs beyond a full buffer', async () => {
    // Mill: inputs 1 wheat per batch, outputs 1 flour per batch (1 unit).
    // Buffer cap: 12 units. Arithmetic for the bound:
    // - Start buffer at 11 flour: room = 12 - 11 = 1 unit (exactly room for 1 batch)
    // - 1 worker contributes 1.0 work power per tick
    // - Mill recipe needs 3 ticks per batch (ticksPerBatch)
    // - Tick 1-3: consume 1 wheat (line 31), produce 1 flour per tick, bank at tick 3
    // - At tick 3: bank 1 flour (buffer = 12) and consume 1 more wheat for next batch (line 53)
    // - Total: 2 wheat consumed, 1 batch banked, 1 batch in flight
    // - Tick 4+: room check (line 30) prevents new batches
    // Expected: exactly one batch's worth of inputs held in flight, no more consumed
    const { world, building, stockpile } = await setup('mill', { wheat: 2 });
    const buffer = building.getComponent(OutputBuffer)!;
    const production = building.getComponent(Production)!;

    // Fill buffer to 11 flour (leaving room for exactly 1 more batch)
    buffer.add('flour', 11);

    // Run ticks for 1 batch to complete: 3 ticks
    for (let i = 0; i < 3; i++) await world.step();

    // Exactly 2 wheat consumed: 1 for the batch that completed, 1 for the batch in flight
    expect(stockpile.get('wheat')).toBe(0); // 2 - 2 = 0
    expect(buffer.total()).toBe(12); // 11 + 1 = 12 (full)
    expect(production.batchActive).toBe(true); // One batch in flight (inputs paid, waiting to bank)
    expect(production.progress).toBe(0); // Progress reset after banking

    // Run many more ticks: no further wheat consumed (can't start new batch due to full buffer)
    for (let i = 0; i < 50; i++) await world.step();
    expect(stockpile.get('wheat')).toBe(0);
    expect(buffer.total()).toBe(12);
  });
});
