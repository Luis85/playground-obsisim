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
 * different things: the goods DESTROYED are the out-tray plus, for a FINISHED
 * building, its in-tray (a mill demolished mid-batch loses both, and one
 * clause naming only the flour would be a false receipt for the wheat), while
 * the goods MOVED are a storehouse's share of the ledger — which lives in the
 * Stockpile and not on the entity at all — plus, for a SITE, the materials
 * `refundInTrayOf` has just handed back to the camp. */
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
 * loss.
 *
 * A SITE'S DELIVERED MATERIALS RIDE THE `moved` CLAUSE, not the `lost` one,
 * and that is the same rule rather than a second one. `refundInTrayOf` banks
 * them at the camp exactly as a demolished storehouse's stock is banked there,
 * so "moved to the camp" is literally what happened to them — while calling
 * them `lost`, which is what this sentence said about every in-tray back when
 * nothing could reach a site's, would be OBS-4-07's defect with the sign
 * flipped the other way: the ledger conserves the wood and the receipt tells
 * the player it burned. The caller decides which lookup feeds each clause,
 * because only it knows whether this was a site.
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
 * `refundInTrayOf` below hands over. The two may not be summed into one loop:
 * this one pays back a PRICE the colony was charged, that one pays back GOODS
 * the colony still owns, and a site is owed exactly one of them.
 */
export function refundCostOf(ctx: CommandContext, found: BuildingRow): void {
  if (isUnderConstruction(found.construction.ticksLeft)) return;
  for (const [resource, amount] of Object.entries(BUILDINGS[found.building.defId].cost)) {
    ctx.stockpile.refund(resource as ResourceId, amount);
  }
}

/**
 * The materials haulers actually delivered to a construction site, handed back
 * to the colony when the player cancels it.
 *
 * WITHOUT THIS, CANCELLING A PARTLY SUPPLIED SITE DESTROYS EVERYTHING
 * DELIVERED, and it ships with the task that first lets a material reach a
 * site's tray rather than after it. The rule for a demolished building empties
 * both trays into nothing, and §2.7's argument for that is sound for a
 * FINISHED building: a building left full of goods should be expensive to
 * bulldoze, because that pressure is what haulers exist to relieve, and a
 * player who wants the goods kept has the non-destructive `moveBuilding`.
 * Neither half survives the move to a site. There is nothing to move — a site
 * is a hole in the ground — and cancelling is the only way out of a misplaced
 * build order, so the pressure would fall on the one action the player has.
 *
 * `refund`, never `add`: nobody hauled these to the camp, and `add` records a
 * delivery, which would inflate the Economy view's Delivered/t for a round
 * trip that moved nothing (Stockpile.add's doc comment). To the CAMP, which is
 * where `refundCostOf` already pays a finished building's cost back and where
 * `spillTo` already sends a demolished storehouse's stock — one destination
 * for everything a demolition returns, rather than three rules for three piles.
 *
 * Returns what it handed back so the caller can word the notice from the same
 * figures it banked rather than re-reading a tray it is about to clear.
 */
export function refundInTrayOf(ctx: CommandContext, found: BuildingRow): Map<ResourceId, number> {
  const returned = new Map<ResourceId, number>();
  if (!isUnderConstruction(found.construction.ticksLeft)) return returned;
  for (const [resource, amount] of found.input.amounts) {
    if (amount <= 0) continue;
    returned.set(resource, amount);
    ctx.stockpile.refund(resource, amount);
  }
  return returned;
}
