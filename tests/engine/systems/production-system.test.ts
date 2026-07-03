import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Building, Production } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { ProductionSystem } from '../../../src/engine/systems/production-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';
import type { BuildingDefId, ResourceId } from '../../../src/shared/content-types';

async function setup(defId: BuildingDefId, stock: Partial<Record<ResourceId, number>>, workerCount = 1, workerToolTicks = 0) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const building: IEntity = spawnBuilding(prep, ids, { defId, progress: 0, batchActive: false });
  const buildingId = building.getComponent(Building)!.id;
  for (let i = 0; i < workerCount; i++) spawnWorker(prep, ids, { buildingId, toolTicks: workerToolTicks });
  const world = await prep.prepareRun();
  return { world, building, stockpile: world.getResource(Stockpile) };
}

describe('ProductionSystem', () => {
  it('produces raw output after ticksPerBatch worker-ticks (forester: 3)', async () => {
    const { world, stockpile } = await setup('forester', {});
    await world.step();
    await world.step();
    expect(stockpile.get('wood')).toBe(0);
    await world.step();
    expect(stockpile.get('wood')).toBe(1);
  });

  it('consumes inputs at batch start, all-or-nothing (mill)', async () => {
    const { world, building, stockpile } = await setup('mill', { wheat: 1 });
    await world.step();
    expect(stockpile.get('wheat')).toBe(0); // consumed at start
    expect(building.getComponent(Production)!.batchActive).toBe(true);
    await world.step();
    await world.step(); // 3 worker-ticks done
    expect(stockpile.get('flour')).toBe(1);
    expect(building.getComponent(Production)!.batchActive).toBe(false); // no wheat for next batch
  });

  it('stalls without inputs', async () => {
    const { world, building, stockpile } = await setup('mill', {});
    await world.step();
    expect(building.getComponent(Production)!.batchActive).toBe(false);
    expect(stockpile.get('flour')).toBe(0);
  });

  it('does nothing when unstaffed', async () => {
    const { world, stockpile } = await setup('forester', {}, 0);
    for (let i = 0; i < 5; i++) await world.step();
    expect(stockpile.get('wood')).toBe(0);
  });

  it('tooled workers contribute 1.5x work power', async () => {
    // forester needs 3 worker-ticks; 2 covered workers x 1.5 = 3 power/tick -> 1 wood per tick
    const { world, stockpile } = await setup('forester', {}, 2, 1000);
    await world.step();
    expect(stockpile.get('wood')).toBe(1);
  });

  it('only covered workers get the multiplier (mixed staffing)', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = {}; // starting wood would mask the 'no output yet' assertion
    const prep = buildColonyPrepWorld({ save, systems: [ProductionSystem] });
    const ids = getPrepResource(prep, IdCounter);
    // one covered worker (1.5) + one bare worker (1.0) = 2.5 power/tick, forester batch is 3
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    spawnWorker(prep, ids, { buildingId, toolTicks: 1000 });
    spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();
    await world.step(); // 2.5 < 3: batch not done
    expect(world.getResource(Stockpile).get('wood')).toBe(0);
    await world.step(); // 5.0 >= 3
    expect(world.getResource(Stockpile).get('wood')).toBe(1);
  });

  it('completes whole batches at exactly matching power', async () => {
    // 4 workers on the farm (4 power/tick, needs 4): exactly 1 wheat per tick
    const { world, stockpile } = await setup('farm', {}, 4);
    await world.step();
    await world.step();
    expect(stockpile.get('wheat')).toBe(2);
  });

  it('carries overflow progress across batches (no throughput loss)', async () => {
    // 4 tooled farm workers: 6 power/tick against a 4-tick recipe -> 1.5 wheat/tick average
    const { world, stockpile } = await setup('farm', {}, 4, 1000);
    for (let i = 0; i < 4; i++) await world.step();
    expect(stockpile.get('wheat')).toBe(6);
  });
});
