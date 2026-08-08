import type { SavedColonist, SaveGameV5 } from '../shared/save';
import { clampedAge, clampedHunger, clampedStarving, clampedToolTicks } from './spawn';

/**
 * The roster a save actually restores as.
 *
 * Every load-time clamp is applied HERE, exactly once, and both restore paths
 * read the result: `buildColonyPrepWorld` spawns entities from these records,
 * and `buildInitialSnapshot` projects the seeded snapshot from the same ones.
 * The two used to apply the clamps independently and agree by comment — a
 * restored engine starts PAUSED, so any disagreement is what the player looks
 * at until they unpause, and the first tick then silently changes it.
 */
export function restoredColonists(save: SaveGameV5): SavedColonist[] {
  return save.colonists.map((saved) => ({
    ...saved,
    hunger: clampedHunger(saved.hunger),
    toolTicks: clampedToolTicks(saved.toolTicks),
    ageTicks: clampedAge(saved.ageTicks),
    starvingTicks: clampedStarving(saved.starvingTicks),
  }));
}
