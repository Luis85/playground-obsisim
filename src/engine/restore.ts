import type { SavedColonist, SaveGameV5 } from '../shared/save';
import { lifespanFor, stageOf } from '../shared/population';
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
 * Repairing rather than rejecting is the load principle (spec 4.5): every
 * state below is one a BALANCE retune genuinely produces, unlike the
 * reference rules in save-guard.ts, which no engine version could write.
 *
 * Deliberately NOT folded into `colonistComponents`: that is also the LIVE
 * creation path (recruit, birth) and every test fixture's spawn, and a test
 * that deliberately spawns an elder holding a job — to prove
 * `standDownNonAdults` clears it — would become vacuous rather than fail.
 */
export function restoredColonists(save: SaveGameV5): SavedColonist[] {
  // Before the bed count, not after: a colonist the rules have already killed
  // must not hold one of the beds `overCapacityEvictions` is handing out, or
  // the repair for one balance retune displaces a living colonist on behalf of
  // a dead one — and tick 1 would rehome them into the bed it frees.
  const living = save.colonists.filter(hasLifeLeft);
  const evicted = overCapacityEvictions(living, save.buildings);
  return living.map((saved) => {
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
 * Whether this saved colonist is someone the current rules still consider
 * alive — the third balance-coupled repair, and the only one that removes the
 * record rather than mending a field on it.
 *
 * `clampedAge` bounds a restored age to MAX_AGE_TICKS, the LONGEST lifespan
 * current balance can draw (`lifespanTicks + spreadTicks`). But a colonist's
 * actual lifespan is drawn per id by `lifespanFor` and lands anywhere in
 * `[lifespanTicks - spreadTicks, lifespanTicks + spreadTicks]`, so an age
 * between their own draw and MAX_AGE_TICKS survives the clamp and restores
 * them ALIVE — for `resolveOldAge` to kill on the first tick. Only a lifespan
 * (or spread) retune downward can write such a record, which is what makes it
 * a repair rather than a rejection, exactly like the two below.
 *
 * DROPPED, not clamped down to `lifespan - 1`. Two reasons:
 *
 * 1. Clamping does not even satisfy the principle. `ageEveryone` runs BEFORE
 *    `resolveOldAge` in the same tick, so a colonist seeded at `lifespan - 1`
 *    turns `lifespan` on tick 1 and dies anyway — the seeded snapshot would
 *    still advertise someone the first tick removes, which is the whole thing
 *    this module exists to prevent.
 * 2. By the game's own rules they are dead. An age is not a balance-coupled
 *    magnitude like hunger or tool wear, where a smaller number is the honest
 *    current-balance reading of the same fact; here the fact itself — that
 *    this person is still in the colony — is what the retune revoked.
 *
 * Nothing downstream counts on the roster's length: `nextEntityId` is restored
 * from the save's own header (so ids never shift or collide), and population,
 * demographics, occupancy and meals-per-head are all derived from the roster
 * this function returns, by both restore paths.
 *
 * A NaN age (only reachable through `createColonyWorld` — `isLoadableSave`
 * refuses the save outright) fails this comparison and is dropped too, which
 * is the same answer `resolveOldAge`'s identical comparison would reach on
 * tick 1.
 */
function hasLifeLeft(saved: SavedColonist): boolean {
  return clampedAge(saved.ageTicks) < lifespanFor(saved.id, BALANCE.lifeBands);
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
 * whole save for it rather than quietly patching one field. A `homeId` naming
 * a RELOCATING shelter is left alone for exactly the same reason — see the
 * bed map below.
 */
function overCapacityEvictions(
  colonists: readonly SavedColonist[],
  buildings: SaveGameV5['buildings'],
): ReadonlySet<number> {
  const beds = new Map<number, number>();
  for (const b of buildings) {
    if (!Object.hasOwn(BUILDINGS, b.defId)) continue;
    const { beds: count } = BUILDINGS[b.defId];
    // Relocating shelters are excluded, as they already are from `spareBeds`,
    // `shelterWithRoom` and `freeBeds`: a house in transit offers no beds, and
    // `rehome` evicts its residents on the first tick. Counting them made this
    // the one place that treated a relocating shelter as usable, and evicted
    // its overflow as though a `houseBeds` retune had put them there. Leaving
    // it out drops such a `homeId` into the same untouched branch below as a
    // `homeId` naming nothing at all — both are reference states
    // `isLoadableSave` refuses the whole save for, not balance-coupled values
    // to repair. Unreachable through a guard-valid save (rule 3 rejects the
    // pairing); reachable through `createColonyWorld`, which tests call
    // directly with saves nobody validated.
    if (count > 0 && b.relocatingTicks === 0) beds.set(b.id, count);
  }
  const evicted = new Set<number>();
  for (const c of [...colonists].sort((a, b) => a.id - b.id)) {
    if (c.homeId === null) continue;
    const remaining = beds.get(c.homeId);
    if (remaining === undefined) continue;
    if (remaining > 0) beds.set(c.homeId, remaining - 1);
    else evicted.add(c.id);
  }
  return evicted;
}
