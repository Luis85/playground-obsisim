import { describe, expect, it } from 'vitest';
import type { IEntity } from 'sim-ecs';
import { Hunger } from '../../../src/engine/components';
import { IdCounter, Stockpile } from '../../../src/engine/resources';
import { HungerSystem } from '../../../src/engine/systems/hunger-system';
import { buildColonyPrepWorld, getPrepResource, initialSave, spawnColonist } from '../../../src/engine/world';

async function setup(hunger: number, stock: Partial<Record<'bread' | 'berries', number>>) {
  const save = initialSave();
  save.colonists = [];
  save.buildings = [];   // no starter house: this fixture builds its own world
  save.stockpile = stock;
  const prep = buildColonyPrepWorld({ save, systems: [HungerSystem] });
  const worker: IEntity = spawnColonist(prep, getPrepResource(prep, IdCounter), { hunger });
  const world = await prep.prepareRun();
  return { world, worker, stockpile: world.getResource(Stockpile) };
}

describe('HungerSystem', () => {
  it('raises hunger by 1 per tick up to the cap', async () => {
    const { world, worker } = await setup(0, {});
    await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(1);
    for (let i = 0; i < 150; i++) await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(100);
  });

  it('eats bread at the meal threshold, resetting hunger to 0', async () => {
    const { world, worker, stockpile } = await setup(49, { bread: 1, berries: 5 });
    await world.step(); // 49 -> 50 -> eats
    expect(worker.getComponent(Hunger)!.value).toBe(0);
    expect(stockpile.get('bread')).toBe(0);
    expect(stockpile.get('berries')).toBe(5); // bread preferred
  });

  it('falls back to berries when no bread', async () => {
    const { world, worker, stockpile } = await setup(49, { berries: 2 });
    await world.step(); // 50 - 30 = 20
    expect(worker.getComponent(Hunger)!.value).toBe(20);
    expect(stockpile.get('berries')).toBe(1);
  });

  // Killer tests for the meal-threshold gate (increment-1 review: this mutation
  // survived). Every other test here either crosses the threshold or has an
  // empty stockpile, so a worker that ate unconditionally passed all of them.
  it('does not eat below the meal threshold, even with food in stock', async () => {
    const { world, worker, stockpile } = await setup(0, { bread: 5, berries: 5 });
    await world.step(); // 0 -> 1: nowhere near the threshold
    expect(worker.getComponent(Hunger)!.value).toBe(1);
    expect(stockpile.get('bread')).toBe(5);
    expect(stockpile.get('berries')).toBe(5);
  });

  it('does not eat on the tick that lands one short of the threshold', async () => {
    const { world, worker, stockpile } = await setup(48, { bread: 1 });
    await world.step(); // 48 -> 49
    expect(worker.getComponent(Hunger)!.value).toBe(49);
    expect(stockpile.get('bread')).toBe(1); // the gate is `<`, exclusive
  });

  it('starves without food (no crash, hunger capped)', async () => {
    const { world, worker } = await setup(98, {});
    await world.step();
    await world.step();
    await world.step();
    expect(worker.getComponent(Hunger)!.value).toBe(100);
  });
});
