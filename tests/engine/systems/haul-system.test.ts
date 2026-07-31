import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Building, HaulTrip, OutputBuffer } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { BALANCE } from '../../../src/engine/content/balance';
import { HaulSystem } from '../../../src/engine/systems/haul-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnBuilding, spawnWorker } from '../../../src/engine/world';

interface BuildingSpec { col: number; row: number; wood: number; id?: number }

async function setup(specs: readonly BuildingSpec[], haulerCount: number) {
  const save = initialSave();
  save.workers = [];
  save.stockpile = {};
  const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
  const ids = getPrepResource(prep, IdCounter);
  const buildings: IEntity[] = specs.map((spec) => {
    const entity = spawnBuilding(prep, ids, {
      id: spec.id, defId: 'forester', progress: 0, batchActive: false, col: spec.col, row: spec.row,
    });
    if (spec.wood > 0) entity.getComponent(OutputBuffer)!.add('wood', spec.wood);
    return entity;
  });
  const haulers: IEntity[] = Array.from({ length: haulerCount }, () => spawnWorker(prep, ids, { hauling: true }));
  const world = await prep.prepareRun();
  const step = async (times: number) => { for (let i = 0; i < times; i++) await world.step(); };
  return { world, buildings, haulers, step, stockpile: world.getResource(Stockpile) };
}

const tripOf = (hauler: IEntity) => hauler.getComponent(HaulTrip)!;
const bufferOf = (building: IEntity) => building.getComponent(OutputBuffer)!;

describe('HaulSystem', () => {
  it('walks out, loads a full carry, walks back, and banks it in the store', async () => {
    // (5,4) is 5 tiles from the camp -> 3 ticks each way
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 9 }], 1);
    await step(1);
    expect(tripOf(haulers[0]).phase).toBe('outbound');
    expect(tripOf(haulers[0]).ticksLeft).toBe(3);

    await step(3); // arrival tick
    expect(bufferOf(buildings[0]).total()).toBe(3); // 6 carried away
    expect(tripOf(haulers[0]).phase).toBe('returning');
    expect(tripOf(haulers[0]).amount).toBe(BALANCE.haulCarryCapacity);
    expect(stockpile.get('wood')).toBe(0); // not banked until it arrives

    await step(3);
    expect(stockpile.get('wood')).toBe(BALANCE.haulCarryCapacity);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('charges a tick each way even beside the camp — no trip is free', async () => {
    const { step, stockpile } = await setup([{ col: 3, row: 0, wood: 6 }], 1);
    await step(2);
    expect(stockpile.get('wood')).toBe(0); // dispatched, arrived, not yet home
    await step(1);
    expect(stockpile.get('wood')).toBe(6);
  });

  it('lets several haulers share one backlog without claiming the same units', async () => {
    const { haulers, step, stockpile } = await setup([{ col: 3, row: 0, wood: 12 }], 2);
    await step(1);
    expect(haulers.every((h) => tripOf(h).phase === 'outbound')).toBe(true);
    await step(2);
    expect(stockpile.get('wood')).toBe(12); // 6 each, nothing double-counted
  });

  it('leaves a hauler idle when the backlog is already spoken for', async () => {
    const { haulers, step } = await setup([{ col: 3, row: 0, wood: 6 }], 3);
    await step(1);
    const phases = haulers.map((h) => tripOf(h).phase).sort();
    expect(phases).toEqual(['idle', 'idle', 'outbound']);
  });

  it('serves the worst backlog first, even when it is farther away', async () => {
    const { buildings, haulers, step } = await setup(
      [{ col: 4, row: 1, wood: 2 }, { col: 20, row: 10, wood: 9 }],
      1,
    );
    await step(1);
    expect(tripOf(haulers[0]).targetId).toBe(buildings[1].getComponent(Building)!.id);
  });

  it('dispatches identically regardless of entity order — same world, same claim', async () => {
    // both 3 tiles from camp, both holding 4: the lowest id must win either way
    const forward = await setup([{ id: 10, col: 5, row: 0, wood: 4 }, { id: 11, col: 2, row: 3, wood: 4 }], 1);
    const reversed = await setup([{ id: 11, col: 2, row: 3, wood: 4 }, { id: 10, col: 5, row: 0, wood: 4 }], 1);
    await forward.step(1);
    await reversed.step(1);
    expect(tripOf(forward.haulers[0]).targetId).toBe(10);
    expect(tripOf(reversed.haulers[0]).targetId).toBe(10);
  });

  it('leaves haulers idle when nothing is waiting', async () => {
    const { haulers, step } = await setup([{ col: 5, row: 4, wood: 0 }], 2);
    await step(4);
    expect(haulers.every((h) => tripOf(h).phase === 'idle')).toBe(true);
  });

  it('returns empty-handed when the buffer is drained before arrival', async () => {
    const { buildings, haulers, step, stockpile } = await setup([{ col: 5, row: 4, wood: 6 }], 1);
    await step(1);
    bufferOf(buildings[0]).take('wood', 6); // someone else got there first
    await step(3);
    expect(tripOf(haulers[0]).amount).toBe(0);
    await step(3);
    expect(stockpile.get('wood')).toBe(0);
    expect(tripOf(haulers[0]).phase).toBe('idle');
  });

  it('ignores workers who are not haulers', async () => {
    const save = initialSave();
    save.workers = [];
    save.stockpile = {};
    const prep = buildColonyPrepWorld({ save, systems: [HaulSystem] });
    const ids = getPrepResource(prep, IdCounter);
    const building = spawnBuilding(prep, ids, { defId: 'forester', progress: 0, batchActive: false, col: 4, row: 1 });
    building.getComponent(OutputBuffer)!.add('wood', 9);
    const idle = spawnWorker(prep, ids, {});
    const world = await prep.prepareRun();
    for (let i = 0; i < 6; i++) await world.step();
    expect(idle.getComponent(HaulTrip)!.phase).toBe('idle');
    expect(world.getResource(Stockpile).get('wood')).toBe(0);
  });
});
