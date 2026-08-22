<script setup lang="ts">
import type { ColonistSnapshot } from '../../../shared/snapshot';
import { ageLabel, commuteLabel, LIFE_STAGE_LABELS, starvingLabel } from '../../labels';

// The colonist half of the Inspector (spec §2.3 makes a colonist selectable
// alongside a building — Population rows and a house's own occupant rows are
// both routes onto this card). Split out of InspectorPanel.vue for the same
// reason InspectorProducer.vue is: see that file's own comment.
defineProps<{ colonist: ColonistSnapshot }>();
</script>

<template>
  <div class="obsisim-inspector-colonist" data-test="inspector-colonist">
    <strong>#{{ colonist.id }}</strong>
    <span>{{ LIFE_STAGE_LABELS[colonist.stage] }}</span>
    <span>{{ ageLabel(colonist.ageTicks) }}</span>
    <span>{{ commuteLabel(colonist.homeId, colonist.commuteTiles, colonist.commuteFactor) }}</span>
    <span v-if="colonist.starvingTicks > 0">{{ starvingLabel(colonist.starvingTicks) }}</span>
  </div>
</template>
