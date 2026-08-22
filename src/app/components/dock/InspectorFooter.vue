<script setup lang="ts">
import { computed, inject } from 'vue';
import { ENGINE_KEY } from '../../engine-key';
import { useUiStore } from '../../stores/ui-store';
import type { BuildingSnapshot } from '../../../shared/snapshot';
import { suppliedLabel } from '../../labels';
import TwoStepButton from '../TwoStepButton.vue';

// The part of the Inspector every building kind shares: the construction
// countdown (when there is one), the relocation countdown (when there is
// one), and the two verbs at the foot — Move, Demolish. Split out of
// InspectorPanel.vue for the same reason InspectorProducer.vue is: see that
// file's own comment. Kept separate from the per-kind components (producer/
// house/storehouse) because this region is ORTHOGONAL to kind — a settled
// producer, house or storehouse can all be mid-relocation, and Move/Demolish
// apply to every one of them.
const props = defineProps<{ building: BuildingSnapshot }>();
const engine = inject(ENGINE_KEY)!;
const ui = useUiStore();

/** Why Move is disabled, or null — `handleMoveBuilding` always refuses a
 * site, the one branch this control has (spec §2.2: the reason is stated
 * here, not left in a `title`). */
const moveReason = computed(() => (
  props.building.constructionTicks > 0 ? 'A building under construction cannot be moved.' : null
));
</script>

<template>
  <!-- The construction countdown, and the per-material shortfall beside it —
       the only way to tell a site that is waiting from one that is stuck,
       minutes after the order (§2.10). `suppliedLabel`, not `needsLabel`: the
       shortfall alone reads the same at 0/25 and at 24/25. -->
  <template v-if="building.constructionTicks > 0">
    <p data-test="selection-construction">Under construction: {{ building.constructionTicks }}t left</p>
    <p data-test="selection-needs">Needs: {{ suppliedLabel(building.defId, building.constructionNeeds) }}</p>
  </template>
  <p v-if="building.relocatingTicks > 0" data-test="selection-relocating">
    Relocating: {{ building.relocatingTicks }}t left
  </p>
  <button data-test="inspector-move" :disabled="moveReason !== null" @click="ui.armMove(building.id)">Move</button>
  <p v-if="moveReason" class="obsisim-reason" data-test="inspector-move-reason">{{ moveReason }}</p>
  <TwoStepButton
    label="Demolish" confirm-label="Confirm demolish?" data-test="selection-demolish"
    @confirm="engine.dispatch({ type: 'demolishBuilding', buildingId: building.id })"
  />
</template>
