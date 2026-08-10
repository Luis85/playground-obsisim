import type { IRuntimeWorld } from 'sim-ecs';
import { CommandQueue, IdCounter, SimClock, Stockpile } from '../../src/engine/resources';
import { HaulTrip, InputBuffer, OutputBuffer } from '../../src/engine/components';
import { applyRemovals, refreshEntitySections } from '../../src/engine/world';
import { CAMP_TILE } from '../../src/shared/haul';
import type { ResourceId } from '../../src/shared/content-types';
import type { TileRef } from '../../src/shared/placement';
import type { Command } from '../../src/shared/commands';

/**
 * Every unit of one resource the colony owns, wherever it is standing: banked
 * at any site, waiting in any building's in-tray or out-tray, or in a hauler's
 * hands. THE assertion for conservation — the field a handler just wrote can be
 * made to agree with itself, a colony-wide total cannot.
 *
 * Shared rather than copied into each suite that needs it: goods now live in
 * four places plus a pair of hands, and a second copy of this walk is exactly
 * how one of them stops being counted.
 */
export function colonyTotal(world: IRuntimeWorld, resource: ResourceId): number {
  let total = world.getResource(Stockpile).get(resource);
  for (const entity of world.getEntities()) {
    total += entity.getComponent(InputBuffer)?.amounts.get(resource) ?? 0;
    total += entity.getComponent(OutputBuffer)?.amounts.get(resource) ?? 0;
    const trip = entity.getComponent(HaulTrip);
    if (trip !== undefined && trip.resource === resource) total += trip.amount;
  }
  return total;
}

/**
 * A commute-neutral tile for a hauler's house that nothing else is standing on.
 *
 * Only THREE tiles are both buildable (col >= CAMP_COLS) and inside
 * `BALANCE.commute.freeTiles` of the camp store: (3,0), (3,1) and (4,0). A
 * hauler housed on one of them scores commuteFactor 1.0 exactly, so
 * `haulerCapacity` returns the flat `BALANCE.haulCarryCapacity` and a haulage
 * fixture keeps measuring haulage — the same move as the balance harness's FED
 * berry stock holding hunger neutral.
 *
 * Hardcoding (3,0) — `CAMP_TILE.col + 1` — collides with the haul sweep's own
 * nearest case, `forester(3, 0, 1)`, and `spawnBuilding` writes tiles directly
 * without consulting `isTileBuildable`, so the two would silently stack. That
 * would put an unreachable layout inside the very measurements increment 5
 * pinned as this increment's regression net.
 *
 * Throws rather than falling back to a distant tile: a hauler housed outside
 * the free radius pays a commute, which would move those numbers for a reason
 * having nothing to do with hauling.
 */
export function campAdjacentFreeTile(taken: readonly TileRef[]): TileRef {
  const candidates: TileRef[] = [
    { col: CAMP_TILE.col + 1, row: CAMP_TILE.row },
    { col: CAMP_TILE.col + 1, row: CAMP_TILE.row + 1 },
    { col: CAMP_TILE.col + 2, row: CAMP_TILE.row },
  ];
  const free = candidates.find((t) => !taken.some((u) => u.col === t.col && u.row === t.row));
  if (free === undefined) throw new Error('No commute-neutral tile left for the hauler house');
  return free;
}

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
 * One tick of the actual production sequence, mirroring GameEngine.runStep
 * line for line: RETRY ANY LEFTOVER REMOVAL, advance the clock, step the
 * world, DRAIN THE REMOVAL LEDGER, then refresh the snapshot's entity-derived
 * sections only if the id counter moved or something was removed.
 *
 * The leading drain is a no-op on every tick that did not inherit a re-queued
 * entry from a detach that threw, and it is mirrored here rather than left to
 * production because a fixture that skips it would let a test observe the
 * rehome-into-a-doomed-shelter sequence runStep now makes impossible.
 *
 * A bare `await world.step()` is NOT equivalent, and since OBS-6-02 it is
 * short of the truth in two ways rather than one. It never applied a tick's
 * creations to the published snapshot; it now also never applies a tick's
 * REMOVALS to the world at all, because deaths and demolitions no longer go
 * through sim-ecs's command queue — they go onto RemovalLedger, and
 * `applyRemovals` is the only thing that takes them off it. A test that
 * demolishes or kills and then steps raw leaves the entity standing.
 *
 * The refresh gate matters beyond faithfulness: an UNconditional refresh here
 * would hide a removal that never reached the ledger, since the snapshot would
 * be re-walked either way. Gating on the drain's own count means a removal
 * that did not happen genuinely fails a test — and, unlike the `dirty` flag
 * this replaced, the count cannot be forgotten by a new removal site, because
 * it comes from the removal itself.
 */
export async function stepTick(world: IRuntimeWorld): Promise<void> {
  applyRemovals(world);
  const idsBefore = world.getResource(IdCounter).peek();
  world.getResource(SimClock).tick++;
  await world.step();
  const removed = applyRemovals(world);
  if (world.getResource(IdCounter).peek() !== idsBefore || removed > 0) {
    refreshEntitySections(world);
  }
}
