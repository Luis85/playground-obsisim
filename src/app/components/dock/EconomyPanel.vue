<script setup lang="ts">
import { useGameStore } from '../../stores/game-store';
import { useUiStore } from '../../stores/ui-store';
import type { BuildingDefId } from '../../../engine/content';
import type { ChainStageRow } from '../../labels';
// Reads the exact same chain-row derivation EconomyView reads, rather than
// re-walking CHAINS here — spec §2.7. See economy.ts's own comment for why a
// composable rather than a shared component (the two tables' column sets
// genuinely differ), and EconomyPressureLines.vue/ChainTable.vue's own
// comments for the parts that ARE shared as components: the three pressure
// lines, and the table's outer section/h3/table/Stage-column shell.
import { useEconomyChains } from '../../economy';
import EconomyPressureLines from '../EconomyPressureLines.vue';
import ChainTable from '../ChainTable.vue';

const store = useGameStore();
const ui = useUiStore();
const { chains } = useEconomyChains();

// A stage is a def, not a building: EconomyView emits one row per step in
// CHAINS and aggregates it through staffingByDef, so a stage stands for
// however many buildings of that def exist — none, one, or six. Highlighting
// the whole set — even a set of one — keeps the click from behaving
// differently depending on a count the player is not looking at (spec §2.3,
// argued at length there because it is where a plural rule usually breaks).
//
// Clears the selection first for the same reason AttentionPanel's plural
// rows do (Task 11): a stage row's one result is "highlights every building
// of that def; selects nothing", and a selection surviving from whatever
// panel the player was on before is not that result. `clearSelection()`
// (-> `select({ kind: 'none' })`) does NOT itself blank `highlight` — only a
// non-`none` outgoing selection does that (see ui-store.ts's own comment on
// `select`) — which is exactly what lets `setHighlight` below still land.
function highlightStage(defId: BuildingDefId) {
  ui.clearSelection();
  ui.setHighlight((store.snapshot?.buildings ?? [])
    .filter((b) => b.defId === defId)
    .map((b) => ({ kind: 'building' as const, id: b.id })));
}

function onRowClick(row: ChainStageRow) {
  highlightStage(row.building);
}
</script>

<template>
  <!-- Guarded on `store.snapshot`, the house convention every other view and
       panel in this codebase follows (DashboardView, ResourceStrip,
       InspectorPanel, ColonyPanel). -->
  <div v-if="store.snapshot" class="obsisim-economy" data-test="economy-panel">
    <EconomyPressureLines />
    <ChainTable :chains="chains" @row-click="onRowClick">
      <template #headers>
        <th>Crew (staffed)</th><th>Status</th><th>Empties in</th>
      </template>
      <template #cells="{ row }">
        <td>{{ row.crew }}</td>
        <td>{{ row.status }}</td>
        <td>{{ row.runway }}</td>
      </template>
    </ChainTable>
  </div>
</template>
