<script setup lang="ts">
import type { BuildingSnapshot, ColonistSnapshot } from '../../../shared/snapshot';
import { batchLabel } from '../../labels';
import { useUiStore } from '../../stores/ui-store';

// The house half of the Inspector's per-kind detail region (spec §2.3): beds,
// and its occupants as clickable rows — "Inspector occupant row -> selects
// that colonist" in §2.3's table. Split out of InspectorPanel.vue for the
// same reason InspectorProducer.vue is: see that file's own comment.
defineProps<{ building: BuildingSnapshot; occupants: ColonistSnapshot[] }>();
const ui = useUiStore();
</script>

<template>
  <div class="obsisim-inspector-house">
    <p data-test="inspector-beds">Beds: {{ batchLabel(building.beds, building.occupants, building.progressPct) }}</p>
    <ul>
      <li
        v-for="occupant in occupants" :key="occupant.id" :data-test="`occupant-${occupant.id}`"
        @click="ui.selectColonist(occupant.id)"
      >#{{ occupant.id }}</li>
    </ul>
  </div>
</template>
