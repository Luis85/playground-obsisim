<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS } from '../../engine/content';
import { BUILDING_STATE_LABELS, needsLabel } from '../labels';
import TwoStepButton from './TwoStepButton.vue';

// The selected building's live card, derived from the current snapshot by
// id — staffing, state, and tile stay fresh as ticks arrive, and the card
// vanishes by itself if the building does (the parent also clears its
// selection state reactively; both guards are cheap).
const props = defineProps<{ buildingId: number }>();
const emit = defineEmits<{ move: []; demolish: []; close: [] }>();
const store = useGameStore();

const building = computed(
  () => store.snapshot?.buildings.find((b) => b.id === props.buildingId) ?? null,
);
</script>

<template>
  <div v-if="building" class="obsisim-selection-panel" data-test="selection-panel">
    <strong>{{ BUILDINGS[building.defId].name }}</strong>
    <span>({{ building.col }}, {{ building.row }})</span>
    <span>{{ building.workers }}/{{ building.workerSlots }} workers — {{ BUILDING_STATE_LABELS[building.state] }}</span>
    <span data-test="selection-waiting">Waiting: {{ building.buffered }}</span>
    <span data-test="selection-input">In: {{ building.inputBuffered }}</span>
    <span v-if="building.storage > 0" data-test="selection-storage">Stored: {{ building.stored }} / {{ building.storage }}</span>
    <span v-if="building.relocatingTicks > 0" data-test="selection-relocating">Relocating: {{ building.relocatingTicks }}t left</span>
    <!-- The construction countdown, alongside relocatingTicks above for the
         same reason Step 1's grep pairs the two: a site is the other state
         with ticks left to run down. And the per-material shortfall beside
         it — the only way to tell a site that is waiting from one that is
         stuck, minutes after the order (§2.10). -->
    <span v-if="building.constructionTicks > 0" data-test="selection-construction">Under construction: {{ building.constructionTicks }}t left</span>
    <span v-if="building.constructionTicks > 0" data-test="selection-needs">Needs: {{ needsLabel(building.constructionNeeds) }}</span>
    <button data-test="selection-move" @click="emit('move')">Move</button>
    <TwoStepButton label="Demolish" confirm-label="Confirm demolish?" data-test="selection-demolish" @confirm="emit('demolish')" />
    <button data-test="selection-close" title="Deselect" aria-label="Deselect" @click="emit('close')">✕</button>
  </div>
</template>
