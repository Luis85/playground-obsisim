import { computed } from 'vue';
import { useGameStore } from './stores/game-store';
import { CHAINS } from '../engine/content';
import { buildPressureLabel, chainTableRows, haulPressureLabel, inputPressureLabel } from './labels';

/**
 * The Economy chain table's reactive derivation — the three backlog
 * sentences and the per-stage rows — computed once and read by both
 * `EconomyView` (the Ledger's wide table) and `EconomyPanel` (the dock's
 * narrower one, Task 10). Spec §2.7: "the two readers share a store getter,
 * never a second derivation." `chainTableRows`/`*PressureLabel` in
 * labels.ts already do the actual formatting from plain data; this
 * composable is the one place that wires them to `useGameStore()`'s
 * reactive getters, so the `computed(...)` wrapping itself exists exactly
 * once rather than being retyped, identically, in both `<script setup>`
 * blocks — which is what fallow's clone detector flagged when it was.
 *
 * A plain `.ts` composable rather than a shared component, following
 * `src/app/world/interaction.ts`'s own precedent (a `computed`-returning
 * function outside any single `.vue` file): the two views' TEMPLATES
 * genuinely differ (nine columns vs four, inert rows vs clickable ones), so
 * only the figures are shared here — the presentation is not, per §2.7's
 * second sentence. The one block that IS identical between the two
 * surfaces (the three `<p>` pressure lines) is `EconomyPressureLines.vue`,
 * which reads this same composable rather than repeating its own copy.
 */
export function useEconomyChains() {
  const store = useGameStore();

  const haulPressure = computed(() => haulPressureLabel(store.unitsWaiting, store.haulerCount, store.stalledBuildings));
  const inputPressure = computed(() => inputPressureLabel(store.buildingsWaitingForInput, store.unitsShort));
  const buildPressure = computed(() => buildPressureLabel(store.buildingsUnderConstruction, store.unitsNeededForConstruction));

  // The two `obsisim-negative` gates EconomyPressureLines.vue binds to — a
  // stall is worth flagging red; a construction site is not (see
  // buildPressureLabel's own comment), which is why there is no third one.
  const haulNegative = computed(() => store.stalledBuildings > 0);
  const inputNegative = computed(() => store.buildingsWaitingForInput > 0);

  const chains = computed(() => {
    const snapshot = store.snapshot;
    if (!snapshot) return [];
    return chainTableRows(CHAINS, store.staffingByDef, store.stageStatuses, store.runways, snapshot.stockpile);
  });

  return { haulPressure, inputPressure, buildPressure, haulNegative, inputNegative, chains };
}
