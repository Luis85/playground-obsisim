import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue } from '../../src/engine/resources';
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
