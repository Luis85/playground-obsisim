import type { SavedColonist, SaveGameV5 } from '../shared/save';
import { stageOf } from '../shared/population';
import { BALANCE } from './content/balance';
import { BUILDINGS } from './content/buildings';
import { clampedAge, clampedHunger, clampedStarving, clampedToolTicks } from './spawn';

/**
 * The roster a save actually restores as.
 *
 * Every load-time clamp and repair is applied HERE, exactly once, and both
 * restore paths read the result: `buildColonyPrepWorld` spawns entities from
 * these records, and `buildInitialSnapshot` projects the seeded snapshot from
 * the same ones. The two used to apply the clamps independently and agree by
 * comment — and a restored engine starts PAUSED, so any disagreement is what
 * the player looks at until they unpause, at which point the first tick
 * silently changes it.
 *
 * Repairing rather than rejecting is the load principle (spec 4.5): both
 * states below are ones a BALANCE retune genuinely produces, unlike the
 * reference rules in save-guard.ts, which no engine version could write.
 *
 * Deliberately NOT folded into `colonistComponents`: that is also the LIVE
 * creation path (recruit, birth) and every test fixture's spawn, and a test
 * that deliberately spawns an elder holding a job — to prove
 * `standDownNonAdults` clears it — would become vacuous rather than fail.
 */
export function restoredColonists(save: SaveGameV5): SavedColonist[] {
  const evicted = overCapacityEvictions(save);
  return save.colonists.map((saved) => {
    const ageTicks = clampedAge(saved.ageTicks);
    // Raise matureTicks in a retune and a save restores a colonist who is now
    // a CHILD but still carries a job; lower retireTicks (or clamp an
    // over-long age down to MAX_AGE_TICKS) and it restores an ELDER holding
    // one. standDownNonAdults repairs both — but only on the first tick, and
    // a paused engine never reaches it, so the seeded snapshot would show a
    // child staffing a building, counted in `workers` and contributing to
    // `workPower`, for as long as the player leaves it there.
    const adult = stageOf(ageTicks, BALANCE.lifeBands) === 'adult';
    return {
      ...saved,
      hunger: clampedHunger(saved.hunger),
      toolTicks: clampedToolTicks(saved.toolTicks),
      ageTicks,
      starvingTicks: clampedStarving(saved.starvingTicks),
      buildingId: adult ? saved.buildingId : null,
      hauling: adult && saved.hauling,
      homeId: evicted.has(saved.id) ? null : saved.homeId,
    };
  });
}

/**
 * Colonists a house cannot actually sleep, by id.
 *
 * A save with five colonists in a four-bed house is exactly what a `houseBeds`
 * retune from 5 to 4 produces, and rejecting it would orphan a save for a
 * balance change. So the excess is evicted instead, filling in ASCENDING
 * colonist id — `rehome`'s own documented rule, which means the highest ids
 * are displaced and a reload lands on the same assignment the engine would.
 *
 * A `homeId` that names no shelter at all is left alone here: that is a
 * record no engine version could write, and `isLoadableSave` refuses the
 * whole save for it rather than quietly patching one field.
 */
function overCapacityEvictions(save: SaveGameV5): ReadonlySet<number> {
  const beds = new Map<number, number>();
  for (const b of save.buildings) {
    if (!Object.hasOwn(BUILDINGS, b.defId)) continue;
    const { beds: count } = BUILDINGS[b.defId];
    if (count > 0) beds.set(b.id, count);
  }
  const evicted = new Set<number>();
  for (const c of [...save.colonists].sort((a, b) => a.id - b.id)) {
    if (c.homeId === null) continue;
    const remaining = beds.get(c.homeId);
    if (remaining === undefined) continue;
    if (remaining > 0) beds.set(c.homeId, remaining - 1);
    else evicted.add(c.id);
  }
  return evicted;
}
