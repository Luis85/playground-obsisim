import type { BuildingSnapshot } from '../shared/snapshot';
import { NO_IDLE_ADULTS_REASON, NOTHING_STAFFED_REASON, STAFFING_FULL_REASON, STAFFING_SITE_REASON } from './labels';

/*
 * Why a staffing verb is refused, or null when it isn't — the ONE derivation
 * behind both surfaces spec §2.2 requires (the Inspector's `+`/`-` and
 * BuildingsView's `+`/`-`), following §2.7's "one figure, one derivation, two
 * surfaces" for a REASON rather than a number. Before this module existed,
 * InspectorPanel.vue carried these three branches as a local computed and
 * BuildingsView.vue carried none at all — Task 7 found and fixed the first
 * half (a staffing gate that ignored a construction site entirely, and a
 * middle branch nobody had a test for), Task 12's sweep finds the second: the
 * SAME gate is needed on the table, and copying the three branches into a
 * second file would have been the exact "rule applied to one surface, missed
 * on its twin" this sweep exists to catch, plus a second place to word the
 * same sentence differently the day it changes.
 *
 * A free function, not a `computed`, because the two callers read it two
 * different ways: InspectorPanel wraps one call in a `computed` bound to its
 * single selected building; BuildingsView calls it once per table row. A
 * `computed` cannot serve both without either wrapping every row's call
 * itself (defeating the point of a shared computed) or handing back a whole
 * `Map`, which is more machinery than a three-branch pure function needs.
 */
export function staffingRefusal(b: BuildingSnapshot, idleAdults: number): string | null {
  if (b.constructionTicks > 0) return STAFFING_SITE_REASON;
  if (b.workers >= b.workerSlots) return STAFFING_FULL_REASON;
  if (idleAdults === 0) return NO_IDLE_ADULTS_REASON;
  return null;
}

/** `handleUnassignWorker`'s one refusal, restated for the panel — the
 * unassign-direction twin of `staffingRefusal` above, same reasoning for why
 * it is a shared function rather than two copies. */
export function unassignRefusal(b: BuildingSnapshot): string | null {
  return b.workers === 0 ? NOTHING_STAFFED_REASON : null;
}
