<script setup lang="ts">
import type { ChainStageRow, ChainTableRow } from '../labels';

/**
 * The chain table's outer shell — one `<section>`/`<h3>`/`<table>` per
 * chain, the Stage column every row leads with, and the starved-row class —
 * shared between `EconomyView`'s nine-column table and `EconomyPanel`'s
 * four-column one (spec §2.7). This is genuinely identical structure, not a
 * coincidence of two authors reaching for the same table shape
 * independently: both walk the exact same `chains` (from `useEconomyChains`,
 * itself shared), both render one section per chain, and both lead with the
 * stage's own name — fallow's clone detector flagged this block when it was
 * pasted twice rather than shared.
 *
 * What differs between the two callers — the REST of the columns, and
 * whether a row does anything on click — stays with each caller through the
 * `headers`/`cells` slots and the `rowClick` emit. A caller that does not
 * listen for `rowClick` (`EconomyView`) gets a row that does nothing on
 * click, exactly the inert behaviour it had before this table shell was
 * extracted — the emit exists, but nothing here decides what it MEANS.
 */
defineProps<{ chains: ChainTableRow[] }>();
const emit = defineEmits<{ rowClick: [row: ChainStageRow] }>();
</script>

<template>
  <section v-for="chain in chains" :key="chain.name">
    <h3>{{ chain.name }} chain</h3>
    <table class="obsisim-table">
      <thead>
        <tr>
          <th>Stage</th>
          <slot name="headers" />
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in chain.steps"
          :key="row.building"
          :data-test="`stage-row-${row.building}`"
          :class="{ 'obsisim-starved': row.starved }"
          @click="emit('rowClick', row)"
        >
          <td>{{ row.stage }}</td>
          <slot name="cells" :row="row" />
        </tr>
      </tbody>
    </table>
  </section>
</template>
