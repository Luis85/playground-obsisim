import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, IdCounter, RemovalLedger, SimClock } from '../../src/engine/resources';
import { refreshEntitySections } from '../../src/engine/world';
import type { Command } from '../../src/shared/commands';

/**
 * Enqueue commands the way GameEngine.dispatch does — through CommandQueue.push,
 * so fixtures go through the overflow cap rather than around it. Shared because
 * the pattern a test copies is the pattern the next test copies: this file is
 * the one place a change to how commands enter the queue has to land.
 */
export function enqueue(world: IRuntimeWorld, ...commands: Command[]): void {
  const queue = world.getResource(CommandQueue);
  for (const command of commands) queue.push(command);
}

/**
 * One tick of the actual production sequence (mirrors GameEngine.runStep,
 * including its gate): advance the clock, step the world, then refresh the
 * snapshot's entity-derived sections ONLY if the id counter moved or
 * RemovalLedger.dirty was raised — exactly the condition game-engine.ts's
 * runStep applies, clearing the flag the same way. A bare `await world.step()`
 * is NOT equivalent — sim-ecs only syncs a tick's entity creations/removals
 * after step() resolves, so SnapshotStore.latest can still show an entity that
 * died (or omit one that was born) this same tick until refreshEntitySections
 * re-walks the world. Any test asserting on population, a corpse's absence, or
 * a newborn's presence needs this, not a raw step().
 *
 * The gate matters beyond mirroring production faithfully: an UNconditional
 * refresh here would make every remover's `removals.dirty = true` untestable
 * — the snapshot would refresh anyway, and a handler that forgot to raise the
 * flag would still pass. Gating identically means a missing `dirty = true`
 * genuinely fails a test, the same way it would silently stale-publish in
 * production.
 */
export async function stepTick(world: IRuntimeWorld): Promise<void> {
  const idsBefore = world.getResource(IdCounter).peek();
  world.getResource(SimClock).tick++;
  await world.step();
  const removals = world.getResource(RemovalLedger);
  if (world.getResource(IdCounter).peek() !== idsBefore || removals.dirty) {
    removals.dirty = false;
    refreshEntitySections(world);
  }
}
