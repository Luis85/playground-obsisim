<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
// The chain-row derivation and the three pressure sentences are shared with
// EconomyPanel (the dock's version of this same table, Task 10) through this
// one composable, rather than each view walking CHAINS or building its own
// sentence — spec §2.7's "one figure, one derivation, two surfaces". See
// economy.ts's own comment for why a composable rather than a shared
// component: the two views' COLUMN SETS genuinely differ (nine vs four).
import { useEconomyChains } from '../economy';
// The three pressure lines and the chain table's outer shell ARE identical
// markup in both surfaces, which is the OTHER half of §2.7 ("where a whole
// block is identical, share the component") — see each component's own
// comment for what stays shared and what a caller supplies itself.
import EconomyPressureLines from '../components/EconomyPressureLines.vue';
import ChainTable from '../components/ChainTable.vue';

// The chain view exists to make bottlenecks visible (PRD §5): a starving
// stage is the signal that the stage before it is too slow. Verdicts come
// precomputed from the store (stageStatuses); rows are assembled here so
// the template stays flat interpolation.
const store = useGameStore();
const { chains } = useEconomyChains();
</script>

<template>
  <div v-if="store.snapshot">
    <EconomyPressureLines />
    <ChainTable :chains="chains">
      <template #headers>
        <th>Buildings (staffed)</th><th>Status</th><th>Output</th><th data-test="made-heading">Made/t</th><th data-test="inflow-heading">Delivered/t</th><th>Cons/t</th><th>Stock</th><th>Empties in</th>
      </template>
      <template #cells="{ row }">
        <td>{{ row.crew }}</td>
        <td :data-test="`status-${row.building}`">{{ row.status }}</td>
        <td>{{ row.output }}</td>
        <td :data-test="`made-${row.building}`">{{ row.made }}</td>
        <td :data-test="`delivered-${row.building}`">{{ row.delivered }}</td>
        <td>{{ row.cons }}</td>
        <td>{{ row.stock }}</td>
        <td :data-test="`runway-${row.outputId}`">{{ row.runway }}</td>
      </template>
    </ChainTable>
  </div>
</template>
