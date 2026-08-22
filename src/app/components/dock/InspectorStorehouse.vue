<script setup lang="ts">
import type { BuildingSnapshot } from '../../../shared/snapshot';
import { waitingLabel } from '../../labels';

// The storehouse half of the Inspector's per-kind detail region (spec §2.3):
// `held / capacity`. Split out of InspectorPanel.vue for the same reason
// InspectorProducer.vue is — see that file's own comment.
defineProps<{ building: BuildingSnapshot }>();
</script>

<template>
  <p data-test="inspector-storage">{{ waitingLabel(building.storage, building.stored, building.buffered) }}</p>
</template>
