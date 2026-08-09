import { CAMP_SITE_ID, CAMP_TILE, type StoreSite } from '../../shared/haul';
import type { PendingChanges } from '../resources';

/**
 * A building that can store goods, as `storeSitesOf` needs it to build the
 * `StoreSite[]` `HaulSystem` will haul against. `capacity` is resolved by the
 * caller (`BUILDINGS[defId].storage`) rather than carried as a `defId` here —
 * the same choice `ShelterRow` makes for `beds` in population-handlers.ts —
 * so this module stays free of a content-catalog dependency.
 */
export interface StoreSiteRow {
  id: number;
  col: number;
  row: number;
  capacity: number;
  /** A storehouse in transit stores nothing until it lands — `beds.total`'s
   * existing rule for a relocating house (increment 6), applied to storage. */
  relocating: boolean;
}

/**
 * Store sites right now: the camp, then every live storehouse — what
 * `HaulSystem` needs in order to answer "where can this load go" (spec §2.3,
 * §2.7).
 *
 * Two exclusions apply to a storehouse row, each borrowed from a rule that
 * already governs the same tick elsewhere in this engine:
 *
 * - `relocating`: a building mid-move provides none of its service — the
 *   same rule `beds.total` already applies to a relocating house.
 * - `pending.demolished`: `CommandSystem` runs before `HaulSystem`, and a
 *   demolished entity survives in every query until the post-step sync (see
 *   `PendingChanges` in resources.ts). Without this exclusion a hauler would
 *   be dispatched to a shed that is already gone.
 *
 * Deliberately does NOT fold in `pending.constructed`, unlike homing's
 * shelters (`CommandContext.shelters` in command-system.ts). A colonist left
 * homeless beside a house built this tick is a contradiction the player can
 * SEE in one snapshot, so homing must close it the same tick. A hauler not
 * yet routing to a shed built this tick is invisible: the shed simply becomes
 * a site next tick, one tick later than it could have, and nothing about that
 * gap is observable. Simpler wins where the cost of waiting is that small.
 *
 * The camp always leads, at `CAMP_SITE_ID` with unbounded capacity; the
 * storehouses that follow are ascending by id — the same tie-break-to-id
 * determinism every other selection in `src/shared/haul.ts` commits to, so
 * the result never depends on `rows`' own order (the second test above
 * passes `rows` out of id order on purpose).
 */
export function storeSitesOf(rows: readonly StoreSiteRow[], pending: PendingChanges): StoreSite[] {
  const camp: StoreSite = { id: CAMP_SITE_ID, col: CAMP_TILE.col, row: CAMP_TILE.row, capacity: null };
  const storehouses = rows
    .filter((row) => !row.relocating && !pending.demolished.has(row.id))
    .map((row): StoreSite => ({ id: row.id, col: row.col, row: row.row, capacity: row.capacity }))
    .sort((a, b) => a.id - b.id);
  return [camp, ...storehouses];
}
