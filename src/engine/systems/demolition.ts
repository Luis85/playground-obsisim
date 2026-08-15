import type { ResourceId } from '../../shared/content-types';
import { isUnderConstruction } from '../../shared/placement';
import { BUILDINGS } from '../content/buildings';
import { RESOURCES, RESOURCE_IDS } from '../content/resources';
import type { BuildingRow, CommandContext } from './command-handlers';

// What happens to a demolished building's GOODS and to the sentence the player
// reads about it — split out of placement-handlers.ts along the seam Task 1
// drew for world.ts, and for the same reason: that file was at 444 of the
// 500-line cap with the in-tray refund still to land in it. The three commands
// that place, move and remove a building stay there; what a removal does to
// the ledger, and how it is worded, is one subject and lives here.

/** What a demolished building was holding, worded for the success notice:
 * resource names from the same catalog `BUILDINGS` comes from, in catalog
 * order — the determinism rule `OutputBuffer.fullestResource` also uses — and
 * comma-separated. Empty when it held nothing; the caller decides whether that
 * is worth a clause of its own.
 *
 * Takes a lookup rather than a map because the two clauses below count
 * different things: the goods DESTROYED are the in-tray and the out-tray
 * summed (a mill demolished mid-batch loses both, and one clause naming only
 * the flour would be a false receipt for the wheat), while the goods MOVED are
 * a storehouse's share of the ledger, which lives in the Stockpile and not on
 * the entity at all. */
export function heldText(amountOf: (id: ResourceId) => number): string {
  const parts: string[] = [];
  for (const id of RESOURCE_IDS) {
    const amount = amountOf(id);
    if (amount > 0) parts.push(`${amount} ${RESOURCES[id].name}`);
  }
  return parts.join(', ');
}

/**
 * One clause per thing that happened to this building's goods, in the wording
 * OBS-4-07 fixed: a zero-units clause would be noise on the common case, so
 * nothing held means the plain sentence, byte-identical to before §2.7 gave
 * the storehouse a second outcome.
 *
 * `wasSite` picks the opening clause: a FINISHED building was actually paid
 * for, so "cost refunded" is true; a SITE never was (§2.3), and `refundCostOf`
 * hands nothing back for one, so claiming a refund here would be OBS-4-07's
 * exact defect with the sign flipped — a false receipt instead of a silent
 * loss. This covers only the construction-cost half of that claim. A site can
 * also hold delivered materials in its in-tray once Task 3 ships supply to
 * one; naming THEIR loss in this notice, the way `lost` already does for a
 * finished building's buffer, is Task 7's half — nothing can reach a site's
 * tray yet, so there is nothing for this function to say about it today.
 */
export function demolitionNotice(name: string, lost: string, moved: string, displaced: number, wasSite: boolean): string {
  let notice = wasSite ? `Cancelled the ${name} — nothing was charged` : `Demolished the ${name} — cost refunded`;
  if (lost !== '') notice += `, ${lost} lost`;
  if (moved !== '') notice += `, ${moved} moved to the camp`;
  notice += '.';
  return displaced > 0 ? `${notice} — ${displaced} colonist(s) displaced.` : notice;
}

/**
 * The construction cost handed back when a building is demolished.
 *
 * Full refund for a FINISHED building — a flagged balance knob (increment 5
 * owns tuning), and a decision rather than an accident: cutting it was
 * considered and rejected. `refund()`, not `add()`: the building was never
 * hauled to, so this must not inflate the Economy view's Delivered/t
 * (Stockpile.refund's doc comment says why). Active batch progress is simply
 * lost with the entity.
 *
 * A SITE gets nothing back, and that branch arrives with §2.3 rather than with
 * the rest of cancellation: the cost was never charged at the order, so paying
 * it back would MINT it out of nothing every time a player cancelled a build.
 * What a site does owe back is the materials actually DELIVERED to it, which
 * is a later task's half — nothing can reach an in-tray until dispatch learns
 * to supply a site.
 */
export function refundCostOf(ctx: CommandContext, found: BuildingRow): void {
  if (isUnderConstruction(found.construction.ticksLeft)) return;
  for (const [resource, amount] of Object.entries(BUILDINGS[found.building.defId].cost)) {
    ctx.stockpile.refund(resource as ResourceId, amount);
  }
}
