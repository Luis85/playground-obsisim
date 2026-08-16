import { createSystem, queryComponents, Read, Write } from 'sim-ecs';
import type { BuildingDefId, ResourceId } from '../../shared/content-types';
import { isUnderConstruction } from '../../shared/placement';
import { BUILDINGS } from '../content/buildings';
import { Building, Construction, InputBuffer } from '../components';

/**
 * A site's materials are fully delivered, checked directly against the
 * `InputBuffer` it actually holds rather than through anything haulage
 * computes.
 *
 * `siteNeedOf` and `inputRoomOf` (haul-construction.ts) answer a DIFFERENT
 * question — how much more a site may be OFFERED, net of what haulers already
 * walking toward it have CLAIMED — because a dispatch decision must not send
 * two haulers after the same last unit. Completion cares about none of that:
 * a claim is a hauler still walking, not a delivery, and reading it here would
 * complete a site whose materials have not physically arrived. So this reads
 * the same shape `payFrom` (production-system.ts) already reads a recipe's
 * inputs with — every entry of the cost map met by what is actually banked —
 * applied to a building's cost instead of a batch's inputs, the only overlap
 * the two ever had.
 */
function materialsComplete(input: InputBuffer, defId: BuildingDefId): boolean {
  const { cost } = BUILDINGS[defId];
  return Object.entries(cost).every(([id, amount]) => (input.amounts.get(id as ResourceId) ?? 0) >= amount);
}

/**
 * Turns a fully supplied construction site into the finished building it has
 * been standing in for since the order was placed (spec §2.5's last step).
 *
 * Placed AFTER `HaulSystem` — a delivery landing this tick must count toward
 * this tick's countdown, not next tick's — and BEFORE `StatsSystem`, so a
 * completion this tick is folded into the flows `StatsSystem` reads before
 * clearing them. `buildColonyPrepWorld`'s `assertSystemOrder` enforces both
 * halves of that placement against `ALL_SYSTEMS` (world.ts).
 *
 * MATERIALS COMPLETE IS DERIVED HERE, EVERY TICK, NEVER STORED: recomputing
 * `materialsComplete` against the live `InputBuffer` is the whole of the
 * check, so there is no second flag that could disagree with the buffer it
 * summarises — a hauler delivering the last unit and a later cancellation
 * refunding it both stay correct for free, because neither has a flag to
 * forget to update.
 *
 * EMPTYING THE IN-TRAY AT ZERO RECORDS NO CONSUMPTION. Those goods were
 * consumed the moment they left the colony's ledger — `unload`
 * (haul-system.ts) already calls `Stockpile.recordConsumed` on arrival, the
 * same tick a hauler's delivery lands in this in-tray — so clearing the tray
 * here is bookkeeping on a pile nothing outside this component still counts,
 * not a second spend of the same goods. Recording it again would double the
 * flow this build ever cost the colony.
 */
export const ConstructionSystem = () => createSystem({
  sites: queryComponents({ building: Read(Building), construction: Write(Construction), input: Write(InputBuffer) }),
})
  .withName('ConstructionSystem')
  .withRunFunction(({ sites }) => {
    for (const { building, construction, input } of sites.iter()) {
      if (!isUnderConstruction(construction.ticksLeft)) continue;
      if (!materialsComplete(input, building.defId)) continue;
      construction.ticksLeft -= 1;
      if (construction.ticksLeft === 0) input.amounts.clear();
    }
  })
  .build();
