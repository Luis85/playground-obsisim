import { describe, expect, it } from 'vitest';
import { Building, Efficiency, JobAssignment, ToolCoverage } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { EfficiencySystem } from '../../../src/engine/systems/efficiency-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

function makePrep(tools: number) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = { tools };
  return buildColonyPrepWorld({ save, systems: [EfficiencySystem] });
}

describe('EfficiencySystem', () => {
  it('computes worker efficiency from hunger', async () => {
    const prep = makePrep(0);
    const worker = spawnWorker(prep, getPrepResource(prep, IdCounter), { hunger: 75 });
    const world = await prep.prepareRun();
    await world.step();
    expect(worker.getComponent(Efficiency)!.value).toBeCloseTo(0.6);
  });

  it('staffed worker consumes one tool for a 300-tick coverage that ticks down', async () => {
    const prep = makePrep(2);
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const worker = spawnWorker(prep, ids, { buildingId: building.getComponent(Building)!.id });
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(1);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(300);
    await world.step(); // covered: ticks down, no extra tool consumed
    expect(world.getResource(Stockpile).get('tools')).toBe(1);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(299);
  });

  it('idle workers never consume tools', async () => {
    const prep = makePrep(2);
    const worker = spawnWorker(prep, getPrepResource(prep, IdCounter), {});
    const world = await prep.prepareRun();
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(2);
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(0);
  });

  it('covers exactly as many workers as there are tools', async () => {
    const prep = makePrep(1);
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    const first = spawnWorker(prep, ids, { buildingId });
    const second = spawnWorker(prep, ids, { buildingId });
    const world = await prep.prepareRun();
    await world.step();
    const covered = [first, second].filter((w) => w.getComponent(ToolCoverage)!.remainingTicks > 0);
    expect(covered).toHaveLength(1);
    expect(world.getResource(Stockpile).get('tools')).toBe(0);
  });

  it('coverage follows the worker: replacements pay for their own tool', async () => {
    const prep = makePrep(2);
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const buildingId = building.getComponent(Building)!.id;
    const veteran = spawnWorker(prep, ids, { buildingId, toolTicks: 100 });
    const replacement = spawnWorker(prep, ids, {});
    const world = await prep.prepareRun();
    await world.step(); // veteran already covered, replacement idle: nothing charged
    expect(world.getResource(Stockpile).get('tools')).toBe(2);
    // swap the staff without changing the headcount
    veteran.getComponent(JobAssignment)!.buildingId = null;
    replacement.getComponent(JobAssignment)!.buildingId = buildingId;
    await world.step();
    expect(world.getResource(Stockpile).get('tools')).toBe(1); // replacement paid
    expect(replacement.getComponent(ToolCoverage)!.remainingTicks).toBe(300);
    expect(veteran.getComponent(ToolCoverage)!.remainingTicks).toBeGreaterThan(0); // keeps his own
  });

  it('renews an expiring tool in the same tick (no untooled gap)', async () => {
    const prep = makePrep(1);
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false });
    const worker = spawnWorker(prep, ids, { buildingId: building.getComponent(Building)!.id, toolTicks: 1 });
    const world = await prep.prepareRun();
    await world.step(); // 1 -> 0 -> renewed to 300 within the same tick
    expect(worker.getComponent(ToolCoverage)!.remainingTicks).toBe(300);
    expect(world.getResource(Stockpile).get('tools')).toBe(0);
  });
});
