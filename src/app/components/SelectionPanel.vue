<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../stores/game-store';
import { BUILDINGS } from '../../engine/content';
import { BUILDING_STATE_LABELS } from '../labels';
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
    <span v-if="building.relocatingTicks > 0" data-test="selection-relocating">Relocating: {{ building.relocatingTicks }}t left</span>
    <button data-test="selection-move" @click="emit('move')">Move</button>
    <TwoStepButton label="Demolish" confirm-label="Confirm demolish?" data-test="selection-demolish" @confirm="emit('demolish')" />
    <button data-test="selection-close" title="Deselect" aria-label="Deselect" @click="emit('close')">✕</button>
  </div>
</template>
