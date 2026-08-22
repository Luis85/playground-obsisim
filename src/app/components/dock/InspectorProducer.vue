<script setup lang="ts">
import { BUILDINGS } from '../../../engine/content';
import type { BuildingSnapshot } from '../../../shared/snapshot';
import { batchLabel, recipeLabel } from '../../labels';

// The producer half of the Inspector's per-kind detail region (spec §2.3):
// recipe, batch progress, in-tray, out-tray, work power, tooled workers.
// Split out of InspectorPanel.vue rather than left as one of its template
// branches — the parent's kind switch plus this component's five fields in
// one template was enough branching to trip fallow's cognitive-complexity
// gate (`scripts/check-quality.mjs`'s `complexFunctions` counter), and a
// component per kind is the natural seam: each one already corresponds to
// exactly one row of the spec table.
defineProps<{ building: BuildingSnapshot }>();
</script>

<template>
  <div class="obsisim-inspector-producer">
    <p data-test="inspector-recipe">{{ recipeLabel(BUILDINGS[building.defId]) }}</p>
    <p>Batch: {{ batchLabel(building.beds, building.occupants, building.progressPct) }}</p>
    <p data-test="inspector-buffers">In: {{ building.inputBuffered }} · Out: {{ building.buffered }}</p>
    <p>Work power: {{ building.workPower.toFixed(2) }}</p>
    <p data-test="inspector-tools">Tools: {{ building.tooledWorkers }} / {{ building.workers }}</p>
  </div>
</template>
