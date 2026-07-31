<script setup lang="ts">
import { useGameStore } from '../stores/game-store';
import { BUILDINGS, BUILDING_IDS, type BuildingDefId } from '../../engine/content';
import { costLabel } from '../labels';
import { BUILDING_GLYPHS } from '../world/theme';

// The construct catalog as canvas-side buttons: click arms placement mode
// (the parent owns the mode), click again disarms. Arming is gated on
// affordability; STAYING armed is not — stock can drain under an armed
// palette, and the engine is the authority that rejects with a notice.
const props = defineProps<{ armedDefId: BuildingDefId | null }>();
const emit = defineEmits<{ arm: [defId: BuildingDefId]; disarm: [] }>();
const store = useGameStore();

function toggle(id: BuildingDefId) {
  if (props.armedDefId === id) emit('disarm');
  else emit('arm', id);
}
</script>

<template>
  <div class="obsisim-build-palette" data-test="build-palette">
    <button
      v-for="id in BUILDING_IDS"
      :key="id"
      :data-test="`palette-${id}`"
      :class="{ 'is-armed': armedDefId === id }"
      :disabled="armedDefId !== id && !store.affordableDefs[id]"
      @click="toggle(id)"
    >
      <span>{{ BUILDING_GLYPHS[id] }} {{ BUILDINGS[id].name }}</span>
      <span class="obsisim-palette-cost">{{ costLabel(BUILDINGS[id].cost) }}</span>
    </button>
  </div>
</template>
